import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAndIncrementUserQuota,
  recordGeminiDailyUsage,
  getUserQuotaReport,
  resetDailyQuotas,
} from '../src/quota.js';
import { config } from '../src/config.js';

test('Quota: enforces user daily request limit and blocks when exceeded', () => {
  resetDailyQuotas();
  const testUser = 'u_quota_test_user';

  const origMax = config.MAX_REQUESTS_PER_USER_PER_DAY;
  config.MAX_REQUESTS_PER_USER_PER_DAY = 3;

  // Requests 1, 2, 3 allowed
  assert.strictEqual(checkAndIncrementUserQuota(testUser).allowed, true);
  assert.strictEqual(checkAndIncrementUserQuota(testUser).allowed, true);
  assert.strictEqual(checkAndIncrementUserQuota(testUser).allowed, true);

  // Request 4 blocked
  const res4 = checkAndIncrementUserQuota(testUser);
  assert.strictEqual(res4.allowed, false);
  assert.strictEqual(res4.reason, 'user_daily_quota_reached');

  const report = getUserQuotaReport(testUser);
  assert.strictEqual(report.userCount, 3);
  assert.strictEqual(report.userMax, 3);

  config.MAX_REQUESTS_PER_USER_PER_DAY = origMax;
  resetDailyQuotas();
});

test('Quota: enforces global Gemini daily budget limit', () => {
  resetDailyQuotas();
  const testUser = 'u_gemini_quota_user';

  const origGeminiMax = config.MAX_GEMINI_REQUESTS_PER_DAY;
  config.MAX_GEMINI_REQUESTS_PER_DAY = 2;

  recordGeminiDailyUsage();
  recordGeminiDailyUsage();

  const res = checkAndIncrementUserQuota(testUser);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'gemini_daily_budget_reached');

  config.MAX_GEMINI_REQUESTS_PER_DAY = origGeminiMax;
  resetDailyQuotas();
});
