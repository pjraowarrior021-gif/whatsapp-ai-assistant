import test from 'node:test';
import assert from 'node:assert/strict';
import { JobEngine, InMemoryJobStore, JOB_STATUS, JOB_PRIORITY } from '../src/job-engine.js';

test('JobEngine: submits and executes a job with registered handler', async () => {
  const engine = new JobEngine({ concurrency: 1, autoStart: true });
  let handlerCalled = false;

  engine.registerJobHandler('test_simple', async (job, updateProgress) => {
    handlerCalled = true;
    await updateProgress(50);
    return { success: true, echo: job.payload.data };
  });

  const job = await engine.submitJob({
    type: 'test_simple',
    payload: { data: 'hello_world' },
    priority: JOB_PRIORITY.NORMAL,
  });

  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.equal(job.type, 'test_simple');

  // Wait for completion
  await new Promise((resolve) => {
    engine.on('job:completed', (completedJob) => {
      if (completedJob.id === job.id) resolve();
    });
  });

  assert.equal(handlerCalled, true);
  const fetched = await engine.getJob(job.id);
  assert.equal(fetched.status, JOB_STATUS.COMPLETED);
  assert.equal(fetched.progress, 100);
  assert.equal(fetched.result.echo, 'hello_world');

  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: respects priority queues (high before normal before low)', async () => {
  const engine = new JobEngine({ concurrency: 1, autoStart: false });
  const executedOrder = [];

  engine.registerJobHandler('order_test', async (job) => {
    executedOrder.push(job.payload.name);
    return { done: true };
  });

  // Submit in reverse priority order while engine is stopped
  await engine.submitJob({ type: 'order_test', priority: JOB_PRIORITY.LOW, payload: { name: 'low' } });
  await engine.submitJob({
    type: 'order_test',
    priority: JOB_PRIORITY.NORMAL,
    payload: { name: 'normal' },
  });
  await engine.submitJob({
    type: 'order_test',
    priority: JOB_PRIORITY.HIGH,
    payload: { name: 'high' },
  });

  // Start engine and wait until all 3 are processed
  engine.start();

  while (executedOrder.length < 3) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.deepEqual(executedOrder, ['high', 'normal', 'low']);

  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: performs exponential backoff retries and fails on exhaustion', async () => {
  const engine = new JobEngine({
    concurrency: 1,
    defaultRetryBaseDelayMs: 20, // fast in test
    autoStart: true,
  });

  let attempts = 0;
  engine.registerJobHandler('flaky_job', async () => {
    attempts++;
    throw new Error(`Intentional failure attempt ${attempts}`);
  });

  const job = await engine.submitJob({
    type: 'flaky_job',
    maxRetries: 2,
    retryBaseDelayMs: 20,
  });

  await new Promise((resolve) => {
    engine.on('job:failed', (failedJob) => {
      if (failedJob.id === job.id) resolve();
    });
  });

  // 1 initial attempt + 2 retries = 3 total attempts
  assert.equal(attempts, 3);
  const fetched = await engine.getJob(job.id);
  assert.equal(fetched.status, JOB_STATUS.FAILED);
  assert.equal(fetched.retries, 2);
  assert.match(fetched.error, /Intentional failure attempt 3/);

  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: execution timeout guard triggers abort signal and fails job', async () => {
  const engine = new JobEngine({ concurrency: 1, autoStart: true });

  engine.registerJobHandler('slow_job', async (job, updateProgress, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Job aborted by timeout'));
      });
    });
  });

  const job = await engine.submitJob({
    type: 'slow_job',
    timeoutMs: 50, // 50ms timeout
    maxRetries: 0,
  });

  await new Promise((resolve) => {
    engine.on('job:failed', (failedJob) => {
      if (failedJob.id === job.id) resolve();
    });
  });

  const fetched = await engine.getJob(job.id);
  assert.equal(fetched.status, JOB_STATUS.FAILED);
  assert.match(fetched.error, /timed out after 50ms/);

  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: cancels a queued or running job', async () => {
  const engine = new JobEngine({ concurrency: 1, autoStart: false });

  engine.registerJobHandler('cancellable', async (job, updateProgress, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      });
    });
  });

  const job1 = await engine.submitJob({ type: 'cancellable', payload: { n: 1 } });
  const job2 = await engine.submitJob({ type: 'cancellable', payload: { n: 2 } });

  // Cancel job2 while still in queue
  const cancelResult = await engine.cancelJob(job2.id, 'User test cancellation');
  assert.equal(cancelResult, true);

  const fetchedJob2 = await engine.getJob(job2.id);
  assert.equal(fetchedJob2.status, JOB_STATUS.CANCELLED);
  assert.equal(fetchedJob2.cancelReason, 'User test cancellation');

  // Start engine and cancel job1 while running
  engine.start();
  await new Promise((r) => setTimeout(r, 20));

  await engine.cancelJob(job1.id, 'Abort running');
  const fetchedJob1 = await engine.getJob(job1.id);
  assert.equal(fetchedJob1.status, JOB_STATUS.CANCELLED);

  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: manual retry of failed job', async () => {
  const engine = new JobEngine({ concurrency: 1, autoStart: true });
  let shouldFail = true;

  engine.registerJobHandler('retryable', async () => {
    if (shouldFail) {
      throw new Error('Initial test error');
    }
    return { recovered: true };
  });

  const job = await engine.submitJob({ type: 'retryable', maxRetries: 0 });

  await new Promise((resolve) => {
    engine.on('job:failed', (j) => {
      if (j.id === job.id) resolve();
    });
  });

  assert.equal((await engine.getJob(job.id)).status, JOB_STATUS.FAILED);

  // Now enable success and manually retry
  shouldFail = false;
  const retriedJob = await engine.retryJob(job.id);
  assert.equal(retriedJob.status, JOB_STATUS.QUEUED);

  await new Promise((resolve) => {
    engine.on('job:completed', (j) => {
      if (j.id === job.id) resolve();
    });
  });

  const finalJob = await engine.getJob(job.id);
  assert.equal(finalJob.status, JOB_STATUS.COMPLETED);
  assert.equal(finalJob.result.recovered, true);

  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: restart recovery detects and recovers interrupted running jobs', async () => {
  const customStore = new InMemoryJobStore();
  // Simulate interrupted running job from prior crash
  await customStore.save({
    id: 'job_crashed_1',
    type: 'recovery_test',
    status: JOB_STATUS.RUNNING,
    priority: JOB_PRIORITY.HIGH,
    retries: 0,
    maxRetries: 2,
    createdAt: Date.now() - 5000,
  });

  const engine = new JobEngine({
    store: customStore,
    concurrency: 1,
    autoStart: false,
  });

  let recoveredExecuted = false;
  engine.registerJobHandler('recovery_test', async () => {
    recoveredExecuted = true;
    return { ok: true };
  });

  const recoveryStats = await engine.recoverUnfinishedJobs();
  assert.equal(recoveryStats.recovered, 1);
  assert.equal(recoveryStats.failed, 0);

  const jobAfterRecovery = await customStore.get('job_crashed_1');
  assert.equal(jobAfterRecovery.status, JOB_STATUS.QUEUED);
  assert.equal(jobAfterRecovery.retries, 1);

  // Start engine and ensure it completes
  engine.start();
  await new Promise((resolve) => {
    engine.on('job:completed', (j) => {
      if (j.id === 'job_crashed_1') resolve();
    });
  });

  assert.equal(recoveredExecuted, true);
  await engine.shutdown({ drainTimeoutMs: 100 });
});

test('JobEngine: getStats and listJobs filtering and pagination', async () => {
  const engine = new JobEngine({ concurrency: 1, autoStart: false });

  await engine.submitJob({ type: 'stat_job', priority: JOB_PRIORITY.HIGH, userId: 'user_a' });
  await engine.submitJob({ type: 'stat_job', priority: JOB_PRIORITY.NORMAL, userId: 'user_a' });
  await engine.submitJob({ type: 'stat_job', priority: JOB_PRIORITY.LOW, userId: 'user_b' });

  const stats = await engine.getStats();
  assert.equal(stats.queued, 3);
  assert.equal(stats.priorityBreakdown.high, 1);
  assert.equal(stats.priorityBreakdown.normal, 1);
  assert.equal(stats.priorityBreakdown.low, 1);

  const userAFilter = await engine.listJobs({ userId: 'user_a' });
  assert.equal(userAFilter.total, 2);
  assert.equal(userAFilter.jobs.length, 2);

  const paged = await engine.listJobs({ limit: 1, offset: 0 });
  assert.equal(paged.jobs.length, 1);
  assert.equal(paged.total, 3);

  await engine.shutdown({ drainTimeoutMs: 50 });
});

test('JobEngine: graceful shutdown drains active jobs without dropping', async () => {
  const engine = new JobEngine({ concurrency: 2, autoStart: true });
  let jobCompleted = false;

  engine.registerJobHandler('drain_test', async () => {
    await new Promise((r) => setTimeout(r, 60));
    jobCompleted = true;
    return { drained: true };
  });

  await engine.submitJob({ type: 'drain_test' });
  // Allow job to start
  await new Promise((r) => setTimeout(r, 20));

  // Trigger shutdown with drain timeout
  await engine.shutdown({ drainTimeoutMs: 500, abortOnTimeout: false });

  assert.equal(jobCompleted, true);
  assert.equal(engine.isRunning, false);
});
