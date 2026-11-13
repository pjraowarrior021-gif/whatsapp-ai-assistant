import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  recordLastInboundInteraction,
  getLastInboundInteraction,
  isWithinSessionWindow,
  buildTemplateComponents,
  sendProactiveMessage,
  SESSION_WINDOW_MS,
} from '../src/templates.js';
import { store } from '../src/store/index.js';

beforeEach(async () => {
  await store.flushAll();
});

test('Templates: records and retrieves last inbound timestamp', async () => {
  const user = '919876543210';
  const now = 1700000000000;

  await recordLastInboundInteraction(user, now);
  const retrieved = await getLastInboundInteraction(user);
  assert.strictEqual(retrieved, now);

  const missing = await getLastInboundInteraction('unknown_user');
  assert.strictEqual(missing, null);
});

test('Templates: evaluates 24-hour customer service window accurately', async () => {
  const user = '919999888877';
  const baseTime = 1700000000000;

  await recordLastInboundInteraction(user, baseTime);

  // 1 hour later => within 24h window
  assert.strictEqual(await isWithinSessionWindow(user, SESSION_WINDOW_MS, baseTime + 3600 * 1000), true);

  // 23 hours later => within 24h window
  assert.strictEqual(await isWithinSessionWindow(user, SESSION_WINDOW_MS, baseTime + 23 * 3600 * 1000), true);

  // Exactly 24 hours later => within window boundary
  assert.strictEqual(await isWithinSessionWindow(user, SESSION_WINDOW_MS, baseTime + 24 * 3600 * 1000), true);

  // 25 hours later => outside window
  assert.strictEqual(await isWithinSessionWindow(user, SESSION_WINDOW_MS, baseTime + 25 * 3600 * 1000), false);

  // Unknown user => outside window
  assert.strictEqual(await isWithinSessionWindow('never_seen_user'), false);
});

test('Templates: buildTemplateComponents formats parameters correctly', () => {
  const empty = buildTemplateComponents([]);
  assert.deepStrictEqual(empty, []);

  const arrayParams = buildTemplateComponents(['Reminder: Team sync', '10:00 AM']);
  assert.deepStrictEqual(arrayParams, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Reminder: Team sync' },
        { type: 'text', text: '10:00 AM' },
      ],
    },
  ]);

  const objParams = buildTemplateComponents({ title: 'Standup', time: '9:30' });
  assert.deepStrictEqual(objParams, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Standup' },
        { type: 'text', text: '9:30' },
      ],
    },
  ]);
});

test('Templates: sendProactiveMessage delivers session message within 24h window', async () => {
  const user = '910000000000'; // test phone bypass
  await recordLastInboundInteraction(user, Date.now());

  const res = await sendProactiveMessage(user, {
    text: 'Your daily briefing is ready!',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.channel, 'session');
  assert.ok(res.messageId);
});

test('Templates: sendProactiveMessage falls back to template outside 24h window', async () => {
  const user = '910000000000'; // test phone bypass
  // Set last seen to 48 hours ago
  await recordLastInboundInteraction(user, Date.now() - 48 * 3600 * 1000);

  const res = await sendProactiveMessage(user, {
    text: 'Reminder: Project review today',
    templateName: 'utility_reminder_notification',
    templateParams: ['Project review today'],
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.channel, 'template');
  assert.ok(res.messageId);
});
