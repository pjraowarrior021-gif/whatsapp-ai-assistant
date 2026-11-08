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

test('Config: validateConfig warns if SKIP_SIGNATURE_VERIFICATION is enabled outside test', () => {
  const originalEnv = config.NODE_ENV;
  const originalSkip = config.SKIP_SIGNATURE_VERIFICATION;

  config.NODE_ENV = 'production';
  config.SKIP_SIGNATURE_VERIFICATION = true;

  const result = validateConfig();
  assert.ok(result.warnings.some((w) => w.includes('SKIP_SIGNATURE_VERIFICATION')));

  config.NODE_ENV = originalEnv;
  config.SKIP_SIGNATURE_VERIFICATION = originalSkip;
});
