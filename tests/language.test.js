import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_LANGUAGES,
  getUserLanguage,
  setUserLanguage,
  getLanguageInstruction,
  handleLanguageCommand,
} from '../src/language.js';

test('Language: defaults to auto and allows setting supported languages', async () => {
  assert.ok(SUPPORTED_LANGUAGES.en);
  assert.ok(SUPPORTED_LANGUAGES.hi);
  const anonId = 'u_lang_test_1';
  assert.strictEqual(getUserLanguage(anonId), 'auto');

  // Set to Hindi
  const successHi = await setUserLanguage(anonId, 'hi');
  assert.strictEqual(successHi, true);
  assert.strictEqual(getUserLanguage(anonId), 'hi');

  // Set to invalid language rejected
  const successInvalid = await setUserLanguage(anonId, 'kryptonian');
  assert.strictEqual(successInvalid, false);
  assert.strictEqual(getUserLanguage(anonId), 'hi');
});

test('Language: getLanguageInstruction generates targeted Gemini system directive', () => {
  const autoDirective = getLanguageInstruction('auto');
  assert.ok(autoDirective.includes('exact same language'));

  const hiDirective = getLanguageInstruction('hi');
  assert.ok(hiDirective.includes('Hindi'));
  assert.ok(hiDirective.includes('हिन्दी'));

  const taDirective = getLanguageInstruction('ta');
  assert.ok(taDirective.includes('Tamil'));
});

test('Language: handleLanguageCommand provides interactive responses', async () => {
  const anonId = 'u_lang_cmd_user';

  // 1. List
  const listReply = await handleLanguageCommand(anonId, 'list');
  assert.ok(listReply.includes('Supported Languages'));
  assert.ok(listReply.includes('/language hi'));

  // 2. Set valid language
  const setReply = await handleLanguageCommand(anonId, 'fr');
  assert.ok(setReply.includes('French'));
  assert.strictEqual(getUserLanguage(anonId), 'fr');

  // 3. Reset to auto
  const resetReply = await handleLanguageCommand(anonId, 'auto');
  assert.ok(resetReply.includes('Auto-Detect'));
  assert.strictEqual(getUserLanguage(anonId), 'auto');
});
