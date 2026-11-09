/**
 * User Data Export Module (/export)
 * Complies with data sovereignty and transparency principles by exporting
 * all stored user sessions, preferences, to-dos, and reminders as an in-memory JSON document.
 */
import { getConversation, isVoiceReplyEnabled } from './privacy.js';
import { getPersona, isSearchGroundingEnabled } from './gemini.js';
import { getUserLanguage } from './language.js';
import { listMemoryFacts } from './memory.js';
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
