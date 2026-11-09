import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { MessageQueue } from '../src/queue.js';
import { config } from '../src/config.js';
import { scheduleReminder, listReminders, initReminders, stopReminders } from '../src/reminders.js';

test('Queue: Concurrency limits strictly cap simultaneous active executions', async () => {
  const queue = new MessageQueue({ concurrency: 2, maxSize: 50 });
  let maxObservedActive = 0;
  let activeNow = 0;
  let completedCount = 0;

  queue.setHandler(async (_task) => {
    activeNow++;
    if (activeNow > maxObservedActive) {
      maxObservedActive = activeNow;
    }
    // Simulate async I/O
    await new Promise((resolve) => setTimeout(resolve, 30));
    activeNow--;
    completedCount++;
  });

  for (let i = 0; i < 6; i++) {
    const accepted = queue.push({ id: i, text: `task_${i}` });
    assert.strictEqual(accepted, true);
  }

  await queue.onIdle();

  assert.strictEqual(completedCount, 6);
  assert.ok(maxObservedActive <= 2, `Observed max active was ${maxObservedActive}, expected <= 2`);
});

test('Queue: Backpressure limit drops excess requests when capacity exceeded', async () => {
  const queue = new MessageQueue({ concurrency: 1, maxSize: 3 });

  // Task that holds worker busy
  let releaseWorker;
  const workerBlocker = new Promise((resolve) => {
    releaseWorker = resolve;
  });

  queue.setHandler(async () => {
    await workerBlocker;
  });

  // 1 task becomes active, 3 fill queue buffer
  assert.strictEqual(queue.push({ id: 1 }), true);
  assert.strictEqual(queue.push({ id: 2 }), true);
  assert.strictEqual(queue.push({ id: 3 }), true);
  assert.strictEqual(queue.push({ id: 4 }), true);

  // 5th task should exceed buffer (buffer limit = 3)
  const rejected = queue.push({ id: 5 });
  assert.strictEqual(rejected, false);
  assert.strictEqual(queue.getStats().dropped, 1);

  releaseWorker();
  await queue.onIdle();
});

test('Queue: Transient errors are retried with exponential backoff and eventually succeed', async () => {
  const queue = new MessageQueue({
    concurrency: 2,
    maxRetries: 3,
    retryBaseDelayMs: 20, // Fast backoff for tests
  });

  let attempts = 0;
  queue.setHandler(async (_task) => {
    attempts++;
    if (attempts < 3) {
      const err = new Error('Resource exhausted: Rate limit 429');
      err.status = 429;
      throw err;
    }
  });

  queue.push({ id: 'flaky_task', text: 'retry me' });
  await queue.onIdle();

  assert.strictEqual(attempts, 3);
  const stats = queue.getStats();
  assert.strictEqual(stats.processed, 1);
  assert.strictEqual(stats.retried, 2);
  assert.strictEqual(stats.deadLettered, 0);
});

test('Queue: Exhausted retries route to dead-letter handler', async () => {
  let deadLetterTask = null;
  let deadLetterErr = null;

  const queue = new MessageQueue({
    concurrency: 1,
    maxRetries: 2,
    retryBaseDelayMs: 10,
    onDeadLetter: async (task, err) => {
      deadLetterTask = task;
      deadLetterErr = err;
    },
  });

  queue.setHandler(async () => {
    const err = new Error('503 Service Unavailable');
    err.status = 503;
    throw err;
  });

  queue.push({ id: 'doomed_task', anonId: 'u_dead', text: 'will fail' });
  await queue.onIdle();

  const stats = queue.getStats();
  assert.strictEqual(stats.failed, 1);
  assert.strictEqual(stats.deadLettered, 1);
  assert.ok(deadLetterTask);
  assert.strictEqual(deadLetterTask.id, 'doomed_task');
  assert.ok(deadLetterErr);
  assert.ok(deadLetterErr.message.includes('503'));
});

test('Queue: Non-transient errors go directly to dead-letter without retries', async () => {
  let attempts = 0;
  const queue = new MessageQueue({
    concurrency: 1,
    maxRetries: 3,
    retryBaseDelayMs: 10,
  });

  queue.setHandler(async () => {
    attempts++;
    throw new Error('Fatal validation error: invalid JSON schema');
  });

  queue.push({ id: 'bad_syntax', text: 'malformed' });
  await queue.onIdle();

  assert.strictEqual(attempts, 1);
  const stats = queue.getStats();
  assert.strictEqual(stats.retried, 0);
  assert.strictEqual(stats.deadLettered, 1);
});

test('Queue: drain pauses acceptance and flushes inflight tasks cleanly', async () => {
  const queue = new MessageQueue({ concurrency: 2 });
  let processed = 0;

  queue.setHandler(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    processed++;
  });

  queue.push({ id: 1 });
  queue.push({ id: 2 });

  const drained = await queue.drain(2000);
  assert.strictEqual(drained, true);
  assert.strictEqual(processed, 2);

  // New push rejected while paused/drained
  assert.strictEqual(queue.push({ id: 3 }), false);
});

test('Reminders: Durable persistence across simulated restarts', () => {
  const origPersist = config.REMINDERS_PERSIST;
  const testDataDir = path.resolve('tests/.tmp-reminders');
  const origDataDir = config.DATA_DIR;

  config.REMINDERS_PERSIST = true;
  config.DATA_DIR = testDataDir;

  stopReminders();

  const user = 'u_persisted_user';
  const phone = '919999888877';

  // 1. Schedule a reminder
  const sched = scheduleReminder(phone, user, '2h', 'Persisted doctor appointment');
  assert.strictEqual(sched.success, true);
  const remId = sched.reminder.id;

  const remFile = path.join(testDataDir, 'reminders.json');
  assert.ok(fs.existsSync(remFile), 'reminders.json should exist on disk');

  const content = JSON.parse(fs.readFileSync(remFile, 'utf-8'));
  assert.ok(Array.isArray(content));
  assert.ok(content.some((r) => r.id === remId));

  // 2. Simulate process restart by stopping and clearing in-memory state
  stopReminders();
  assert.ok(listReminders(user).includes('no scheduled reminders'));

  // 3. Reload from disk
  initReminders();
  const reloadedList = listReminders(user);
  assert.ok(reloadedList.includes('Persisted doctor appointment'));
  assert.ok(reloadedList.includes(remId));

  // Teardown
  stopReminders();
  if (fs.existsSync(remFile)) fs.unlinkSync(remFile);
  if (fs.existsSync(testDataDir)) fs.rmdirSync(testDataDir);

  config.REMINDERS_PERSIST = origPersist;
  config.DATA_DIR = origDataDir;
});
