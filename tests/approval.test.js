import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  requestActionApproval,
  getPendingApproval,
  resolveApproval,
  cancelPendingApproval,
  setHumanHandoff,
  isHumanHandoffActive,
  clearHumanHandoff,
  listActiveHandoffs,
} from '../src/approval.js';
import { store } from '../src/store/index.js';

beforeEach(async () => {
  await store.flushAll();
});

test('Approval: requestActionApproval creates durable pending record with buttons', async () => {
  const userId = 'user_approval_1';
  const req = await requestActionApproval(userId, {
    type: 'delete_reminder',
    description: 'Delete reminder "Doctor Appointment"',
    payload: { reminderId: 'rem_123' },
  });

  assert.ok(req.actionId.startsWith('act_'));
  assert.ok(req.promptText.includes('Delete reminder "Doctor Appointment"'));
  assert.strictEqual(req.buttons.length, 2);
  assert.strictEqual(req.buttons[0].id, `approve_action_${req.actionId}`);

  const pending = await getPendingApproval(userId);
  assert.ok(pending);
  assert.strictEqual(pending.actionId, req.actionId);
  assert.strictEqual(pending.type, 'delete_reminder');
});

test('Approval: resolveApproval resolves affirmative confirmation via text and button', async () => {
  const userId = 'user_approval_2';
  const req = await requestActionApproval(userId, {
    type: 'send_mass_broadcast',
    description: 'Broadcast message to 50 users',
  });

  // Test button click
  const resBtn = await resolveApproval(userId, `approve_action_${req.actionId}`);
  assert.strictEqual(resBtn.hasPending, true);
  assert.strictEqual(resBtn.resolved, true);
  assert.strictEqual(resBtn.approved, true);

  // Key should now be cleared
  const pendingAfter = await getPendingApproval(userId);
  assert.strictEqual(pendingAfter, null);

  // Test text confirmation 'yes'
  await requestActionApproval(userId, {
    type: 'format_disk',
    description: 'Format memory database',
  });
  const resText = await resolveApproval(userId, 'yes, please confirm');
  assert.strictEqual(resText.resolved, true);
  assert.strictEqual(resText.approved, true);
});

test('Approval: resolveApproval resolves negative denial via text and button', async () => {
  const userId = 'user_approval_3';
  const req = await requestActionApproval(userId, {
    type: 'delete_account',
    description: 'Permanently delete user data',
  });

  const resDeny = await resolveApproval(userId, `deny_action_${req.actionId}`);
  assert.strictEqual(resDeny.hasPending, true);
  assert.strictEqual(resDeny.resolved, true);
  assert.strictEqual(resDeny.approved, false);
  assert.ok(resDeny.message.includes('cancelled'));

  const pendingAfter = await getPendingApproval(userId);
  assert.strictEqual(pendingAfter, null);
});

test('Approval: resolveApproval prompts user on ambiguous responses', async () => {
  const userId = 'user_approval_4';
  await requestActionApproval(userId, {
    type: 'restart_service',
    description: 'Restart background worker',
  });

  const resAmbiguous = await resolveApproval(userId, 'what happens if I do?');
  assert.strictEqual(resAmbiguous.hasPending, true);
  assert.strictEqual(resAmbiguous.resolved, false);
  assert.ok(resAmbiguous.message.includes('Confirmation Pending'));

  // Pending approval should remain active
  const pending = await getPendingApproval(userId);
  assert.ok(pending);
});

test('Approval: cancelPendingApproval removes record cleanly', async () => {
  const userId = 'user_approval_5';
  await requestActionApproval(userId, {
    type: 'test_action',
    description: 'Test action',
  });

  await cancelPendingApproval(userId);
  const pending = await getPendingApproval(userId);
  assert.strictEqual(pending, null);
});

test('Approval: Human handoff toggle pauses and resumes bot automation', async () => {
  const userId = 'user_handoff_1';

  assert.strictEqual(await isHumanHandoffActive(userId), false);

  await setHumanHandoff(userId, true, 'Customer requested billing agent', 'op_42');
  assert.strictEqual(await isHumanHandoffActive(userId), true);

  const activeList = await listActiveHandoffs();
  assert.strictEqual(activeList.length, 1);
  assert.strictEqual(activeList[0].userId, userId);
  assert.strictEqual(activeList[0].operatorId, 'op_42');

  await clearHumanHandoff(userId);
  assert.strictEqual(await isHumanHandoffActive(userId), false);

  const emptyList = await listActiveHandoffs();
  assert.strictEqual(emptyList.length, 0);
});
