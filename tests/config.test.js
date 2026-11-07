import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, maskSecret, validateConfig, config } from '../src/config.js';

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

test('Config: validateConfig returns validation status and warnings', () => {
  const result = validateConfig();
  assert.ok(typeof result.valid === 'boolean');
  assert.ok(Array.isArray(result.errors));
  assert.ok(Array.isArray(result.warnings));
});
