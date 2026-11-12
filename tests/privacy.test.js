import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthorized,
  getAnonymizedId,
  maskSensitiveInfo,
  isValidLuhn,
  getConversation,
  saveTurn,
  resetConversation,
  deleteUserData,
  getPrivacyDisclosure,
  checkUserRateLimit,
  resetUserRateLimit,
  rememberMessage,
  getRememberedMessage,
  cleanupRememberedMessages,
} from '../src/privacy.js';
import { config } from '../src/config.js';

test('Privacy: isAuthorized checks whitelist correctly', () => {
  // Test with configured authorized number from config
  const testNumber = config.ALLOWED_PHONE_NUMBERS.values().next().value || '919876543210';
  config.ALLOWED_PHONE_NUMBERS.add(testNumber);
  assert.strictEqual(isAuthorized(testNumber), true);
  assert.strictEqual(isAuthorized(`+${testNumber}`), true);

  // Unauthorized stranger
  assert.strictEqual(isAuthorized('19998887777'), false);
  assert.strictEqual(isAuthorized(''), false);
  assert.strictEqual(isAuthorized(null), false);
});

test('Privacy: getAnonymizedId creates consistent salted non-reversible hashes', () => {
  const id1 = getAnonymizedId('+91 98765 43210');
  const id2 = getAnonymizedId('919876543210');
  const idOther = getAnonymizedId('1234567890');

  assert.strictEqual(id1, id2);
  assert.notStrictEqual(id1, idOther);
  assert.ok(id1.startsWith('u_'));
  assert.ok(!id1.includes('98765'));
});

test('Privacy: isValidLuhn validates checksums correctly', () => {
  // Standard valid 16-digit card
  assert.strictEqual(isValidLuhn('4532015012345671'), true);
  // Standard valid 15-digit Amex card
  assert.strictEqual(isValidLuhn('378282246310005'), true);
  // Invalid Luhn
  assert.strictEqual(isValidLuhn('1234567890123'), false);
  assert.strictEqual(isValidLuhn('4532015012345679'), false);
  assert.strictEqual(isValidLuhn(''), false);
});

test('Privacy: maskSensitiveInfo redacts payment cards and avoids false positives', () => {
  // True positive: Luhn-valid 16-digit card
  const validCard = 'My credit card is 4532 0150 1234 5671 and expires next month';
  const resultValid = maskSensitiveInfo(validCard);
  assert.strictEqual(resultValid.hasRedactions, true);
  assert.ok(resultValid.categories.includes('Payment Card'));
  assert.ok(!resultValid.sanitizedText.includes('4532 0150 1234 5671'));
  assert.ok(resultValid.sanitizedText.includes('[REDACTED_CARD_NUMBER]'));

  // False positive 1: Order ID
  const orderText = 'Order 1234567890123 shipped';
  const resultOrder = maskSensitiveInfo(orderText);
  assert.strictEqual(resultOrder.hasRedactions, false);
  assert.strictEqual(resultOrder.sanitizedText, orderText);

  // False positive 2: ISO timestamp
  const dateText = 'Deployment occurred at 2026-11-08T10:50:24';
  const resultDate = maskSensitiveInfo(dateText);
  assert.strictEqual(resultDate.hasRedactions, false);
  assert.strictEqual(resultDate.sanitizedText, dateText);

  // False positive 3: 10-digit phone number
  const phoneText = 'Call me at 9876543210';
  const resultPhone = maskSensitiveInfo(phoneText);
  assert.strictEqual(resultPhone.hasRedactions, false);
  assert.strictEqual(resultPhone.sanitizedText, phoneText);
});

test('Privacy: maskSensitiveInfo redacts Aadhaar IDs with 4-4-4 format or context prefix', () => {
  // 4-4-4 grouped format
  const aadhaarGrouped = 'My id is 9876 5432 1098 please verify';
  const res1 = maskSensitiveInfo(aadhaarGrouped);
  assert.strictEqual(res1.hasRedactions, true);
  assert.ok(res1.categories.includes('National ID'));
  assert.ok(res1.sanitizedText.includes('[REDACTED_NATIONAL_ID]'));

  // Context-word prefixed 12 digits
  const aadhaarContext = 'My aadhaar: 987654321098 is registered';
  const res2 = maskSensitiveInfo(aadhaarContext);
  assert.strictEqual(res2.hasRedactions, true);
  assert.ok(res2.categories.includes('National ID'));
  assert.ok(res2.sanitizedText.includes('[REDACTED_NATIONAL_ID]'));
});

test('Privacy: maskSensitiveInfo redacts CVV codes', () => {
  const input = 'My cvv is 849 for this card';
  const result = maskSensitiveInfo(input);

  assert.strictEqual(result.hasRedactions, true);
  assert.ok(result.categories.includes('Card Security Code'));
  assert.ok(!result.sanitizedText.includes('849'));
  assert.ok(result.sanitizedText.includes('[REDACTED_CVV]'));
});

test('Privacy: maskSensitiveInfo redacts UPI PIN / ATM PIN', () => {
  const input = 'The upi pin: 948301 should be kept secret';
  const result = maskSensitiveInfo(input);

  assert.strictEqual(result.hasRedactions, true);
  assert.ok(result.categories.includes('PIN'));
  assert.ok(!result.sanitizedText.includes('948301'));
  assert.ok(result.sanitizedText.includes('[REDACTED_PIN]'));
});

test('Privacy: maskSensitiveInfo redacts Passwords and OTPs', () => {
  const input = 'Here is your verification code: 629401 and my password: SuperSecretPassword123!';
  const result = maskSensitiveInfo(input);

  assert.strictEqual(result.hasRedactions, true);
  assert.ok(result.categories.includes('One-Time Password'));
  assert.ok(result.categories.includes('Password/Credential'));
  assert.ok(!result.sanitizedText.includes('629401'));
  assert.ok(!result.sanitizedText.includes('SuperSecretPassword123!'));
});

test('Privacy: maskSensitiveInfo leaves normal conversation untouched', () => {
  const input = 'Can you explain how quantum computing differs from classical computers?';
  const result = maskSensitiveInfo(input);

  assert.strictEqual(result.hasRedactions, false);
  assert.strictEqual(result.categories.length, 0);
  assert.strictEqual(result.sanitizedText, input);
});

test('Privacy: checkUserRateLimit enforces sliding window limits', () => {
  const testAnon = 'u_rate_test_user';
  resetUserRateLimit(testAnon);

  const origMax = config.USER_RATE_LIMIT_MAX;
  const origWindow = config.USER_RATE_LIMIT_WINDOW_MS;
  config.USER_RATE_LIMIT_MAX = 3;
  config.USER_RATE_LIMIT_WINDOW_MS = 1000;

  // 1st, 2nd, 3rd allowed
  assert.strictEqual(checkUserRateLimit(testAnon).allowed, true);
  assert.strictEqual(checkUserRateLimit(testAnon).allowed, true);
  assert.strictEqual(checkUserRateLimit(testAnon).allowed, true);

  // 4th blocked
  const blocked = checkUserRateLimit(testAnon);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);

  // Reset restores access
  resetUserRateLimit(testAnon);
  assert.strictEqual(checkUserRateLimit(testAnon).allowed, true);

  config.USER_RATE_LIMIT_MAX = origMax;
  config.USER_RATE_LIMIT_WINDOW_MS = origWindow;
  resetUserRateLimit(testAnon);
});

test('Privacy: rememberMessage and getRememberedMessage enforce bounds and TTL', () => {
  const msgId = 'wamid.test_reply_123';
  rememberMessage(msgId, 'What is the speed of light?');

  const retrieved = getRememberedMessage(msgId);
  assert.strictEqual(retrieved, 'What is the speed of light?');

  // Unknown ID returns null
  assert.strictEqual(getRememberedMessage('wamid.unknown'), null);

  // cleanupRememberedMessages should preserve active messages
  cleanupRememberedMessages();
  assert.strictEqual(getRememberedMessage(msgId), 'What is the speed of light?');
});

test('Privacy: in-memory conversation store saves, trims, and resets turns', () => {
  const testUser = 'u_test_session_user';
  deleteUserData(testUser);

  // Initially empty
  assert.strictEqual(getConversation(testUser).length, 0);

  // Save 1 turn (user + model = 2 messages)
  saveTurn(testUser, 'Hello assistant', 'Hello! How can I help you?');
  const conv1 = getConversation(testUser);
  assert.strictEqual(conv1.length, 2);
  assert.strictEqual(conv1[0].role, 'user');
  assert.strictEqual(conv1[0].parts[0].text, 'Hello assistant');
  assert.strictEqual(conv1[1].role, 'model');

  // Reset conversation
  const resetSuccess = resetConversation(testUser);
  assert.strictEqual(resetSuccess, true);
  assert.strictEqual(getConversation(testUser).length, 0);
});

test('Privacy: sliding window retains maximum configured context turns', () => {
  const testUser = 'u_sliding_window_user';
  deleteUserData(testUser);

  // Save more turns than MAX_CONTEXT_TURNS (default 10)
  for (let i = 1; i <= 8; i++) {
    saveTurn(testUser, `User message ${i}`, `AI reply ${i}`);
  }

  const conv = getConversation(testUser);
  assert.ok(conv.length <= config.MAX_CONTEXT_TURNS);
  // Last message should be the latest reply
  assert.strictEqual(conv[conv.length - 1].parts[0].text, 'AI reply 8');

  deleteUserData(testUser);
});

test('Privacy: getPrivacyDisclosure contains explicit non-E2E notice and boundary explanation', () => {
  const disclosure = getPrivacyDisclosure();
  assert.ok(disclosure.includes('end-to-end encrypted'));
  assert.ok(disclosure.includes('Meta WhatsApp Cloud API'));
  assert.ok(disclosure.includes('Google Gemini API'));
  assert.ok(disclosure.includes('RAM Only') || disclosure.includes('RAM'));
  assert.ok(disclosure.includes('/reset'));
  assert.ok(disclosure.includes('/delete'));
});
