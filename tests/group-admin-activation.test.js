/**
 * Activation, persistence and cross-group isolation.
 *
 * These are the security-critical invariants: nothing is enabled implicitly,
 * disabled groups never reach an agent, the emergency stop wins over every
 * per-group setting, and memory cannot cross a group boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOrchestrator, makeFakeTransport, GROUP_A, GROUP_B } from './helpers/group-fixtures.js';

async function discover(ctx, jid, name) {
  return ctx.orchestrator.registerDiscoveredGroups([{ jid, name }], 'personal');
}

test('a newly discovered group is always disabled', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  const result = await discover(ctx, GROUP_A, 'Team Chat');
  assert.equal(result.discovered, 1);

  const group = ctx.orchestrator.activation.getGroup(GROUP_A);
  assert.equal(group.enabled, false);
  assert.equal(group.discoveredAt.length > 0, true);
  assert.equal(group.enabledAt, null);

  const auth = ctx.orchestrator.security.authorizeInbound({ groupJid: GROUP_A });
  assert.equal(auth.allowed, false);
  assert.equal(auth.reason, 'group_disabled');
});

test('discovering the same group twice does not create a duplicate or enable it', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'First name');
  const second = await discover(ctx, GROUP_A, 'Renamed');
  assert.equal(second.discovered, 0);
  assert.equal(ctx.orchestrator.activation.listGroups().length, 1);
  assert.equal(ctx.orchestrator.activation.getGroup(GROUP_A).name, 'Renamed');
  assert.equal(ctx.orchestrator.activation.isEnabled(GROUP_A), false);
});

test('explicit enable then disable is honoured by the backend gate', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'Team Chat');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester', reason: 'opt in' });

  const enabled = ctx.orchestrator.activation.getGroup(GROUP_A);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.enabledBy, 'tester');
  assert.equal(ctx.orchestrator.security.authorizeInbound({ groupJid: GROUP_A }).allowed, true);

  await ctx.orchestrator.disableGroup(GROUP_A, { actor: 'tester' });
  assert.equal(ctx.orchestrator.activation.isEnabled(GROUP_A), false);
  assert.equal(ctx.orchestrator.security.authorizeInbound({ groupJid: GROUP_A }).reason, 'group_disabled');
});

test('the global emergency stop overrides an enabled group', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'Team Chat');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });

  await ctx.orchestrator.emergencyStop(true, { actor: 'tester', reason: 'drill' });
  assert.equal(ctx.orchestrator.activation.isGloballyPaused(), true);
  const auth = ctx.orchestrator.security.authorizeInbound({ groupJid: GROUP_A });
  assert.equal(auth.allowed, false);
  assert.equal(auth.reason, 'global_pause');

  await ctx.orchestrator.emergencyStop(false, { actor: 'tester' });
  assert.equal(ctx.orchestrator.security.authorizeInbound({ groupJid: GROUP_A }).allowed, true);
});

test('messages timestamped before activation are rejected', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'Team Chat');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });
  const enabledAt = Date.parse(ctx.orchestrator.activation.getGroup(GROUP_A).enabledAt);

  const backlog = ctx.orchestrator.security.authorizeInbound({
    groupJid: GROUP_A,
    timestampMs: enabledAt - 5000,
  });
  assert.equal(backlog.allowed, false);
  assert.equal(backlog.reason, 'before_activation');

  const fresh = ctx.orchestrator.security.authorizeInbound({
    groupJid: GROUP_A,
    timestampMs: enabledAt + 5000,
  });
  assert.equal(fresh.allowed, true);
});

test('history import can be explicitly opted in per group', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'Team Chat');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });
  await ctx.orchestrator.updateGroupSettings(GROUP_A, { processPreActivationHistory: true }, { actor: 'tester' });
  const enabledAt = Date.parse(ctx.orchestrator.activation.getGroup(GROUP_A).enabledAt);

  const backlog = ctx.orchestrator.security.authorizeInbound({ groupJid: GROUP_A, timestampMs: enabledAt - 5000 });
  assert.equal(backlog.allowed, true);
});

test('activation survives a restart (persisted to disk)', async (t) => {
  const first = await makeOrchestrator();
  t.after(() => first.cleanup());

  await discover(first, GROUP_A, 'Team Chat');
  await first.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });
  await first.orchestrator.emergencyStop(true, { actor: 'tester', reason: 'persisted pause' });
  await first.orchestrator.shutdown();

  const second = await makeOrchestrator({ dir: first.dir, transport: makeFakeTransport() });
  assert.equal(second.orchestrator.activation.isEnabled(GROUP_A), true);
  assert.equal(second.orchestrator.activation.isGloballyPaused(), true);
  await second.orchestrator.shutdown();
});

test('invalid identifiers are rejected everywhere', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  assert.equal(ctx.orchestrator.security.authorizeInbound({ groupJid: 'not-a-group' }).reason, 'invalid_group_id');
  await assert.rejects(() => ctx.orchestrator.enableGroup('not-a-group'), /Invalid group identifier/);
  const skipped = await ctx.orchestrator.registerDiscoveredGroups([{ jid: 'user@s.whatsapp.net' }], 'personal');
  assert.equal(skipped.discovered, 0);
  assert.equal(ctx.orchestrator.activation.listGroups().length, 0);
});

test('a group name is never used as its identity', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  // Two distinct groups may share a display name; they remain separate.
  await discover(ctx, GROUP_A, 'Same Name');
  await discover(ctx, GROUP_B, 'Same Name');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });

  assert.equal(ctx.orchestrator.activation.listGroups().length, 2);
  assert.equal(ctx.orchestrator.activation.isEnabled(GROUP_A), true);
  assert.equal(ctx.orchestrator.activation.isEnabled(GROUP_B), false);
});

test('group memory is structurally isolated', async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'Group A');
  await discover(ctx, GROUP_B, 'Group B');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });
  await ctx.orchestrator.enableGroup(GROUP_B, { actor: 'tester' });

  await ctx.orchestrator.memoryAgent.addFact(GROUP_A, { text: 'alpha-only-secret', category: 'test' });
  await ctx.orchestrator.memoryAgent.addFact(GROUP_B, { text: 'beta-only-secret', category: 'test' });

  const memoryA = ctx.orchestrator.memoryAgent.getMemory(GROUP_A);
  const memoryB = ctx.orchestrator.memoryAgent.getMemory(GROUP_B);
  assert.equal(
    memoryA.facts.some((f) => f.text === 'alpha-only-secret'),
    true
  );
  assert.equal(
    memoryA.facts.some((f) => f.text === 'beta-only-secret'),
    false
  );
  assert.equal(
    memoryB.facts.some((f) => f.text === 'beta-only-secret'),
    true
  );
  assert.equal(
    memoryB.facts.some((f) => f.text === 'alpha-only-secret'),
    false
  );

  // Context building is also scoped to a single group.
  assert.equal(ctx.orchestrator.memoryAgent.getContext(GROUP_A).includes('beta-only-secret'), false);
});

test("deleting one group's data leaves other groups intact", async (t) => {
  const ctx = await makeOrchestrator();
  t.after(() => ctx.cleanup());

  await discover(ctx, GROUP_A, 'Group A');
  await discover(ctx, GROUP_B, 'Group B');
  await ctx.orchestrator.enableGroup(GROUP_A, { actor: 'tester' });
  await ctx.orchestrator.enableGroup(GROUP_B, { actor: 'tester' });
  await ctx.orchestrator.memoryAgent.addFact(GROUP_A, { text: 'delete-me', category: 'test' });
  await ctx.orchestrator.memoryAgent.addFact(GROUP_B, { text: 'keep-me', category: 'test' });

  await ctx.orchestrator.deleteGroupData(GROUP_A, { actor: 'tester' });

  assert.equal(ctx.orchestrator.memoryAgent.getMemory(GROUP_A).facts.length, 0);
  assert.equal(
    ctx.orchestrator.memoryAgent.getMemory(GROUP_B).facts.some((f) => f.text === 'keep-me'),
    true
  );
});
