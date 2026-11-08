import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Normalizes phone numbers by stripping non-digit characters (+, spaces, hyphens).
 * @param {string} phone
 * @returns {string}
 */
export function normalizePhoneNumber(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * Parses a comma-separated string of authorized phone numbers.
 * @param {string} rawList
 * @returns {Set<string>}
 */
function parseAllowedNumbers(rawList) {
  if (!rawList) return new Set();
  const list = rawList
    .split(',')
    .map((num) => normalizePhoneNumber(num.trim()))
    .filter((num) => num.length > 0);
  return new Set(list);
}

/**
 * Parses and de-duplicates fallback Gemini models, excluding the primary model.
 * @param {string} rawList
 * @param {string} primaryModel
 * @returns {string[]}
 */
export function parseFallbackModels(rawList, primaryModel) {
  const defaults = 'gemini-3.1-flash-lite,gemini-3.5-flash';
  const source = typeof rawList === 'string' ? rawList : defaults;
  const list = source
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && m !== primaryModel);
  return [...new Set(list)];
}

const primaryGeminiModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

/**
 * Application Configuration Object
 */
export const config = {
  // Server Configuration
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_FORMAT: process.env.LOG_FORMAT || 'text',

  // Google Gemini AI Configuration
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: primaryGeminiModel,
  GEMINI_FALLBACK_MODELS: parseFallbackModels(process.env.GEMINI_FALLBACK_MODELS, primaryGeminiModel),
  GEMINI_MAX_OUTPUT_TOKENS: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 1024,
  GEMINI_TEMPERATURE: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.7,
  ENABLE_SEARCH_GROUNDING: process.env.ENABLE_SEARCH_GROUNDING === 'true',

  // WhatsApp Cloud API Configuration
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || '',
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || '',
  WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION || 'v21.0',
  SKIP_SIGNATURE_VERIFICATION: process.env.SKIP_SIGNATURE_VERIFICATION === 'true',

  // Media Download Hardening
  MEDIA_MAX_BYTES: parseInt(process.env.MEDIA_MAX_BYTES, 10) || 16 * 1024 * 1024, // 16MB
  MEDIA_FETCH_TIMEOUT_MS: parseInt(process.env.MEDIA_FETCH_TIMEOUT_MS, 10) || 15000, // 15 seconds

  // Privacy & Access Control Configuration
  ALLOWED_PHONE_NUMBERS: parseAllowedNumbers(process.env.ALLOWED_PHONE_NUMBERS),
  SESSION_TIMEOUT_MINUTES: parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 15,
  MAX_CONTEXT_TURNS: parseInt(process.env.MAX_CONTEXT_TURNS, 10) || 10, // 5 user + 5 assistant turns
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_PER_WINDOW: parseInt(process.env.RATE_LIMIT_MAX_PER_WINDOW, 10) || 20, // 20 requests per minute
  USER_RATE_LIMIT_MAX: parseInt(process.env.USER_RATE_LIMIT_MAX, 10) || 10, // 10 requests per user per window
  USER_RATE_LIMIT_WINDOW_MS: parseInt(process.env.USER_RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // 1 minute

  // Quotas & Reminders
  MAX_REQUESTS_PER_USER_PER_DAY: parseInt(process.env.MAX_REQUESTS_PER_USER_PER_DAY, 10) || 200,
  MAX_GEMINI_REQUESTS_PER_DAY: parseInt(process.env.MAX_GEMINI_REQUESTS_PER_DAY, 10) || 1400,
  REMINDERS_PERSIST: process.env.REMINDERS_PERSIST === 'true',
};

/**
 * Validates critical environment variables and returns a diagnostic report.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateConfig() {
  const errors = [];
  const warnings = [];

  // Critical for Gemini
  if (!config.GEMINI_API_KEY) {
    errors.push('Missing GEMINI_API_KEY. Obtain a free key from https://aistudio.google.com/apikey');
  }

  // Critical for WhatsApp Cloud API
  if (!config.WHATSAPP_TOKEN) {
    errors.push('Missing WHATSAPP_TOKEN (Meta System User or User Access Token).');
  }
  if (!config.WHATSAPP_PHONE_NUMBER_ID) {
    errors.push('Missing WHATSAPP_PHONE_NUMBER_ID from Meta WhatsApp App dashboard.');
  }
  if (!config.WHATSAPP_VERIFY_TOKEN) {
    errors.push('Missing WHATSAPP_VERIFY_TOKEN (custom verification token for webhook handshake).');
  }
  if (!config.WHATSAPP_APP_SECRET) {
    warnings.push(
      'WHATSAPP_APP_SECRET is not set. Meta Webhook HMAC-SHA256 signature verification will be bypassed in dev mode.'
    );
  } else if (config.WHATSAPP_APP_SECRET.includes('test_meta_app_secret')) {
    warnings.push(
      'WHATSAPP_APP_SECRET is set to placeholder "test_meta_app_secret". HMAC signature verification is bypassed until your real Meta App Secret is configured in .env and Railway.'
    );
  }

  // Access Control Warning
  if (config.ALLOWED_PHONE_NUMBERS.size === 0) {
    warnings.push(
      'ALLOWED_PHONE_NUMBERS is empty. All incoming messages will be rejected by default to prevent unauthorized access.'
    );
  }

  // Security check for signature verification bypass
  if (config.SKIP_SIGNATURE_VERIFICATION && config.NODE_ENV !== 'test') {
    warnings.push(
      'CRITICAL: SKIP_SIGNATURE_VERIFICATION is enabled outside of test environment! Webhook HMAC validation is inactive.'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Safely masks sensitive secret strings for diagnostic logging.
 * @param {string} str
 * @returns {string}
 */
export function maskSecret(str) {
  if (!str) return '[NOT_SET]';
  if (str.length <= 6) return '******';
  return `${str.substring(0, 3)}***${str.substring(str.length - 3)}`;
}

/**
 * Generates a privacy-safe diagnostic summary of the current configuration.
 * @returns {object}
 */
export function getSafeConfigSummary() {
  return {
    environment: config.NODE_ENV,
    port: config.PORT,
    logFormat: config.LOG_FORMAT,
    gemini: {
      model: config.GEMINI_MODEL,
      fallbackModels: config.GEMINI_FALLBACK_MODELS,
      searchGrounding: config.ENABLE_SEARCH_GROUNDING,
      maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
      temperature: config.GEMINI_TEMPERATURE,
      hasApiKey: Boolean(config.GEMINI_API_KEY),
      apiKeyMasked: maskSecret(config.GEMINI_API_KEY),
    },
    whatsapp: {
      apiVersion: config.WHATSAPP_API_VERSION,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID || '[NOT_SET]',
      hasToken: Boolean(config.WHATSAPP_TOKEN),
      tokenMasked: maskSecret(config.WHATSAPP_TOKEN),
      hasVerifyToken: Boolean(config.WHATSAPP_VERIFY_TOKEN),
      hasAppSecret: Boolean(config.WHATSAPP_APP_SECRET),
    },
    media: {
      maxBytes: config.MEDIA_MAX_BYTES,
      fetchTimeoutMs: config.MEDIA_FETCH_TIMEOUT_MS,
    },
    privacy: {
      authorizedNumbersCount: config.ALLOWED_PHONE_NUMBERS.size,
      sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES,
      maxContextTurns: config.MAX_CONTEXT_TURNS,
      rateLimitMaxPerMinute: config.RATE_LIMIT_MAX_PER_WINDOW,
      userRateLimitMax: config.USER_RATE_LIMIT_MAX,
      userRateLimitWindowMs: config.USER_RATE_LIMIT_WINDOW_MS,
      dailyQuotaUser: config.MAX_REQUESTS_PER_USER_PER_DAY,
      dailyQuotaGemini: config.MAX_GEMINI_REQUESTS_PER_DAY,
      remindersPersist: config.REMINDERS_PERSIST,
    },
  };
}
