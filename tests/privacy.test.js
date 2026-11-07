import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthorized,
  getAnonymizedId,
  maskSensitiveInfo,
  privacyLog,
  getConversation,
  saveTurn,
  resetConversation,
  deleteUserData,
  cleanupExpiredSessions,
  getPrivacyDisclosure,
} from '../src/privacy.js';
import { config } from '../src/config.js';

test('Privacy: isAuthorized checks whitelist correctly', () => {
  // Test with configured authorized number from config
  const firstNumber = config.ALLOWED_PHONE_NUMBERS.values().next().value || '918217426307';
  assert.strictEqual(isAuthorized(firstNumber), true);
  assert.strictEqual(isAuthorized(`+${firstNumber}`), true);

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

test('Privacy: maskSensitiveInfo redacts payment cards', () => {
  const input = 'My credit card is 4532 0150 1234 5678 and expires next month';
  const result = maskSensitiveInfo(input);

  assert.strictEqual(result.hasRedactions, true);
  assert.ok(result.categories.includes('Payment Card'));
  assert.ok(!result.sanitizedText.includes('4532 0150 1234 5678'));
  assert.ok(result.sanitizedText.includes('[REDACTED_CARD_NUMBER]'));
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
