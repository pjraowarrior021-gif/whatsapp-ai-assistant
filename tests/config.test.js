import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, maskSecret, validateConfig, parseFallbackModels, config } from '../src/config.js';

test('Config: normalizePhoneNumber should strip non-digits', () => {
  assert.strictEqual(normalizePhoneNumber('+91 98765-43210'), '919876543210');
  assert.strictEqual(normalizePhoneNumber('+1 (415) 555-2671'), '14155552671');
  assert.strictEqual(normalizePhoneNumber('919876543210'), '919876543210');
  assert.strictEqual(normalizePhoneNumber(''), '');
  assert.strictEqual(normalizePhoneNumber(null), '');
});

test('Config: maskSecret should properly redact secrets for diagnostics', () => {
  assert.strictEqual(maskSecret(''), '[NOT_SET]');
  assert.strictEqual(maskSecret(null), '[NOT_SET]');
  assert.strictEqual(maskSecret('short'), '******');
  assert.strictEqual(maskSecret('AIzaSy1234567890abcdef'), 'AIz***def');
  assert.strictEqual(maskSecret('EAAG1234567890ABCDEF'), 'EAA***DEF');
});

test('Config: parseFallbackModels de-duplicates and excludes primary model', () => {
  const primary = 'gemini-3.5-flash-lite';
  const raw = 'gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash, gemini-3.1-flash-lite';
  const parsed = parseFallbackModels(raw, primary);

  assert.deepStrictEqual(parsed, ['gemini-3.1-flash-lite', 'gemini-3.5-flash']);
  assert.ok(!parsed.includes(primary));
});

test('Config: validateConfig returns validation status and warnings', () => {
  const result = validateConfig();
  assert.ok(typeof result.valid === 'boolean');
  assert.ok(Array.isArray(result.errors));
  assert.ok(Array.isArray(result.warnings));
});

test('Config: validateConfig hard-fails in production if SKIP_SIGNATURE_VERIFICATION is enabled', () => {
  const originalEnv = config.NODE_ENV;
  const originalSkip = config.SKIP_SIGNATURE_VERIFICATION;

  config.NODE_ENV = 'production';
  config.SKIP_SIGNATURE_VERIFICATION = true;

  const result = validateConfig();
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('SKIP_SIGNATURE_VERIFICATION')));

  config.NODE_ENV = originalEnv;
  config.SKIP_SIGNATURE_VERIFICATION = originalSkip;
});

test('Config: validateConfig hard-fails in production when WHATSAPP_APP_SECRET is missing or placeholder', () => {
  const originalEnv = config.NODE_ENV;
  const originalSecret = config.WHATSAPP_APP_SECRET;

  config.NODE_ENV = 'production';

  // 1. Unset secret
  config.WHATSAPP_APP_SECRET = '';
  const resEmpty = validateConfig();
  assert.strictEqual(resEmpty.valid, false);
  assert.ok(resEmpty.errors.some((e) => e.includes('WHATSAPP_APP_SECRET')));

  // 2. Placeholder secret
  config.WHATSAPP_APP_SECRET = 'test_meta_app_secret_123';
  const resPlaceholder = validateConfig();
  assert.strictEqual(resPlaceholder.valid, false);
  assert.ok(resPlaceholder.errors.some((e) => e.includes('WHATSAPP_APP_SECRET')));

  config.NODE_ENV = originalEnv;
  config.WHATSAPP_APP_SECRET = originalSecret;
});
