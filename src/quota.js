/**
 * Daily Quota Management Module
 * Tracks per-user and global daily request limits in memory, resetting on UTC date rollover.
 */
import { config } from './config.js';
import { privacyLog } from './privacy.js';

let currentDateUtc = getUtcDateString();
const userDailyCounters = new Map(); // Map<anonId, number>
let globalGeminiCount = 0;

/**
 * Returns current UTC date string in 'YYYY-MM-DD' format.
 * @returns {string}
 */
export function getUtcDateString() {
  return new Date().toISOString().slice(0, 10);
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

  userDailyCounters.set(anonId, currentCount + 1);
  return {
    allowed: true,
    userCount: currentCount + 1,
    userMax,
  };
}

/**
 * Increments global Gemini daily request counter.
 */
export function recordGeminiDailyUsage() {
  rolloverIfNewDay();
  globalGeminiCount++;
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
  currentDateUtc = getUtcDateString();
}
