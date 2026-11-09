/**
 * In-Process Work Queue & Concurrency Controller
 * Decouples webhook receipt from async execution, limits concurrency,
 * provides exponential backoff retries for transient errors, and routes
 * exhausted tasks to a privacy-safe dead-letter notification path.
 */
import { config } from './config.js';
import { privacyLog } from './privacy.js';
import { recordErrorMetric } from './metrics.js';
import { sendWhatsAppMessage } from './whatsapp.js';

export class MessageQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency] - Max concurrent tasks (default: config.MESSAGE_CONCURRENCY || 4)
   * @param {number} [options.maxSize] - Max queued items before backpressure drops (default: config.QUEUE_MAX_SIZE || 1000)
   * @param {number} [options.maxRetries] - Max retries for transient errors (default: config.QUEUE_MAX_RETRIES || 3)
   * @param {number} [options.retryBaseDelayMs] - Base delay in ms for exponential backoff (default: 1000)
   * @param {Function} [options.handler] - Async task processor
   * @param {Function} [options.onDeadLetter] - Optional dead-letter handler
   */
  constructor(options = {}) {
    this.concurrency = options.concurrency || config.MESSAGE_CONCURRENCY || 4;
    this.maxSize = options.maxSize || config.QUEUE_MAX_SIZE || 1000;
    this.maxRetries = options.maxRetries ?? config.QUEUE_MAX_RETRIES ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.handler = options.handler || null;
    this.onDeadLetter = options.onDeadLetter || null;

    this.queue = [];
    this.activeCount = 0;
    this.paused = false;
    this.idleWaiters = [];
    this.pendingTimeouts = new Set();

    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
      dropped: 0,
    };
  }

  /**
   * Sets the task processor function.
   * @param {Function} fn
   */
  setHandler(fn) {
    this.handler = fn;
  }

  /**
   * Number of items waiting in queue.
   * @returns {number}
   */
  get size() {
    return this.queue.length;
  }

  /**
   * Returns an operational snapshot of queue health.
   * @returns {object}
   */
  getStats() {
    return {
      pending: this.queue.length,
      active: this.activeCount,
      concurrency: this.concurrency,
      maxSize: this.maxSize,
      paused: this.paused,
      ...this.stats,
    };
  }

  /**
   * Enqueues a message processing task.
   * Enforces backpressure when queue is full.
   *
   * @param {object} task
   * @returns {boolean} true if accepted, false if rejected due to backpressure or pause
   */
  push(task) {
    if (this.paused) {
      privacyLog('warn', 'QUEUE_PUSH_REJECTED_PAUSED', {
        user: task.anonId,
        requestId: task.requestId,
      });
      return false;
    }

    if (this.queue.length >= this.maxSize) {
      this.stats.dropped++;
      recordErrorMetric('queue_overflow');
      privacyLog('warn', 'QUEUE_BACKPRESSURE_LIMIT_REACHED', {
        currentSize: this.queue.length,
        maxSize: this.maxSize,
        requestId: task.requestId,
      });
      return false;
    }

    const item = {
      ...task,
      retryCount: task.retryCount || 0,
      enqueuedAt: Date.now(),
    };

    this.queue.push(item);
    this.stats.enqueued++;

    this._processNext();
    return true;
  }

  /**
   * Determines whether an error is transient and eligible for retry.
   * Covers HTTP 429, 500, 502, 503, 504, and common network dropouts.
   *
   * @param {Error|object} err
   * @returns {boolean}
   */
  isTransientError(err) {
    if (!err) return false;
    const status = Number(err.status || err.statusCode || err.code);
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }

    const code = String(err.code || '');
    if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
      return true;
    }

    const msg = String(err.message || '').toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('resource exhausted') ||
      msg.includes('quota') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('500') ||
      msg.includes('overloaded') ||
      msg.includes('service unavailable') ||
      msg.includes('timeout') ||
      msg.includes('econnreset')
    );
  }

  /**
   * Internal worker loop driving concurrency.
   */
  _processNext() {
    if (this.paused) return;

    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this.activeCount++;

      (async () => {
        try {
          if (!this.handler) {
            throw new Error('MessageQueue has no registered handler.');
          }
          await this.handler(task);
          this.stats.processed++;
        } catch (err) {
          await this._handleTaskError(task, err);
        } finally {
          this.activeCount--;
          this._checkIdle();
          this._processNext();
        }
      })();
    }

    this._checkIdle();
  }

  /**
   * Checks if queue has settled to notify idle waiters.
   */
  _checkIdle() {
    if (this.activeCount === 0 && this.queue.length === 0 && this.pendingTimeouts.size === 0) {
      while (this.idleWaiters.length > 0) {
        const resolve = this.idleWaiters.shift();
        resolve();
      }
    }
  }

  /**
   * Handles task errors: retries transient errors with exponential backoff,
   * routes permanent or exhausted errors to dead-letter.
   *
   * @param {object} task
   * @param {Error} err
   */
  async _handleTaskError(task, err) {
    const isTransient = this.isTransientError(err);

    if (isTransient && task.retryCount < this.maxRetries) {
      task.retryCount++;
      this.stats.retried++;
      const delayMs = this.retryBaseDelayMs * Math.pow(2, task.retryCount - 1);

      privacyLog('warn', 'QUEUE_TASK_RETRYING', {
        requestId: task.requestId,
        user: task.anonId,
        retryCount: task.retryCount,
        maxRetries: this.maxRetries,
        delayMs,
        error: err.message,
      });

      const timerId = setTimeout(() => {
        this.pendingTimeouts.delete(timerId);
        // Prepend to front of queue so retries are prioritized
        this.queue.unshift(task);
        this._processNext();
      }, delayMs);

      if (timerId.unref) timerId.unref();
      this.pendingTimeouts.add(timerId);
      return;
    }

    // Dead-Letter routing
    this.stats.failed++;
    this.stats.deadLettered++;
    recordErrorMetric('dead_letter');

    privacyLog('error', 'QUEUE_TASK_DEAD_LETTERED', {
      requestId: task.requestId,
      user: task.anonId,
      retriesExhausted: task.retryCount >= this.maxRetries,
      retryCount: task.retryCount,
      error: err.message,
    });

    if (typeof this.onDeadLetter === 'function') {
      try {
        await this.onDeadLetter(task, err);
      } catch (dlErr) {
        privacyLog('error', 'CUSTOM_DEAD_LETTER_HANDLER_FAILED', { error: dlErr.message });
      }
    }

    // Notify user with polite retry guidance if recipient is known
    const recipient = task.to || task.senderId;
    if (recipient) {
      try {
        await sendWhatsAppMessage(
          recipient,
          '⚠️ *We were unable to process your request after multiple attempts due to temporary service disruptions. Please try again in a few moments.*'
        );
      } catch (notifyErr) {
        privacyLog('warn', 'DEAD_LETTER_USER_NOTIFY_FAILED', { error: notifyErr.message });
      }
    }
  }

  /**
   * Resolves when all queued and active items have completed.
   * @returns {Promise<void>}
   */
  onIdle() {
    if (this.activeCount === 0 && this.queue.length === 0 && this.pendingTimeouts.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Pauses queue ingestion and awaits active task draining up to timeout.
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<boolean>} true if cleanly drained, false if timed out
   */
  async drain(timeoutMs = config.SHUTDOWN_TIMEOUT_MS || 10000) {
    this.paused = true;

    if (this.activeCount === 0 && this.queue.length === 0 && this.pendingTimeouts.size === 0) {
      return true;
    }

    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      if (timer.unref) timer.unref();
    });

    const drained = await Promise.race([this.onIdle().then(() => true), timeoutPromise]);

    clearTimeout(timer);
    return drained;
  }

  /**
   * Resumes ingestion and processing.
   */
  resume() {
    this.paused = false;
    this._processNext();
  }

  /**
   * Clears all pending queue items and timeouts (for test teardown).
   */
  reset() {
    for (const timerId of this.pendingTimeouts) {
      clearTimeout(timerId);
    }
    this.pendingTimeouts.clear();
    this.queue = [];
    this.activeCount = 0;
    this.paused = false;
    this.idleWaiters = [];
    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
      dropped: 0,
    };
  }
}

// Global default message queue singleton
export const messageQueue = new MessageQueue();
