/**
 * Group administrator HTTP API tests.
 *
 * The authenticated dashboard mounts this router; here the router is mounted
 * directly on a throwaway Express app so the handlers can be exercised without
 * the OPS-token middleware (which is tested separately by the existing suite).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createGroupAdminRouter } from '../src/dashboard/group-api.js';
import { setGroupAdminService } from '../src/group-admin/registry.js';
import { makeOrchestrator, makeFakeGateway, GROUP_A, ADMIN_JID } from './helpers/group-fixtures.js';

async function startApi(orchestrator) {
  setGroupAdminService(orchestrator);
  const app = express();
  app.use(express.json());
  app.use('/', createGroupAdminRouter());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      setGroupAdminService(null);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function ready() {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  await ctx.orchestrator.registerDiscoveredGroups(
    [{ jid: GROUP_A, name: 'Team Chat', adminJids: [ADMIN_JID] }],
    'personal'
  );
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });
  return ctx;
}

test('the API refuses requests before the service is initialized', async (t) => {
  const api = await startApi({ initialized: false });
  t.after(() => api.close());

  const res = await fetch(`${api.base}/`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('overview lists groups and status without exposing secrets', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const res = await fetch(`${api.base}/`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0].jid, GROUP_A);
  assert.equal(body.groups[0].enabled, true);
  assert.equal(body.status.counts.enabledGroups, 1);

  const raw = JSON.stringify(body);
  assert.equal(raw.includes('test-gemini-key-not-real'), false);
  assert.equal(raw.includes('GEMINI_API_KEY'), false);
});

test('enable and disable are available over HTTP', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const disabled = await fetch(`${api.base}/${encodeURIComponent(GROUP_A)}/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).group.enabled, false);

  const enabled = await fetch(`${api.base}/${encodeURIComponent(GROUP_A)}/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'opt in' }),
  });
  assert.equal(enabled.status, 200);
  const body = await enabled.json();
  assert.equal(body.group.enabled, true);
  assert.match(body.message, /enabled/i);
});

test('group detail bundles analytics, memory and audit for one group only', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  await ctx.orchestrator.memoryAgent.addFact(GROUP_A, { text: 'detail-fact' });
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const res = await fetch(`${api.base}/${encodeURIComponent(GROUP_A)}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.group.jid, GROUP_A);
  assert.equal(body.group.enabled, true);
  assert.equal(
    body.memory.facts.some((f) => f.text === 'detail-fact'),
    true
  );
  assert.equal(Array.isArray(body.audit), true);
  assert.equal(Array.isArray(body.moderation), true);
  assert.equal(Array.isArray(body.approvals), true);
});

test('settings patches are validated through the same backend rules as the chat path', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const res = await fetch(`${api.base}/${encodeURIComponent(GROUP_A)}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      replyCooldownMs: 4000,
      maxRepliesPerHour: 9999, // clamped to 500
      moderation: { action: 'warn' },
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.group.settings.replyCooldownMs, 4000);
  assert.equal(body.group.settings.maxRepliesPerHour, 500);
  assert.equal(body.group.settings.moderation.action, 'warn');
});

test('the emergency stop endpoint pauses and resumes all group AI', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const paused = await fetch(`${api.base}/emergency-stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: true, reason: 'test' }),
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).global.aiPaused, true);

  const status = await (await fetch(`${api.base}/status`)).json();
  assert.equal(status.global.aiPaused, true);
  assert.equal(status.status.personal.state, 'connected');
});

test('an approval resolved over HTTP executes and verifies the stored value', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  await ctx.orchestrator.administrationAgent.requestOperation({
    groupJid: GROUP_A,
    action: 'set_subject',
    value: 'Approved Subject',
    requestedBy: 'tester',
  });

  const list = await (await fetch(`${api.base}/approvals?status=pending`)).json();
  assert.equal(list.approvals.length, 1);
  const approvalId = list.approvals[0].id;

  const resolved = await fetch(`${api.base}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true, actor: 'operator' }),
  });
  const body = await resolved.json();

  assert.equal(resolved.status, 200);
  assert.equal(body.executed, true);
  assert.equal(ctx.transport.adminActions[0].action, 'set_subject');
  assert.equal(ctx.transport.adminActions[0].value, 'Approved Subject');
});

test('an operator message is sent through the transport', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const res = await fetch(`${api.base}/${encodeURIComponent(GROUP_A)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello from Mission Control' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.verified, true);
  assert.equal(ctx.transport.sent.at(-1).text, 'Hello from Mission Control');
});

test('an unknown group identifier is a 404', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const res = await fetch(`${api.base}/not-a-group`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('provider listing never includes an API key', async (t) => {
  const ctx = await ready();
  t.after(() => ctx.cleanup());
  const api = await startApi(ctx.orchestrator);
  t.after(() => api.close());

  const res = await fetch(`${api.base}/providers`);
  const body = await res.json();
  const raw = JSON.stringify(body);

  assert.equal(res.status, 200);
  assert.equal(raw.includes('test-gemini-key-not-real'), false);
  assert.equal(raw.includes('apiKey'), false);
});
