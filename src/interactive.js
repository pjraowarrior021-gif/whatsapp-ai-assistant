/**
 * Interactive WhatsApp UI Builder
 * Constructs and dispatches native WhatsApp Quick-Reply Buttons,
 * Interactive List Menus, and WhatsApp Flows adhering to Meta Cloud API constraints.
 */
import { config, normalizePhoneNumber } from './config.js';
import { privacyLog } from './privacy.js';

const WHATSAPP_API_BASE = 'https://graph.facebook.com';

/**
 * Builds a valid WhatsApp Quick-Reply button interactive payload.
 * Constraints: Max 3 buttons, title <= 20 chars, id <= 256 chars.
 *
 * @param {string} bodyText - Main message body
 * @param {Array<{ id: string, title: string }>} buttons - Up to 3 buttons
 * @param {object} [options]
 * @param {string} [options.header] - Optional text header
 * @param {string} [options.footer] - Optional text footer (<= 60 chars)
 * @returns {object} Interactive buttons payload
 */
export function buildQuickReplyButtons(bodyText, buttons = [], options = {}) {
  if (!bodyText || typeof bodyText !== 'string') {
    throw new Error('Quick-Reply buttons require a non-empty bodyText string');
  }

  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('Quick-Reply requires at least 1 button');
  }

  if (buttons.length > 3) {
    throw new Error(`Quick-Reply supports a maximum of 3 buttons (received ${buttons.length})`);
  }

  const formattedButtons = buttons.map((b, idx) => {
    const title = String(b.title || `Button ${idx + 1}`)
      .trim()
      .slice(0, 20);
    const id = String(b.id || `btn_${idx + 1}`)
      .trim()
      .slice(0, 256);
    return {
      type: 'reply',
      reply: {
        id,
        title,
      },
    };
  });

  const payload = {
    type: 'button',
    body: {
      text: bodyText.slice(0, 1024),
    },
    action: {
      buttons: formattedButtons,
    },
  };

  if (options.header) {
    payload.header = {
      type: 'text',
      text: String(options.header).slice(0, 60),
    };
  }

  if (options.footer) {
    payload.footer = {
      text: String(options.footer).slice(0, 60),
    };
  }

  return payload;
}

/**
 * Builds a valid WhatsApp Interactive List Menu payload.
 * Constraints: Total rows across sections <= 10, row title <= 24 chars, description <= 72 chars.
 *
 * @param {string} bodyText - Main message body
 * @param {string} buttonText - Label on list launcher button (<= 20 chars)
 * @param {Array<{ title?: string, rows: Array<{ id: string, title: string, description?: string }> }>} sections
 * @param {object} [options]
 * @returns {object} Interactive list payload
 */
export function buildListMenu(bodyText, buttonText = 'Select Option', sections = [], options = {}) {
  if (!bodyText) {
    throw new Error('List menu requires a non-empty bodyText string');
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('List menu requires at least 1 section');
  }

  let totalRows = 0;
  const formattedSections = sections.map((sec, secIdx) => {
    const secTitle = sec.title ? String(sec.title).slice(0, 24) : `Category ${secIdx + 1}`;
    const rows = (sec.rows || []).map((r, rowIdx) => {
      totalRows++;
      return {
        id: String(r.id || `row_${secIdx}_${rowIdx}`).slice(0, 200),
        title: String(r.title || `Option ${rowIdx + 1}`).slice(0, 24),
        description: r.description ? String(r.description).slice(0, 72) : undefined,
      };
    });
    return {
      title: secTitle,
      rows,
    };
  });

  if (totalRows === 0) {
    throw new Error('List menu must contain at least 1 row across all sections');
  }

  if (totalRows > 10) {
    throw new Error(`List menu supports a maximum of 10 rows total (received ${totalRows})`);
  }

  const payload = {
    type: 'list',
    body: {
      text: String(bodyText).slice(0, 1024),
    },
    action: {
      button: String(buttonText || 'Options').slice(0, 20),
      sections: formattedSections,
    },
  };

  if (options.header) {
    payload.header = {
      type: 'text',
      text: String(options.header).slice(0, 60),
    };
  }

  if (options.footer) {
    payload.footer = {
      text: String(options.footer).slice(0, 60),
    };
  }

  return payload;
}

/**
 * Builds a WhatsApp Flow interactive message payload.
 *
 * @param {string} bodyText
 * @param {object} flowConfig
 * @param {string} flowConfig.flowId - Meta Flow ID
 * @param {string} flowConfig.flowCta - Button call-to-action text (<= 20 chars)
 * @param {string} [flowConfig.flowToken] - Flow session token
 * @param {string} [flowConfig.initialScreen] - Screen ID to open
 * @param {object} [flowConfig.initialData] - Initial screen data payload
 * @param {object} [options]
 * @returns {object} Interactive flow payload
 */
export function buildFlowMessage(bodyText, flowConfig = {}, options = {}) {
  if (!bodyText || !flowConfig.flowId) {
    throw new Error('Flow message requires bodyText and flowConfig.flowId');
  }

  const payload = {
    type: 'flow',
    body: {
      text: String(bodyText).slice(0, 1024),
    },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_token: flowConfig.flowToken || `flw_${Date.now()}`,
        flow_id: String(flowConfig.flowId),
        flow_cta: String(flowConfig.flowCta || 'Start Flow').slice(0, 20),
        flow_action: 'navigate',
        flow_action_payload: {
          screen: flowConfig.initialScreen || 'START',
          data: flowConfig.initialData || {},
        },
      },
    },
  };

  if (options.header) {
    payload.header = {
      type: 'text',
      text: String(options.header).slice(0, 60),
    };
  }

  if (options.footer) {
    payload.footer = {
      text: String(options.footer).slice(0, 60),
    };
  }

  return payload;
}

/**
 * Dispatches an interactive WhatsApp message via Meta Graph API.
 *
 * @param {string} to - Recipient phone number
 * @param {object} interactivePayload - Validated interactive structure (button, list, flow)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppInteractive(to, interactivePayload) {
  const normalizedTo = normalizePhoneNumber(to);

  if (!interactivePayload || !interactivePayload.type) {
    return { success: false, error: 'Invalid interactive payload structure' };
  }

  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    return { success: false, error: 'Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID' };
  }

  // Hermetic test bypass
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_test_int_${Date.now()}` };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'interactive',
    interactive: interactivePayload,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      const errorMsg = data?.error?.message || `HTTP ${res.status}`;
      privacyLog('error', 'WHATSAPP_INTERACTIVE_SEND_FAILED', {
        toEnding: normalizedTo.slice(-4),
        type: interactivePayload.type,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    }

    const messageId = data?.messages?.[0]?.id || `wamid.int_${Date.now()}`;
    privacyLog('info', 'WHATSAPP_INTERACTIVE_SENT', {
      toEnding: normalizedTo.slice(-4),
      type: interactivePayload.type,
      messageId,
    });

    return { success: true, messageId };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_INTERACTIVE_NETWORK_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}
