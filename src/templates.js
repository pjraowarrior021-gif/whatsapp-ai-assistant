/**
 * 24-Hour Session Window & Meta Message Template Fallback Manager
 * Tracks contact inbound activity and automatically routes proactive notifications
 * (reminders, daily briefings) to pre-approved Meta Templates when outside the 24h window.
 */
import { store } from './store/index.js';
import { config } from './config.js';
import { privacyLog } from './privacy.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from './whatsapp.js';

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

/**
 * Records an inbound interaction timestamp for a contact.
 *
 * @param {string} userId - Contact phone number or identifier
 * @param {number} [timestamp=Date.now()]
 * @returns {Promise<boolean>}
 */
export async function recordLastInboundInteraction(userId, timestamp = Date.now()) {
  if (!userId) return false;
  const key = `contact:last_seen:${userId}`;
  await store.set(key, timestamp);
  return true;
}

/**
 * Retrieves the timestamp of the contact's most recent inbound message.
 *
 * @param {string} userId
 * @returns {Promise<number|null>} epoch milliseconds or null
 */
export async function getLastInboundInteraction(userId) {
  if (!userId) return null;
  const key = `contact:last_seen:${userId}`;
  const val = await store.get(key);
  if (val === null || val === undefined) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

/**
 * Determines whether the contact is within the active 24-hour customer service window.
 *
 * @param {string} userId
 * @param {number} [windowMs=SESSION_WINDOW_MS]
 * @param {number} [now=Date.now()]
 * @returns {Promise<boolean>}
 */
export async function isWithinSessionWindow(userId, windowMs = SESSION_WINDOW_MS, now = Date.now()) {
  if (!userId) return false;
  const lastSeen = await getLastInboundInteraction(userId);
  if (!lastSeen) return false;
  return now - lastSeen <= windowMs;
}

/**
 * Builds standard Meta template component parameters.
 *
 * @param {Array<string>|object} params - Body variable replacements
 * @returns {Array<object>}
 */
export function buildTemplateComponents(params = []) {
  if (!params) return [];

  if (Array.isArray(params)) {
    if (params.length === 0) return [];
    return [
      {
        type: 'body',
        parameters: params.map((val) => ({
          type: 'text',
          text: String(val),
        })),
      },
    ];
  }

  if (typeof params === 'object') {
    const values = Object.values(params);
    return [
      {
        type: 'body',
        parameters: values.map((val) => ({
          type: 'text',
          text: String(val),
        })),
      },
    ];
  }

  return [];
}

/**
 * Proactive notification dispatcher.
 * Routes message to standard free-form text if within 24h, or to a pre-approved Meta Template if outside 24h.
 *
 * @param {string} to - Recipient phone number
 * @param {object} options
 * @param {string} options.text - Free-form message body (used within 24h window)
 * @param {string} [options.templateName] - Pre-approved Meta template name
 * @param {string} [options.languageCode='en'] - Template language code
 * @param {Array<string>} [options.templateParams] - Body variable values for template
 * @returns {Promise<{ success: boolean, channel: 'session'|'template'|'skipped', messageId?: string, reason?: string }>}
 */
export async function sendProactiveMessage(to, options = {}) {
  const { text = '', templateName, languageCode = 'en', templateParams = [] } = options;

  if (!to) {
    return { success: false, channel: 'skipped', reason: 'Missing recipient phone number' };
  }

  const withinWindow = await isWithinSessionWindow(to);

  if (withinWindow) {
    // Within 24-hour window: Send free-form session message directly
    privacyLog('debug', 'PROACTIVE_SESSION_MESSAGE_DISPATCHED', { toEnding: to.slice(-4) });
    const res = await sendWhatsAppMessage(to, text);
    const messageId = res.messageId || res.messageIds?.[0] || `sim_proactive_${Date.now()}`;
    return {
      success: res.success,
      channel: 'session',
      messageId,
      reason: res.error,
    };
  }

  // Outside 24-hour window: Meta requires pre-approved template message
  const targetTemplate =
    templateName || config.TEMPLATE_PROACTIVE_NAME || config.TEMPLATE_DIGEST_NAME || 'utility_reminder_notification';

  if (!targetTemplate) {
    privacyLog('warn', 'PROACTIVE_MESSAGE_SKIPPED_OUTSIDE_24H_NO_TEMPLATE', {
      toEnding: to.slice(-4),
    });
    return {
      success: false,
      channel: 'skipped',
      reason: 'Recipient outside 24-hour window and no pre-approved Meta template is configured.',
    };
  }

  const components = buildTemplateComponents(templateParams.length > 0 ? templateParams : [text.slice(0, 120)]);

  privacyLog('info', 'PROACTIVE_TEMPLATE_MESSAGE_DISPATCHED', {
    toEnding: to.slice(-4),
    template: targetTemplate,
  });

  const res = await sendWhatsAppTemplate(to, targetTemplate, languageCode, components);

  return {
    success: res.success,
    channel: 'template',
    messageId: res.messageId,
    reason: res.error,
  };
}
