import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReminderTime, scheduleReminder, listReminders, deleteReminder, stopReminders } from '../src/reminders.js';

test('Reminders: parseReminderTime parses relative offsets accurately', () => {
  const baseTime = new Date('2026-11-08T12:00:00.000Z');

  // 15 minutes
  const r15m = parseReminderTime('15m', baseTime);
  assert.ok(r15m);
  assert.strictEqual(r15m.targetTimeMs, baseTime.getTime() + 15 * 60 * 1000);

  // 2 hours
  const r2h = parseReminderTime('2h', baseTime);
  assert.ok(r2h);
  assert.strictEqual(r2h.targetTimeMs, baseTime.getTime() + 2 * 60 * 60 * 1000);

  // 1 day
  const r1d = parseReminderTime('1d', baseTime);
  assert.ok(r1d);
  assert.strictEqual(r1d.targetTimeMs, baseTime.getTime() + 24 * 60 * 60 * 1000);

  // 30 seconds
  const r30s = parseReminderTime('30s', baseTime);
  assert.ok(r30s);
  assert.strictEqual(r30s.targetTimeMs, baseTime.getTime() + 30 * 1000);
});

test('Reminders: parseReminderTime handles absolute 24h time and future rollover', () => {
  const now = new Date('2026-11-08T10:00:00.000');

  // Later today (14:30)
  const laterToday = parseReminderTime('14:30', now);
  assert.ok(laterToday);
  const laterDate = new Date(laterToday.targetTimeMs);
  assert.strictEqual(laterDate.getHours(), 14);
  assert.strictEqual(laterDate.getMinutes(), 30);
  assert.strictEqual(laterDate.getDate(), now.getDate());

  // Earlier today (08:00) should roll over to tomorrow
  const tomorrow = parseReminderTime('08:00', now);
  assert.ok(tomorrow);
  const tomorrowDate = new Date(tomorrow.targetTimeMs);
  assert.strictEqual(tomorrowDate.getHours(), 8);
  assert.strictEqual(tomorrowDate.getMinutes(), 0);
  assert.strictEqual(tomorrowDate.getDate(), now.getDate() + 1);
});

test('Reminders: parseReminderTime handles DD-MM-YYYY HH:MM date format', () => {
  const now = new Date('2026-11-08T10:00:00.000');
  const future = parseReminderTime('25-12-2026 09:30', now);
  assert.ok(future);
  const fDate = new Date(future.targetTimeMs);
  assert.strictEqual(fDate.getFullYear(), 2026);
  assert.strictEqual(fDate.getMonth(), 11); // December is month index 11
  assert.strictEqual(fDate.getDate(), 25);
  assert.strictEqual(fDate.getHours(), 9);
  assert.strictEqual(fDate.getMinutes(), 30);

  // Past date rejected
  const past = parseReminderTime('01-01-2020 12:00', now);
  assert.strictEqual(past, null);

  // Garbage input rejected
  assert.strictEqual(parseReminderTime('whenever you can', now), null);
  assert.strictEqual(parseReminderTime('', now), null);
});

test('Reminders: scheduleReminder, listReminders, and deleteReminder lifecycle', (_t) => {
  stopReminders();
  const testUser = 'u_rem_test_user';
  const testPhone = '910000000000';

  // Schedule a reminder
  const res = scheduleReminder(testPhone, testUser, '30m', 'Submit expense report');
  assert.strictEqual(res.success, true);
  assert.ok(res.reminder?.id);
  assert.ok(res.message.includes('Reminder Scheduled'));

  // List active reminders
  const listText = listReminders(testUser);
  assert.ok(listText.includes('Submit expense report'));
  assert.ok(listText.includes(res.reminder.id));

  // Cancel / Delete reminder
  const delRes = deleteReminder(testUser, res.reminder.id);
  assert.strictEqual(delRes.success, true);
  assert.ok(delRes.message.includes('cancelled') || delRes.message.includes('deleted'));

  // List again - should be empty
  const emptyList = listReminders(testUser);
  assert.ok(emptyList.includes('no scheduled reminders'));

  stopReminders();
});
