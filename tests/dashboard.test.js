import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { dashboardRouter } from '../src/dashboard/api.js';
import { config } from '../src/config.js';

test('Personal AI Dashboard API Test Suite', async (t) => {
  // Setup standalone express server with dashboardRouter mounted at /dashboard/api
  const app = express();
  app.use('/dashboard/api', dashboardRouter);
  app.use('/dashboard', express.static('public/dashboard'));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/dashboard/api`;
  const staticUrl = `http://localhost:${port}/dashboard`;

  const originalEnv = config.NODE_ENV;
  const originalToken = config.OPS_TOKEN;

  t.after(() => {
    config.NODE_ENV = originalEnv;
    config.OPS_TOKEN = originalToken;
    server.close();
  });

  // =========================================================================
  // 1. Authentication & Security Safeguards
  // =========================================================================
  await t.test('Auth: enforces OPS_TOKEN when configured', async () => {
    config.OPS_TOKEN = 'secret_dashboard_token_xyz987';
    config.NODE_ENV = 'production';

    // 1. Request without auth -> 401
    const resNoAuth = await fetch(`${baseUrl}/overview`);
    assert.strictEqual(resNoAuth.status, 401);
    const bodyNoAuth = await resNoAuth.json();
    assert.strictEqual(bodyNoAuth.success, false);

    // 2. Request with invalid Bearer token -> 401
    const resBadBearer = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: 'Bearer bad_token_123' },
    });
    assert.strictEqual(resBadBearer.status, 401);

    // 3. Request with valid Bearer token -> 200
    const resGoodBearer = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: 'Bearer secret_dashboard_token_xyz987' },
    });
    assert.strictEqual(resGoodBearer.status, 200);

    // 4. Request with valid x-api-key header -> 200
    const resGoodApiKey = await fetch(`${baseUrl}/overview`, {
      headers: { 'x-api-key': 'secret_dashboard_token_xyz987' },
    });
    assert.strictEqual(resGoodApiKey.status, 200);

    // 5. Request with valid ?token= query param -> 200
    const resGoodQuery = await fetch(`${baseUrl}/overview?token=secret_dashboard_token_xyz987`);
    assert.strictEqual(resGoodQuery.status, 200);

    // 6. Auth status probe -> 200
    const resProbe = await fetch(`${baseUrl}/auth/status`);
    assert.strictEqual(resProbe.status, 200);
    const probeData = await resProbe.json();
    assert.strictEqual(probeData.requiresAuth, true);

    // Reset auth for subsequent tests
    config.OPS_TOKEN = '';
    config.NODE_ENV = 'development';
  });

  // Helper for authenticated fetch
  const authFetch = (url, opts = {}) => {
    return fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  };

  // =========================================================================
  // 2. Section 1: GET /overview
  // =========================================================================
  await t.test('Section 1: GET /overview returns complete system status and metrics', async () => {
    const res = await authFetch(`${baseUrl}/overview`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert.strictEqual(data.status, 'online');
    assert.strictEqual(data.systemHealth, 'healthy');
    assert.ok(typeof data.uptimeSeconds === 'number');
    assert.ok(typeof data.uptimeFormatted === 'string');
    assert.ok(data.model && data.model.active);
    assert.ok(Array.isArray(data.model.fallbackChain));
    assert.ok(data.messageCounts && typeof data.messageCounts.queuePending === 'number');
    assert.ok(data.activeJobs && typeof data.activeJobs.totalTracked === 'number');
    assert.ok(data.memory && typeof data.memory.rssMb === 'number');
    assert.ok(data.features && data.features.zeroDiskStorage === true);
  });

  // =========================================================================
  // 3. Section 2: Semantic Memory (GET/POST/DELETE /memory)
  // =========================================================================
  await t.test('Section 2: Semantic Memory CRUD operations', async () => {
    // 1. GET /memory
    const getRes = await authFetch(`${baseUrl}/memory`);
    assert.strictEqual(getRes.status, 200);
    const getData = await getRes.json();
    assert.strictEqual(getData.success, true);
    assert.ok(Array.isArray(getData.facts));
    assert.ok(getData.total >= 0);

    // 2. POST /memory (create fact)
    const newFactPayload = {
      userId: 'test_user_42',
      category: 'work_context',
      fact: 'User works on high-performance distributed AI bots in Node.js.',
      confidence: 0.99,
    };
    const postRes = await authFetch(`${baseUrl}/memory`, {
      method: 'POST',
      body: JSON.stringify(newFactPayload),
    });
    assert.strictEqual(postRes.status, 200);
    const postData = await postRes.json();
    assert.strictEqual(postData.success, true);
    assert.strictEqual(postData.fact.fact, newFactPayload.fact);
    assert.strictEqual(postData.fact.category, newFactPayload.category);
    assert.ok(postData.fact.id);

    const createdId = postData.fact.id;

    // 3. POST /memory (update existing fact)
    const updateRes = await authFetch(`${baseUrl}/memory`, {
      method: 'POST',
      body: JSON.stringify({
        id: createdId,
        fact: 'User works on enterprise production WhatsApp AI bots.',
        confidence: 1.0,
      }),
    });
    assert.strictEqual(updateRes.status, 200);
    const updateData = await updateRes.json();
    assert.strictEqual(updateData.fact.id, createdId);
    assert.strictEqual(updateData.fact.fact, 'User works on enterprise production WhatsApp AI bots.');

    // 4. POST /memory with invalid payload -> 400
    const badPost = await authFetch(`${baseUrl}/memory`, {
      method: 'POST',
      body: JSON.stringify({ fact: '' }),
    });
    assert.strictEqual(badPost.status, 400);

    // 5. GET /memory?q=enterprise (search query)
    const searchRes = await authFetch(`${baseUrl}/memory?q=enterprise`);
    assert.strictEqual(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.ok(searchData.facts.some((f) => f.id === createdId));

    // 6. DELETE /memory?id=... (delete fact)
    const delRes = await authFetch(`${baseUrl}/memory?id=${createdId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(delRes.status, 200);
    const delData = await delRes.json();
    assert.strictEqual(delData.deletedId, createdId);

    // 7. DELETE /memory with non-existent ID -> 404
    const del404 = await authFetch(`${baseUrl}/memory?id=non_existent_fact_id`, {
      method: 'DELETE',
    });
    assert.strictEqual(del404.status, 404);
  });

  // =========================================================================
  // 4. Section 3: Knowledge Base & RAG Documents (GET/POST/DELETE /knowledge)
  // =========================================================================
  await t.test('Section 3: Knowledge Base document indexing and retrieval', async () => {
    // 1. POST /knowledge (upload & index text)
    const sampleDoc = {
      title: 'WhatsApp Graph API Architecture',
      content:
        'The WhatsApp Business Platform Cloud API allows developers to send and receive messages programmatically.\n\n' +
        'It utilizes webhook verification through HMAC-SHA256 signatures, ensuring secure transport.\n\n' +
        'Interactive message types include lists, reply buttons, and media templates.',
      category: 'architecture',
      tags: ['whatsapp', 'meta', 'api'],
    };

    const indexRes = await authFetch(`${baseUrl}/knowledge`, {
      method: 'POST',
      body: JSON.stringify(sampleDoc),
    });
    assert.strictEqual(indexRes.status, 200);
    const indexData = await indexRes.json();
    assert.strictEqual(indexData.success, true);
    assert.strictEqual(indexData.doc.title, sampleDoc.title);
    assert.ok(indexData.doc.chunkCount >= 2);
    assert.ok(indexData.doc.id);

    const docId = indexData.doc.id;

    // 2. GET /knowledge (list indexed documents)
    const listRes = await authFetch(`${baseUrl}/knowledge`);
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.strictEqual(listData.success, true);
    assert.ok(listData.totalDocs >= 1);
    assert.ok(listData.totalChunks >= 2);
    assert.strictEqual(listData.vectorIndexed, true);

    // 3. GET /knowledge with search filter
    const searchRes = await authFetch(`${baseUrl}/knowledge?q=architecture`);
    assert.strictEqual(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.ok(searchData.documents.some((d) => d.id === docId));

    // 4. POST /knowledge with missing title -> 400
    const badIndex = await authFetch(`${baseUrl}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({ content: 'no title doc' }),
    });
    assert.strictEqual(badIndex.status, 400);

    // 5. DELETE /knowledge?id=... (delete doc)
    const delRes = await authFetch(`${baseUrl}/knowledge?id=${docId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(delRes.status, 200);
    const delData = await delRes.json();
    assert.strictEqual(delData.deletedId, docId);

    // 6. DELETE /knowledge with invalid ID -> 404
    const del404 = await authFetch(`${baseUrl}/knowledge?id=unknown_doc_xyz`, {
      method: 'DELETE',
    });
    assert.strictEqual(del404.status, 404);
  });

  // =========================================================================
  // 5. Section 4: Multi-Agent Orchestrator (GET/PUT /agents)
  // =========================================================================
  await t.test('Section 4: Multi-Agent listing and permission configuration', async () => {
    // 1. GET /agents
    const res = await authFetch(`${baseUrl}/agents`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert.ok(data.totalAgents >= 5);
    assert.strictEqual(data.fastPathEnabled, true);

    const codingAgent = data.agents.find((a) => a.id === 'coding');
    assert.ok(codingAgent);
    assert.strictEqual(codingAgent.permissions.allowCodeExecution, true);

    // 2. PUT /agents (update permissions and maxHops)
    const putRes = await authFetch(`${baseUrl}/agents`, {
      method: 'PUT',
      body: JSON.stringify({
        id: 'coding',
        maxHops: 4,
        permissions: {
          allowCodeExecution: false,
        },
      }),
    });
    assert.strictEqual(putRes.status, 200);
    const putData = await putRes.json();
    assert.strictEqual(putData.agent.maxHops, 4);
    assert.strictEqual(putData.agent.permissions.allowCodeExecution, false);

    // 3. PUT /agents with unknown agent -> 404
    const notFoundRes = await authFetch(`${baseUrl}/agents`, {
      method: 'PUT',
      body: JSON.stringify({ id: 'ghost_agent_unknown' }),
    });
    assert.strictEqual(notFoundRes.status, 404);

    // 4. PUT /agents missing id -> 400
    const missingIdRes = await authFetch(`${baseUrl}/agents`, {
      method: 'PUT',
      body: JSON.stringify({ maxHops: 2 }),
    });
    assert.strictEqual(missingIdRes.status, 400);
  });

  // =========================================================================
  // 6. Section 5: Job Engine (GET/POST /jobs)
  // =========================================================================
  await t.test('Section 5: Job Engine tracking, queuing, and cancellation', async () => {
    // 1. GET /jobs
    const getRes = await authFetch(`${baseUrl}/jobs`);
    assert.strictEqual(getRes.status, 200);
    const getData = await getRes.json();
    assert.strictEqual(getData.success, true);
    assert.ok(getData.stats && typeof getData.stats.total === 'number');
    assert.ok(Array.isArray(getData.jobs));

    // 2. POST /jobs (enqueue new job)
    const newJobPayload = {
      title: 'Nightly Vector Compaction & Rerank',
      type: 'system_task',
      priority: 'high',
      payload: { target: 'all_chunks' },
    };
    const postRes = await authFetch(`${baseUrl}/jobs`, {
      method: 'POST',
      body: JSON.stringify(newJobPayload),
    });
    assert.strictEqual(postRes.status, 201);
    const postData = await postRes.json();
    assert.strictEqual(postData.success, true);
    assert.strictEqual(postData.job.status, 'queued');
    assert.strictEqual(postData.job.priority, 'high');
    assert.ok(postData.job.id);

    const queuedJobId = postData.job.id;

    // 3. POST /jobs (cancel the queued job)
    const cancelRes = await authFetch(`${baseUrl}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'cancel',
        id: queuedJobId,
      }),
    });
    assert.strictEqual(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.strictEqual(cancelData.job.status, 'cancelled');

    // 4. POST /jobs with invalid job ID -> 404
    const cancel404 = await authFetch(`${baseUrl}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'cancel',
        id: 'non_existent_job_9999',
      }),
    });
    assert.strictEqual(cancel404.status, 404);
  });

  // =========================================================================
  // 7. Section 6: Model Router (GET/PUT /models)
  // =========================================================================
  await t.test('Section 6: Model Router inspection, switching, and circuit breaker', async () => {
    // 1. GET /models
    const res = await authFetch(`${baseUrl}/models`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert.ok(data.activeModel);
    assert.ok(Array.isArray(data.fallbackModels));
    assert.ok(data.circuitBreaker && data.circuitBreaker.state === 'closed');
    assert.ok(data.modelStats && data.modelStats['gemini-3.1-flash-lite']);

    // 2. PUT /models (switch active model and update strategy)
    const putRes = await authFetch(`${baseUrl}/models`, {
      method: 'PUT',
      body: JSON.stringify({
        activeModel: 'gemini-2.5-flash',
        strategy: 'quality-priority',
        circuitBreakerReset: true,
      }),
    });
    assert.strictEqual(putRes.status, 200);
    const putData = await putRes.json();
    assert.strictEqual(putData.activeModel, 'gemini-2.5-flash');
    assert.strictEqual(putData.strategy, 'quality-priority');
    assert.strictEqual(putData.circuitBreaker.state, 'closed');
  });

  // =========================================================================
  // 8. Section 7: Security & Audit Logs (GET /security)
  // =========================================================================
  await t.test('Section 7: Security posture, whitelist, and redaction stats', async () => {
    const res = await authFetch(`${baseUrl}/security`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert.ok(data.whitelist && typeof data.whitelist.enabled === 'boolean');
    assert.ok(data.protectionBoundaries && data.protectionBoundaries.zeroDiskStorage === true);
    assert.ok(data.protectionBoundaries.piiSanitization === true);
    assert.ok(data.redactionCounters);
    assert.ok(Array.isArray(data.auditLogs));
  });

  // =========================================================================
  // 9. Section 8: Settings & Briefing Configuration (GET/PUT /settings)
  // =========================================================================
  await t.test('Section 8: Settings and daily briefing schedule configuration', async () => {
    // 1. GET /settings
    const getRes = await authFetch(`${baseUrl}/settings`);
    assert.strictEqual(getRes.status, 200);
    const getData = await getRes.json();

    assert.strictEqual(getData.success, true);
    assert.ok(getData.environment && getData.environment.nodeEnv);
    assert.ok(getData.features);
    assert.ok(getData.briefing && typeof getData.briefing.scheduledHour === 'number');

    // 2. PUT /settings (update search grounding & briefing hour)
    const putRes = await authFetch(`${baseUrl}/settings`, {
      method: 'PUT',
      body: JSON.stringify({
        searchGrounding: true,
        voiceReply: true,
        briefing: {
          enabled: true,
          scheduledHour: 7,
          timezone: 'UTC',
        },
      }),
    });
    assert.strictEqual(putRes.status, 200);
    const putData = await putRes.json();
    assert.strictEqual(putData.success, true);
    assert.strictEqual(putData.settings.features.searchGrounding, true);
    assert.strictEqual(putData.settings.features.voiceReply, true);
    assert.strictEqual(putData.settings.briefing.scheduledHour, 7);
    assert.strictEqual(putData.settings.briefing.timezone, 'UTC');
  });

  // =========================================================================
  // 10. Premium Web UI Static Serving
  // =========================================================================
  await t.test('Section 10: Static Web UI files serve HTML, CSS, and JS properly', async () => {
    // 1. GET /dashboard (HTML)
    const htmlRes = await fetch(`${staticUrl}/`);
    assert.strictEqual(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('AI Assistant Mission Control'));
    assert.ok(html.includes('app.js'));

    // 2. GET /dashboard/style.css (CSS)
    const cssRes = await fetch(`${staticUrl}/style.css`);
    assert.strictEqual(cssRes.status, 200);
    const css = await cssRes.text();
    assert.ok(css.includes('--bg-base'));

    // 3. GET /dashboard/app.js (JS)
    const jsRes = await fetch(`${staticUrl}/app.js`);
    assert.strictEqual(jsRes.status, 200);
    const js = await jsRes.text();
    assert.ok(js.includes('loadOverview'));
  });

  // =========================================================================
  // 11. DLQ & Human Handoff API Endpoints
  // =========================================================================
  await t.test('Section 11: DLQ and Human Handoff API endpoints respond with structured JSON', async () => {
    // 1. GET /dashboard/api/dlq
    const dlqRes = await fetch(`${baseUrl}/dlq`);
    assert.strictEqual(dlqRes.status, 200);
    const dlqData = await dlqRes.json();
    assert.strictEqual(dlqData.success, true);
    assert.ok(Array.isArray(dlqData.deadLetters));

    // 2. GET /dashboard/api/handoff
    const handoffRes = await fetch(`${baseUrl}/handoff`);
    assert.strictEqual(handoffRes.status, 200);
    const handoffData = await handoffRes.json();
    assert.strictEqual(handoffData.success, true);
    assert.ok(Array.isArray(handoffData.handoffs));

    // 3. POST /dashboard/api/handoff/:userId
    const toggleRes = await fetch(`${baseUrl}/handoff/919999000011`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, reason: 'Dashboard manual operator toggle' }),
    });
    assert.strictEqual(toggleRes.status, 200);
    const toggleData = await toggleRes.json();
    assert.strictEqual(toggleData.success, true);
    assert.strictEqual(toggleData.enabled, true);
  });
});
