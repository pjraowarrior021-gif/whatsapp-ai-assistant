import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Default timezone to Indian Standard Time (Asia/Kolkata, UTC+5:30) if not explicitly set
const defaultTimezone = process.env.TIMEZONE || 'Asia/Kolkata';
process.env.TIMEZONE = defaultTimezone;
process.env.TZ = defaultTimezone;

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
const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  process.execArgv.includes('--test') ||
  process.argv.some((a) => a.includes('test'));

function parseAllowedNumbers(rawList) {
  const fallback = isTestEnv ? '919876543210,910000000000' : '';
  const source = rawList || fallback;
  if (!source) return new Set();
  const list = source
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
  const defaults = 'gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.8-flash';
  const source = typeof rawList === 'string' ? rawList : defaults;
  const list = source
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && m !== primaryModel);
  return [...new Set(list)];
}

const primaryGeminiModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

/**
 * Application Configuration Object
 */
export const config = {
  // Server Configuration
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || (isTestEnv ? 'test' : 'development'),
  LOG_FORMAT: process.env.LOG_FORMAT || 'text',
  OPS_TOKEN: process.env.OPS_TOKEN || '',

  // Google Gemini AI Configuration
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || (isTestEnv ? 'mock_test_gemini_key' : ''),
  GEMINI_MODEL: primaryGeminiModel,
  GEMINI_FALLBACK_MODELS: parseFallbackModels(process.env.GEMINI_FALLBACK_MODELS, primaryGeminiModel),
  GEMINI_MAX_OUTPUT_TOKENS: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 1024,
  GEMINI_TEMPERATURE: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.7,
  ENABLE_SEARCH_GROUNDING: process.env.ENABLE_SEARCH_GROUNDING === 'true',

  // WhatsApp Cloud API Configuration
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || (isTestEnv ? 'mock_test_token' : ''),
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || (isTestEnv ? '123456789012345' : ''),
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || (isTestEnv ? 'mock_verify_token' : ''),
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || (isTestEnv ? 'mock_test_app_secret' : ''),
  WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION || 'v21.0',
  SKIP_SIGNATURE_VERIFICATION: process.env.SKIP_SIGNATURE_VERIFICATION === 'true',
  ENABLE_CONTEXTUAL_REACTIONS: process.env.ENABLE_CONTEXTUAL_REACTIONS !== 'false',

  // Media Download Hardening (Aligned with WhatsApp Cloud API 100MB document limit)
  MEDIA_MAX_BYTES: parseInt(process.env.MEDIA_MAX_BYTES, 10) || 100 * 1024 * 1024, // 100MB
  MEDIA_FETCH_TIMEOUT_MS: parseInt(process.env.MEDIA_FETCH_TIMEOUT_MS, 10) || 60000, // 60 seconds

  // AI Media & Video Generation Configuration
  VIDEO_ENGINE: process.env.VIDEO_ENGINE || 'free', // 'free' (Hugging Face ZeroGPU AI Video / Storyboard), 'storyboard', 'gradio', or 'motion'
  VIDEO_MODEL: process.env.VIDEO_MODEL || 'storyboard', // 'storyboard' (Gemini+FLUX.1 4-Stage Diffusion), 'wan2.1' (Alibaba Wan 2.1), or 'animatediff'
  VIDEO_DEFAULT_DURATION: parseInt(process.env.VIDEO_DEFAULT_DURATION, 10) || 12, // Minimum 10 to 15 seconds (default: 12s)
  HF_TOKEN: process.env.HF_TOKEN || '', // Optional Hugging Face access token for ZeroGPU Spaces
  POLLINATIONS_API_KEY: process.env.POLLINATIONS_API_KEY || '',
  POLLINATIONS_VIDEO_MODEL: process.env.POLLINATIONS_VIDEO_MODEL || 'alibaba/wan-2.2-fast',

  // Privacy & Access Control Configuration
  ALLOWED_PHONE_NUMBERS: parseAllowedNumbers(process.env.ALLOWED_PHONE_NUMBERS),
  SESSION_TIMEOUT_MINUTES: parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 15,
  MAX_CONTEXT_TURNS: parseInt(process.env.MAX_CONTEXT_TURNS, 10) || 10, // 5 user + 5 assistant turns
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_PER_WINDOW: parseInt(process.env.RATE_LIMIT_MAX_PER_WINDOW, 10) || 20, // 20 requests per minute
  USER_RATE_LIMIT_MAX: parseInt(process.env.USER_RATE_LIMIT_MAX, 10) || 10, // 10 requests per user per window
  USER_RATE_LIMIT_WINDOW_MS: parseInt(process.env.USER_RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // 1 minute

  // Storage & State Configuration
  STATE_BACKEND: process.env.STATE_BACKEND || (process.env.REDIS_URL ? 'redis' : 'memory'),
  REDIS_URL: process.env.REDIS_URL || '',
  DATA_DIR: process.env.DATA_DIR || path.resolve(__dirname, '../.data'),

  // Quotas & Reminders
  MAX_REQUESTS_PER_USER_PER_DAY: parseInt(process.env.MAX_REQUESTS_PER_USER_PER_DAY, 10) || 200,
  MAX_GEMINI_REQUESTS_PER_DAY: parseInt(process.env.MAX_GEMINI_REQUESTS_PER_DAY, 10) || 1400,
  REMINDERS_PERSIST: process.env.REMINDERS_PERSIST === 'true',
  TIMEZONE: process.env.TIMEZONE || 'Asia/Kolkata',
  TIMEZONE_OFFSET_HOURS:
    process.env.TIMEZONE_OFFSET_HOURS !== undefined ? parseFloat(process.env.TIMEZONE_OFFSET_HOURS) : 5.5,

  // Message Queue & Concurrency
  MESSAGE_CONCURRENCY: parseInt(process.env.MESSAGE_CONCURRENCY, 10) || 4,
  QUEUE_MAX_RETRIES: parseInt(process.env.QUEUE_MAX_RETRIES, 10) || 3,
  QUEUE_MAX_SIZE: parseInt(process.env.QUEUE_MAX_SIZE, 10) || 1000,
  SHUTDOWN_TIMEOUT_MS: parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10000,

  // Feature Flags & Extended Integrations
  ENABLE_AI_TOOLS: process.env.ENABLE_AI_TOOLS === 'true',
  ALLOWED_GROUP_IDS: parseAllowedNumbers(process.env.ALLOWED_GROUP_IDS),
  GROUP_TRIGGER_PREFIX: process.env.GROUP_TRIGGER_PREFIX || '/',
  TEMPLATE_DIGEST_NAME: process.env.TEMPLATE_DIGEST_NAME || '',
  TEMPLATE_DIGEST_LANG: process.env.TEMPLATE_DIGEST_LANG || 'en',

  // Speech-to-Text & Inbound Voice Notes
  STT_ENGINE: process.env.STT_ENGINE || 'gemini',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  // Human-in-the-Loop & Approval Gate
  APPROVAL_TIMEOUT_SECONDS: parseInt(process.env.APPROVAL_TIMEOUT_SECONDS, 10) || 600,

  // 24-Hour Session Window & Templates
  TEMPLATE_PROACTIVE_NAME: process.env.TEMPLATE_PROACTIVE_NAME || 'utility_reminder_notification',
  TEMPLATE_PROACTIVE_LANG: process.env.TEMPLATE_PROACTIVE_LANG || 'en',

  // MCP External Tools
  MCP_SERVERS: process.env.MCP_SERVERS || '',

  // Topic & Compliance Guardrails
  ENABLE_GUARDRAILS: process.env.ENABLE_GUARDRAILS !== 'false',
  GUARDRAIL_ALLOWED_DOMAINS: process.env.GUARDRAIL_ALLOWED_DOMAINS || 'assistant,coding,productivity,media,research',

  // 2026 Image Generation Pipeline
  IMAGE_MODEL_FAST: process.env.IMAGE_MODEL_FAST || 'gemini-3.1-flash-image',
  IMAGE_MODEL_PRO: process.env.IMAGE_MODEL_PRO || 'gemini-3-pro-image',
  IMAGE_CACHE_TTL_DAYS: parseInt(process.env.IMAGE_CACHE_TTL_DAYS, 10) || 25,

  // ---------------------------------------------------------------------
  // Autonomous Group Administrator
  // ---------------------------------------------------------------------
  // Master switch for the group subsystem. Groups are ALWAYS disabled by
  // default regardless of this flag; it only controls whether the subsystem
  // is wired into the message pipeline at all.
  GROUP_ADMIN_ENABLED: process.env.GROUP_ADMIN_ENABLED !== 'false',
  GROUP_ADMIN_DATA_DIR: process.env.GROUP_ADMIN_DATA_DIR || '',
  // Explicitly import legacy ALLOWED_GROUP_IDS as enabled groups (these were
  // already an explicit opt-in via environment config). Never applies to
  // newly discovered groups.
  GROUP_ADMIN_IMPORT_LEGACY: process.env.GROUP_ADMIN_IMPORT_LEGACY !== 'false',
  GROUP_ADMIN_DEFAULT_PERSONA: process.env.GROUP_ADMIN_DEFAULT_PERSONA || 'professional',
  GROUP_ADMIN_BOT_ALIASES: process.env.GROUP_ADMIN_BOT_ALIASES || 'ai,assistant,bot,admin',
  GROUP_ADMIN_CONTEXT_MESSAGES: parseInt(process.env.GROUP_ADMIN_CONTEXT_MESSAGES, 10) || 24,
  GROUP_ADMIN_HISTORY_TTL_MINUTES: parseInt(process.env.GROUP_ADMIN_HISTORY_TTL_MINUTES, 10) || 360,
  GROUP_ADMIN_MAX_REPLIES_PER_HOUR: parseInt(process.env.GROUP_ADMIN_MAX_REPLIES_PER_HOUR, 10) || 30,
  GROUP_ADMIN_REPLY_COOLDOWN_MS: parseInt(process.env.GROUP_ADMIN_REPLY_COOLDOWN_MS, 10) || 15000,
  GROUP_ADMIN_QUEUE_CONCURRENCY: parseInt(process.env.GROUP_ADMIN_QUEUE_CONCURRENCY, 10) || 2,
  GROUP_ADMIN_AUDIT_MAX_ENTRIES: parseInt(process.env.GROUP_ADMIN_AUDIT_MAX_ENTRIES, 10) || 2000,
  GROUP_ADMIN_HUMAN_ADMINS: process.env.GROUP_ADMIN_HUMAN_ADMINS || '',
  GROUP_ADMIN_REPORT_HOUR: parseInt(process.env.GROUP_ADMIN_REPORT_HOUR, 10) || 21,
  GROUP_ADMIN_REPORT_TIMEZONE: process.env.GROUP_ADMIN_REPORT_TIMEZONE || process.env.TIMEZONE || 'Asia/Kolkata',
  GROUP_ADMIN_REQUIRE_APPROVAL: process.env.GROUP_ADMIN_REQUIRE_APPROVAL !== 'false',

  // Personal-account transport (deferred / opt-in). The driver is shipped but
  // stays entirely inactive unless explicitly enabled. Unofficial transport:
  // review WhatsApp's terms and the account-restriction risk before enabling.
  PERSONAL_WHATSAPP_ENABLED: process.env.PERSONAL_WHATSAPP_ENABLED === 'true',
  PERSONAL_WHATSAPP_AUTH_DIR: process.env.PERSONAL_WHATSAPP_AUTH_DIR || '',
  PERSONAL_WHATSAPP_PRIVATE_CHATS: process.env.PERSONAL_WHATSAPP_PRIVATE_CHATS === 'true',
  PERSONAL_WHATSAPP_RECONNECT_MAX_MS: parseInt(process.env.PERSONAL_WHATSAPP_RECONNECT_MAX_MS, 10) || 60000,
  PERSONAL_WHATSAPP_PAIRING_NUMBER: process.env.PERSONAL_WHATSAPP_PAIRING_NUMBER || '',

  // ---------------------------------------------------------------------
  // Multi-provider AI gateway (group tasks). Existing Gemini chat pipeline
  // is untouched; this gateway is used only by group agents.
  // ---------------------------------------------------------------------
  AI_PROVIDER_ORDER: process.env.AI_PROVIDER_ORDER || 'gemini,openrouter,qwen,openai_compatible',
  AI_FREE_ONLY: process.env.AI_FREE_ONLY === 'true',
  AI_RATE_LIMIT_PER_MINUTE: parseInt(process.env.AI_RATE_LIMIT_PER_MINUTE, 10) || 30,
  AI_REQUEST_TIMEOUT_MS: parseInt(process.env.AI_REQUEST_TIMEOUT_MS, 10) || 30000,
  AI_MAX_FALLBACKS: parseInt(process.env.AI_MAX_FALLBACKS, 10) || 3,
  AI_USAGE_RETENTION_DAYS: parseInt(process.env.AI_USAGE_RETENTION_DAYS, 10) || 90,

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  OPENROUTER_APP_NAME: process.env.OPENROUTER_APP_NAME || 'WhatsApp Group AI Administrator',

  QWEN_API_KEY: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
  QWEN_BASE_URL:
    process.env.QWEN_BASE_URL ||
    process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',

  OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY || '',
  OPENAI_COMPAT_BASE_URL: process.env.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com/v1',

  AI_MODEL_CHAT: process.env.AI_MODEL_CHAT || '',
  AI_MODEL_MODERATION: process.env.AI_MODEL_MODERATION || '',
  AI_MODEL_SUMMARY: process.env.AI_MODEL_SUMMARY || '',
  AI_MODEL_REPORT: process.env.AI_MODEL_REPORT || '',
  AI_MODEL_MEMORY: process.env.AI_MODEL_MEMORY || '',
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
  // Meta App Secret Verification & Hardening
  const isPlaceholderSecret =
    !config.WHATSAPP_APP_SECRET ||
    config.WHATSAPP_APP_SECRET.includes('test_meta_app_secret') ||
    config.WHATSAPP_APP_SECRET.includes('your_meta_app_secret');

  if (config.NODE_ENV === 'production') {
    if (isPlaceholderSecret) {
      errors.push(
        'Missing or placeholder WHATSAPP_APP_SECRET. In production, a valid Meta App Secret is required to verify webhook HMAC signatures.'
      );
    }
    if (config.SKIP_SIGNATURE_VERIFICATION) {
      errors.push(
        'CRITICAL: SKIP_SIGNATURE_VERIFICATION is enabled in production! Webhook HMAC validation must remain active.'
      );
    }
  } else {
    if (!config.WHATSAPP_APP_SECRET) {
      warnings.push(
        'WHATSAPP_APP_SECRET is not set. Meta Webhook HMAC-SHA256 signature verification will fail closed.'
      );
    } else if (isPlaceholderSecret) {
      warnings.push(
        'WHATSAPP_APP_SECRET is set to placeholder "test_meta_app_secret". HMAC signature verification will reject incoming webhooks until your real Meta App Secret is configured.'
      );
    }
    if (config.SKIP_SIGNATURE_VERIFICATION && config.NODE_ENV !== 'test') {
      warnings.push(
        'SKIP_SIGNATURE_VERIFICATION is enabled outside of test environment! Webhook HMAC validation is inactive.'
      );
    }
  }

  // Access Control Warning
  if (config.ALLOWED_PHONE_NUMBERS.size === 0) {
    warnings.push(
      'ALLOWED_PHONE_NUMBERS is empty. All incoming messages will be rejected by default to prevent unauthorized access.'
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
    image: {
      modelFast: config.IMAGE_MODEL_FAST,
      modelPro: config.IMAGE_MODEL_PRO,
      cacheTtlDays: config.IMAGE_CACHE_TTL_DAYS,
    },
    video: {
      engine: config.VIDEO_ENGINE,
      hasApiKey: Boolean(config.POLLINATIONS_API_KEY),
      apiKeyMasked: maskSecret(config.POLLINATIONS_API_KEY),
      model: config.POLLINATIONS_VIDEO_MODEL,
    },
    timezone: {
      zone: config.TIMEZONE,
      offsetHours: config.TIMEZONE_OFFSET_HOURS,
    },
    ops: {
      hasOpsToken: Boolean(config.OPS_TOKEN),
    },
    groupAdmin: {
      enabled: config.GROUP_ADMIN_ENABLED,
      importLegacyGroups: config.GROUP_ADMIN_IMPORT_LEGACY,
      defaultPersona: config.GROUP_ADMIN_DEFAULT_PERSONA,
      requireApprovalForHighImpact: config.GROUP_ADMIN_REQUIRE_APPROVAL,
      humanAdminsConfigured: Boolean(config.GROUP_ADMIN_HUMAN_ADMINS),
      personalTransportEnabled: config.PERSONAL_WHATSAPP_ENABLED,
    },
    aiGateway: {
      providers: {
        gemini: Boolean(config.GEMINI_API_KEY),
        openrouter: Boolean(config.OPENROUTER_API_KEY),
        qwen: Boolean(config.QWEN_API_KEY),
        openaiCompatible: Boolean(config.OPENAI_COMPAT_API_KEY),
      },
      freeOnly: config.AI_FREE_ONLY,
      rateLimitPerMinute: config.AI_RATE_LIMIT_PER_MINUTE,
    },
    state: {
      backend: config.STATE_BACKEND,
      hasRedisUrl: Boolean(config.REDIS_URL),
      dataDir: config.DATA_DIR,
    },
    queue: {
      concurrency: config.MESSAGE_CONCURRENCY,
      maxRetries: config.QUEUE_MAX_RETRIES,
      maxSize: config.QUEUE_MAX_SIZE,
      shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    },
    features: {
      aiTools: config.ENABLE_AI_TOOLS,
      allowedGroupsCount: config.ALLOWED_GROUP_IDS.size,
      groupTriggerPrefix: config.GROUP_TRIGGER_PREFIX,
      hasDigestTemplate: Boolean(config.TEMPLATE_DIGEST_NAME),
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
