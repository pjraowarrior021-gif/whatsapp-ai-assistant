import crypto from 'crypto';
import { config, normalizePhoneNumber } from './config.js';
import { store } from './store/index.js';
import { clearUserProfile } from './conversation-adapter.js';
import { isKnownContact } from './contacts.js';

// Internal session store: In-Memory ONLY (zero disk writes)
// Map<anonymizedUserId, { messages: Array<{role: string, parts: Array<{text: string}>}>, lastActivity: number }>
const sessionStore = new Map();

// In-Memory user sliding-window rate limit store: Map<anonymizedUserId, number[]>
const userRateLimits = new Map();

// In-Memory remembered messages for quoted-reply context: Map<messageId, { text: string, timestamp: number }>
const rememberedMessages = new Map();
const REMEMBERED_MESSAGES_MAX = 200;
const REMEMBERED_MESSAGES_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-Memory user voice reply preferences: Map<anonymizedUserId, boolean>
const userVoicePreferences = new Map();

// In-Memory rolling buffer for recent privacy-safe diagnostic logs (max 50)
const recentLogsRing = [];
const MAX_RECENT_LOGS = 50;

// Salt generated at runtime; fallback to RUNTIME_SALT if neither persistent env salt nor secret is present
const RUNTIME_SALT = crypto.randomBytes(16).toString('hex');
const PERSISTENT_SALT =
  process.env.USER_PERSISTENCE_SALT ||
  (config.WHATSAPP_APP_SECRET && config.WHATSAPP_APP_SECRET !== 'placeholder_app_secret'
    ? crypto.createHash('sha256').update(config.WHATSAPP_APP_SECRET).digest('hex').substring(0, 32)
    : RUNTIME_SALT);

/**
 * Returns a non-reversible anonymized identifier for logging and internal session mapping.
 * @param {string} phoneNumber
 * @returns {string} e.g. "u_a1b2c3d4"
 */
export function getAnonymizedId(phoneNumber) {
  if (!phoneNumber) return 'u_anonymous';
  const normalized = normalizePhoneNumber(phoneNumber);
  return (
    'u_' +
    crypto
      .createHash('sha256')
      .update(normalized + PERSISTENT_SALT)
      .digest('hex')
      .substring(0, 10)
  );
}

/**
 * Checks if a given phone number is in the authorized whitelist.
 * @param {string} phoneNumber
 * @returns {boolean}
 */
export function isAuthorized(phoneNumber) {
  if (!phoneNumber) return false;
  const normalized = normalizePhoneNumber(phoneNumber);
  if (config.ALLOWED_PHONE_NUMBERS.size === 0) {
    // Fail closed: if no allowed numbers configured, deny all
    return false;
  }
  if (config.ALLOWED_PHONE_NUMBERS.has(normalized)) {
    return true;
  }
  // Check flexible matching (handling with/without country code e.g. 91 vs 0 vs raw 10 digits)
  for (const allowed of config.ALLOWED_PHONE_NUMBERS) {
    if (
      normalized === allowed ||
      (allowed.length >= 10 && normalized.length >= 10 && allowed.slice(-10) === normalized.slice(-10))
    ) {
      return true;
    }
  }
  if (isKnownContact(normalized)) {
    return true;
  }
  return false;
}

/**
 * Validates a string of digits using the standard Luhn checksum algorithm.
 * @param {string} digits
 * @returns {boolean}
 */
export function isValidLuhn(digits) {
  if (!digits || typeof digits !== 'string') return false;
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = parseInt(clean.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

// Payment card candidate regex (13-19 digits with optional spaces or dashes)
const CARD_CANDIDATE_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Privacy Guard: Sensitive data regex patterns
 */
const SENSITIVE_PATTERNS = [
  // CVV / CVC patterns (e.g. "cvv is 849", "cvv: 849", "cvv 849")
  {
    regex: /\b(?:cvv|cvc|cvv2|security code)(?:\s+is|\s*[:=])?\s+[0-9]{3,4}\b/gi,
    replacement: '[REDACTED_CVV]',
    category: 'Card Security Code',
  },
  // UPI PIN / ATM PIN / MPIN patterns
  {
    regex: /\b(?:upi\s*pin|atm\s*pin|mpin|secret\s*pin)[:=\s]+[0-9]{4,6}\b/gi,
    replacement: '[REDACTED_PIN]',
    category: 'PIN',
  },
  // Password / Secret key patterns
  {
    regex: /\b(?:password|passwd|pwd|passcode|secret\s*key)[:=\s]+\S+/gi,
    replacement: '[REDACTED_PASSWORD]',
    category: 'Password/Credential',
  },
  // Indian Aadhaar format: 4-4-4 grouped with spaces/hyphens
  {
    regex: /\b[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b/g,
    replacement: '[REDACTED_NATIONAL_ID]',
    category: 'National ID',
  },
  // Indian Aadhaar format: 12 digits preceded by context word
  {
    regex: /\b(?:aadhaar|aadhar|uid)[\s:=]+([2-9]\d{11})\b/gi,
    replacement: (match) => match.replace(/[2-9]\d{11}/, '[REDACTED_NATIONAL_ID]'),
    category: 'National ID',
  },
  // US SSN format (3-2-4 digits)
  {
    regex: /\b\d{3}[-]\d{2}[-]\d{4}\b/g,
    replacement: '[REDACTED_SSN]',
    category: 'SSN',
  },
  // OTP patterns (e.g. "otp is 123456", "verification code: 482910")
  {
    regex: /\b(?:otp|one\s*time\s*password|verification\s*code|auth\s*code)[:=\s]+[0-9]{4,8}\b/gi,
    replacement: '[REDACTED_OTP]',
    category: 'One-Time Password',
  },
];

/**
 * Sanitizes user input by masking recognized sensitive financial and credential patterns.
 * Validates payment cards with the Luhn algorithm to prevent false positives on order IDs.
 * Uses stateless replace operations to avoid regex statefulness bugs.
 *
 * @param {string} text
 * @returns {{ sanitizedText: string, hasRedactions: boolean, categories: string[] }}
 */
export function maskSensitiveInfo(text) {
  if (!text || typeof text !== 'string') {
    return { sanitizedText: '', hasRedactions: false, categories: [] };
  }

  let sanitized = text;
  const categories = [];

  // 1. Payment Cards: Luhn-validated redaction
  const cardReplaced = sanitized.replace(CARD_CANDIDATE_REGEX, (match) => {
    const digits = match.replace(/\D/g, '');
    if (isValidLuhn(digits)) {
      categories.push('Payment Card');
      return '[REDACTED_CARD_NUMBER]';
    }
    return match;
  });
  sanitized = cardReplaced;

  // 2. Other sensitive patterns with stateless replacements
  for (const pattern of SENSITIVE_PATTERNS) {
    const next = sanitized.replace(pattern.regex, pattern.replacement);
    if (next !== sanitized) {
      categories.push(pattern.category);
      sanitized = next;
    }
  }

  return {
    sanitizedText: sanitized,
    hasRedactions: categories.length > 0,
    categories: [...new Set(categories)],
  };
}

/**
 * Privacy-Safe Structured Logger.
 * Strict Rule: Never logs message content, API keys, phone numbers, or tokens.
 * Only logs metadata: timestamps, event type, anonymized IDs, lengths, latencies, status codes.
 * Supports text and JSON output formats via LOG_FORMAT.
 *
 * @param {'info' | 'warn' | 'error' | 'debug'} level
 * @param {string} event
 * @param {object} [meta={}]
 */
export function privacyLog(level, event, meta = {}) {
  // Strip any accidental sensitive fields
  const safeMeta = { ...meta };
  delete safeMeta.text;
  delete safeMeta.message;
  delete safeMeta.body;
  delete safeMeta.token;
  delete safeMeta.apiKey;
  delete safeMeta.secret;
  delete safeMeta.prompt;
  delete safeMeta.response;
  delete safeMeta.rawBody;

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    event,
    ...safeMeta,
  };

  recentLogsRing.push(logEntry);
  if (recentLogsRing.length > MAX_RECENT_LOGS) {
    recentLogsRing.shift();
  }

  let output;
  if (config.LOG_FORMAT === 'json') {
    output = JSON.stringify(logEntry);
  } else {
    output = `[${logEntry.timestamp}] [${logEntry.level}] [${logEntry.event}] ${
      Object.keys(safeMeta).length > 0 ? JSON.stringify(safeMeta) : ''
    }`;
  }

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

/**
 * Returns recent diagnostic logs from volatile RAM ring buffer.
 * @returns {Array<object>}
 */
export function getRecentLogs() {
  return [...recentLogsRing];
}

/**
 * Sliding-window rate limiter per anonymized user.
 * @param {string} anonId
 * @returns {{ allowed: boolean, retryAfterMs?: number }}
 */
export function checkUserRateLimit(anonId) {
  if (!anonId) return { allowed: true };

  const now = Date.now();
  const windowMs = config.USER_RATE_LIMIT_WINDOW_MS;
  const max = config.USER_RATE_LIMIT_MAX;

  let timestamps = userRateLimits.get(anonId) || [];
  // Prune timestamps outside current sliding window
  timestamps = timestamps.filter((ts) => now - ts < windowMs);

  if (timestamps.length >= max) {
    const oldest = timestamps[0];
    const retryAfterMs = Math.max(0, oldest + windowMs - now);
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  userRateLimits.set(anonId, timestamps);
  return { allowed: true };
}

/**
 * Resets the rate limit history for an anonymized user.
 * @param {string} anonId
 */
export function resetUserRateLimit(anonId) {
  userRateLimits.delete(anonId);
}

/**
 * Remembers a message text or placeholder in memory for quoted-reply context.
 * Bounded to max 200 items with a 10-minute TTL.
 *
 * @param {string} messageId
 * @param {string} text
 */
export function rememberMessage(messageId, text) {
  if (!messageId || !text) return;

  if (rememberedMessages.size >= REMEMBERED_MESSAGES_MAX) {
    const oldestKey = rememberedMessages.keys().next().value;
    rememberedMessages.delete(oldestKey);
  }

  rememberedMessages.set(messageId, {
    text: String(text).trim(),
    timestamp: Date.now(),
  });
}

/**
 * Retrieves a remembered message by its ID if still within its 10-minute TTL.
 * @param {string} messageId
 * @returns {string | null}
 */
export function getRememberedMessage(messageId) {
  if (!messageId) return null;
  const entry = rememberedMessages.get(messageId);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > REMEMBERED_MESSAGES_TTL_MS) {
    rememberedMessages.delete(messageId);
    return null;
  }

  return entry.text;
}

/**
 * Purges expired entries from the in-memory remembered messages cache.
 */
export function cleanupRememberedMessages() {
  const cutoff = Date.now() - REMEMBERED_MESSAGES_TTL_MS;
  for (const [id, entry] of rememberedMessages.entries()) {
    if (entry.timestamp < cutoff) {
      rememberedMessages.delete(id);
    }
  }
}

/**
 * Retrieves the temporary in-memory conversation context for an anonymized user.
 * Returns empty array if session expired or does not exist.
 * @param {string} anonId
 * @returns {Array<{ role: string, parts: Array<{ text: string }> }>}
 */
export function getConversation(anonId) {
  const session = sessionStore.get(anonId);
  if (!session) return [];

  const now = Date.now();
  const maxIdleMs = config.SESSION_TIMEOUT_MINUTES * 60 * 1000;

  if (now - session.lastActivity > maxIdleMs) {
    sessionStore.delete(anonId);
    privacyLog('info', 'SESSION_EXPIRED_EVICTED', { user: anonId });
    return [];
  }

  return session.messages || [];
}

/**
 * Appends a conversation turn to the temporary in-memory store.
 * Automatically trims history to MAX_CONTEXT_TURNS to minimize Gemini prompt payload.
 * @param {string} anonId
 * @param {string} sanitizedUserMessage
 * @param {string} assistantResponse
 */
export function saveTurn(anonId, sanitizedUserMessage, assistantResponse) {
  const maxTurns = config.MAX_CONTEXT_TURNS;
  let currentMessages = getConversation(anonId);

  currentMessages.push({
    role: 'user',
    parts: [{ text: sanitizedUserMessage }],
  });

  currentMessages.push({
    role: 'model',
    parts: [{ text: assistantResponse }],
  });

  // Keep within sliding window: retain at most maxTurns
  if (currentMessages.length > maxTurns) {
    currentMessages = currentMessages.slice(currentMessages.length - maxTurns);
  }

  sessionStore.set(anonId, {
    messages: currentMessages,
    lastActivity: Date.now(),
  });

  const sessionTtlSec = config.SESSION_TIMEOUT_MINUTES * 60;
  store.set(`session:${anonId}`, currentMessages, sessionTtlSec).catch(() => {});
}

/**
 * Resets the active conversation context for an anonymized user.
 * @param {string} anonId
 * @returns {boolean} true if cleared, false if no session was active
 */
export function resetConversation(anonId) {
  const hadSession = sessionStore.has(anonId);
  sessionStore.delete(anonId);
  store.del(`session:${anonId}`).catch(() => {});
  privacyLog('info', 'CONVERSATION_RESET', { user: anonId, hadActiveSession: hadSession });
  return hadSession;
}

/**
 * Checks if voice note audio replies are enabled for a user.
 * @param {string} anonId
 * @returns {boolean}
 */
export function isVoiceReplyEnabled(anonId) {
  if (!anonId) return false;
  return Boolean(userVoicePreferences.get(anonId));
}

/**
 * Sets voice note audio replies state for a user.
 * @param {string} anonId
 * @param {boolean} enabled
 */
export function setVoiceReplyEnabled(anonId, enabled) {
  if (anonId) {
    userVoicePreferences.set(anonId, Boolean(enabled));
    store.set(`voice:${anonId}`, Boolean(enabled)).catch(() => {});
    privacyLog('info', 'VOICE_MODE_TOGGLED', { user: anonId, enabled: Boolean(enabled) });
  }
}

/**
 * Deletes all temporary data for an anonymized user immediately.
 * @param {string} anonId
 * @returns {boolean}
 */
export function deleteUserData(anonId) {
  resetUserRateLimit(anonId);
  userVoicePreferences.delete(anonId);
  store.del(`voice:${anonId}`).catch(() => {});
  store.del(`ratelimit:${anonId}`).catch(() => {});
  store.del(`user:memory:${anonId}`).catch(() => {});
  store.del(`user:workflows:${anonId}`).catch(() => {});
  store.del(`user:profile:${anonId}`).catch(() => {});
  store.del(`image:learner:${anonId}`).catch(() => {});
  clearUserProfile(anonId);
  return resetConversation(anonId);
}

/**
 * Initializes and restores privacy preferences from store on startup.
 */
export async function initPrivacyStore() {
  try {
    const voiceKeys = await store.keys('voice:*');
    for (const key of voiceKeys) {
      const anonId = key.substring(6);
      const val = await store.get(key);
      if (anonId && typeof val === 'boolean') {
        userVoicePreferences.set(anonId, val);
      }
    }
  } catch (err) {
    privacyLog('warn', 'PRIVACY_STORE_INIT_FAILED', { error: err.message });
  }
}

/**
 * Sweeps the in-memory session store, user rate-limit maps, and remembered messages.
 * @returns {number} count of evicted sessions
 */
export function cleanupExpiredSessions() {
  const now = Date.now();
  const maxIdleMs = config.SESSION_TIMEOUT_MINUTES * 60 * 1000;
  let evictedCount = 0;

  // 1. Evict idle chat sessions
  for (const [anonId, session] of sessionStore.entries()) {
    if (now - session.lastActivity > maxIdleMs) {
      sessionStore.delete(anonId);
      evictedCount++;
    }
  }

  // 2. Prune stale user rate-limit entries
  const limitCutoff = now - config.USER_RATE_LIMIT_WINDOW_MS;
  for (const [anonId, timestamps] of userRateLimits.entries()) {
    const fresh = timestamps.filter((ts) => ts > limitCutoff);
    if (fresh.length === 0) {
      userRateLimits.delete(anonId);
    } else {
      userRateLimits.set(anonId, fresh);
    }
  }

  // 3. Purge expired quoted-reply context messages
  cleanupRememberedMessages();

  if (evictedCount > 0) {
    privacyLog('debug', 'SESSION_CLEANUP_SWEEP', { evictedCount, remaining: sessionStore.size });
  }

  return evictedCount;
}

/**
 * Starts periodic cleanup timer for expired sessions.
 * @param {number} intervalMs (default 60 seconds)
 * @returns {NodeJS.Timeout}
 */
export function startSessionSweeper(intervalMs = 60000) {
  const sweeper = setInterval(cleanupExpiredSessions, intervalMs);
  if (sweeper.unref) {
    sweeper.unref();
  }
  return sweeper;
}

/**
 * Returns active sessions count for Prometheus metrics.
 * @returns {number}
 */
export function getActiveSessionCount() {
  return sessionStore.size;
}

/**
 * Generates the official Privacy & Data Processing Disclosure text for users.
 * Explicitly clarifies the lack of complete end-to-end encryption across AI servers.
 * @returns {string}
 */
export function getPrivacyDisclosure() {
  return [
    `🔒 *PRIVACY & ARCHITECTURE DISCLOSURE*`,
    ``,
    `*1. Data Flow & Processing Services:*`,
    `• Your messages travel from your WhatsApp app to *Meta WhatsApp Cloud API* servers.`,
    `• Our backend validates the message and forwards your prompt to *Google Gemini API* servers to generate responses.`,
    `• Responses travel back via Meta's servers directly to your WhatsApp app.`,
    ``,
    `*2. Encryption Boundaries:*`,
    `• ⚠️ *IMPORTANT:* The complete pipeline is *NOT* end-to-end encrypted.`,
    `• Transport between your phone, Meta, our server, and Google is encrypted using HTTPS/TLS.`,
    `• However, Meta and Google process message content within their secure clouds in order to transmit messages and run the AI model.`,
    ``,
    `*3. Zero Permanent Storage Policy:*`,
    `• Our backend does *NOT* write conversations to any database or hard drive.`,
    `• Conversation history is held strictly in volatile RAM for context (${config.SESSION_TIMEOUT_MINUTES} minutes idle timeout) and automatically deleted.`,
    `• Quoted reply context is held in RAM for a maximum of 10 minutes.`,
    `• *Exception:* Scheduled reminders and active to-do lists are saved to encrypted/local storage only when REMINDERS_PERSIST is explicitly enabled.`,
    `• Message bodies, personal credentials, and API keys are *NEVER* written to server logs.`,
    ``,
    `*4. Data Minimization & Guardrails:*`,
    `• Automated filters redact payment cards (Luhn-verified), PINs, passwords, and IDs before transmission to the AI.`,
    `• Never send passwords, OTPs, UPI PINs, or banking credentials.`,
    ``,
    `*5. Commands:*`,
    `• Send */reset* to wipe current conversation context.`,
    `• Send */delete* to purge all your session data from RAM.`,
    `• Send */help* for a full list of commands.`,
  ].join('\n');
}
