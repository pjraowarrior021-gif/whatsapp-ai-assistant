/**
 * Topic & Compliance Guardrails Module
 * Enforces Meta Business Platform messaging policies and configurable
 * domain scope limits before and after AI agent execution.
 */
import { config } from './config.js';
import { privacyLog } from './privacy.js';

/**
 * Meta Business Platform prohibited content category matchers.
 */
const POLICY_RULES = [
  {
    category: 'hate_speech',
    regex: /\b(nazi|white supremacy|hate speech|kill all [a-z]+|racial slur)\b/i,
    reason: 'Content contains hate speech or discriminatory abuse.',
  },
  {
    category: 'violence_and_weapons',
    regex:
      /\b(how to build a bomb|how to make explosive|buy illegal weapon|assassinate|how to make poison|mass shooting)\b/i,
    reason: 'Content promotes violence, weapons, or physical harm.',
  },
  {
    category: 'illicit_substances',
    regex: /\b(buy cocaine|sell heroin|buy fentanyl|buy meth online|illicit narcotics supplier)\b/i,
    reason: 'Content promotes illicit drugs or regulated substances.',
  },
  {
    category: 'phishing_and_fraud',
    regex: /\b(phishing script|steal credit card numbers|dump passwords|carding forum|bank account hack)\b/i,
    reason: 'Content violates cybersecurity and anti-fraud guidelines.',
  },
  {
    category: 'adult_content',
    regex: /\b(pornography|hardcore porn|explicit sex scenes|escort service)\b/i,
    reason: 'Content violates Meta adult and sexually explicit policies.',
  },
];

/**
 * Checks whether compliance guardrails are currently active.
 * @returns {boolean}
 */
export function isGuardrailsEnabled() {
  if (config.ENABLE_GUARDRAILS === false || config.ENABLE_GUARDRAILS === 'false') {
    return false;
  }
  return true;
}

/**
 * Evaluates inbound user text against Meta Business Platform compliance rules and domain boundaries.
 *
 * @param {string} text - User message text
 * @param {object} [context]
 * @returns {{ allowed: boolean, category?: string, reason?: string, policyNotice?: string }}
 */
export function evaluateInputGuardrails(text = '', context = {}) {
  if (!isGuardrailsEnabled()) {
    return { allowed: true };
  }

  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return { allowed: true };
  }

  // 1. Meta Business Platform Prohibited Content Check
  for (const rule of POLICY_RULES) {
    if (rule.regex.test(trimmed)) {
      privacyLog('warn', 'GUARDRAIL_POLICY_VIOLATION_BLOCKED', {
        category: rule.category,
        user: context.anonId || context.user,
      });

      return {
        allowed: false,
        category: rule.category,
        reason: rule.reason,
        policyNotice:
          '🛡️ *Policy Notice:* This request cannot be processed because it violates Meta WhatsApp Business Platform policies and safety guidelines.',
      };
    }
  }

  // 2. Domain Scope Filtering (if configured)
  const allowedDomains = (
    context.allowedDomains ||
    config.GUARDRAIL_ALLOWED_DOMAINS ||
    'assistant,coding,productivity,media,research'
  )
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  if (allowedDomains.length > 0 && context.targetDomain) {
    const isDomainAllowed = allowedDomains.includes(String(context.targetDomain).toLowerCase());
    if (!isDomainAllowed) {
      privacyLog('info', 'GUARDRAIL_OUT_OF_DOMAIN_BLOCKED', {
        targetDomain: context.targetDomain,
        allowedDomains,
      });
      return {
        allowed: false,
        category: 'out_of_domain',
        reason: `Topic '${context.targetDomain}' is outside the authorized assistant domains.`,
        policyNotice: `ℹ️ *Notice:* The assistant is currently limited to the following domains: ${allowedDomains.join(', ')}.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validates AI agent output before transmission to user to prevent model policy leakage or unsafe completions.
 *
 * @param {string} text - Generated AI output
 * @param {object} [context]
 * @returns {{ allowed: boolean, reason?: string, sanitizedText: string }}
 */
export function evaluateOutputGuardrails(text = '', context = {}) {
  if (!isGuardrailsEnabled()) {
    return { allowed: true, sanitizedText: text };
  }

  const raw = String(text || '');

  // Detect and sanitize any accidental leak of private system keys or tokens
  let sanitized = raw;
  if (/AIzaSy[0-9A-Za-z-_]{20,}/.test(sanitized)) {
    sanitized = sanitized.replace(/AIzaSy[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]');
  }
  if (/EAAG[0-9A-Za-z-_]{20,}/.test(sanitized)) {
    sanitized = sanitized.replace(/EAAG[0-9A-Za-z-_]{20,}/g, '[REDACTED_WHATSAPP_TOKEN]');
  }

  // Check output for policy violations
  for (const rule of POLICY_RULES) {
    if (rule.regex.test(sanitized)) {
      privacyLog('error', 'GUARDRAIL_OUTPUT_VIOLATION_CAUGHT', {
        category: rule.category,
        user: context.anonId || context.user,
      });
      return {
        allowed: false,
        reason: rule.reason,
        sanitizedText:
          '⚠️ *Notice:* The generated response could not be delivered in compliance with Meta safety policies.',
      };
    }
  }

  return {
    allowed: true,
    sanitizedText: sanitized,
  };
}
