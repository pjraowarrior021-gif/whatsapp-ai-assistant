import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileDailyBriefing,
  getUserBriefingSettings,
  updateUserBriefingSettings,
  isInQuietHours,
  isBriefingDue,
  recordBriefingDelivered,
  handleBriefingCommand,
  initBriefingScheduler,
  stopBriefingScheduler,
  resetBriefingState,
  registerBriefingUser,
} from '../src/briefing.js';

test.beforeEach(() => {
  resetBriefingState();
});

test.afterEach(() => {
  stopBriefingScheduler();
  resetBriefingState();
});

test('Briefing: empty state produces zero hallucinated events with clear status', async () => {
  const result = await compileDailyBriefing({
    userId: 'user_empty_test',
    overrideReminders: [],
    overrideTodos: [],
    overrideJobs: [],
  });

  assert.match(result.text, /Daily Snapshot:\* 0 reminders \| 0 pending tasks \| 0 active jobs/);
  assert.match(result.text, /No reminders scheduled for today/);
  assert.match(result.text, /All caught up! No pending tasks/);
  assert.match(result.text, /No background jobs currently running/);
  assert.match(result.text, /Your schedule is clear and all tasks are complete/);

  assert.equal(result.structured.stats.remindersCount, 0);
  assert.equal(result.structured.stats.todosCount, 0);
  assert.equal(result.structured.stats.jobsCount, 0);
});

test('Briefing: accurately formats explicit reminders, todos, and background jobs', async () => {
  const mockReminders = [
    { id: 'rem_1', time: '10:00 AM', relative: 'in ~1h', text: 'Quarterly team sync' },
    { id: 'rem_2', time: '02:30 PM', relative: 'in ~5h', text: 'Call vendor for invoice' },
  ];

  const mockTodos = [
    { id: 'td_1', text: 'Finish security audit report', completed: false, createdAt: Date.now() },
    { id: 'td_2', text: 'Review PR #42', completed: false, createdAt: Date.now() },
  ];

  const mockJobs = [
    { id: 'job_101', type: 'deep_research', priority: 'high', status: 'running', progress: 45 },
    { id: 'job_102', type: 'doc_index', priority: 'normal', status: 'queued', progress: 0 },
  ];

  const result = await compileDailyBriefing({
    userId: 'user_populated_test',
    overrideReminders: mockReminders,
    overrideTodos: mockTodos,
    overrideJobs: mockJobs,
  });

  assert.match(result.text, /Daily Snapshot:\* 2 reminders \| 2 pending tasks \| 2 active jobs/);
  assert.match(result.text, /`rem_1`[\s\S]*Quarterly team sync/);
  assert.match(result.text, /`rem_2`[\s\S]*Call vendor for invoice/);
  assert.match(result.text, /`td_1`\*: Finish security audit report/);
  assert.match(result.text, /`job_101`\* - deep_research \[HIGH\] • _running_ \(45%\)/);
  assert.match(result.text, /Focus Suggestion:/);
  assert.match(result.text, /Your next scheduled commitment: \*"Quarterly team sync"\*/);

  assert.equal(result.structured.stats.remindersCount, 2);
  assert.equal(result.structured.stats.todosCount, 2);
  assert.equal(result.structured.stats.jobsCount, 2);
});

test('Briefing Settings: reads and updates delivery configuration and quiet hours', () => {
  const userId = 'u_settings_test';
  const defaults = getUserBriefingSettings(userId);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.deliveryHour, 8);
  assert.equal(defaults.quietHours.start, 22);
  assert.equal(defaults.quietHours.end, 7);

  const updated = updateUserBriefingSettings(userId, {
    deliveryHour: 9,
    deliveryMinute: 15,
    quietHours: { start: 23, end: 6 },
  });

  assert.equal(updated.deliveryHour, 9);
  assert.equal(updated.deliveryMinute, 15);
  assert.equal(updated.quietHours.start, 23);
  assert.equal(updated.quietHours.end, 6);

  const reRead = getUserBriefingSettings(userId);
  assert.equal(reRead.deliveryHour, 9);
  assert.equal(reRead.deliveryMinute, 15);
});

test('Briefing Quiet Hours: accurately flags overnight and daytime quiet periods', () => {
  const settings = {
    timezone: 'UTC',
    quietHours: {
      enabled: true,
      start: 22, // 10 PM
      end: 7, // 7 AM
    },
  };

  // 23:00 UTC is inside overnight quiet window
  const nightDate = new Date(Date.UTC(2026, 10, 12, 23, 0, 0));
  assert.equal(isInQuietHours(settings, nightDate), true);

  // 04:00 UTC is inside overnight quiet window
  const earlyMorningDate = new Date(Date.UTC(2026, 10, 12, 4, 0, 0));
  assert.equal(isInQuietHours(settings, earlyMorningDate), true);

  // 14:00 UTC is outside quiet window
  const afternoonDate = new Date(Date.UTC(2026, 10, 12, 14, 0, 0));
  assert.equal(isInQuietHours(settings, afternoonDate), false);

  // Disabled quiet hours
  const disabledSettings = {
    timezone: 'UTC',
    quietHours: { enabled: false, start: 22, end: 7 },
  };
  assert.equal(isInQuietHours(disabledSettings, nightDate), false);
});

test('Briefing Due Check: enforces target hour, quiet hours suppression, and once-per-day deduplication', () => {
  const userId = 'u_due_test';
  const settings = {
    enabled: true,
    deliveryHour: 8,
    deliveryMinute: 0,
    timezone: 'UTC',
    quietHours: { enabled: true, start: 22, end: 7 },
    lastDeliveredDate: null,
  };

  // 06:30 UTC: before 8 AM and also inside quiet hours -> NOT due
  const tooEarly = new Date(Date.UTC(2026, 10, 12, 6, 30, 0));
  assert.equal(isBriefingDue(settings, tooEarly), false);

  // 08:05 UTC: at or after 8 AM and outside quiet hours -> DUE
  const onTime = new Date(Date.UTC(2026, 10, 12, 8, 5, 0));
  assert.equal(isBriefingDue(settings, onTime), true);

  // Mark delivered for today
  recordBriefingDelivered(userId, onTime);
  const updatedSettings = getUserBriefingSettings(userId);
  updatedSettings.deliveryHour = 8;
  updatedSettings.deliveryMinute = 0;
  updatedSettings.timezone = 'UTC';

  // Later on the same day (10:00 UTC) -> NOT due (already delivered)
  const laterSameDay = new Date(Date.UTC(2026, 10, 12, 10, 0, 0));
  assert.equal(isBriefingDue(updatedSettings, laterSameDay), false);

  // Next day (08:10 UTC on Nov 13) -> DUE again
  const nextDay = new Date(Date.UTC(2026, 10, 13, 8, 10, 0));
  assert.equal(isBriefingDue(updatedSettings, nextDay), true);
});

test('Briefing Commands: /briefing on, off, time, status, and on-demand execution', async () => {
  const userId = 'u_cmd_test';

  // 1. /briefing status
  const statusRes = await handleBriefingCommand(userId, '/briefing status');
  assert.match(statusRes, /Daily Briefing Configuration:/);
  assert.match(statusRes, /Scheduled Time:\* 08:00/);

  // 2. /briefing time
  const timeRes = await handleBriefingCommand(userId, '/briefing time 09:45');
  assert.match(timeRes, /Briefing Schedule Updated:/);
  assert.match(timeRes, /09:45/);

  // 3. /briefing off
  const offRes = await handleBriefingCommand(userId, '/briefing off');
  assert.match(offRes, /Daily Briefing Disabled:/);
  assert.equal(getUserBriefingSettings(userId).enabled, false);

  // 4. /briefing on
  const onRes = await handleBriefingCommand(userId, '/briefing on');
  assert.match(onRes, /Daily Briefing Enabled:/);
  assert.equal(getUserBriefingSettings(userId).enabled, true);

  // 5. /briefing time invalid format
  const invalidTimeRes = await handleBriefingCommand(userId, '/briefing time 25:99');
  assert.match(invalidTimeRes, /Invalid Time Format:/);

  // 6. On-demand briefing /briefing
  const onDemandRes = await handleBriefingCommand(userId, '/briefing');
  assert.match(onDemandRes, /Daily Snapshot:/);
  assert.match(onDemandRes, /Upcoming Reminders:/);
});

test('Briefing Scheduler: proactively triggers deliveries to registered users', async () => {
  const userId = 'u_sched_test';
  registerBriefingUser(userId);

  // Configure user briefing to be due immediately
  const now = new Date();
  const tz = 'UTC';
  const currentHour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
  const currentMinute = parseInt(now.toLocaleString('en-US', { timeZone: tz, minute: 'numeric' }), 10);

  updateUserBriefingSettings(userId, {
    enabled: true,
    deliveryHour: currentHour,
    deliveryMinute: currentMinute,
    timezone: tz,
    quietHours: { enabled: false },
  });

  const deliveredMessages = [];
  initBriefingScheduler({
    checkIntervalMs: 20, // fast check in test
    sendBriefingFn: async (uid, text) => {
      deliveredMessages.push({ uid, text });
    },
  });

  // Wait for scheduler cycle
  for (let i = 0; i < 10; i++) {
    if (deliveredMessages.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(deliveredMessages.length, 1);
  assert.equal(deliveredMessages[0].uid, userId);
  assert.match(deliveredMessages[0].text, /Daily Snapshot:/);

  // Ensure it doesn't duplicate delivery on next cycle
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(deliveredMessages.length, 1);
});
