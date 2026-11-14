/**
 * Daily Quota Management Module
 * Tracks per-user and global daily request limits with persistent store backing,
 * resetting on UTC date rollover.
 */
import { config } from './config.js';
import { privacyLog } from './privacy.js';
import { store } from './store/index.js';

let currentDateUtc = getUtcDateString();
const userDailyCounters = new Map(); // Map<anonId, number>
let globalGeminiCount = 0;

export const MAX_BACKGROUND_LEARN_REQUESTS_PER_DAY = 50;
export const MAX_BACKGROUND_LEARN_TOKENS_PER_DAY = 200_000;
let globalBackgroundRequests = 0;
let globalBackgroundTokens = 0;

/**
 * Returns current UTC date string in 'YYYY-MM-DD' format.
 * @returns {string}
 */
export function getUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Initializes and restores quota state from persistent store if available.
 */
export async function initQuotas() {
  try {
    const today = getUtcDateString();
    currentDateUtc = today;

    const geminiVal = await store.get(`quota:gemini:${today}`);
    if (typeof geminiVal === 'number') {
      globalGeminiCount = geminiVal;
    }

    const bgVal = await store.get(`quota:background:${today}`);
    if (bgVal && typeof bgVal === 'object') {
      globalBackgroundRequests = bgVal.requests || 0;
      globalBackgroundTokens = bgVal.tokens || 0;
    }

    const userKeys = await store.keys(`quota:user:${today}:*`);
    for (const key of userKeys) {
      const parts = key.split(':');
      const anonId = parts[parts.length - 1];
      const count = await store.get(key);
      if (anonId && typeof count === 'number') {
        userDailyCounters.set(anonId, count);
      }
    }

    privacyLog('info', 'QUOTAS_RESTORED_FROM_STORE', {
      today,
      activeUsers: userDailyCounters.size,
      globalGeminiCount,
    });
  } catch (err) {
    privacyLog('warn', 'QUOTAS_STORE_LOAD_FAILED', { error: err.message });
  }
}

/**
 * Checks if the UTC day has rolled over and resets counters if needed.
 */
function rolloverIfNewDay() {
  const todayUtc = getUtcDateString();
  if (todayUtc !== currentDateUtc) {
    privacyLog('info', 'DAILY_QUOTA_RESET', {
      previousDate: currentDateUtc,
      newDate: todayUtc,
      userCount: userDailyCounters.size,
      globalGeminiCount,
    });
    userDailyCounters.clear();
    globalGeminiCount = 0;
    globalBackgroundRequests = 0;
    globalBackgroundTokens = 0;
    currentDateUtc = todayUtc;
  }
}

/**
 * Checks and increments the daily request quota for an anonymized user.
 *
 * @param {string} anonId
 * @returns {{ allowed: boolean, userCount: number, userMax: number, reason?: string }}
 */
export function checkAndIncrementUserQuota(anonId) {
  rolloverIfNewDay();

  const userMax = config.MAX_REQUESTS_PER_USER_PER_DAY;
  const geminiMax = config.MAX_GEMINI_REQUESTS_PER_DAY;

  // Check global Gemini budget
  if (globalGeminiCount >= geminiMax) {
    return {
      allowed: false,
      userCount: userDailyCounters.get(anonId) || 0,
      userMax,
      reason: 'gemini_daily_budget_reached',
    };
  }

  // Check individual user daily quota
  const currentCount = userDailyCounters.get(anonId) || 0;
  if (currentCount >= userMax) {
    return {
      allowed: false,
      userCount: currentCount,
      userMax,
      reason: 'user_daily_quota_reached',
    };
  }

  const newCount = currentCount + 1;
  userDailyCounters.set(anonId, newCount);

  // Asynchronously persist to store (48h TTL)
  const today = currentDateUtc;
  const TTL_2DAYS = 48 * 3600;
  store.set(`quota:user:${today}:${anonId}`, newCount, TTL_2DAYS).catch(() => {});

  return {
    allowed: true,
    userCount: newCount,
    userMax,
  };
}

/**
 * Increments global Gemini daily request counter.
 */
export function recordGeminiDailyUsage() {
  rolloverIfNewDay();
  globalGeminiCount++;
  const today = currentDateUtc;
  const TTL_2DAYS = 48 * 3600;
  store.set(`quota:gemini:${today}`, globalGeminiCount, TTL_2DAYS).catch(() => {});
}

/**
 * Checks and increments the daily background learning quota.
 * Ensures autonomous background web-scraping & ingestion never starves user-facing chat budgets.
 *
 * @param {object} [options]
 * @param {number} [options.tokens=500] - Estimated tokens for this background operation
 * @returns {{ allowed: boolean, requests: number, maxRequests: number, tokens: number, maxTokens: number, reason?: string }}
 */
export function checkAndIncrementBackgroundQuota({ tokens = 500 } = {}) {
  rolloverIfNewDay();

  if (globalBackgroundRequests >= MAX_BACKGROUND_LEARN_REQUESTS_PER_DAY) {
    return {
      allowed: false,
      requests: globalBackgroundRequests,
      maxRequests: MAX_BACKGROUND_LEARN_REQUESTS_PER_DAY,
      tokens: globalBackgroundTokens,
      maxTokens: MAX_BACKGROUND_LEARN_TOKENS_PER_DAY,
      reason: 'background_request_budget_reached',
    };
  }

  if (globalBackgroundTokens + tokens > MAX_BACKGROUND_LEARN_TOKENS_PER_DAY) {
    return {
      allowed: false,
      requests: globalBackgroundRequests,
      maxRequests: MAX_BACKGROUND_LEARN_REQUESTS_PER_DAY,
      tokens: globalBackgroundTokens,
      maxTokens: MAX_BACKGROUND_LEARN_TOKENS_PER_DAY,
      reason: 'background_token_budget_reached',
    };
  }

  globalBackgroundRequests += 1;
  globalBackgroundTokens += tokens;

  const today = currentDateUtc;
  const TTL_2DAYS = 48 * 3600;
  store
    .set(`quota:background:${today}`, { requests: globalBackgroundRequests, tokens: globalBackgroundTokens }, TTL_2DAYS)
    .catch(() => {});

  return {
    allowed: true,
    requests: globalBackgroundRequests,
    maxRequests: MAX_BACKGROUND_LEARN_REQUESTS_PER_DAY,
    tokens: globalBackgroundTokens,
    maxTokens: MAX_BACKGROUND_LEARN_TOKENS_PER_DAY,
  };
}

/**
 * Retrieves daily background ingestion usage report.
 * @returns {{ requests: number, maxRequests: number, tokens: number, maxTokens: number, dateUtc: string }}
 */
export function getBackgroundQuotaReport() {
  rolloverIfNewDay();
  return {
    requests: globalBackgroundRequests,
    maxRequests: MAX_BACKGROUND_LEARN_REQUESTS_PER_DAY,
    tokens: globalBackgroundTokens,
    maxTokens: MAX_BACKGROUND_LEARN_TOKENS_PER_DAY,
    dateUtc: currentDateUtc,
  };
}

/**
 * Retrieves daily usage report for an anonymized user.
 * @param {string} anonId
 * @returns {{ userCount: number, userMax: number, geminiCount: number, geminiMax: number, dateUtc: string }}
 */
export function getUserQuotaReport(anonId) {
  rolloverIfNewDay();
  return {
    userCount: userDailyCounters.get(anonId) || 0,
    userMax: config.MAX_REQUESTS_PER_USER_PER_DAY,
    geminiCount: globalGeminiCount,
    geminiMax: config.MAX_GEMINI_REQUESTS_PER_DAY,
    dateUtc: currentDateUtc,
  };
}

/**
 * Resets quota counters manually (used in tests).
 */
export function resetDailyQuotas() {
  userDailyCounters.clear();
  globalGeminiCount = 0;
  globalBackgroundRequests = 0;
  globalBackgroundTokens = 0;
  currentDateUtc = getUtcDateString();
  const today = currentDateUtc;
  store.del(`quota:gemini:${today}`).catch(() => {});
  store.del(`quota:background:${today}`).catch(() => {});
  store
    .keys(`quota:user:${today}:*`)
    .then((keys) => {
      for (const k of keys) store.del(k).catch(() => {});
    })
    .catch(() => {});
}
