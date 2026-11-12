/**
 * WhatsApp Contacts & Outbound Message Relay Module
 * Provides privacy-hardened contact alias management, anti-relay protection,
 * and bi-directional message forwarding between the primary administrator and contacts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, normalizePhoneNumber } from './config.js';
import { privacyLog } from './privacy.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from './whatsapp.js';

/**
 * In-memory contacts store.
 * Key: normalized E.164 phone number
 * Value: { alias: string, phone: string, name: string, allowAiChat: boolean, createdAt: number }
 */
const contactsByPhone = new Map();

/**
 * Index mapping alias (lowercased) -> normalized phone number
 */
const aliasToPhone = new Map();

/**
 * In-memory outbound rate limiter tracking timestamps of recent admin dispatches.
 * Array of unix millisecond timestamps.
 */
const outboundDispatchTimestamps = [];
const OUTBOUND_MAX_PER_HOUR = 20;

const getPersistenceDir = () => config.DATA_DIR || path.resolve('.data');
const getPersistenceFile = () => path.join(getPersistenceDir(), 'contacts.json');

/**
 * Masks a phone number for safe display in chat and logs.
 * e.g. "919876543210" -> "+91 98765 ****10"
 *
 * @param {string} phone
 * @returns {string}
 */
export function maskPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const clean = normalizePhoneNumber(phone);
  if (clean.length < 6) return '****';
  const prefix = clean.slice(0, 5);
  const suffix = clean.slice(-2);
  return `+${prefix} ****${suffix}`;
}

/**
 * Validates whether an alias is safe, url/command-friendly, and distinct.
 * Must be 2-30 characters of lowercase alphanumeric and underscores.
 *
 * @param {string} alias
 * @returns {boolean}
 */
export function isValidAlias(alias) {
  if (!alias || typeof alias !== 'string') return false;
  return /^[a-z0-9_]{2,30}$/i.test(alias.trim());
}

/**
 * Validates that a string is a plausible international mobile phone number (10 to 15 digits).
 *
 * @param {string} phone
 * @returns {boolean}
 */
export function isValidPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const normalized = normalizePhoneNumber(phone);
  return normalized.length >= 10 && normalized.length <= 15;
}

/**
 * Returns the primary administrator's phone number from config.
 *
 * @returns {string}
 */
export function getPrimaryAdminNumber() {
  if (process.env.ADMIN_PHONE_NUMBER) {
    return normalizePhoneNumber(process.env.ADMIN_PHONE_NUMBER);
  }
  const first = config.ALLOWED_PHONE_NUMBERS?.values()?.next()?.value;
  return first ? normalizePhoneNumber(first) : '';
}

/**
 * Evaluates whether a phone number belongs to the primary administrator.
 *
 * @param {string} phone
 * @returns {boolean}
 */
export function isPrimaryAdmin(phone) {
  if (!phone) return false;
  const admin = getPrimaryAdminNumber();
  if (!admin) return false;
  const normalized = normalizePhoneNumber(phone);
  return (
    normalized === admin ||
    (admin.length >= 10 && normalized.length >= 10 && admin.slice(-10) === normalized.slice(-10))
  );
}

/**
 * Loads persisted contacts from disk if REMINDERS_PERSIST is active.
 */
export function initContacts() {
  if (!config.REMINDERS_PERSIST) return;

  try {
    const file = getPersistenceFile();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      contactsByPhone.clear();
      aliasToPhone.clear();

      for (const item of parsed) {
        if (item.phone && item.alias) {
          const normalized = normalizePhoneNumber(item.phone);
          const alias = item.alias.toLowerCase();
          const contact = {
            alias,
            phone: normalized,
            name: item.name || alias,
            allowAiChat: Boolean(item.allowAiChat),
            createdAt: item.createdAt || Date.now(),
          };
          contactsByPhone.set(normalized, contact);
          aliasToPhone.set(alias, normalized);
        }
      }
      privacyLog('info', 'CONTACTS_LOADED_FROM_DISK', { count: parsed.length });
    }
  } catch (err) {
    privacyLog('warn', 'CONTACTS_LOAD_FAILED', { error: err.message });
  }
}

/**
 * Atomically writes active contacts to disk.
 */
export function persistContacts() {
  if (!config.REMINDERS_PERSIST) return;

  try {
    const dir = getPersistenceDir();
    const file = getPersistenceFile();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = Array.from(contactsByPhone.values());
    const tempFile = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, file);
  } catch (err) {
    privacyLog('warn', 'CONTACTS_PERSIST_FAILED', { error: err.message });
  }
}

/**
 * Registers or updates a contact alias in the contact book.
 *
 * @param {string} alias
 * @param {string} phone
 * @param {string} [name='']
 * @param {object} [options={}]
 * @param {boolean} [options.allowAiChat=false]
 * @returns {{ ok: boolean, contact?: object, error?: string }}
 */
export function addContact(alias, phone, name = '', options = {}) {
  const cleanAlias = (alias || '').trim().toLowerCase().replace(/^@/, '');
  if (!isValidAlias(cleanAlias)) {
    return {
      ok: false,
      error: 'Invalid alias. Must be 2-30 characters of letters, numbers, or underscores (e.g. "mom", "john_doe").',
    };
  }

  if (!isValidPhoneNumber(phone)) {
    return {
      ok: false,
      error: 'Invalid phone number. Must include full country code without "+" (e.g. 919876543210).',
    };
  }

  const normalizedPhone = normalizePhoneNumber(phone);
  const adminNumber = getPrimaryAdminNumber();

  if (adminNumber && (normalizedPhone === adminNumber || normalizedPhone.slice(-10) === adminNumber.slice(-10))) {
    return {
      ok: false,
      error: 'Cannot add yourself (administrator) as a recipient contact.',
    };
  }

  // If alias was previously bound to another number, remove old reverse mapping
  const existingPhoneForAlias = aliasToPhone.get(cleanAlias);
  if (existingPhoneForAlias && existingPhoneForAlias !== normalizedPhone) {
    contactsByPhone.delete(existingPhoneForAlias);
  }

  const contact = {
    alias: cleanAlias,
    phone: normalizedPhone,
    name: (name || cleanAlias).trim(),
    allowAiChat: Boolean(options.allowAiChat),
    createdAt: Date.now(),
  };

  contactsByPhone.set(normalizedPhone, contact);
  aliasToPhone.set(cleanAlias, normalizedPhone);
  persistContacts();

  privacyLog('info', 'CONTACT_SAVED', {
    alias: cleanAlias,
    allowAiChat: contact.allowAiChat,
  });

  return { ok: true, contact };
}

/**
 * Removes a contact by alias or phone number.
 *
 * @param {string} aliasOrPhone
 * @returns {{ ok: boolean, removed?: object, error?: string }}
 */
export function removeContact(aliasOrPhone) {
  if (!aliasOrPhone) return { ok: false, error: 'Alias or phone number required.' };
  const query = aliasOrPhone.trim().toLowerCase().replace(/^@/, '');

  let contact = null;
  if (aliasToPhone.has(query)) {
    const phone = aliasToPhone.get(query);
    contact = contactsByPhone.get(phone);
    aliasToPhone.delete(query);
    if (phone) contactsByPhone.delete(phone);
  } else {
    const normalized = normalizePhoneNumber(query);
    if (contactsByPhone.has(normalized)) {
      contact = contactsByPhone.get(normalized);
      if (contact?.alias) aliasToPhone.delete(contact.alias);
      contactsByPhone.delete(normalized);
    }
  }

  if (!contact) {
    return { ok: false, error: `No contact found matching "${aliasOrPhone}".` };
  }

  persistContacts();
  privacyLog('info', 'CONTACT_REMOVED', { alias: contact.alias });
  return { ok: true, removed: contact };
}

/**
 * Retrieves a contact record by alias or phone.
 *
 * @param {string} aliasOrPhone
 * @returns {object | null}
 */
export function getContact(aliasOrPhone) {
  if (!aliasOrPhone) return null;
  const query = String(aliasOrPhone).trim().toLowerCase().replace(/^@/, '');

  if (aliasToPhone.has(query)) {
    const phone = aliasToPhone.get(query);
    return contactsByPhone.get(phone) || null;
  }

  const normalized = normalizePhoneNumber(query);
  if (contactsByPhone.has(normalized)) {
    return contactsByPhone.get(normalized) || null;
  }

  // Flexible 10-digit suffix matching
  if (normalized.length >= 10) {
    for (const [phone, contact] of contactsByPhone.entries()) {
      if (phone.slice(-10) === normalized.slice(-10)) {
        return contact;
      }
    }
  }

  return null;
}

/**
 * Checks if a phone number matches any registered contact.
 *
 * @param {string} phone
 * @returns {boolean}
 */
export function isKnownContact(phone) {
  return Boolean(getContact(phone));
}

/**
 * Checks if a contact has direct AI conversational access enabled.
 *
 * @param {string} phone
 * @returns {boolean}
 */
export function isContactAiAllowed(phone) {
  const contact = getContact(phone);
  return Boolean(contact && contact.allowAiChat);
}

/**
 * Toggles AI chat permission for a contact.
 *
 * @param {string} aliasOrPhone
 * @param {boolean} allowed
 * @returns {{ ok: boolean, contact?: object, error?: string }}
 */
export function setContactAiAllowed(aliasOrPhone, allowed) {
  const contact = getContact(aliasOrPhone);
  if (!contact) {
    return { ok: false, error: `Contact "${aliasOrPhone}" not found.` };
  }

  contact.allowAiChat = Boolean(allowed);
  contactsByPhone.set(contact.phone, contact);
  persistContacts();

  privacyLog('info', 'CONTACT_AI_PERMIT_UPDATED', {
    alias: contact.alias,
    allowAiChat: contact.allowAiChat,
  });

  return { ok: true, contact };
}

/**
 * Resolves a recipient argument into a structured phone and label object.
 * Accepts either an existing alias (@mom) or a raw international phone number.
 *
 * @param {string} targetInput
 * @returns {{ phone: string, name: string, alias: string | null, isAlias: boolean } | null}
 */
export function resolveContactRecipient(targetInput) {
  if (!targetInput || typeof targetInput !== 'string') return null;
  const trimmed = targetInput.trim();

  // Try alias first
  const existing = getContact(trimmed);
  if (existing) {
    return {
      phone: existing.phone,
      name: existing.name || existing.alias,
      alias: existing.alias,
      isAlias: true,
    };
  }

  // Check if raw valid phone number
  if (isValidPhoneNumber(trimmed)) {
    const normalized = normalizePhoneNumber(trimmed);
    return {
      phone: normalized,
      name: maskPhoneNumber(normalized),
      alias: null,
      isAlias: false,
    };
  }

  return null;
}

/**
 * Returns a list of all registered contacts.
 *
 * @returns {Array<object>}
 */
export function listContacts() {
  return Array.from(contactsByPhone.values()).sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Formats the contact book for presentation in WhatsApp.
 *
 * @returns {string}
 */
export function formatContactsList() {
  const contacts = listContacts();
  if (contacts.length === 0) {
    return [
      '📖 *WhatsApp Contacts Book*',
      '',
      'No contacts saved yet.',
      '',
      '_💡 Save contacts using:_',
      '`/c add <alias> <phone> [name]` (or `/contact add`)',
      '*Example:* `/c add mom 919876543210 Mom`',
    ].join('\n');
  }

  const lines = [
    `📖 *WhatsApp Contacts Book (${contacts.length}):*`,
    '',
    ...contacts.map((c, i) => {
      const mode = c.allowAiChat ? '🤖 Full AI & Relay' : '📨 Relay Only';
      return `${i + 1}. *${c.name}* (\`@${c.alias}\`)\n   📱 ${maskPhoneNumber(c.phone)} | _${mode}_`;
    }),
    '',
    '_💡 To message a contact:_ `/s <alias> <message>` (or `/send`)',
    '_💡 To delete:_ `/c remove <alias>`',
    '_💡 To permit AI chat:_ `/c permit <alias> on|off`',
  ];

  return lines.join('\n');
}

/**
 * Dispatches an outbound message to a contact on behalf of the administrator.
 * Enforces anti-relay authentication, E.164 phone validation, rate limits, and 24h window failovers.
 *
 * @param {string} senderPhone - Must be primary admin
 * @param {string} targetInput - Alias or phone number
 * @param {string} messageBody - The text content to deliver
 * @returns {Promise<{ ok: boolean, error?: string, message?: string, recipient?: object }>}
 */
export async function sendOutboundContactMessage(senderPhone, targetInput, messageBody) {
  // 1. Anti-Relay Guard: Only the Primary Admin can send outbound messages
  if (!isPrimaryAdmin(senderPhone)) {
    privacyLog('warn', 'OUTBOUND_RELAY_DENIED', {
      sender: normalizePhoneNumber(senderPhone),
      target: targetInput,
    });
    return {
      ok: false,
      error: 'unauthorized',
      message: '⛔ *Access Denied:* Only the primary bot administrator can send outbound messages to contacts.',
    };
  }

  // 2. Resolve recipient
  const recipient = resolveContactRecipient(targetInput);
  if (!recipient) {
    return {
      ok: false,
      error: 'invalid_recipient',
      message: `⚠️ *Recipient Not Found:* "${targetInput}" is neither a saved contact alias nor a valid phone number.\n\nUse \`/contacts\` to see saved aliases or provide a full international number (e.g. \`919876543210\`).`,
    };
  }

  const cleanBody = (messageBody || '').trim();
  if (!cleanBody) {
    return {
      ok: false,
      error: 'empty_message',
      message:
        '⚠️ *Message Required:* Please provide the message text to send.\n\n*Format:* `/send <alias> <your message>`',
    };
  }

  // 3. Outbound Rate Limiting (Prevent abuse or Meta bans)
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  while (outboundDispatchTimestamps.length > 0 && outboundDispatchTimestamps[0] < oneHourAgo) {
    outboundDispatchTimestamps.shift();
  }

  if (outboundDispatchTimestamps.length >= OUTBOUND_MAX_PER_HOUR) {
    return {
      ok: false,
      error: 'rate_limit_exceeded',
      message: `⚠️ *Outbound Limit Reached:* Max ${OUTBOUND_MAX_PER_HOUR} outbound messages per hour to protect your WhatsApp account reputation. Please wait before sending more.`,
    };
  }

  outboundDispatchTimestamps.push(now);

  // 4. Format delivery payload
  const formattedOutboundText = [
    `💬 *Message from WhatsApp Assistant:*`,
    '',
    cleanBody,
    '',
    `_Reply to this message to send your response back._`,
  ].join('\n');

  privacyLog('info', 'OUTBOUND_CONTACT_MESSAGE_ATTEMPT', {
    target: recipient.isAlias ? recipient.alias : 'direct_number',
    length: cleanBody.length,
  });

  // 5. Attempt direct WhatsApp send (valid within 24-hour customer service window)
  const sendResult = await sendWhatsAppMessage(recipient.phone, formattedOutboundText);

  if (sendResult && sendResult.success) {
    return {
      ok: true,
      recipient,
      messageId: sendResult.messageId,
      message: `✅ *Delivered!* Message sent to *${recipient.name}* (${maskPhoneNumber(recipient.phone)}).`,
    };
  }

  // 6. Handle Meta 24-hour service window expiry
  const errorMessage = sendResult?.error || '';
  const is24HourError =
    errorMessage.includes('131047') ||
    errorMessage.toLowerCase().includes('24 hour') ||
    errorMessage.toLowerCase().includes('re-engagement');

  if (is24HourError) {
    // If a Meta Template is configured, attempt proactive template delivery
    if (config.TEMPLATE_DIGEST_NAME) {
      const templateResult = await sendWhatsAppTemplate(
        recipient.phone,
        config.TEMPLATE_DIGEST_NAME,
        config.TEMPLATE_DIGEST_LANG || 'en',
        [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: recipient.name },
              { type: 'text', text: cleanBody },
            ],
          },
        ]
      );

      if (templateResult && templateResult.success) {
        return {
          ok: true,
          recipient,
          isTemplate: true,
          message: `✅ *Delivered via Meta Template!* Proactive notification sent to *${recipient.name}* (template: \`${config.TEMPLATE_DIGEST_NAME}\`).`,
        };
      }
    }

    return {
      ok: false,
      error: 'meta_24h_window_expired',
      message: [
        `⚠️ *Meta 24-Hour Policy Notice:*`,
        `Could not deliver free-form text to *${recipient.name}* because they have not messaged the bot in the last 24 hours.`,
        '',
        `*How to connect:*`,
        `1. Ask *${recipient.name}* to send a message (like "Hi") to your bot number to open a free 24-hour session.`,
        `2. Or configure an approved Meta Utility Template (\`TEMPLATE_DIGEST_NAME\`) in your WhatsApp Business Manager.`,
      ].join('\n'),
    };
  }

  return {
    ok: false,
    error: 'send_failed',
    message: `❌ *Delivery Failed:* Meta API returned an error: ${errorMessage || 'Unknown network error'}.`,
  };
}

/**
 * Resets contact store (used for test teardown).
 */
export function clearContacts() {
  contactsByPhone.clear();
  aliasToPhone.clear();
  outboundDispatchTimestamps.length = 0;
}
