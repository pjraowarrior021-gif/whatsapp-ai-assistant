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
 * Application Configuration Object
 */
export const config = {
  // Server Configuration
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Google Gemini AI Configuration
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  GEMINI_MAX_OUTPUT_TOKENS: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 1024,
  GEMINI_TEMPERATURE: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.7,

  // WhatsApp Cloud API Configuration
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || '',
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || '',
  WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION || 'v21.0',

  // Privacy & Access Control Configuration
  ALLOWED_PHONE_NUMBERS: parseAllowedNumbers(process.env.ALLOWED_PHONE_NUMBERS),
  SESSION_TIMEOUT_MINUTES: parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 15,
  MAX_CONTEXT_TURNS: parseInt(process.env.MAX_CONTEXT_TURNS, 10) || 10, // 5 user + 5 assistant turns
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_PER_WINDOW: parseInt(process.env.RATE_LIMIT_MAX_PER_WINDOW, 10) || 20, // 20 requests per minute
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
    warnings.push('WHATSAPP_APP_SECRET is not set. Meta Webhook HMAC-SHA256 signature verification will be bypassed in dev mode.');
  }

  // Access Control Warning
  if (config.ALLOWED_PHONE_NUMBERS.size === 0) {
    warnings.push('ALLOWED_PHONE_NUMBERS is empty. All incoming messages will be rejected by default to prevent unauthorized access.');
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
    gemini: {
      model: config.GEMINI_MODEL,
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
    privacy: {
      authorizedNumbersCount: config.ALLOWED_PHONE_NUMBERS.size,
      sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES,
      maxContextTurns: config.MAX_CONTEXT_TURNS,
      rateLimitMaxPerMinute: config.RATE_LIMIT_MAX_PER_WINDOW,
    },
  };
}
