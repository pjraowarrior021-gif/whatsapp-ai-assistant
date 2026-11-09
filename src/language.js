/**
 * Multilingual Translation & Response Directives
 * Supports setting per-user target language preferences with automatic detection
 * and localized system prompts for Google Gemini.
 */
import { store } from './store/index.js';
import { privacyLog } from './privacy.js';

export const SUPPORTED_LANGUAGES = {
  auto: { name: 'Auto-Detect', native: 'Automatic' },
  en: { name: 'English', native: 'English' },
  hi: { name: 'Hindi', native: 'हिन्दी' },
  ta: { name: 'Tamil', native: 'தமிழ்' },
  te: { name: 'Telugu', native: 'తెలుగు' },
  bn: { name: 'Bengali', native: 'বাংলা' },
  mr: { name: 'Marathi', native: 'मराठी' },
  gu: { name: 'Gujarati', native: 'ગુજરાતી' },
  kn: { name: 'Kannada', native: 'ಕನ್ನಡ' },
  ml: { name: 'Malayalam', native: 'മലയാളം' },
  pa: { name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  or: { name: 'Odia', native: 'ଓଡ଼ିଆ' },
  ur: { name: 'Urdu', native: 'اردو' },
  es: { name: 'Spanish', native: 'Español' },
  fr: { name: 'French', native: 'Français' },
  de: { name: 'German', native: 'Deutsch' },
  ar: { name: 'Arabic', native: 'العربية' },
};

// Fast in-memory cache for synchronous reads during prompt construction
const userLanguageCache = new Map();

/**
 * Initializes user language preferences from storage.
 * @param {string} anonId
 * @returns {Promise<string>}
 */
export async function loadUserLanguage(anonId) {
  if (userLanguageCache.has(anonId)) {
    return userLanguageCache.get(anonId);
  }
  try {
    const saved = await store.get(`user:lang:${anonId}`);
    if (saved && SUPPORTED_LANGUAGES[saved]) {
      userLanguageCache.set(anonId, saved);
      return saved;
    }
  } catch (err) {
    privacyLog('debug', 'LOAD_USER_LANGUAGE_FALLBACK', { error: err.message });
  }
  userLanguageCache.set(anonId, 'auto');
  return 'auto';
}

/**
 * Gets the active language code for a user.
 * @param {string} anonId
 * @returns {string}
 */
export function getUserLanguage(anonId) {
  return userLanguageCache.get(anonId) || 'auto';
}

/**
 * Sets user language preference.
 * @param {string} anonId
 * @param {string} langCode
 * @returns {Promise<boolean>}
 */
export async function setUserLanguage(anonId, langCode) {
  const code = String(langCode || '')
    .toLowerCase()
    .trim();
  if (!SUPPORTED_LANGUAGES[code]) {
    return false;
  }
  userLanguageCache.set(anonId, code);
  try {
    await store.set(`user:lang:${anonId}`, code);
  } catch (err) {
    privacyLog('warn', 'SET_USER_LANGUAGE_STORE_FAILED', { error: err.message });
  }
  privacyLog('info', 'USER_LANGUAGE_CHANGED', { user: anonId, lang: code });
  return true;
}

/**
 * Generates system prompt instruction for Gemini based on user's language preference.
 * @param {string} langCode
 * @returns {string}
 */
export function getLanguageInstruction(langCode = 'auto') {
  if (langCode === 'auto' || !SUPPORTED_LANGUAGES[langCode]) {
    return 'Language Directive: Respond naturally in the exact same language, dialect, and script used by the user.';
  }
  const lang = SUPPORTED_LANGUAGES[langCode];
  return `Language Directive: You MUST formulate your entire response in ${lang.name} (${lang.native}). Use fluent, native phrasing and correct grammar.`;
}

/**
 * Formats supported languages list for user display.
 * @returns {string}
 */
export function formatSupportedLanguages() {
  const lines = ['🌐 *Supported Languages for Assistant:*', ''];
  for (const [code, info] of Object.entries(SUPPORTED_LANGUAGES)) {
    lines.push(`• \`/language ${code}\` - ${info.name} (${info.native})`);
  }
  lines.push('');
  lines.push('_Example:_ `/language hi` or `/language auto`');
  return lines.join('\n');
}

/**
 * Handles `/language` command invocation.
 * @param {string} anonId
 * @param {string} arg
 * @returns {Promise<string>}
 */
export async function handleLanguageCommand(anonId, arg) {
  const cleanArg = String(arg || '')
    .trim()
    .toLowerCase();

  if (!cleanArg || cleanArg === 'list') {
    const current = getUserLanguage(anonId);
    const currInfo = SUPPORTED_LANGUAGES[current] || SUPPORTED_LANGUAGES.auto;
    return `🌐 *Current Language:* ${currInfo.name} (\`${current}\`)\n\n${formatSupportedLanguages()}`;
  }

  const success = await setUserLanguage(anonId, cleanArg);
  if (success) {
    const lang = SUPPORTED_LANGUAGES[cleanArg];
    return `✅ *Language Updated:* The assistant will now reply in *${lang.name} (${lang.native})*.\n\n_To reset to automatic language detection, send \`/language auto\`._`;
  }

  return `⚠️ *Unknown Language:* \`${cleanArg}\`\n\n${formatSupportedLanguages()}`;
}
