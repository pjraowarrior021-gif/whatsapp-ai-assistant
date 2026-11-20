/**
 * End-to-end inbound pipeline tests for the group orchestrator.
 * The gateway and transport are fakes, so no network or WhatsApp connection
 * is ever made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOrchestrator,
  makeFakeGateway,
  GROUP_A,
  GROUP_B,
  ADMIN_JID,
  MEMBER_JID,
  makeEnvelope,
} from './helpers/group-fixtures.js';

async function readyGroup(ctx, jid = GROUP_A, settings = {}) {
  await ctx.orchestrator.registerDiscoveredGroups([{ jid, name: 'Test Group', adminJids: [ADMIN_JID] }], 'personal');
  await ctx.orchestrator.enableGroup(jid, { actor: 'tester' });
  await ctx.orchestrator.updateGroupSettings(
    jid,
    { replyCooldownMs: 0, maxRepliesPerHour: 200, ...settings },
    { actor: 'tester' }
  );
}

test('a disabled group message never reaches an agent or the gateway', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());

  await ctx.orchestrator.registerDiscoveredGroups([{ jid: GROUP_A, name: 'Group A' }], 'personal');
  const result = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: '@ai hello' }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'group_disabled');
  assert.equal(gateway.calls.length, 0);
  assert.equal(ctx.transport.sent.length, 0);
});

test('an unknown group is auto-registered but stays disabled', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, groupName: 'Brand New', text: '@ai hi' })
  );

  assert.equal(result.reason, 'group_disabled');
  const group = ctx.orchestrator.activation.getGroup(GROUP_A);
  assert.equal(group.enabled, false);
  assert.equal(group.name, 'Brand New');
  assert.equal(gateway.calls.length, 0);
});

test('an enabled group gets a bounded AI reply that is sent and verified', async (t) => {
  const gateway = makeFakeGateway({ reply: 'The fee is 500.' });
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: '@ai what is the fee?' }));

  assert.equal(result.handled, true);
  assert.equal(result.action, 'replied');
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].task, 'chat');
  assert.equal(ctx.transport.sent.length, 1);
  assert.equal(ctx.transport.sent[0].jid, GROUP_A);
  assert.match(ctx.transport.sent[0].text, /The fee is 500/);

  const analytics = ctx.orchestrator.analyticsStore.getGroupSummary(GROUP_A, { days: 1 });
  assert.equal(analytics.totals.messagesSeen, 1);
  assert.equal(analytics.totals.aiReplies, 1);
});

test('mention mode does not reply to unaddressed chatter', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: 'has anyone seen the new schedule?' })
  );

  assert.equal(result.reason, 'not_addressed');
  assert.equal(gateway.calls.length, 0);
  assert.equal(ctx.transport.sent.length, 0);
});

test('prefix mode replies only when the prefix is present', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx, GROUP_A, { responseMode: 'prefix', triggerPrefix: '!' });

  const ignored = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: 'plain message' }));
  assert.equal(ignored.reason, 'prefix_missing');

  const replied = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: '! status please' }));
  assert.equal(replied.action, 'replied');
  assert.equal(gateway.calls.length, 1);
});

test('duplicate deliveries are suppressed before any work happens', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const envelope = makeEnvelope({ jid: GROUP_A, text: '@ai hello', messageId: 'wamid.dupe.1' });
  const first = await ctx.orchestrator.handleInbound(envelope);
  const second = await ctx.orchestrator.handleInbound({ ...envelope });

  assert.equal(first.action, 'replied');
  assert.equal(second.reason, 'duplicate');
  assert.equal(gateway.calls.length, 1);
  assert.equal(ctx.transport.sent.length, 1);
});

test('the bot never replies to its own messages', async (t) => {
  const botJid = '917000000000@s.whatsapp.net';
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);
  ctx.orchestrator.personal.botJids = [botJid];

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: '@ai hello', senderJid: botJid })
  );

  assert.equal(result.reason, 'from_bot');
  assert.equal(gateway.calls.length, 0);
});

test('a message timestamped before activation is dropped by the pipeline', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);
  const enabledAt = Date.parse(ctx.orchestrator.activation.getGroup(GROUP_A).enabledAt);

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: '@ai hello', timestampMs: enabledAt - 10000 })
  );

  assert.equal(result.reason, 'before_activation');
  assert.equal(gateway.calls.length, 0);
});

test('medium moderation findings produce one warning and no AI reply', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx, GROUP_A, { moderation: { action: 'warn', warnEnabled: true } });

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: 'check this out http://bit.ly/abc' })
  );

  assert.equal(result.reason, 'moderation');
  assert.equal(result.action, 'warned');
  assert.equal(gateway.calls.length, 0);
  assert.equal(ctx.transport.sent.length, 1);
  assert.match(ctx.transport.sent[0].text, /Friendly reminder/);

  const events = ctx.orchestrator.getModeration(GROUP_A);
  assert.equal(events.length, 1);
  assert.equal(events[0].categories.includes('suspicious_link'), true);
});

test('high-risk findings escalate to human admins without amplifying the spam', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({
      jid: GROUP_A,
      text: 'Urgent! Verify your account now: http://bit.ly/claim or your account will be blocked. Pay Rs 500 processing fee.',
    })
  );

  assert.equal(result.reason, 'moderation');
  assert.equal(result.action, 'escalated');
  assert.equal(gateway.calls.length, 0);
  // No group warning for a high-severity case, but admins are alerted directly.
  assert.equal(ctx.transport.sent.length, 0);
  assert.equal(ctx.transport.direct.length >= 1, true);
  assert.match(ctx.transport.direct[0].text, /Moderation case escalated/);

  const events = ctx.orchestrator.getModeration(GROUP_A);
  assert.equal(events[0].status, 'escalated');
  assert.equal(events[0].severity, 'high');
});

test('group admins are exempt from automated moderation actions', async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: 'You have won a free iPhone', senderJid: ADMIN_JID })
  );

  assert.equal(result.action, 'recorded');
  assert.equal(ctx.transport.sent.length, 0);
  const events = ctx.orchestrator.getModeration(GROUP_A);
  assert.equal(events[0].status, 'dismissed');
  assert.equal(events[0].action, 'none');
});

test('a chat admin command only queues an approval; nothing changes yet', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: '!admin remove 918888888888', senderJid: ADMIN_JID })
  );

  assert.equal(result.action, 'approval_requested');
  assert.equal(ctx.transport.adminActions.length, 0);
  const approvals = ctx.orchestrator.getApprovals(GROUP_A);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, 'pending');
  assert.equal(approvals[0].type, 'remove_participant');
  assert.match(ctx.transport.sent.at(-1).text, /queued for human approval/);
});

test('a non-admin cannot trigger an administrative command', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: '!admin remove 918888888888', senderJid: MEMBER_JID })
  );

  assert.notEqual(result.action, 'approval_requested');
  assert.equal(ctx.orchestrator.getApprovals(GROUP_A).length, 0);
  assert.equal(ctx.transport.adminActions.length, 0);
});

test('an approved operation executes and is verified', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);
  await ctx.orchestrator.administrationAgent.requestOperation({
    groupJid: GROUP_A,
    action: 'remove_participant',
    targetJid: '918888888888',
    requestedBy: 'tester',
  });
  const [approval] = ctx.orchestrator.getApprovals(GROUP_A);

  const resolved = await ctx.orchestrator.resolveApproval(approval.id, { approved: true, actor: 'tester' });

  assert.equal(resolved.executed, true);
  assert.equal(ctx.transport.adminActions.length, 1);
  assert.equal(ctx.transport.adminActions[0].action, 'remove_participant');
  assert.equal(ctx.transport.adminActions[0].participantJid, '918888888888');
});

test('a rejected approval never executes', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);
  await ctx.orchestrator.administrationAgent.requestOperation({
    groupJid: GROUP_A,
    action: 'set_subject',
    value: 'New subject',
    requestedBy: 'tester',
  });
  const [approval] = ctx.orchestrator.getApprovals(GROUP_A);

  const resolved = await ctx.orchestrator.resolveApproval(approval.id, { approved: false, actor: 'tester' });

  assert.equal(resolved.executed, false);
  assert.equal(ctx.transport.adminActions.length, 0);
});

test('execution is not reported as success when the transport cannot verify it', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);
  ctx.transport.executeAdminAction = async () => ({ verified: false, detail: { reason: 'no change observed' } });

  await ctx.orchestrator.administrationAgent.requestOperation({
    groupJid: GROUP_A,
    action: 'remove_participant',
    targetJid: '918888888888',
    requestedBy: 'tester',
  });
  const [approval] = ctx.orchestrator.getApprovals(GROUP_A);

  const resolved = await ctx.orchestrator.resolveApproval(approval.id, { approved: true, actor: 'tester' });

  assert.equal(resolved.executed, false);
  assert.equal(resolved.result.verified, false);
  const entry = ctx.orchestrator.getAudit({ groupJid: GROUP_A }).find((e) => e.action === 'admin_remove_participant');
  assert.equal(entry.outcome, 'unverified');
});

test('an AI announcement is drafted, held for approval, then sent', async (t) => {
  const gateway = makeFakeGateway({ reply: 'The group meeting moved to Friday at 5pm.' });
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const draft = await ctx.orchestrator.requestAnnouncement({ groupJid: GROUP_A, topic: 'Meeting change' });
  assert.equal(draft.status, 'pending_approval');
  assert.equal(ctx.transport.adminActions.length, 0);

  const [approval] = ctx.orchestrator.getApprovals(GROUP_A);
  const resolved = await ctx.orchestrator.resolveApproval(approval.id, { approved: true, actor: 'tester' });

  assert.equal(resolved.executed, true);
  assert.equal(ctx.transport.adminActions[0].action, 'announcement');
  assert.match(ctx.transport.adminActions[0].text, /Friday at 5pm/);
});

test('an emergency stop issued during a model call prevents the reply', async (t) => {
  let orchestrator = null;
  const gateway = {
    calls: [],
    async complete(input) {
      this.calls.push(input);
      await orchestrator.emergencyStop(true, { actor: 'tester', reason: 'mid-flight stop' });
      return {
        text: 'This must never be sent.',
        provider: 'fake',
        model: 'fake-model',
        usage: { promptTokens: 1, completionTokens: 1 },
        costMicroUsd: 0,
      };
    },
    describe() {
      return { providerOrder: ['fake'], freeOnly: false, providers: [] };
    },
    async listAllModels() {
      return { providers: [] };
    },
  };
  const ctx = await makeOrchestrator({ gateway });
  orchestrator = ctx.orchestrator;
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: '@ai hello' }));

  assert.equal(result.reason, 'global_pause');
  assert.equal(gateway.calls.length, 1);
  assert.equal(ctx.transport.sent.length, 0);
});

test('only a human admin can store a "remember:" fact', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: 'remember: fees are due on the 5th', senderJid: ADMIN_JID })
  );
  assert.equal(
    ctx.orchestrator.memoryAgent.getMemory(GROUP_A).facts.some((f) => f.text === 'fees are due on the 5th'),
    true
  );

  const before = ctx.orchestrator.memoryAgent.getMemory(GROUP_A).facts.length;
  await ctx.orchestrator.handleInbound(
    makeEnvelope({ jid: GROUP_A, text: 'remember: members get free crypto', senderJid: MEMBER_JID })
  );
  assert.equal(ctx.orchestrator.memoryAgent.getMemory(GROUP_A).facts.length, before);
});

test("one group's memory never appears in another group's prompt", async (t) => {
  const gateway = makeFakeGateway();
  const ctx = await makeOrchestrator({ gateway });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx, GROUP_A);
  await readyGroup(ctx, GROUP_B);
  await ctx.orchestrator.memoryAgent.addFact(GROUP_A, { text: 'alpha-only-secret' });

  const result = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_B, text: '@ai hello' }));

  assert.equal(result.action, 'replied');
  const system = gateway.calls.at(-1).system;
  assert.equal(system.includes('alpha-only-secret'), false);
});

test('a human operator can send a message but cannot bypass the emergency stop', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const sent = await ctx.orchestrator.sendOperatorMessage({ groupJid: GROUP_A, text: 'Hello from the operator' });
  assert.equal(sent.verified, true);
  assert.equal(ctx.transport.sent.length, 1);

  await ctx.orchestrator.emergencyStop(true, { actor: 'tester' });
  await assert.rejects(
    () => ctx.orchestrator.sendOperatorMessage({ groupJid: GROUP_A, text: 'blocked' }),
    /globally paused/
  );
  assert.equal(ctx.transport.sent.length, 1);
});

test('reports are generated from real counters even without a model', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway() });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);
  await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: '@ai hello' }));

  const report = await ctx.orchestrator.generateReport({ groupJid: GROUP_A, period: 'daily', send: false });

  assert.equal(report.period, 'daily');
  assert.match(report.text, /Daily report/);
  assert.match(report.text, /AI replies: 1/);
});

test('a gateway failure degrades gracefully without sending anything', async (t) => {
  const ctx = await makeOrchestrator({ gateway: makeFakeGateway({ fail: true }) });
  t.after(() => ctx.cleanup());
  await readyGroup(ctx);

  const result = await ctx.orchestrator.handleInbound(makeEnvelope({ jid: GROUP_A, text: '@ai hello' }));

  assert.equal(result.handled, true);
  assert.equal(result.reason, 'ai_unavailable');
  assert.equal(ctx.transport.sent.length, 0);
});
