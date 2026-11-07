import crypto from 'crypto';
import { config, normalizePhoneNumber } from './config.js';

// Internal session store: In-Memory ONLY (zero disk writes)
// Map<anonymizedUserId, { messages: Array<{role: string, parts: Array<{text: string}>}>, lastActivity: number }>
const sessionStore = new Map();

// Salt generated at runtime; resets on every process restart to ensure non-linkability across restarts
const RUNTIME_SALT = crypto.randomBytes(16).toString('hex');

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
      .update(normalized + RUNTIME_SALT)
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
  return false;
}

/**
 * Privacy Guard: Sensitive data regex patterns
 */
const SENSITIVE_PATTERNS = [
  // Credit / Debit card patterns (13-19 digits with optional spaces or dashes)
  {
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[REDACTED_CARD_NUMBER]',
    category: 'Payment Card',
  },
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
  // Indian Aadhaar number format (4-4-4 digits)
  {
    regex: /\b[2-9]{1}[0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/g,
    replacement: '[REDACTED_NATIONAL_ID]',
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
 * @param {string} text
 * @returns {{ sanitizedText: string, hasRedactions: boolean, categories: string[] }}
 */
export function maskSensitiveInfo(text) {
  if (!text || typeof text !== 'string') {
    return { sanitizedText: '', hasRedactions: false, categories: [] };
  }

  let sanitized = text;
  let hasRedactions = false;
  const categories = [];

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.regex.test(sanitized)) {
      hasRedactions = true;
      categories.push(pattern.category);
      sanitized = sanitized.replace(pattern.regex, pattern.replacement);
    }
  }

  return {
    sanitizedText: sanitized,
    hasRedactions,
    categories: [...new Set(categories)],
  };
}

/**
 * Privacy-Safe Structured Logger.
 * Strict Rule: Never logs message content, API keys, phone numbers, or tokens.
 * Only logs metadata: timestamps, event type, anonymized IDs, lengths, latencies, status codes.
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

  const output = `[${logEntry.timestamp}] [${logEntry.level}] [${logEntry.event}] ${
    Object.keys(safeMeta).length > 0 ? JSON.stringify(safeMeta) : ''
  }`;

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
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
}

/**
 * Resets the active conversation context for an anonymized user.
 * @param {string} anonId
 * @returns {boolean} true if cleared, false if no session was active
 */
export function resetConversation(anonId) {
  const hadSession = sessionStore.has(anonId);
  sessionStore.delete(anonId);
  privacyLog('info', 'CONVERSATION_RESET', { user: anonId, hadActiveSession: hadSession });
  return hadSession;
}

/**
 * Deletes all temporary data for an anonymized user immediately.
 * @param {string} anonId
 * @returns {boolean}
 */
export function deleteUserData(anonId) {
  return resetConversation(anonId);
}

/**
 * Sweeps the in-memory session store and deletes expired sessions.
 * @returns {number} count of evicted sessions
 */
export function cleanupExpiredSessions() {
  const now = Date.now();
  const maxIdleMs = config.SESSION_TIMEOUT_MINUTES * 60 * 1000;
  let evictedCount = 0;

  for (const [anonId, session] of sessionStore.entries()) {
    if (now - session.lastActivity > maxIdleMs) {
      sessionStore.delete(anonId);
      evictedCount++;
    }
  }

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
    `• Message bodies, personal credentials, and API keys are *NEVER* written to server logs.`,
    ``,
    `*4. Data Minimization & Guardrails:*`,
    `• Automated filters redact payment cards, PINs, passwords, and IDs before transmission to the AI.`,
    `• Never send passwords, OTPs, UPI PINs, or banking credentials.`,
    ``,
    `*5. Commands:*`,
    `• Send */reset* to wipe current conversation context.`,
    `• Send */delete* to purge all your session data from RAM.`,
    `• Send */help* for a full list of commands.`,
  ].join('\n');
}
