/**
 * User Data, Calendar & Contact Export Module
 *
 * Provides export utilities:
 * 1. Full GDPR-compliant in-memory JSON data export (/export).
 * 2. Standard RFC 5545 iCalendar (.ics) event generator & dispatcher.
 * 3. Standard vCard 3.0 (.vcf) contact card generator & dispatcher.
 */
import { getConversation, isVoiceReplyEnabled } from './privacy.js';
import { getPersona, isSearchGroundingEnabled } from './gemini.js';
import { getUserLanguage } from './language.js';
import { listMemoryFacts } from './memory.js';
import { listLearnedWorkflows } from './workflow-learner.js';
import { getUserProfile } from './conversation-adapter.js';
import { exportImageLearnerProfile } from './image-learner.js';
import { listTodos } from './todos.js';
import { listReminders } from './reminders.js';
import { sendWhatsAppDocument, sendWhatsAppMessage } from './whatsapp.js';
import { privacyLog } from './privacy.js';

/**
 * Compiles a sanitized JSON export of the user's data and transmits it via WhatsApp.
 *
 * @param {string} from - Recipient phone number
 * @param {string} anonId - Anonymized user identifier
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function exportUserData(from, anonId) {
  privacyLog('info', 'DATA_EXPORT_REQUESTED', { user: anonId });

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    anonymizedUserId: anonId,
    privacyNotice: 'Exported from Personal WhatsApp AI Assistant. All sensitive PII was masked before storage.',
    preferences: {
      persona: getPersona(anonId),
      language: getUserLanguage(anonId),
      voiceReply: isVoiceReplyEnabled(anonId),
      searchGrounding: isSearchGroundingEnabled(),
    },
    conversationHistory: getConversation(anonId),
    todosSummary: listTodos(anonId),
    remindersSummary: listReminders(anonId),
    memorySummary: listMemoryFacts(anonId),
    learnedWorkflows: listLearnedWorkflows(anonId),
    adaptiveProfile: getUserProfile(anonId),
    imagePreferences: exportImageLearnerProfile(anonId),
  };

  const jsonString = JSON.stringify(exportPayload, null, 2);
  const jsonBuffer = Buffer.from(jsonString, 'utf-8');
  const filename = `data_export_${anonId}_${Date.now()}.json`;
  const caption = '📁 *Personal Data Export:* Here is a copy of your stored session, todos, and preferences.';

  try {
    const docRes = await sendWhatsAppDocument(from, jsonBuffer, filename, caption);
    if (docRes && docRes.success) {
      return {
        success: true,
        message: '✅ *Data Export Sent:* Your exported JSON file has been delivered as a document.',
      };
    }
  } catch (err) {
    privacyLog('warn', 'EXPORT_DOCUMENT_SEND_FAILED', { error: err.message });
  }

  // Fallback: Send summary text message if document upload is not available
  const fallbackMessage = [
    '📁 *Personal Data Summary:*',
    `• *User ID:* \`${anonId}\``,
    `• *Language:* ${exportPayload.preferences.language}`,
    `• *Persona:* ${exportPayload.preferences.persona}`,
    `• *Voice Replies:* ${exportPayload.preferences.voiceReply ? 'Enabled' : 'Disabled'}`,
    `• *Search Grounding:* ${exportPayload.preferences.searchGrounding ? 'Enabled' : 'Disabled'}`,
    `• *Conversation Turns in RAM:* ${exportPayload.conversationHistory.length}`,
    '',
    '_Note: Set up media storage to receive full raw JSON files as documents._',
  ].join('\n');

  await sendWhatsAppMessage(from, fallbackMessage);

  return {
    success: true,
    message: fallbackMessage,
  };
}

/**
 * Generates standard RFC 5545 iCalendar (.ics) buffer for 1-tap calendar import.
 *
 * @param {object} options
 * @param {string} options.title - Meeting or event summary
 * @param {string} [options.description]
 * @param {string} [options.location]
 * @param {string|Date} [options.startTime]
 * @param {string|Date} [options.endTime]
 * @param {number} [options.durationMinutes=60]
 * @returns {Buffer}
 */
export function generateCalendarEventIcs(options = {}) {
  const uid = options.uid || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@whatsapp.ai`;
  const now = new Date();
  const formatUtc = (d) =>
    d
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');

  const start = options.startTime ? new Date(options.startTime) : new Date(now.getTime() + 60 * 60 * 1000);
  const durationMs = (options.durationMinutes || 60) * 60 * 1000;
  const end = options.endTime ? new Date(options.endTime) : new Date(start.getTime() + durationMs);

  const title = (options.title || 'Meeting / Reminder').replace(/[\r\n]/g, ' ');
  const description = (options.description || 'Created via WhatsApp AI Assistant').replace(/[\r\n]/g, '\\n');
  const location = (options.location || '').replace(/[\r\n]/g, ' ');

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WhatsApp AI Assistant//NONSGML v1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(now)}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
  ];

  if (location) {
    icsLines.push(`LOCATION:${location}`);
  }

  icsLines.push('STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR');

  return Buffer.from(icsLines.join('\r\n'), 'utf-8');
}

/**
 * Sends a calendar invite (.ics) to WhatsApp so the user can import it with 1 tap.
 *
 * @param {string} to - Recipient phone number
 * @param {object} eventOptions
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendCalendarInvite(to, eventOptions = {}) {
  const icsBuffer = generateCalendarEventIcs(eventOptions);
  const cleanTitle = (eventOptions.title || 'Event').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 24);
  const filename = `${cleanTitle}_${Date.now()}.ics`;
  const caption = `📅 *Calendar Invite:* ${eventOptions.title || 'New Event'}\nTap to add directly to Google Calendar or Apple Calendar.`;

  return sendWhatsAppDocument(to, icsBuffer, filename, caption);
}

/**
 * Generates standard vCard 3.0 (.vcf) buffer for 1-tap contact saving.
 *
 * @param {object} options
 * @param {string} options.name - Contact full name
 * @param {string} [options.phone]
 * @param {string} [options.email]
 * @param {string} [options.organization]
 * @param {string} [options.title]
 * @param {string} [options.note]
 * @returns {Buffer}
 */
export function generateContactCardVcf(options = {}) {
  const name = (options.name || 'New Contact').replace(/[\r\n]/g, ' ');
  const phone = (options.phone || '').replace(/[\r\n]/g, '');
  const email = (options.email || '').replace(/[\r\n]/g, '');
  const organization = (options.organization || '').replace(/[\r\n]/g, ' ');
  const title = (options.title || '').replace(/[\r\n]/g, ' ');
  const note = (options.note || 'Saved from WhatsApp AI Assistant').replace(/[\r\n]/g, '\\n');

  const vcfLines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `N:${name};;;;`];

  if (organization) vcfLines.push(`ORG:${organization}`);
  if (title) vcfLines.push(`TITLE:${title}`);
  if (phone) vcfLines.push(`TEL;TYPE=CELL,VOICE:${phone}`);
  if (email) vcfLines.push(`EMAIL;TYPE=INTERNET:${email}`);
  if (note) vcfLines.push(`NOTE:${note}`);

  vcfLines.push('END:VCARD');

  return Buffer.from(vcfLines.join('\r\n'), 'utf-8');
}

/**
 * Sends a contact card (.vcf) to WhatsApp so the user can save it to their phone book with 1 tap.
 *
 * @param {string} to - Recipient phone number
 * @param {object} contactOptions
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendContactCard(to, contactOptions = {}) {
  const vcfBuffer = generateContactCardVcf(contactOptions);
  const cleanName = (contactOptions.name || 'Contact').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 24);
  const filename = `${cleanName}.vcf`;
  const caption = `👤 *Contact Card:* ${contactOptions.name}\nTap to add directly to your contacts.`;

  return sendWhatsAppDocument(to, vcfBuffer, filename, caption);
}
