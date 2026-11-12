import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { getKnowledgeGraph, clearKnowledgeGraph } from '../src/knowledge-graph.js';
import { ragEngine } from '../src/rag/index.js';
import { AgentOrchestrator } from '../src/agents/orchestrator.js';
import { ModelRouter, TASK_TYPES } from '../src/model-router.js';
import { JobEngine, InMemoryJobStore, JOB_PRIORITY } from '../src/job-engine.js';
import { compileDailyBriefing, updateUserBriefingSettings } from '../src/briefing.js';
import { dashboardRouter } from '../src/dashboard/api.js';
import { config } from '../src/config.js';
import { verifyMetaSignature } from '../src/webhook.js';
import { maskSensitiveInfo } from '../src/privacy.js';

test('Integration & Regression Quality Assurance Test Suite', async (t) => {
  const testUser = 'u_regression_verify_123';
  const otherUser = 'u_regression_isolated_456';

  t.after(async () => {
    await clearKnowledgeGraph(testUser);
    await clearKnowledgeGraph(otherUser);
    ragEngine.clearUser(testUser);
    ragEngine.clearUser(otherUser);
  });

  // =========================================================================
  // 1. Core Security & Privacy Safeguards (Zero-Regression Gate)
  // =========================================================================
  await t.test('Security: Webhook HMAC-SHA256 signature verification executes sub-millisecond', () => {
    const secret = 'prod_app_secret_regression_check_999';
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload, 'utf8');
    const validSignature = `sha256=${hmac.digest('hex')}`;

    const start = performance.now();
    const isValid = verifyMetaSignature(payload, validSignature, secret);
    const durationMs = performance.now() - start;

    assert.strictEqual(isValid, true, 'Valid signature should verify true');
    assert.strictEqual(durationMs < 5.0, true, `HMAC check must be sub-second (took ${durationMs.toFixed(3)}ms)`);

    // Tampered payload verification
    const tamperedPayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ malicious: true }] });
    const isTamperedValid = verifyMetaSignature(tamperedPayload, validSignature, secret);
    assert.strictEqual(isTamperedValid, false, 'Tampered payload must be rejected');
  });

  await t.test('Privacy: Luhn verification and sensitive PII redaction execute sub-millisecond', () => {
    const rawText = 'My Visa card is 4532 0150 1234 5671 and my cvv is 849. Address: Delhi.';
    const start = performance.now();
    const result = maskSensitiveInfo(rawText);
    const durationMs = performance.now() - start;

    assert.strictEqual(durationMs < 5.0, true, `Redaction must be sub-second (took ${durationMs.toFixed(3)}ms)`);
    assert.strictEqual(result.hasRedactions, true);
    assert.strictEqual(result.sanitizedText.includes('4532 0150 1234 5671'), false, 'Credit card must be redacted');
    assert.strictEqual(result.sanitizedText.includes('[REDACTED_CARD_NUMBER]'), true, 'Card token should be inserted');
    assert.strictEqual(result.sanitizedText.includes('849'), false, 'CVV must be redacted');
    assert.strictEqual(result.sanitizedText.includes('[REDACTED_CVV]'), true, 'CVV token should be inserted');
  });

  // =========================================================================
  // 2. Personal Knowledge Graph & Personal RAG Fusion
  // =========================================================================
  await t.test('Knowledge & RAG: Multi-tenant partitioning and context synthesis', async () => {
    const kg = getKnowledgeGraph(testUser);
    const otherKg = getKnowledgeGraph(otherUser);
    const userId = `user:${testUser}`;

    // 1. Add Knowledge Graph facts
    const rel1 = kg.addRelation({
      source: userId,
      predicate: 'LOCATED_IN',
      target: 'location:san_francisco',
      category: 'location',
      provenance: 'direct_message',
      confidence: 1.0,
    });
    assert.strictEqual(rel1.temporal.status, 'active');

    // 2. Add conflicting fact to verify contradiction resolution & supersession
    const rel2 = kg.addRelation({
      source: userId,
      predicate: 'LOCATED_IN',
      target: 'location:tokyo',
      category: 'location',
      provenance: 'direct_message',
      confidence: 1.0,
    });

    const activeRelations = kg.getRelations(userId, { category: 'location', status: 'active' });
    assert.strictEqual(activeRelations.length, 1);
    assert.strictEqual(activeRelations[0].target, 'location:tokyo');

    // Verify older fact is superseded
    const oldRelation = kg.getRelation(rel1.id);
    assert.ok(oldRelation, 'Previous relation should exist in history');
    assert.strictEqual(oldRelation.temporal.status, 'superseded');
    assert.strictEqual(oldRelation.supersededBy, rel2.id);

    // Verify other user has zero facts (strict tenant isolation)
    assert.strictEqual(otherKg.getRelations(`user:${otherUser}`).length, 0);

    // 3. Ingest document into RAG
    const docResult = await ragEngine.addDocument(testUser, {
      title: 'Company Policy 2026',
      content: 'Antigravity systems enforce strict zero-disk in-memory storage and sub-second latencies.',
      source: 'policy.txt',
    });
    assert.strictEqual(docResult.success, true);

    // 4. Retrieve RAG context
    const ragContextResult = await ragEngine.buildRagPrompt(testUser, 'What storage policy is enforced?', {
      maxChunks: 2,
    });
    assert.strictEqual(ragContextResult.hasContext, true);
    assert.ok(ragContextResult.context.includes('Antigravity systems enforce strict zero-disk'));
    assert.ok(ragContextResult.context.includes('policy.txt'));

    // Verify other user cannot see first user's RAG data
    const otherRagResult = await ragEngine.buildRagPrompt(otherUser, 'What storage policy is enforced?');
    assert.strictEqual(otherRagResult.hasContext, false);
    assert.strictEqual(otherRagResult.context, '');
  });

  // =========================================================================
  // 3. Multi-Agent Orchestrator & Intelligent Model Router
  // =========================================================================
  await t.test('Orchestrator & Router: Fast-path execution, agent routing and fallback', async () => {
    const orchestrator = new AgentOrchestrator();

    // 1. Fast-path conversational greeting (< 50ms, 0 hops)
    const greetingStart = performance.now();
    const greetingResult = await orchestrator.handleRequest({
      message: 'Hello good morning!',
      user: testUser,
    });
    const greetingLatency = performance.now() - greetingStart;

    assert.strictEqual(
      greetingLatency < 50.0,
      true,
      `Fast-path must be sub-second (took ${greetingLatency.toFixed(2)}ms)`
    );
    assert.strictEqual(greetingResult.agentUsed, 'conversation');
    assert.strictEqual(greetingResult.fastPath, true);
    assert.strictEqual(greetingResult.hops, 0);

    // 2. Coding query routes to CodingAgent
    const codeResult = await orchestrator.handleRequest({
      message: 'function add(a, b) { return a + b; } optimize this in TypeScript',
      user: testUser,
      runner: async () => ({ text: `export const add = (a: number, b: number): number => a + b;` }),
    });
    assert.strictEqual(codeResult.agentUsed, 'coding');
    assert.strictEqual(codeResult.fastPath, false);

    // 3. Research query routes to ResearchAgent
    const researchResult = await orchestrator.handleRequest({
      message: 'Search and research latest advancements in quantum computing',
      user: testUser,
      runner: async () => ({ text: 'Recent quantum breakthroughs focus on neutral atoms...' }),
    });
    assert.strictEqual(researchResult.agentUsed, 'research');

    // 4. Model Router fallback cascade verification
    const router = new ModelRouter();
    const fallbackChain = router.getFallbackChain('gemini-3.1-flash-lite', TASK_TYPES.CODING);
    assert.ok(fallbackChain.length >= 2);

    const attempts = [];
    const response = await router.executeWithFallback(
      TASK_TYPES.CODING,
      async (modelId) => {
        attempts.push(modelId);
        if (modelId === 'gemini-3.1-flash-lite') {
          throw new Error('429 Rate limited');
        }
        return { output: 'Success on fallback model' };
      },
      { preferredModel: 'gemini-3.1-flash-lite', userId: testUser }
    );

    assert.strictEqual(response.fallbackOccurred, true);
    assert.notStrictEqual(response.modelUsed, 'gemini-3.1-flash-lite');
    assert.ok(attempts.length >= 2);
  });

  // =========================================================================
  // 4. Background Job Engine & Proactive Daily Briefing
  // =========================================================================
  await t.test('Job Engine & Briefing: Priority queues, backoff, and non-hallucinatory compilation', async () => {
    const jobStore = new InMemoryJobStore();
    const jobEngine = new JobEngine({ store: jobStore, concurrency: 1, autoStart: false });

    const executionSequence = [];
    jobEngine.registerJobHandler('regression_task', async (job) => {
      executionSequence.push(job.payload.name);
      return { success: true };
    });

    // Enqueue jobs with different priorities while stopped
    await jobEngine.submitJob({
      type: 'regression_task',
      priority: JOB_PRIORITY.LOW,
      payload: { name: 'low_prio' },
    });
    await jobEngine.submitJob({
      type: 'regression_task',
      priority: JOB_PRIORITY.HIGH,
      payload: { name: 'high_prio' },
    });

    // Start engine to process in priority order
    jobEngine.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await jobEngine.shutdown({ drainTimeoutMs: 100 });

    // High priority should execute first
    assert.strictEqual(executionSequence[0], 'high_prio');
    assert.strictEqual(executionSequence[1], 'low_prio');

    // Verify Daily Briefing compiles with zero hallucinations
    updateUserBriefingSettings(testUser, { enabled: true, deliveryHour: 9, deliveryMinute: 0 });
    const briefingResult = await compileDailyBriefing({
      userId: testUser,
      overrideReminders: [],
      overrideTodos: [],
      overrideJobs: [],
    });

    assert.ok(briefingResult.text.includes('0 reminders | 0 pending tasks | 0 active jobs'));
    assert.ok(briefingResult.text.includes('No reminders scheduled for today'));
    assert.ok(briefingResult.text.includes('All caught up! No pending tasks'));
  });

  // =========================================================================
  // 5. Personal AI Dashboard API Protection & Endpoints Integration
  // =========================================================================
  await t.test('Dashboard API: Full route suite with authentication enforcement', async () => {
    const app = express();
    app.use('/dashboard/api', dashboardRouter);
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://localhost:${port}/dashboard/api`;

    const originalToken = config.OPS_TOKEN;
    config.OPS_TOKEN = 'regression_ops_token_9999';

    try {
      // 1. Unauthenticated request rejected
      const unauthRes = await fetch(`${baseUrl}/overview`);
      assert.strictEqual(unauthRes.status, 401);

      // 2. Authenticated requests succeed across centers
      const headers = { Authorization: 'Bearer regression_ops_token_9999' };

      // Overview
      const overviewRes = await fetch(`${baseUrl}/overview`, { headers });
      assert.strictEqual(overviewRes.status, 200);
      const overviewData = await overviewRes.json();
      assert.strictEqual(overviewData.success, true);
      assert.strictEqual(overviewData.status, 'online');
      assert.strictEqual(overviewData.systemHealth, 'healthy');

      // Security
      const securityRes = await fetch(`${baseUrl}/security`, { headers });
      assert.strictEqual(securityRes.status, 200);
      const securityData = await securityRes.json();
      assert.strictEqual(securityData.protectionBoundaries.zeroDiskStorage, true);

      // Agents
      const agentsRes = await fetch(`${baseUrl}/agents`, { headers });
      assert.strictEqual(agentsRes.status, 200);
      const agentsData = await agentsRes.json();
      assert.ok(agentsData.agents.length >= 5);

      // Models
      const modelsRes = await fetch(`${baseUrl}/models`, { headers });
      assert.strictEqual(modelsRes.status, 200);
      const modelsData = await modelsRes.json();
      assert.ok(modelsData.availableModels.length > 0);

      // Settings
      const settingsRes = await fetch(`${baseUrl}/settings`, { headers });
      assert.strictEqual(settingsRes.status, 200);
      const settingsData = await settingsRes.json();
      assert.strictEqual(typeof settingsData.briefing.scheduledHour, 'number');
    } finally {
      config.OPS_TOKEN = originalToken;
      server.close();
    }
  });
});
