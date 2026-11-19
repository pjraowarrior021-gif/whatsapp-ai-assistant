/**
 * @fileoverview Contextual WhatsApp Reaction Engine.
 *
 * Implements context-aware emoji reactions for incoming WhatsApp interactions.
 * Replaces indiscriminate, blanket reactions (such as ⏳ on all messages)
 * with authentic, intent- and sentiment-driven conversational reactions:
 *
 * - Gratitude / Praise ('thank you', 'thanks') -> ❤️ or 🙏
 * - Acknowledgment / Confirmation ('ok', 'got it', 'sure') -> 👍
 * - Laughter / Humor ('haha', 'lol', 'lmao') -> 😂
 * - Celebration / Milestones ('congrats', 'happy birthday') -> 🎉
 * - Direct Media / Task Completion:
 *     * Image generation -> 🎨
 *     * Video generation -> 🎬
 *     * Reminder set -> ⏰
 *     * Todo item logged -> 📝
 *     * Expense logged -> 💰
 *     * Approval granted -> ✅
 *     * Approval denied -> ❌
 * - Normal informational queries, questions, study prompts, and general text:
 *     -> Strictly NO reaction (null), leaving user messages clean and uncluttered.
 */

import { config } from './config.js';
import { sendWhatsAppReaction } from './whatsapp.js';
import { privacyLog } from './privacy.js';

// Contextual reaction patterns with Unicode support (/u flag for proper emoji code point matching)
const GRATITUDE_REGEX =
  /(?:^|\b)(thank(s|\s+you|\s+u)?|thx|ty|appreciate\s+it|grateful|great\s+job|awesome|amazing|perfect|good\s+bot|you('re|\s+are)\s+the\s+best)(?:$|\b)/iu;
const ACKNOWLEDGMENT_REGEX =
  /^(ok(ay)?|cool|got\s+it|noted|understood|sure|alright|fine|sounds\s+good|roger\s+that|k|👍)$/iu;
const LAUGHTER_REGEX = /(?:^|\b)((?:ha){2,}|(?:he){2,}|lol|lmao|rofl|xd|hilarious)(?:$|\b)|[😂🤣]/iu;
const CELEBRATION_REGEX =
  /(?:^|\b)(congrat(s|ulations)?|happy\s+birthday|hbd|cheers|hurray|hooray|yay|kudos)(?:$|\b)|[🎉🥳]/iu;
const LOVE_REGEX = /(?:^|\b)(love\s+(this|you)|love\s+it|<3)(?:$|\b)|[❤️💖]/iu;

// Informational queries, study questions, and standard analytical prompts that must NOT trigger reactions
const INFORMATIONAL_QUERY_REGEX =
  /^(explain|what|how|why|when|where|who|which|can\s+you|could\s+you|please\s+(explain|describe|write|summarize|tell)|summarize|write|generate|tell\s+me|compare|define|list|calculate|solve|check)\b/i;

/**
 * Determines a contextual reaction emoji based on text sentiment or explicit action context.
 *
 * @param {string} [rawText=''] - The user's input message text
 * @param {object} [context={}] - Optional metadata regarding the interaction
 * @param {string} [context.action] - Explicit action type (e.g. 'image_gen', 'video_gen', 'reminder_created', 'todo_created', 'expense_created', 'approval_granted', 'approval_denied')
 * @param {string} [context.messageType] - Type of message ('text', 'image', 'document', etc.)
 * @returns {string|null} - Emoji to react with, or null if no reaction is appropriate
 */
export function getContextualReaction(rawText = '', context = {}) {
  // 1. Explicit action context takes precedence
  if (context.action) {
    switch (context.action) {
      case 'image_gen':
        return '🎨';
      case 'video_gen':
        return '🎬';
      case 'reminder_created':
        return '⏰';
      case 'todo_created':
        return '📝';
      case 'expense_created':
        return '💰';
      case 'approval_granted':
        return '✅';
      case 'approval_denied':
        return '❌';
      default:
        break;
    }
  }

  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return null;

  // 2. Informational questions, study queries, explanations, and long queries should NOT receive reactions
  // (e.g., "Explain in detail", "What is...", "How does...", "Can you...", "Why does...")
  if (INFORMATIONAL_QUERY_REGEX.test(text) || text.length > 120) {
    return null;
  }

  // 3. Conversational sentiment analysis for concise inputs
  if (LOVE_REGEX.test(text)) {
    return '❤️';
  }

  if (GRATITUDE_REGEX.test(text)) {
    return '🙏';
  }

  if (ACKNOWLEDGMENT_REGEX.test(text)) {
    return '👍';
  }

  if (LAUGHTER_REGEX.test(text)) {
    return '😂';
  }

  if (CELEBRATION_REGEX.test(text)) {
    return '🎉';
  }

  // Default: Keep messages clean, do not add unsolicited reactions
  return null;
}

/**
 * Evaluates and applies a contextual reaction to a WhatsApp message if appropriate.
 * Safe and non-blocking: never throws and never delays primary response delivery.
 *
 * @param {string} to - Recipient phone number
 * @param {string} messageId - Target WhatsApp message ID
 * @param {string} [rawText=''] - Message text
 * @param {object} [context={}] - Context metadata
 * @returns {Promise<string|null>} - The reacted emoji, or null if none applied
 */
export async function applyContextualReaction(to, messageId, rawText = '', context = {}) {
  if (!config.ENABLE_CONTEXTUAL_REACTIONS) {
    return null;
  }

  if (!to || !messageId) {
    return null;
  }

  const emoji = getContextualReaction(rawText, context);
  if (!emoji) {
    return null;
  }

  try {
    const res = await sendWhatsAppReaction(to, messageId, emoji);
    if (res?.success) {
      privacyLog('debug', 'CONTEXTUAL_REACTION_SENT', {
        toEnding: to.slice(-4),
        messageId,
        emoji,
        action: context.action || 'conversational',
      });
      return emoji;
    }
  } catch (err) {
    privacyLog('debug', 'CONTEXTUAL_REACTION_ERROR', { error: err.message, messageId });
  }

  return null;
}

/**
 * Removes an existing emoji reaction from a specific WhatsApp message.
 *
 * @param {string} to - Recipient phone number
 * @param {string} messageId - Target WhatsApp message ID
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function clearWhatsAppReaction(to, messageId) {
  if (!to || !messageId) {
    return { success: false, error: 'Missing to or messageId' };
  }
  return sendWhatsAppReaction(to, messageId, '');
}
