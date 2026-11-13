/**
 * Background Task & Job Engine
 *
 * Provides robust asynchronous job execution for long-running research,
 * batch document indexing, and scheduled background tasks.
 *
 * Features:
 * - Priority queues: 'high', 'normal', 'low'
 * - Exponential backoff retries (default maxRetries: 3)
 * - Per-job execution timeout guards with AbortController
 * - Comprehensive job lifecycle tracking (queued, running, completed, failed, cancelled)
 * - In-memory job store with pluggable persistent store adapter interface
 * - Graceful shutdown with draining and restart crash-recovery
 * - Progress tracking & EventEmitter notifications
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { privacyLog } from './privacy.js';

/**
 * Valid Job Lifecycle Statuses
 */
export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/**
 * Priority Levels and Ordering
 */
export const JOB_PRIORITY = Object.freeze({
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
});

const PRIORITY_ORDER = [JOB_PRIORITY.HIGH, JOB_PRIORITY.NORMAL, JOB_PRIORITY.LOW];

/**
 * Generate a unique, compact job ID
 */
function generateJobId() {
  const timestamp = Date.now().toString(36);
  const randomSuffix = randomBytes(4).toString('hex');
  return `job_${timestamp}_${randomSuffix}`;
}

/**
 * In-Memory Job Store Implementation
 * Default storage adapter for jobs.
 */
export class InMemoryJobStore {
  constructor() {
    this.jobs = new Map();
  }

  async save(job) {
    if (!job || !job.id) throw new Error('Job must have a valid id');
    // Store deep clone to prevent unintended reference mutation
    this.jobs.set(job.id, { ...job });
    return this.jobs.get(job.id);
  }

  async get(id) {
    if (!id) return null;
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async update(id, updates) {
    if (!id) return null;
    const existing = this.jobs.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    this.jobs.set(id, updated);
    return { ...updated };
  }

  async delete(id) {
    if (!id) return false;
    return this.jobs.delete(id);
  }

  async list(filters = {}) {
    const { status, priority, userId, type, limit = 50, offset = 0 } = filters;
    let list = Array.from(this.jobs.values());

    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      list = list.filter((j) => statuses.includes(j.status));
    }
    if (priority) {
      list = list.filter((j) => j.priority === priority);
    }
    if (userId) {
      list = list.filter((j) => j.userId === userId);
    }
    if (type) {
      list = list.filter((j) => j.type === type);
    }

    // Sort descending by createdAt
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const total = list.length;
    const paginated = list.slice(offset, offset + limit);

    return {
      total,
      limit,
      offset,
      jobs: paginated.map((j) => ({ ...j })),
    };
  }

  async count(filters = {}) {
    const result = await this.list({ ...filters, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return result.total;
  }

  async clear(olderThanMs = 0) {
    const now = Date.now();
    let removedCount = 0;

    for (const [id, job] of this.jobs.entries()) {
      const isFinished = [JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status);

      if (isFinished) {
        const finishedTime = job.completedAt || job.failedAt || job.cancelledAt || job.createdAt;
        if (now - finishedTime >= olderThanMs) {
          this.jobs.delete(id);
          removedCount++;
        }
      }
    }

    return removedCount;
  }
}

/**
 * Background Job Engine
 */
export class JobEngine extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency=3] - Maximum concurrent running jobs
   * @param {number} [options.defaultMaxRetries=3] - Default retries on transient errors
   * @param {number} [options.defaultTimeoutMs=60000] - Default execution timeout (60s)
   * @param {number} [options.defaultRetryBaseDelayMs=1000] - Base delay for exponential backoff
   * @param {object} [options.store] - Pluggable Job Store Adapter
   * @param {boolean} [options.autoStart=true] - Whether to start processing automatically
   */
  constructor(options = {}) {
    super();

    this.concurrency = options.concurrency || 3;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 3;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.defaultRetryBaseDelayMs = options.defaultRetryBaseDelayMs ?? 1000;

    // Pluggable store adapter
    this.store = options.store || new InMemoryJobStore();

    // Priority Queues: job IDs waiting to be executed
    this.queues = {
      [JOB_PRIORITY.HIGH]: [],
      [JOB_PRIORITY.NORMAL]: [],
      [JOB_PRIORITY.LOW]: [],
    };

    // Active workers: jobId -> { abortController, timeoutTimer, job }
    this.activeJobs = new Map();

    // Registered handlers: type -> async handler function
    this.handlers = new Map();

    // Scheduled timers for future/delayed jobs: jobId -> timeoutRef
    this.scheduledTimers = new Map();

    // Retry timers: jobId -> timeoutRef
    this.retryTimers = new Map();

    // Engine state
    this.isRunning = false;
    this.isShuttingDown = false;
    this.isPaused = false;
    this.totalProcessed = 0;

    if (options.autoStart !== false) {
      this.start();
    }
  }

  /**
   * Set custom persistent store adapter
   * @param {object} storeAdapter
   */
  setStore(storeAdapter) {
    if (!storeAdapter || typeof storeAdapter.save !== 'function') {
      throw new Error('Store adapter must implement store interface (save, get, update, delete, list)');
    }
    this.store = storeAdapter;
  }

  /**
   * Register a job handler function for a specific job type
   * @param {string} type - Unique job type identifier
   * @param {Function} handler - Async function: async (job, updateProgress, signal) => result
   */
  registerJobHandler(type, handler) {
    if (!type || typeof type !== 'string') {
      throw new Error('Job type must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error(`Handler for job type "${type}" must be a function`);
    }
    this.handlers.set(type, handler);
  }

  /**
   * Unregister a job handler
   * @param {string} type
   */
  unregisterJobHandler(type) {
    this.handlers.delete(type);
  }

  /**
   * Start or resume the engine worker loop
   */
  start() {
    if (this.isShuttingDown) {
      throw new Error('Cannot start engine while shutting down');
    }
    this.isRunning = true;
    this.isPaused = false;
    this._dispatchNext();
    this.emit('started');
  }

  /**
   * Pause execution of new queued jobs
   */
  pause() {
    this.isPaused = true;
    this.emit('paused');
  }

  /**
   * Resume execution of queued jobs
   */
  resume() {
    this.isPaused = false;
    this._dispatchNext();
    this.emit('resumed');
  }

  /**
   * Submit a new background job
   * @param {object} options
   * @param {string} options.type - Job type (must correspond to registered handler)
   * @param {any} [options.payload={}] - Input payload for job execution
   * @param {'high'|'normal'|'low'} [options.priority='normal'] - Execution priority
   * @param {number} [options.maxRetries] - Max retry attempts
   * @param {number} [options.timeoutMs] - Timeout in ms
   * @param {number} [options.retryBaseDelayMs] - Base delay for exponential backoff in ms
   * @param {string} [options.userId] - Optional user identifier
   * @param {number|Date} [options.scheduledAt] - Future execution timestamp
   * @param {number} [options.delayMs] - Relative delay in milliseconds before execution
   * @returns {Promise<object>} Created job object
   */
  async submitJob(options = {}) {
    if (this.isShuttingDown) {
      throw new Error('Engine is shutting down; new jobs cannot be submitted');
    }

    const {
      type,
      payload = {},
      priority = JOB_PRIORITY.NORMAL,
      maxRetries = this.defaultMaxRetries,
      timeoutMs = this.defaultTimeoutMs,
      retryBaseDelayMs = this.defaultRetryBaseDelayMs,
      userId = null,
      scheduledAt = null,
      delayMs = 0,
    } = options;

    if (!type || typeof type !== 'string') {
      throw new Error('Job type is required and must be a string');
    }

    const validPriority = PRIORITY_ORDER.includes(priority) ? priority : JOB_PRIORITY.NORMAL;
    const jobId = generateJobId();
    const now = Date.now();

    let targetScheduledTime = null;
    if (scheduledAt) {
      targetScheduledTime = scheduledAt instanceof Date ? scheduledAt.getTime() : Number(scheduledAt);
    } else if (delayMs > 0) {
      targetScheduledTime = now + delayMs;
    }

    const job = {
      id: jobId,
      type,
      payload,
      priority: validPriority,
      status: JOB_STATUS.QUEUED,
      progress: 0,
      progressMeta: null,
      userId,
      retries: 0,
      maxRetries: Math.max(0, Number(maxRetries) || 0),
      timeoutMs: Math.max(0, Number(timeoutMs) || 0),
      retryBaseDelayMs: Math.max(10, Number(retryBaseDelayMs) || 1000),
      result: null,
      error: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      scheduledAt: targetScheduledTime,
    };

    await this.store.save(job);

    privacyLog('info', 'JOB_SUBMITTED', {
      jobId: job.id,
      type: job.type,
      priority: job.priority,
      scheduled: !!targetScheduledTime,
    });

    this.emit('job:submitted', job);
    this.emit('job:queued', job);

    if (targetScheduledTime && targetScheduledTime > now) {
      // Schedule future execution
      const delay = targetScheduledTime - now;
      const timer = setTimeout(() => {
        this.scheduledTimers.delete(jobId);
        this._enqueuePriority(jobId, validPriority);
        this._dispatchNext();
      }, delay);

      if (timer.unref) timer.unref();
      this.scheduledTimers.set(jobId, timer);
    } else {
      this._enqueuePriority(jobId, validPriority);
      this._dispatchNext();
    }

    return { ...job };
  }

  /**
   * Internal priority enqueue
   */
  _enqueuePriority(jobId, priority) {
    const queue = this.queues[priority] || this.queues[JOB_PRIORITY.NORMAL];
    if (!queue.includes(jobId)) {
      queue.push(jobId);
    }
  }

  /**
   * Internal dequeue by highest priority
   */
  _dequeueHighestPriority() {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues[priority];
      if (queue && queue.length > 0) {
        return queue.shift();
      }
    }
    return null;
  }

  /**
   * Dispatch workers up to concurrency limit
   */
  _dispatchNext() {
    if (!this.isRunning || this.isPaused || this.isShuttingDown) {
      return;
    }

    while (this.activeJobs.size < this.concurrency) {
      const jobId = this._dequeueHighestPriority();
      if (!jobId) {
        break; // Queues are empty
      }
      this._processJob(jobId);
    }
  }

  /**
   * Execute a single job
   */
  async _processJob(jobId) {
    const job = await this.store.get(jobId);
    if (!job) {
      this._dispatchNext();
      return;
    }

    // If job was cancelled while in queue, skip execution
    if (job.status === JOB_STATUS.CANCELLED) {
      this._dispatchNext();
      return;
    }

    const handler = this.handlers.get(job.type);
    if (!handler) {
      // Handler not found -> fail permanently
      const errorMsg = `No registered handler found for job type "${job.type}"`;
      await this._finalizeJobFailure(job, errorMsg, false);
      this._dispatchNext();
      return;
    }

    const now = Date.now();
    await this.store.update(jobId, {
      status: JOB_STATUS.RUNNING,
      startedAt: now,
      progress: 0,
    });

    job.status = JOB_STATUS.RUNNING;
    job.startedAt = now;

    privacyLog('info', 'JOB_STARTED', { jobId: job.id, type: job.type });
    this.emit('job:started', job);

    const abortController = new globalThis.AbortController();
    let timeoutTimer = null;

    if (job.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        abortController.abort(new Error(`Job timed out after ${job.timeoutMs}ms`));
      }, job.timeoutMs);
    }

    this.activeJobs.set(jobId, {
      job,
      abortController,
      timeoutTimer,
    });

    const updateProgress = async (percentage, meta = null) => {
      const clamped = Math.min(100, Math.max(0, Math.round(Number(percentage) || 0)));
      await this.store.update(jobId, { progress: clamped, progressMeta: meta });
      job.progress = clamped;
      job.progressMeta = meta;
      this.emit('job:progress', { jobId, progress: clamped, progressMeta: meta });
    };

    try {
      const result = await handler(job, updateProgress, abortController.signal);

      // Check if job was cancelled during execution
      const freshJob = await this.store.get(jobId);
      if (freshJob && freshJob.status === JOB_STATUS.CANCELLED) {
        this._cleanupActive(jobId);
        this._dispatchNext();
        return;
      }

      await this._finalizeJobSuccess(job, result);
    } catch (err) {
      const freshJob = await this.store.get(jobId);
      if (freshJob && freshJob.status === JOB_STATUS.CANCELLED) {
        this._cleanupActive(jobId);
        this._dispatchNext();
        return;
      }

      const isTimeout = abortController.signal.aborted;
      const errorMessage = isTimeout ? `Job timed out after ${job.timeoutMs}ms` : (err && err.message) || String(err);

      await this._handleJobError(job, errorMessage);
    } finally {
      this._cleanupActive(jobId);
      this.totalProcessed++;
      this._dispatchNext();
    }
  }

  _cleanupActive(jobId) {
    const active = this.activeJobs.get(jobId);
    if (active && active.timeoutTimer) {
      clearTimeout(active.timeoutTimer);
    }
    this.activeJobs.delete(jobId);
  }

  async _finalizeJobSuccess(job, result) {
    const now = Date.now();
    await this.store.update(job.id, {
      status: JOB_STATUS.COMPLETED,
      progress: 100,
      result: result ?? null,
      completedAt: now,
      error: null,
    });

    job.status = JOB_STATUS.COMPLETED;
    job.progress = 100;
    job.result = result ?? null;
    job.completedAt = now;

    privacyLog('info', 'JOB_COMPLETED', { jobId: job.id, durationMs: now - (job.startedAt || now) });
    this.emit('job:completed', job);
  }

  async _handleJobError(job, errorMessage) {
    // Determine whether to retry
    if (job.retries < job.maxRetries) {
      job.retries += 1;
      const backoffDelay = job.retryBaseDelayMs * Math.pow(2, job.retries - 1);

      await this.store.update(job.id, {
        status: JOB_STATUS.QUEUED,
        retries: job.retries,
        error: errorMessage,
      });

      privacyLog('warn', 'JOB_RETRYING', {
        jobId: job.id,
        retry: job.retries,
        maxRetries: job.maxRetries,
        delayMs: backoffDelay,
        error: errorMessage,
      });

      this.emit('job:retry', {
        jobId: job.id,
        retry: job.retries,
        maxRetries: job.maxRetries,
        delayMs: backoffDelay,
        error: errorMessage,
      });

      const timer = setTimeout(() => {
        this.retryTimers.delete(job.id);
        this._enqueuePriority(job.id, job.priority);
        this._dispatchNext();
      }, backoffDelay);

      this.retryTimers.set(job.id, timer);
    } else {
      await this._finalizeJobFailure(job, errorMessage, true);
    }
  }

  async _finalizeJobFailure(job, errorMessage, retriesExhausted = true) {
    const now = Date.now();
    await this.store.update(job.id, {
      status: JOB_STATUS.FAILED,
      failedAt: now,
      error: errorMessage,
    });

    job.status = JOB_STATUS.FAILED;
    job.failedAt = now;
    job.error = errorMessage;

    privacyLog('error', 'JOB_FAILED', {
      jobId: job.id,
      retriesExhausted,
      error: errorMessage,
    });

    this.emit('job:failed', job);
  }

  /**
   * Cancel an active or queued job
   * @param {string} jobId
   * @param {string} [reason='User requested cancellation']
   * @returns {Promise<boolean>} True if successfully cancelled
   */
  async cancelJob(jobId, reason = 'User requested cancellation') {
    if (!jobId) return false;

    const job = await this.store.get(jobId);
    if (!job) return false;

    if ([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)) {
      return false; // Already finalized
    }

    const now = Date.now();
    await this.store.update(jobId, {
      status: JOB_STATUS.CANCELLED,
      cancelledAt: now,
      cancelReason: reason,
    });

    // Remove from in-memory queue arrays
    for (const priority of PRIORITY_ORDER) {
      const idx = this.queues[priority].indexOf(jobId);
      if (idx !== -1) {
        this.queues[priority].splice(idx, 1);
      }
    }

    // Clear any scheduled or retry timers
    if (this.scheduledTimers.has(jobId)) {
      clearTimeout(this.scheduledTimers.get(jobId));
      this.scheduledTimers.delete(jobId);
    }
    if (this.retryTimers.has(jobId)) {
      clearTimeout(this.retryTimers.get(jobId));
      this.retryTimers.delete(jobId);
    }

    // If currently running, abort execution
    const active = this.activeJobs.get(jobId);
    if (active) {
      if (active.abortController) {
        active.abortController.abort(new Error(`Job cancelled: ${reason}`));
      }
      this._cleanupActive(jobId);
    }

    privacyLog('info', 'JOB_CANCELLED', { jobId, reason });
    this.emit('job:cancelled', { jobId, reason, cancelledAt: now });

    this._dispatchNext();
    return true;
  }

  /**
   * Manually retry a failed or cancelled job
   * @param {string} jobId
   * @returns {Promise<object|null>}
   */
  async retryJob(jobId) {
    if (!jobId) return null;
    const job = await this.store.get(jobId);
    if (!job) return null;

    if (![JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)) {
      return null;
    }

    const now = Date.now();
    const updated = await this.store.update(jobId, {
      status: JOB_STATUS.QUEUED,
      retries: 0,
      progress: 0,
      error: null,
      cancelReason: null,
      failedAt: null,
      cancelledAt: null,
      updatedAt: now,
    });

    this._enqueuePriority(jobId, updated.priority || JOB_PRIORITY.NORMAL);
    this.emit('job:queued', updated);
    this._dispatchNext();

    return updated;
  }

  /**
   * Get single job by ID
   * @param {string} jobId
   * @returns {Promise<object|null>}
   */
  async getJob(jobId) {
    return this.store.get(jobId);
  }

  /**
   * List jobs with filters and pagination
   * @param {object} filters
   * @returns {Promise<{ total: number, limit: number, offset: number, jobs: Array<object> }>}
   */
  async listJobs(filters = {}) {
    return this.store.list(filters);
  }

  /**
   * Get overall engine statistics
   * @returns {Promise<object>}
   */
  async getStats() {
    const listResult = await this.store.list({ limit: Number.MAX_SAFE_INTEGER });
    const allJobs = listResult.jobs || [];

    const stats = {
      queued: 0,
      running: this.activeJobs.size,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: allJobs.length,
      activeWorkers: this.activeJobs.size,
      maxConcurrency: this.concurrency,
      totalProcessed: this.totalProcessed,
      priorityBreakdown: {
        high: this.queues[JOB_PRIORITY.HIGH].length,
        normal: this.queues[JOB_PRIORITY.NORMAL].length,
        low: this.queues[JOB_PRIORITY.LOW].length,
      },
    };

    for (const job of allJobs) {
      if (job.status === JOB_STATUS.QUEUED) stats.queued++;
      else if (job.status === JOB_STATUS.COMPLETED) stats.completed++;
      else if (job.status === JOB_STATUS.FAILED) stats.failed++;
      else if (job.status === JOB_STATUS.CANCELLED) stats.cancelled++;
    }

    return stats;
  }

  /**
   * Clear older completed, failed, or cancelled jobs
   * @param {number} olderThanMs
   * @returns {Promise<number>} Number of deleted jobs
   */
  async clearFinishedJobs(olderThanMs = 0) {
    return this.store.clear(olderThanMs);
  }

  /**
   * Restart Recovery: recovers jobs left in 'running' or 'queued' state
   * (e.g. if the Node process crashed or restarted).
   * @returns {Promise<{ recovered: number, failed: number }>}
   */
  async recoverUnfinishedJobs() {
    const runningJobsResult = await this.store.list({
      status: [JOB_STATUS.RUNNING, JOB_STATUS.QUEUED],
      limit: Number.MAX_SAFE_INTEGER,
    });

    let recovered = 0;
    let failed = 0;

    for (const job of runningJobsResult.jobs) {
      if (job.status === JOB_STATUS.RUNNING) {
        // Interrupted while running: check retries
        if (job.retries < job.maxRetries) {
          job.retries += 1;
          await this.store.update(job.id, {
            status: JOB_STATUS.QUEUED,
            retries: job.retries,
            error: 'Interrupted by server restart; automatically re-queued',
          });
          this._enqueuePriority(job.id, job.priority);
          recovered++;
        } else {
          await this.store.update(job.id, {
            status: JOB_STATUS.FAILED,
            failedAt: Date.now(),
            error: 'Interrupted by server restart; max retries exceeded',
          });
          failed++;
        }
      } else if (job.status === JOB_STATUS.QUEUED) {
        // Was queued: ensure it is in memory queue
        this._enqueuePriority(job.id, job.priority);
        recovered++;
      }
    }

    privacyLog('info', 'JOBS_RECOVERED', { recovered, failed });
    this._dispatchNext();
    return { recovered, failed };
  }

  /**
   * Graceful shutdown: drains active jobs or aborts after timeout
   * @param {object} [options]
   * @param {number} [options.drainTimeoutMs=5000] - Max wait time for active jobs
   * @param {boolean} [options.abortOnTimeout=true] - Whether to abort active jobs when drain timeout expires
   * @returns {Promise<void>}
   */
  async shutdown(options = {}) {
    const drainTimeoutMs = options.drainTimeoutMs ?? 5000;
    const abortOnTimeout = options.abortOnTimeout ?? true;

    this.isShuttingDown = true;
    this.isRunning = false;

    // Clear scheduled timers
    for (const timer of this.scheduledTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduledTimers.clear();

    // Clear retry timers
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    if (this.activeJobs.size === 0) {
      this.emit('shutdown');
      return;
    }

    const startWait = Date.now();
    while (this.activeJobs.size > 0 && Date.now() - startWait < drainTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.activeJobs.size > 0 && abortOnTimeout) {
      for (const [, active] of this.activeJobs.entries()) {
        if (active.abortController) {
          active.abortController.abort(new Error('Engine shutdown drain timeout exceeded'));
        }
        if (active.timeoutTimer) {
          clearTimeout(active.timeoutTimer);
        }
      }
      this.activeJobs.clear();
    }

    this.emit('shutdown');
  }
}

// Export Singleton Instance
export const jobEngine = new JobEngine({ autoStart: true });

// Built-in standard job handlers for common async tasks
jobEngine.registerJobHandler('research', async (job, updateProgress, signal) => {
  await updateProgress(10, { step: 'Initializing research query' });
  if (signal.aborted) throw new Error('Aborted');
  await new Promise((r) => setTimeout(r, 50));

  await updateProgress(50, { step: 'Gathering contextual citations' });
  if (signal.aborted) throw new Error('Aborted');
  await new Promise((r) => setTimeout(r, 50));

  await updateProgress(90, { step: 'Synthesizing report' });
  return {
    summary: `Research completed for query: ${job.payload?.query || 'General'}`,
    timestamp: Date.now(),
  };
});

jobEngine.registerJobHandler('document_indexing', async (job, updateProgress, signal) => {
  await updateProgress(20, { step: 'Parsing document chunks' });
  if (signal.aborted) throw new Error('Aborted');
  await new Promise((r) => setTimeout(r, 50));

  await updateProgress(80, { step: 'Generating vector embeddings' });
  if (signal.aborted) throw new Error('Aborted');

  return {
    chunksIndexed: job.payload?.chunks?.length || 1,
    status: 'indexed',
  };
});
