import express from 'express';
import crypto from 'crypto';
import { config, normalizePhoneNumber } from './config.js';
import {
  isAuthorized,
  getAnonymizedId,
  maskSensitiveInfo,
  privacyLog,
  getConversation,
  saveTurn,
  resetConversation,
  deleteUserData,
  getPrivacyDisclosure,
  checkUserRateLimit,
  rememberMessage,
  getRememberedMessage,
  isVoiceReplyEnabled,
  setVoiceReplyEnabled,
} from './privacy.js';
import {
  generateAIResponse,
  getActiveModel,
  setActiveModel,
  isSearchGroundingEnabled,
  setSearchGrounding,
  getPersona,
  setPersona,
  listPersonas,
  uploadGeminiFileInMemory,
  deleteGeminiFile,
} from './gemini.js';
import { isDocumentSupported, resolveDocumentMime, extractDocumentContent } from './document.js';
import {
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendWhatsAppVideo,
  sendWhatsAppAudio,
  sendWhatsAppButtons,
  markMessageAsRead,
  sendWhatsAppTypingIndicator,
  getMediaUrl,
  downloadMediaInMemory,
} from './whatsapp.js';
import {
  parseImagePrompt,
  parseImagePromptOptions,
  generateImageUrl,
  generateCleanImage,
  processImageReaction,
  recordImageGeneration,
  resetImageLearner,
} from './image-gen.js';
import { parseVideoPrompt, parseVideoPromptOptions, generateVideo } from './video-gen.js';
import { scheduleReminder, listReminders, deleteReminder, snoozeReminder, completeReminder } from './reminders.js';
import {
  saveUserLocation,
  getUserLocation,
  searchNearbyPlaces,
  formatPlacesSummary,
  LOCATION_CATEGORIES,
} from './location.js';
import { addTodo, listTodos, markTodoDone, clearCompletedTodos } from './todos.js';
import { extractUrl, extractUserPromptAside, fetchAndExtractArticle } from './web-scraper.js';
import { extractYouTubeVideoId, isYouTubeDomain, fetchYouTubeVideoData, buildYouTubeAiPrompt } from './youtube.js';
import { isInstagramUrl, fetchInstagramPostData, buildInstagramAiPrompt } from './instagram.js';
import { synthesizeSpeech } from './tts.js';
import { checkAndIncrementUserQuota, recordGeminiDailyUsage, getUserQuotaReport } from './quota.js';
import { recordMessageMetric, recordErrorMetric, recordMediaBytes, recordGeminiMetric } from './metrics.js';
import { messageQueue } from './queue.js';
import { handleLanguageCommand } from './language.js';
import { handleMemoryCommand, clearUserMemory, addAutoMemoryFact } from './memory.js';
import { clearLearnedWorkflows } from './workflow-learner.js';
import { clearUserProfile } from './conversation-adapter.js';
import { autoLearnFromTurn, extractDeterministicFacts } from './auto-learner.js';
import { exportUserData } from './export.js';
import {
  addContact,
  removeContact,
  getContact,
  formatContactsList,
  setContactAiAllowed,
  sendOutboundContactMessage,
  isPrimaryAdmin,
  getPrimaryAdminNumber,
  maskPhoneNumber,
} from './contacts.js';

export { messageQueue };
export const webhookRouter = express.Router();

import { store } from './store/index.js';
import { transcribeAudioBuffer } from './stt.js';
import { getPendingApproval, resolveApproval, isHumanHandoffActive, setHumanHandoff } from './approval.js';
import { recordLastInboundInteraction } from './templates.js';
import { evaluateInputGuardrails } from './guardrails.js';

// Mount JSON body parser (with raw buffer capture for HMAC) and URL-encoded parser strictly on /webhook
webhookRouter.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
    limit: '1mb',
  })
);
webhookRouter.use(express.urlencoded({ extended: true }));

// In-Memory cache for message deduplication (messageId -> timestamp)
const processedMessageIds = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Checks whether a message ID has already been processed using Redis / Store with in-memory fallback.
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
export async function isMessageProcessed(messageId) {
  if (!messageId) return false;
  try {
    const exists = await store.get(`dedup:msg:${messageId}`);
    if (exists) return true;
  } catch {
    // Fallback to in-memory cache
  }
  return processedMessageIds.has(messageId);
}

/**
 * Marks a message ID as processed in Redis / Store (5-minute TTL) and local memory.
 * @param {string} messageId
 * @returns {Promise<void>}
 */
export async function markMessageProcessed(messageId) {
  if (!messageId) return;
  processedMessageIds.set(messageId, Date.now());
  try {
    await store.set(`dedup:msg:${messageId}`, Date.now(), 300);
  } catch {
    // In-memory fallback already set
  }
}

/**
 * Periodically purge stale deduplication entries
 */
const dedupInterval = setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [msgId, timestamp] of processedMessageIds.entries()) {
    if (timestamp < cutoff) {
      processedMessageIds.delete(msgId);
    }
  }
}, 60 * 1000);
if (dedupInterval.unref) {
  dedupInterval.unref();
}

/**
 * Cryptographically verifies Meta's x-hub-signature-256 header using HMAC-SHA256.
 *
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader - Format "sha256=<hex>"
 * @param {string} appSecret
 * @returns {boolean}
 */
export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader || !rawBody) {
    return false;
  }

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    return false;
  }

  const receivedHash = parts[1];
  const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // Constant-time comparison to prevent timing attacks
  const receivedBuffer = Buffer.from(receivedHash, 'hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * GET /webhook
 * Meta Webhook verification handshake endpoint.
 * Strict comparison against WHATSAPP_VERIFY_TOKEN only.
 */
webhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe') {
      const expectedBuffer = Buffer.from(config.WHATSAPP_VERIFY_TOKEN || '', 'utf-8');
      const receivedBuffer = Buffer.from(String(token), 'utf-8');

      if (
        expectedBuffer.length > 0 &&
        expectedBuffer.length === receivedBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
      ) {
        privacyLog('info', 'WEBHOOK_VERIFICATION_SUCCESS');
        return res.status(200).send(challenge);
      }
    }
    privacyLog('warn', 'WEBHOOK_VERIFICATION_FAILED', {
      receivedTokenProvided: Boolean(token),
    });
    return res.status(403).send('Forbidden: Verify token mismatch.');
  }

  return res.status(400).send('Bad Request: Missing hub.mode or hub.verify_token');
});

/**
 * POST /webhook
 * Meta Webhook message receiver endpoint.
 */
webhookRouter.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  const signature = req.headers['x-hub-signature-256'];

  // 1. Signature Verification (Fail-closed)
  // Only bypass during automated tests when explicitly set with SKIP_SIGNATURE_VERIFICATION
  const shouldSkipSig = Boolean(config.SKIP_SIGNATURE_VERIFICATION) && config.NODE_ENV === 'test';

  if (!shouldSkipSig) {
    const isValid = verifyMetaSignature(req.rawBody, signature, config.WHATSAPP_APP_SECRET);
    if (!isValid) {
      privacyLog('warn', 'INVALID_WEBHOOK_SIGNATURE', {
        requestId,
        hasSignature: Boolean(signature),
      });
      recordErrorMetric('invalid_signature');
      return res.status(401).send('Unauthorized: Invalid HMAC signature.');
    }
  }

  // 2. Immediate 200 OK acknowledgment to Meta to prevent timeout/retry loop
  res.status(200).send('EVENT_RECEIVED');

  // 3. Asynchronous processing of incoming event payload
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      return;
    }

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // If status update (delivered/read receipt), log lightly and skip (log errors on delivery failure)
        if (value.statuses) {
          const s = value.statuses[0];
          privacyLog(s?.status === 'failed' ? 'error' : 'debug', 'STATUS_RECEIPT_RECEIVED', {
            requestId,
            status: s?.status,
            messageId: s?.id,
            errors: s?.errors,
          });
          continue;
        }

        const messages = value.messages;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          continue;
        }

        for (const message of messages) {
          if (message.id && (await isMessageProcessed(message.id))) {
            privacyLog('debug', 'DUPLICATE_WEBHOOK_MESSAGE_DROPPED_EARLY', {
              requestId,
              id: message.id,
            });
            continue;
          }

          privacyLog('info', 'ENQUEUEING_INCOMING_MESSAGE', {
            requestId,
            id: message.id,
            type: message.type,
            fromEnding: message.from ? message.from.slice(-4) : 'unknown',
          });
          messageQueue.push({
            message,
            requestId,
            to: message.from,
            anonId: getAnonymizedId(message.from),
          });
        }
      }
    }
  } catch (err) {
    recordErrorMetric('webhook_processing');
    privacyLog('error', 'WEBHOOK_ASYNC_PROCESS_ERROR', {
      requestId,
      error: err.message,
    });
  }
});

/**
 * Normalizes audio MIME type by stripping parameters (e.g. codecs=opus).
 * @param {string} mime
 * @returns {string}
 */
function normalizeAudioMime(mime) {
  if (!mime) return 'audio/ogg';
  const clean = mime.split(';')[0].trim().toLowerCase();
  return clean || 'audio/ogg';
}

/**
 * Normalizes user input by mapping interactive button IDs and slashless commands to standard slash format.
 * @param {string} text
 * @param {boolean} hasMedia
 * @returns {string}
 */
export function normalizeCommand(text, hasMedia = false) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Interactive Button IDs
  const buttonMap = {
    cmd_help: '/help',
    cmd_status: '/status',
    cmd_reset: '/reset',
    cmd_privacy: '/privacy',
    cmd_usage: '/usage',
    cmd_reminders: '/reminders',
    cmd_todos: '/todos',
    cmd_persona: '/persona',
    cmd_voice: '/voice',
    cmd_language: '/language',
    cmd_memory: '/memory',
    cmd_export: '/export',
    cmd_img_lion: '/image a majestic male lion in a thunderstorm --photo',
    cmd_img_wall: '/image a neon cyberpunk alleyway in Tokyo rain --wallpaper',
    cmd_img_anime: '/image a girl reading in an enchanted sunlit library --anime',
    cmd_vid_drone: '/video a futuristic cybernetic drone racing through neon canyons --drone --wide',
    cmd_vid_nature: '/video waves gently lapping against a bioluminescent beach at twilight --slowmo',
  };
  if (buttonMap[lower]) {
    return buttonMap[lower];
  }

  // Already prefixed with slash
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  // If media is attached, don't auto-convert caption text into commands
  if (hasMedia) {
    return trimmed;
  }

  // 2. Exact slashless commands
  const exactMap = {
    help: '/help',
    status: '/status',
    reset: '/reset',
    delete: '/delete',
    forget: '/forget',
    privacy: '/privacy',
    usage: '/usage',
    reminders: '/reminders',
    todos: '/todos',
    clear_todos: '/clear_todos',
    persona: '/persona',
    voice: '/voice',
    'voice status': '/voice status',
    'voice on': '/voice on',
    'voice off': '/voice off',
    'search on': '/search on',
    'search off': '/search off',
    language: '/language',
    memory: '/memory',
    export: '/export',
    c: '/c',
    'c list': '/c',
    contacts: '/contacts',
    'contact list': '/contacts',
  };
  if (exactMap[lower]) {
    return exactMap[lower];
  }

  // 3. Prefix slashless commands (followed by space)
  const prefixes = [
    'remind ',
    'todo ',
    'done ',
    'persona ',
    'model ',
    'image ',
    'draw ',
    'imagine ',
    'video ',
    'vid ',
    'animate ',
    'motion ',
    'language ',
    'memory ',
    's ',
    'c ',
    'send ',
    'contact ',
    'msg ',
  ];
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return `/${trimmed}`;
    }
  }

  return trimmed;
}

/**
 * Dispatches an individual incoming WhatsApp message.
 * @param {object} message - WhatsApp message payload object
 * @param {string} requestId - Traceable request identifier
 */
export async function handleIncomingMessage(message, requestId = crypto.randomUUID()) {
  const messageId = message.id;
  const from = message.from;
  const messageType = message.type;
  const isGroup = Boolean(from && (from.includes('@g.us') || from.includes('-group') || message.author));
  const senderPhone = message.author || from;
  const anonId = getAnonymizedId(senderPhone);

  // Record inbound interaction timestamp for 24-hour session window tracking
  if (senderPhone) {
    await recordLastInboundInteraction(senderPhone);
  }

  // 1. Deduplication Check
  if (messageId && (await isMessageProcessed(messageId))) {
    privacyLog('debug', 'DUPLICATE_MESSAGE_SKIPPED', { requestId, user: anonId });
    return;
  }
  if (messageId) {
    await markMessageProcessed(messageId);
  }

  // 1a. Human Handoff Check (if active, pause bot automation unless resumed)
  if (senderPhone && (await isHumanHandoffActive(senderPhone))) {
    const rawCheck = String(message.text?.body || message.interactive?.button_reply?.id || '')
      .trim()
      .toLowerCase();
    if (rawCheck === '/bot' || rawCheck === '/resume' || rawCheck === 'resume') {
      await setHumanHandoff(senderPhone, false);
      await sendWhatsAppMessage(from, '🤖 *AI Assistant Resumed:* Bot automation is now active.');
      return;
    }
    privacyLog('info', 'HUMAN_HANDOFF_PASSED_TO_OPERATOR', { requestId, user: anonId });
    return;
  }

  // 1b. Check Pending Action Approval
  if (senderPhone) {
    const pending = await getPendingApproval(senderPhone);
    if (pending) {
      const userReply =
        message.text?.body?.trim() ||
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id ||
        '';
      if (userReply) {
        const resolution = await resolveApproval(senderPhone, userReply);
        if (resolution.resolved) {
          if (resolution.approved) {
            if (resolution.action?.type === 'delete_reminder' && resolution.action?.payload?.reminderId) {
              deleteReminder(resolution.action.payload.reminderId);
            }
            await sendWhatsAppMessage(from, resolution.message || '✅ Action confirmed.');
          } else {
            await sendWhatsAppMessage(from, resolution.message || '❌ Action cancelled.');
          }
          return;
        } else if (resolution.hasPending) {
          await sendWhatsAppMessage(from, resolution.message);
          return;
        }
      }
    }
  }

  // 1c. Fast-path Interactive Action Buttons (Reminders & Location Quick Filters)
  const interactiveButtonId =
    message.interactive?.button_reply?.id ||
    (typeof message.text?.body === 'string' &&
    (message.text.body.startsWith('rem_') || message.text.body.startsWith('loc_cat_'))
      ? message.text.body
      : '');

  if (interactiveButtonId) {
    if (interactiveButtonId.startsWith('rem_done_')) {
      const remId = interactiveButtonId.replace('rem_done_', '');
      const res = completeReminder(remId);
      await sendWhatsAppMessage(from, res.message || '✅ Marked reminder as done!');
      return;
    }
    if (interactiveButtonId.startsWith('rem_snooze_')) {
      const remId = interactiveButtonId.replace('rem_snooze_', '');
      const res = snoozeReminder(remId, 15);
      await sendWhatsAppMessage(from, res.message || '⏱️ Snoozed reminder for 15 minutes.');
      return;
    }
    if (interactiveButtonId.startsWith('rem_dismiss_')) {
      const remId = interactiveButtonId.replace('rem_dismiss_', '');
      const res = completeReminder(remId);
      await sendWhatsAppMessage(from, res.message || '❌ Reminder dismissed.');
      return;
    }
    if (interactiveButtonId.startsWith('loc_cat_')) {
      const catKey = interactiveButtonId.replace('loc_cat_', '');
      const userLoc = await getUserLocation(from);
      if (userLoc) {
        const places = await searchNearbyPlaces({
          latitude: userLoc.latitude,
          longitude: userLoc.longitude,
          category: catKey,
        });
        const catInfo = LOCATION_CATEGORIES[catKey];
        const card = formatPlacesSummary(places, `📍 Nearby ${catInfo?.label || 'Places'}`);
        await sendWhatsAppMessage(from, card);
        return;
      }
    }
  }

  // 1b. Fast-path unhandled message types
  if (messageType === 'reaction') {
    const reactionObj = message.reaction;
    const emoji = reactionObj?.emoji;
    const targetMsgId = reactionObj?.message_id;
    if (emoji && anonId) {
      processImageReaction(anonId, emoji, targetMsgId);
    }
    privacyLog('debug', 'REACTION_PROCESSED', { requestId, user: anonId, emoji, targetMsgId });
    return;
  }
  if (messageType === 'sticker') {
    await sendWhatsAppMessage(
      from,
      '🎨 *Sticker Received:* I cannot analyze animated or image stickers yet. Feel free to send text, documents, or photos!'
    );
    return;
  }
  if (messageType === 'contacts' || messageType === 'contact') {
    await sendWhatsAppMessage(
      from,
      '👤 *Contact Card Received:* Contact cards cannot be processed automatically. Please share contact details as text if you need assistance.'
    );
    return;
  }
  if (messageType === 'video') {
    await sendWhatsAppMessage(
      from,
      '🎥 *Video Received:* Full video analysis is not supported yet. Please send a screenshot, image, or text question instead.'
    );
    return;
  }

  // 2. Authorization Whitelist & Group Check
  if (isGroup) {
    const groupId = from.replace('@g.us', '');
    const isAllowedGroup =
      config.ALLOWED_GROUP_IDS.has(groupId) || config.ALLOWED_GROUP_IDS.has(normalizePhoneNumber(groupId));
    if (!isAllowedGroup) {
      privacyLog('debug', 'GROUP_MESSAGE_IGNORED_UNAUTHORIZED', { groupId });
      return;
    }
    const textBody = message.text?.body?.trim() || '';
    if (!textBody.startsWith(config.GROUP_TRIGGER_PREFIX)) {
      return;
    }
  } else if (!isAuthorized(from)) {
    privacyLog('warn', 'UNAUTHORIZED_ACCESS_ATTEMPT', {
      requestId,
      user: anonId,
      receivedFrom: from,
      normalizedFrom: normalizePhoneNumber(from),
      configuredAllowed: Array.from(config.ALLOWED_PHONE_NUMBERS),
    });
    recordMessageMetric(messageType, 'rejected');
    await sendWhatsAppButtons(
      from,
      '⛔ *Access Restricted:*\nThis personal assistant is private and configured for authorized users only.',
      [{ id: 'cmd_privacy', title: 'Privacy Policy' }]
    );
    return;
  }

  // 3. Mark message as read (blue ticks)
  if (messageId) {
    markMessageAsRead(messageId).catch(() => {});
  }

  // 4. Per-User Sliding-Window Rate Limit Guard
  const rateLimitStatus = checkUserRateLimit(anonId);
  if (!rateLimitStatus.allowed) {
    privacyLog('warn', 'USER_RATE_LIMIT_EXCEEDED', { requestId, user: anonId });
    recordMessageMetric(messageType, 'rate_limited');
    await sendWhatsAppMessage(
      from,
      '⏳ *Rate Limit Notice:*\nYou are sending messages too quickly. Please wait a moment before sending another request.'
    );
    return;
  }

  // 4b. Contact Message Relay to Administrator
  const fromNormalized = normalizePhoneNumber(from);
  const contactInfo = getContact(fromNormalized);
  const isAdminSender = isPrimaryAdmin(from);

  if (contactInfo && !isAdminSender && !contactInfo.allowAiChat) {
    const adminPhone = getPrimaryAdminNumber();
    if (adminPhone) {
      privacyLog('info', 'CONTACT_REPLY_RELAYED_TO_ADMIN', {
        contactAlias: contactInfo.alias,
      });

      const contactLabel = contactInfo.name || contactInfo.alias;
      const relayMessage = [
        `📬 *Reply from ${contactLabel}* (${maskPhoneNumber(fromNormalized)}):`,
        '',
        `"${rawText || '(attachment/media)'}"`,
        '',
        `_💡 To reply:_ \`/s ${contactInfo.alias} <your message>\``,
      ].join('\n');

      await sendWhatsAppMessage(adminPhone, relayMessage);
      await sendWhatsAppMessage(
        from,
        '✅ Your message was forwarded to the administrator. They will get back to you shortly.'
      );
      recordMessageMetric('contact_relay', 'success');
      return;
    }
  }

  // 5. Daily Quota Guard (Per-User and Global Gemini Budget)
  const quotaStatus = checkAndIncrementUserQuota(anonId);
  if (!quotaStatus.allowed) {
    privacyLog('warn', 'USER_OR_GLOBAL_QUOTA_EXCEEDED', {
      requestId,
      user: anonId,
      reason: quotaStatus.reason,
    });
    recordMessageMetric(messageType, 'quota_exceeded');

    if (quotaStatus.reason === 'user_daily_quota_reached') {
      await sendWhatsAppMessage(
        from,
        `🛑 *Daily Quota Reached:*\nYou have reached your personal daily quota of ${config.MAX_REQUESTS_PER_USER_PER_DAY} messages. Your quota resets at 00:00 UTC.`
      );
    } else {
      await sendWhatsAppMessage(
        from,
        `🛑 *Daily System Budget Reached:*\nThe Gemini daily AI request limit has been reached. Please check back after 00:00 UTC.`
      );
    }
    return;
  }

  // 6. Validate supported message types
  const supportedTypes = ['text', 'image', 'audio', 'voice', 'document', 'interactive', 'location'];
  if (!supportedTypes.includes(messageType)) {
    privacyLog('info', 'UNSUPPORTED_MESSAGE_TYPE', {
      requestId,
      user: anonId,
      type: messageType,
    });
    recordMessageMetric(messageType, 'rejected');
    await sendWhatsAppButtons(
      from,
      `ℹ️ _Supported formats: Text, Links, Photos, Voice Notes, Documents, and Locations._\nSend any text question, link, location, or media for instant AI analysis.`,
      [
        { id: 'cmd_help', title: 'Help Manual' },
        { id: 'cmd_status', title: 'System Status' },
      ]
    );
    return;
  }

  let rawText = '';
  let mediaPart = null; // { mimeType, data }
  let forceGrounding = false;
  let locationSnapshotPrompt = '';

  // 7. Parse message content by type
  if (messageType === 'text') {
    rawText = message.text?.body?.trim() || '';
    if (!rawText) return;
  } else if (messageType === 'interactive') {
    const interactive = message.interactive;
    const buttonId = interactive?.button_reply?.id;
    const listId = interactive?.list_reply?.id;
    rawText = buttonId || listId || interactive?.button_reply?.title || '';
    if (!rawText) return;
  } else if (messageType === 'location') {
    const loc = message.location || {};
    const lat = loc.latitude;
    const lng = loc.longitude;
    const locName = loc.name ? loc.name.trim() : '';
    const address = loc.address ? loc.address.trim() : '';

    if (lat !== undefined && lng !== undefined) {
      await saveUserLocation(from, { latitude: lat, longitude: lng, name: locName, address });
    }

    const locParts = [];
    if (lat !== undefined && lng !== undefined) locParts.push(`Coordinates: ${lat}, ${lng}`);
    if (locName) locParts.push(`Name: ${locName}`);
    if (address) locParts.push(`Address: ${address}`);

    rawText = locParts.join(' | ');
    locationSnapshotPrompt = `The user shared this location (${locParts.join(' | ')}).\n\nProvide a quick local snapshot for this location: current weather, area overview, and 3 notable points of interest nearby. Format cleanly with bullet points for WhatsApp.`;
    forceGrounding = true;
  } else if (messageType === 'image') {
    rawText = message.image?.caption?.trim() || '';
    const mediaId = message.image?.id;

    if (!mediaId) {
      await sendWhatsAppMessage(from, '⚠️ *Image Error:* Missing media identifier from WhatsApp.');
      return;
    }

    const mediaMeta = await getMediaUrl(mediaId);
    if (!mediaMeta || !mediaMeta.url) {
      await sendWhatsAppMessage(from, '⚠️ *Image Error:* Could not resolve image download URL from WhatsApp servers.');
      return;
    }

    const downloaded = await downloadMediaInMemory(mediaMeta.url);
    if (!downloaded || !downloaded.buffer) {
      if (downloaded?.reason === 'too_large') {
        await sendWhatsAppMessage(from, '⚠️ *Image Error:* The image exceeds the maximum permitted size of 16MB.');
      } else if (downloaded?.reason === 'timeout') {
        await sendWhatsAppMessage(from, '⚠️ *Image Error:* Image download timed out. Please try sending again.');
      } else {
        await sendWhatsAppMessage(
          from,
          '⚠️ *Image Error:* Failed to download image into memory. Please try sending again.'
        );
      }
      return;
    }

    recordMediaBytes(downloaded.buffer.length);
    mediaPart = {
      mimeType: mediaMeta.mimeType || message.image?.mime_type || 'image/jpeg',
      data: downloaded.base64,
    };
  } else if (messageType === 'audio' || messageType === 'voice') {
    const audioObj = message.audio || message.voice;
    rawText = ''; // Voice notes typically lack captions
    const mediaId = audioObj?.id;

    if (!mediaId) {
      await sendWhatsAppMessage(from, '⚠️ *Voice Note Error:* Missing audio identifier from WhatsApp.');
      return;
    }

    const mediaMeta = await getMediaUrl(mediaId);
    if (!mediaMeta || !mediaMeta.url) {
      await sendWhatsAppMessage(from, '⚠️ *Voice Note Error:* Could not resolve audio download URL.');
      return;
    }

    const downloaded = await downloadMediaInMemory(mediaMeta.url);
    if (!downloaded || !downloaded.buffer) {
      if (downloaded?.reason === 'too_large') {
        await sendWhatsAppMessage(from, '⚠️ *Voice Note Error:* Audio file exceeds maximum allowed size (16MB).');
      } else if (downloaded?.reason === 'timeout') {
        await sendWhatsAppMessage(from, '⚠️ *Voice Note Error:* Audio download timed out. Please try again.');
      } else {
        await sendWhatsAppMessage(from, '⚠️ *Voice Note Error:* Failed to download voice note. Please try again.');
      }
      return;
    }

    recordMediaBytes(downloaded.buffer.length);
    mediaPart = {
      mimeType: normalizeAudioMime(mediaMeta.mimeType || audioObj?.mime_type),
      data: downloaded.base64,
    };

    // Inbound Speech-to-Text transcription
    try {
      const stt = await transcribeAudioBuffer(downloaded.buffer, mediaPart.mimeType);
      if (stt.success && stt.text) {
        rawText = stt.text;
        privacyLog('info', 'VOICE_NOTE_TRANSCRIBED', {
          requestId,
          user: anonId,
          charLength: rawText.length,
        });
      }
    } catch (sttErr) {
      privacyLog('warn', 'VOICE_NOTE_STT_FAILED', { error: sttErr.message });
    }
  } else if (messageType === 'document') {
    const docObj = message.document;
    rawText = docObj?.caption?.trim() || '';
    const mediaId = docObj?.id;
    const reportedMime = (docObj?.mime_type || '').toLowerCase();
    const docFilename = docObj?.filename || '';

    // Document format verification with filename extension fallback
    if (!isDocumentSupported(reportedMime, docFilename)) {
      privacyLog('warn', 'DOCUMENT_MIME_REJECTED', { requestId, mime: reportedMime, filename: docFilename });
      await sendWhatsAppMessage(
        from,
        `⚠️ *Document Error:* Unsupported format (\`${reportedMime || docFilename || 'unknown'}\`).\nPlease upload PDF, Office (PPTX, DOCX, XLSX), or TXT/CSV files.`
      );
      return;
    }

    if (!mediaId) {
      await sendWhatsAppMessage(from, '⚠️ *Document Error:* Missing document identifier.');
      return;
    }

    const mediaMeta = await getMediaUrl(mediaId);
    if (!mediaMeta || !mediaMeta.url) {
      await sendWhatsAppMessage(from, '⚠️ *Document Error:* Could not resolve document download URL.');
      return;
    }

    const downloaded = await downloadMediaInMemory(mediaMeta.url);
    if (!downloaded || !downloaded.buffer) {
      if (downloaded?.reason === 'too_large') {
        const maxMb = Math.round(config.MEDIA_MAX_BYTES / (1024 * 1024));
        await sendWhatsAppMessage(from, `⚠️ *Document Error:* Document exceeds maximum size limit (${maxMb}MB).`);
      } else if (downloaded?.reason === 'timeout') {
        await sendWhatsAppMessage(from, '⚠️ *Document Error:* Download timed out. Please try sending again.');
      } else {
        await sendWhatsAppMessage(from, '⚠️ *Document Error:* Failed to download document.');
      }
      return;
    }

    recordMediaBytes(downloaded.buffer.length);
    const resolvedMime = resolveDocumentMime(reportedMime, docFilename);

    // Extract text in memory for Office/Text formats, or prepare PDF for multimodal reasoning
    const extracted = extractDocumentContent(downloaded.buffer, resolvedMime, docFilename);

    if (extracted.isPdf) {
      if (downloaded.buffer.length > 20 * 1024 * 1024) {
        // PDF > 20MB exceeds Gemini inlineData cap: upload via Gemini Files API
        const uploadedFile = await uploadGeminiFileInMemory(
          downloaded.buffer,
          'application/pdf',
          docFilename || 'document.pdf'
        );
        if (uploadedFile) {
          mediaPart = {
            mimeType: 'application/pdf',
            fileUri: uploadedFile.uri,
            geminiFileName: uploadedFile.name,
          };
        } else {
          await sendWhatsAppMessage(
            from,
            '⚠️ *Document Error:* Unable to process large PDF file. Please try again with a smaller document.'
          );
          return;
        }
      } else {
        mediaPart = {
          mimeType: 'application/pdf',
          data: downloaded.base64,
        };
      }
    } else if (extracted.ok && extracted.text) {
      // Office document / Text / CSV successfully extracted in memory
      const userCaption = rawText ? `\n\nUser Question/Caption: "${rawText}"` : '';
      const docTypeLabel =
        docFilename.toLowerCase().endsWith('.pptx') || resolvedMime.includes('presentation')
          ? `PowerPoint Presentation (${docFilename || 'presentation.pptx'}, ${extracted.slideCount || 0} slides)`
          : docFilename.toLowerCase().endsWith('.docx') || resolvedMime.includes('word')
            ? `Word Document (${docFilename || 'document.docx'})`
            : docFilename.toLowerCase().endsWith('.xlsx') || resolvedMime.includes('sheet')
              ? `Excel Spreadsheet (${docFilename || 'data.xlsx'})`
              : `Document (${docFilename || 'file'})`;

      // Safety clamp extracted text at 120,000 characters to stay comfortably within memory limits
      const clampedText =
        extracted.text.length > 120000
          ? extracted.text.substring(0, 120000) + '\n\n...[Document truncated for length]...'
          : extracted.text;

      rawText = `The user uploaded this ${docTypeLabel}.${userCaption}\n\nDocument Text Content:\n"""\n${clampedText}\n"""`;
    } else {
      privacyLog('warn', 'DOCUMENT_EXTRACTION_UNSUCCESSFUL', {
        mime: resolvedMime,
        filename: docFilename,
        error: extracted.error,
      });
      await sendWhatsAppMessage(
        from,
        `⚠️ *Document Error:* Could not read text from this file (${extracted.error || 'unreadable content'}). Please ensure the document is not password-protected.`
      );
      return;
    }
  }

  // 8. Quoted-Reply Context Injection & Message Storage
  const messagePlaceholder = mediaPart
    ? messageType === 'image'
      ? '[image]'
      : messageType === 'audio' || messageType === 'voice'
        ? '[voice note]'
        : '[document]'
    : messageType === 'location'
      ? '[location]'
      : rawText;

  if (messageId) {
    rememberMessage(messageId, messagePlaceholder);
  }

  let quotedContextPrefix = '';
  const repliedMessageId = message.context?.id;
  if (repliedMessageId) {
    const earlierText = getRememberedMessage(repliedMessageId);
    if (earlierText) {
      quotedContextPrefix = `The user is replying to this earlier message: """${earlierText}"""\n\n`;
    }
  }

  privacyLog('info', 'MESSAGE_RECEIVED', {
    requestId,
    user: anonId,
    type: messageType,
    length: rawText.length,
    hasMedia: Boolean(mediaPart),
    isQuotedReply: Boolean(quotedContextPrefix),
  });

  // 8b. Topic & Compliance Guardrails
  if (rawText && !mediaPart) {
    const guardrail = evaluateInputGuardrails(rawText, { anonId, from });
    if (!guardrail.allowed) {
      await sendWhatsAppMessage(from, guardrail.policyNotice || '🛡️ Request blocked by compliance policy.');
      return;
    }
  }

  // 8c. Human Handoff toggle command
  const lowerHandoffCmd = (rawText || '').trim().toLowerCase();
  if (lowerHandoffCmd === '/human' || lowerHandoffCmd === '/handoff') {
    await setHumanHandoff(senderPhone, true, 'User requested human operator');
    await sendWhatsAppMessage(
      from,
      '👨‍💼 *Human Handoff Active:* An operator has been notified. Bot automation is now paused for this chat. Send */bot* or */resume* at any time to re-activate the AI assistant.'
    );
    return;
  }

  // 9. Command Handlers & Normalization (supports slash commands, slashless inputs, and interactive buttons)
  const effectiveCommand = normalizeCommand(rawText, Boolean(mediaPart));

  // 9a. Image Generation
  const imagePrompt = !mediaPart ? parseImagePrompt(effectiveCommand || rawText) : null;
  if (imagePrompt) {
    const parsedOptions = parseImagePromptOptions(imagePrompt);
    privacyLog('info', 'IMAGE_GENERATION_REQUESTED', {
      requestId,
      user: anonId,
      promptLength: parsedOptions.prompt.length,
      model: parsedOptions.model,
      dimensions: `${parsedOptions.width}x${parsedOptions.height}`,
    });

    const modelBadge =
      parsedOptions.model === 'turbo'
        ? '⚡ SDXL-Turbo (Fast)'
        : parsedOptions.model === 'kontext'
          ? '✨ FLUX.1 Kontext Pro'
          : parsedOptions.model === 'realism'
            ? '📸 FLUX Realism'
            : '✨ FLUX.1 (HD)';
    const dimBadge = `${parsedOptions.width}x${parsedOptions.height}`;

    // Trigger native animated typing indicator instead of sending a bulky placeholder message
    if (messageId) {
      await sendWhatsAppTypingIndicator(messageId).catch(() => {});
    }

    const cleanImage = await generateCleanImage(imagePrompt, { anonId });
    const caption = [
      `🎨 *AI Generated Image* (${modelBadge})`,
      `📐 _Size:_ ${dimBadge}`,
      ``,
      `_Prompt:_ "${parsedOptions.prompt}"`,
    ].join('\n');

    const result = cleanImage
      ? await sendWhatsAppImage(from, cleanImage, caption)
      : await sendWhatsAppImage(from, generateImageUrl(imagePrompt, parsedOptions).imageUrl, caption);

    if (result.success) {
      saveTurn(anonId, rawText, `[Generated and sent image: ${parsedOptions.prompt}]`);
      recordMessageMetric('image_gen', 'success');
      recordImageGeneration(anonId, {
        id: result.messageId || requestId,
        prompt: parsedOptions.prompt,
        enhancedPrompt: cleanImage?.enhancedPrompt || imagePrompt,
        model: parsedOptions.model,
        style: parsedOptions.style,
        appliedLighting: cleanImage?.appliedLearning?.lighting,
        appliedComposition: cleanImage?.appliedLearning?.composition,
        appliedQuality: cleanImage?.appliedLearning?.quality,
      });
    } else {
      recordErrorMetric('image_gen');
      await sendWhatsAppMessage(
        from,
        `⚠️ *Image Generation Notice:*\nCould not deliver generated image: ${result.error || 'Server error'}. Please try again.`
      );
    }
    return;
  }

  // 9a-2. Video Generation (Text-to-Video & Image-to-Video)
  const isImageToVideo = Boolean(mediaPart && messageType === 'image');
  const videoPrompt = !mediaPart || isImageToVideo ? parseVideoPrompt(effectiveCommand || rawText) : null;
  if (videoPrompt) {
    const parsedVidOptions = parseVideoPromptOptions(videoPrompt);
    privacyLog('info', 'VIDEO_GENERATION_REQUESTED', {
      requestId,
      user: anonId,
      promptLength: parsedVidOptions.prompt.length,
      duration: parsedVidOptions.duration,
      dimensions: `${parsedVidOptions.width}x${parsedVidOptions.height}`,
      isImageToVideo,
    });

    // Notify user immediately that generation is underway
    await sendWhatsAppMessage(
      from,
      isImageToVideo
        ? '🎬 *Animating your photo...*\n_Directing AI motion & synthesizing follow-up scenes. This usually takes 15–30 seconds. Hang tight!_'
        : '🎬 *Generating your video...*\n_Directing cinematography & rendering frames. This usually takes 15–30 seconds. Hang tight!_'
    );

    try {
      const vidOptions =
        isImageToVideo && mediaPart?.data ? { imageBuffer: Buffer.from(mediaPart.data, 'base64') } : {};
      const vidResult = await generateVideo(videoPrompt, vidOptions);
      if (vidResult && vidResult.ok && vidResult.buffer) {
        const typeBadge = vidResult.isImageToVideo ? 'Image-to-Video Animation' : 'AI Generated Video';
        const motionBadge = parsedVidOptions.motion ? ` | 🎥 ${parsedVidOptions.motion}` : '';
        const engineBadge = vidResult.isFreeVideo ? ' (100% Free AI)' : '';
        const caption = [
          `🎬 *${typeBadge}*${engineBadge} (${vidResult.duration || parsedVidOptions.duration}s${motionBadge})`,
          `📐 _Resolution:_ ${vidResult.width || parsedVidOptions.width}x${vidResult.height || parsedVidOptions.height}`,
          ``,
          `_Prompt:_ "${parsedVidOptions.prompt}"`,
        ].join('\n');

        const sendRes = await sendWhatsAppVideo(from, vidResult.buffer, caption);
        if (sendRes.success) {
          saveTurn(anonId, rawText, `[Generated and sent video: ${parsedVidOptions.prompt}]`);
          recordMessageMetric('video_gen', 'success');
        } else {
          recordErrorMetric('video_gen');
          await sendWhatsAppMessage(
            from,
            `⚠️ *Video Delivery Notice:*\nCould not deliver video file: ${sendRes.error || 'Server error'}. Please try again.`
          );
        }
      } else {
        recordErrorMetric('video_gen');
        if (vidResult?.fallbackImage) {
          const isApiKeyIssue =
            vidResult.statusCode === 401 ||
            vidResult.reason === 'missing_api_key' ||
            vidResult.reason === 'unauthorized_api_key' ||
            String(vidResult.reason).includes('401');
          const isCreditsIssue =
            vidResult.statusCode === 402 ||
            vidResult.reason === 'credits_exhausted' ||
            String(vidResult.reason).includes('402');

          let header = '🎬 *Video Concept Preview* (Generation queued/busy)';
          let statusText = '⚠️ _Video cloud render is currently busy. Here is your high-definition concept still:_';

          if (isApiKeyIssue) {
            header = '🎬 *Video Concept Preview* (API Key Setup Required)';
            statusText = [
              '⚠️ *Video Generation Setup Required:*',
              '_Text-to-video rendering requires an active Pollinations API key._',
              '_1. Get a free key with starter pollen credits at:_ https://enter.pollinations.ai/keys',
              '_2. Add_ `POLLINATIONS_API_KEY=your_key` _to your bot `.env` file and restart._',
              '',
              '🖼️ _In the meantime, here is your generated high-definition concept still:_',
            ].join('\n');
          } else if (isCreditsIssue) {
            header = '🎬 *Video Concept Preview* (Paid Pollen Required)';
            statusText = [
              '⚠️ *Paid Pollen Balance Required:*',
              vidResult.apiMessage
                ? `_${vidResult.apiMessage}_`
                : '_GPU video rendering requires Paid Pollen (from ~$0.05 per clip)._',
              '',
              '👉 _Top up your Pollinations balance at:_ https://enter.pollinations.ai/top-up',
              '',
              '🖼️ _In the meantime, here is your generated high-definition concept still:_',
            ].join('\n');
          }

          const fallbackCaption = [header, statusText, '', `_Prompt:_ "${parsedVidOptions.prompt}"`].join('\n');
          await sendWhatsAppImage(from, vidResult.fallbackImage, fallbackCaption);
          saveTurn(anonId, rawText, `[Generated video concept preview image: ${parsedVidOptions.prompt}]`);
        } else {
          await sendWhatsAppMessage(
            from,
            `⚠️ *Video Generation Notice:*\nVideo generation is temporarily busy (${vidResult?.reason || 'Service busy'}). Please try again in a few moments.`
          );
        }
      }
    } catch (vidErr) {
      recordErrorMetric('video_gen');
      privacyLog('error', 'VIDEO_DISPATCH_ERROR', { error: vidErr.message });
      await sendWhatsAppMessage(
        from,
        `⚠️ *Video Generation Error:*\nCould not process video request: ${vidErr.message}.`
      );
    }
    return;
  }

  // 9b. Help Manual
  if (!mediaPart && (effectiveCommand === '/help' || effectiveCommand === 'help')) {
    const helpMessage = [
      `🤖 *Personal WhatsApp AI Assistant (Gemini)*`,
      ``,
      `*Available Commands:*`,
      `• */help* - Display this help manual`,
      `• */image <prompt>* or */draw <prompt>* - Generate AI artwork (FLUX.1, Kontext, Realism)`,
      `  _Options: \`--fast\`, \`--wallpaper\` (9:16), \`--wide\` (16:9), \`--standard\` (4:3), \`--anime\`, \`--photo\`, \`--pixel\`, \`--oil\`, \`--watercolor\`, \`--sketch\`_`,
      `• */video <prompt>* or */vid <prompt>* - Generate AI video animation (10s – 15s)`,
      `  _Options: \`--10s\`, \`--15s\`, \`--wide\` (16:9), \`--vertical\` (9:16), \`--drone\`, \`--pan\`, \`--zoom\`, \`--timelapse\`, \`--slowmo\`_`,
      `• */todo <task>* - Add item to your quick to-do list`,
      `• */todos* - List your active to-dos`,
      `• */done <id>* - Mark a task completed`,
      `• */clear_todos* - Clear all completed tasks`,
      `• */persona [name]* - Switch persona (coder, tutor, executive, default)`,
      `• */voice on* | */voice off* - Toggle voice audio replies`,
      `• */remind <time> <task>* - Schedule an automated reminder`,
      `• */reminders* - List your active reminders`,
      `• */remind delete <id>* - Cancel a reminder`,
      `• */search on* | */search off* - Toggle Google Search grounding`,
      `• */usage* - Check your daily request quota`,
      `• */status* - Check system health and current model`,
      `• */model <name>* - Switch Gemini model (e.g. \`/model gemini-3.5-flash-lite\`)`,
      `• */reset* - Clear conversation context`,
      `• */delete* or */forget* - Purge all temporary session data`,
      `• */privacy* - View architecture & privacy disclosure`,
      ``,
      `*Multimodal Capabilities:*`,
      `• 🔗 *Webpage Summaries:* Send any article or webpage URL for 3-5 bullet point takeaways.`,
      `• ▶️ *YouTube Summaries:* Paste any YouTube or Shorts link for key takeaways & topic timestamps.`,
      `• 📸 *Instagram Summaries:* Paste any Instagram Reel or Post link for venue, dish, and creator highlights.`,
      `• 📍 *Location Intelligence:* Share a location pin for local snapshot, weather, and top spots.`,
      `• 📸 *Photos & Images:* Send screenshots, diagrams, or math problems for instant analysis.`,
      `• 🎙️ *Voice Notes:* Send audio voice notes for automatic transcription and answers.`,
      `• 📄 *Documents:* Upload PDF, TXT, or CSV files for summaries and analysis.`,
      `• 💬 *Quoted Replies:* Reply directly to previous messages to maintain context.`,
      ``,
      `*Privacy Guardrails:*`,
      `• All chat history is held in volatile RAM (${config.SESSION_TIMEOUT_MINUTES}m idle timeout).`,
      `• *Zero conversations or images are saved to disk.*`,
    ].join('\n');

    await sendWhatsAppMessage(from, helpMessage);
    await sendWhatsAppButtons(from, '⚡ *Quick Actions:*', [
      { id: 'cmd_status', title: 'Status' },
      { id: 'cmd_todos', title: 'To-Dos' },
      { id: 'cmd_reset', title: 'Clear History' },
    ]);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9c. Memory Reset
  if (effectiveCommand === '/reset') {
    resetConversation(anonId);
    await sendWhatsAppMessage(
      from,
      `🧹 *Conversation Context Cleared!*\nYour previous chat memory has been reset. The next message starts a fresh conversation.`
    );
    recordMessageMetric('command', 'success');
    return;
  }

  // 9d. Data Purge
  if (effectiveCommand === '/delete' || effectiveCommand === '/forget') {
    deleteUserData(anonId);
    await clearUserMemory(anonId);
    await clearLearnedWorkflows(anonId);
    await clearUserProfile(anonId);
    resetImageLearner(anonId);
    await sendWhatsAppMessage(
      from,
      `🗑️ *Data Purged:*\nAll temporary in-memory session data, learned habits, and personal memory have been completely wiped.`
    );
    recordMessageMetric('command', 'success');
    return;
  }

  // 9e. Privacy Disclosure
  if (effectiveCommand === '/privacy') {
    await sendWhatsAppMessage(from, getPrivacyDisclosure());
    recordMessageMetric('command', 'success');
    return;
  }

  // 9f. System Status
  if (effectiveCommand === '/status') {
    const quota = getUserQuotaReport(anonId);
    const searchStatus = isSearchGroundingEnabled() ? 'Enabled (Google Search)' : 'Disabled';
    const statusMsg = [
      `📊 *System Status:*`,
      `• AI Model: *${getActiveModel()}*`,
      `• Active Persona: *${getPersona(anonId)}*`,
      `• Voice Replies: *${isVoiceReplyEnabled(anonId) ? 'Enabled' : 'Disabled'}*`,
      `• Search Grounding: *${searchStatus}*`,
      `• Remaining Daily Quota: *${quota.userMax - quota.userCount} / ${quota.userMax}*`,
      `• Memory Mode: *Volatile RAM Only (Zero Disk Storage)*`,
      `• Idle Session Timeout: *${config.SESSION_TIMEOUT_MINUTES} minutes*`,
      `• Max Context Turns: *${config.MAX_CONTEXT_TURNS}*`,
      `• Meta Webhook: *Active*`,
      `• Transport Security: *HTTPS / TLS 1.3*`,
    ].join('\n');
    await sendWhatsAppButtons(from, statusMsg, [
      { id: 'cmd_usage', title: 'Usage' },
      { id: 'cmd_help', title: 'Help' },
    ]);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9g. Model Switch
  if (effectiveCommand.startsWith('/model ')) {
    const requestedModel = effectiveCommand.substring(7).trim();
    if (requestedModel) {
      setActiveModel(requestedModel);
      await sendWhatsAppMessage(from, `🔄 *Model Switched:*\nActive model is now set to *${getActiveModel()}*.`);
      recordMessageMetric('command', 'success');
      return;
    }
  }

  // 9h. Google Search Grounding Toggle
  if (effectiveCommand === '/search on') {
    setSearchGrounding(true);
    await sendWhatsAppMessage(
      from,
      '🌐 *Google Search Grounding Enabled:*\nGemini will now retrieve live web information and append verified sources.'
    );
    recordMessageMetric('command', 'success');
    return;
  }
  if (effectiveCommand === '/search off') {
    setSearchGrounding(false);
    await sendWhatsAppMessage(
      from,
      '🌐 *Google Search Grounding Disabled:*\nGemini will now respond using internal model knowledge.'
    );
    recordMessageMetric('command', 'success');
    return;
  }

  // 9i. Usage & Quotas
  if (effectiveCommand === '/usage') {
    const quota = getUserQuotaReport(anonId);
    const usageMsg = [
      `📈 *Daily AI Request Usage:*`,
      `• Your Requests Today: *${quota.userCount} / ${quota.userMax}*`,
      `• Requests Remaining: *${quota.userMax - quota.userCount}*`,
      `• Global System Requests: *${quota.geminiCount} / ${quota.geminiMax}*`,
      `• Date (UTC): *${quota.dateUtc}*`,
      `• Resets Daily At: *00:00 UTC*`,
    ].join('\n');
    await sendWhatsAppMessage(from, usageMsg);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9j. Scheduled Reminders
  if (effectiveCommand.startsWith('/remind ')) {
    const remArgs = effectiveCommand.substring(8).trim();
    if (remArgs.toLowerCase().startsWith('delete ')) {
      const deleteId = remArgs.substring(7).trim();
      const delResult = deleteReminder(anonId, deleteId);
      await sendWhatsAppMessage(from, delResult.message);
      return;
    }

    const parts = remArgs.split(/\s+/);
    let whenStr = '';
    let reminderText = '';

    // Handle DD-MM-YYYY HH:MM two-token timestamp
    if (parts.length >= 3 && /^\d{1,2}-\d{1,2}-\d{4}$/.test(parts[0]) && /^\d{1,2}:\d{2}$/.test(parts[1])) {
      whenStr = `${parts[0]} ${parts[1]}`;
      reminderText = parts.slice(2).join(' ');
    } else {
      whenStr = parts[0] || '';
      reminderText = parts.slice(1).join(' ');
    }

    const schedResult = scheduleReminder(from, anonId, whenStr, reminderText);
    await sendWhatsAppMessage(from, schedResult.message);
    recordMessageMetric('reminder', schedResult.success ? 'success' : 'rejected');
    return;
  }

  if (effectiveCommand === '/reminders') {
    const listMsg = listReminders(anonId);
    await sendWhatsAppMessage(from, listMsg);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9k. Quick Notes & To-Do List Tracker
  if (effectiveCommand.startsWith('/todo ')) {
    const taskText = effectiveCommand.substring(6).trim();
    const result = addTodo(anonId, taskText);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('todo', result.success ? 'success' : 'rejected');
    return;
  }

  if (effectiveCommand === '/todos') {
    const listMsg = listTodos(anonId);
    await sendWhatsAppButtons(from, listMsg, [
      { id: 'cmd_help', title: 'Help' },
      { id: 'cmd_status', title: 'Status' },
    ]);
    recordMessageMetric('command', 'success');
    return;
  }

  if (effectiveCommand.startsWith('/done ')) {
    const todoId = effectiveCommand.substring(6).trim();
    const result = markTodoDone(anonId, todoId);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('todo', result.success ? 'success' : 'rejected');
    return;
  }

  if (effectiveCommand === '/clear_todos') {
    const result = clearCompletedTodos(anonId);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('todo', 'success');
    return;
  }

  // 9l. Custom Persona Switching
  if (effectiveCommand === '/persona' || effectiveCommand.startsWith('/persona ')) {
    const personaArg = effectiveCommand.length > 8 ? effectiveCommand.substring(8).trim().toLowerCase() : '';
    if (!personaArg) {
      const current = getPersona(anonId);
      const personas = listPersonas();
      const personaLines = Object.values(personas).map((p) => {
        const marker = p.name === current ? ' *(Active)*' : '';
        return `• */persona ${p.name}* - *${p.title}*${marker}\n  _${p.description}_`;
      });
      const msg = [
        `🎭 *AI Personas:*`,
        `Current Persona: *${current}*`,
        ``,
        ...personaLines,
        ``,
        `_Switch persona by sending e.g. \`/persona coder\` or \`/persona default\`._`,
      ].join('\n');
      await sendWhatsAppMessage(from, msg);
    } else {
      const result = setPersona(anonId, personaArg);
      if (result.success) {
        await sendWhatsAppMessage(
          from,
          `🎭 *Persona Switched to "${result.persona.name}":*\n_${result.persona.description}_`
        );
      } else {
        await sendWhatsAppMessage(from, `⚠️ ${result.error}`);
      }
    }
    recordMessageMetric('command', 'success');
    return;
  }

  // 9m. Voice Note Replies Toggle
  if (effectiveCommand === '/voice on') {
    setVoiceReplyEnabled(anonId, true);
    await sendWhatsAppMessage(
      from,
      '🎙️ *Voice Mode Enabled:*\nAssistant replies will now also be synthesized into audio voice messages.\nType */voice off* anytime to return to text-only.'
    );
    recordMessageMetric('command', 'success');
    return;
  }
  if (effectiveCommand === '/voice off') {
    setVoiceReplyEnabled(anonId, false);
    await sendWhatsAppMessage(from, '💬 *Voice Mode Disabled:*\nAssistant replies will now be delivered as text only.');
    recordMessageMetric('command', 'success');
    return;
  }
  if (effectiveCommand === '/voice' || effectiveCommand === '/voice status') {
    const isVoice = isVoiceReplyEnabled(anonId);
    await sendWhatsAppMessage(
      from,
      `🎙️ *Voice Mode Status:* *${isVoice ? 'Enabled (Audio replies ON)' : 'Disabled (Text-only)'}*\n\n• Type */voice on* to receive voice audio replies.\n• Type */voice off* for text-only replies.\n• Or append \`--voice\` to any single message.`
    );
    recordMessageMetric('command', 'success');
    return;
  }

  // 9n. Multilingual Language Selection
  if (effectiveCommand === '/language' || effectiveCommand.startsWith('/language ')) {
    const langArg = effectiveCommand.length > 9 ? effectiveCommand.substring(9).trim() : '';
    const reply = await handleLanguageCommand(anonId, langArg);
    await sendWhatsAppMessage(from, reply);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9o. Long-Term Personal Memory
  if (effectiveCommand === '/memory' || effectiveCommand.startsWith('/memory ')) {
    const reply = await handleMemoryCommand(anonId, effectiveCommand);
    await sendWhatsAppMessage(from, reply);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9p. User Data Export
  if (effectiveCommand === '/export' || effectiveCommand.startsWith('/export')) {
    await exportUserData(from, anonId);
    recordMessageMetric('command', 'success');
    return;
  }

  // 9q. Outbound Contact Messaging (/s, /send, or /msg)
  if (
    effectiveCommand.startsWith('/s ') ||
    effectiveCommand.startsWith('/send ') ||
    effectiveCommand.startsWith('/msg ')
  ) {
    let args = '';
    if (effectiveCommand.startsWith('/s ')) {
      args = effectiveCommand.slice(3).trim();
    } else if (effectiveCommand.startsWith('/send ')) {
      args = effectiveCommand.slice(6).trim();
    } else {
      args = effectiveCommand.slice(5).trim();
    }
    const firstSpaceIdx = args.indexOf(' ');

    if (firstSpaceIdx === -1) {
      await sendWhatsAppMessage(
        from,
        '⚠️ *Usage:* `/s <contact_or_number> <message>` (or `/send`)\n\n*Examples:*\n• `/s mom Hello Mom, are we meeting tonight?`\n• `/s 919876543210 Here is the report summary.`'
      );
      recordMessageMetric('command', 'invalid_args');
      return;
    }

    const target = args.slice(0, firstSpaceIdx).trim();
    const messageToSend = args.slice(firstSpaceIdx + 1).trim();

    const result = await sendOutboundContactMessage(from, target, messageToSend);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('command', result.ok ? 'success' : 'failed');
    return;
  }

  // 9r. Contacts Book Management (/c, /contact, or /contacts)
  if (
    effectiveCommand === '/c' ||
    effectiveCommand === '/contacts' ||
    effectiveCommand === '/contact' ||
    effectiveCommand === '/contact list' ||
    effectiveCommand === '/c list'
  ) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can manage contacts.');
      return;
    }
    const contactsList = formatContactsList();
    await sendWhatsAppMessage(from, contactsList);
    recordMessageMetric('command', 'success');
    return;
  }

  if (effectiveCommand.startsWith('/c add ') || effectiveCommand.startsWith('/contact add ')) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can add contacts.');
      return;
    }
    const rawArgs = effectiveCommand.replace(/^\/(?:c|contact)\s+add\s+/, '').trim();
    const parts = rawArgs.split(/\s+/);
    const alias = parts[0];
    const phone = parts[1];
    const name = parts.slice(2).join(' ') || alias;

    if (!alias || !phone) {
      await sendWhatsAppMessage(
        from,
        '⚠️ *Usage:* `/c add <alias> <phone> [display_name]`\n\n*Example:* `/c add mom 919876543210 Mom`'
      );
      recordMessageMetric('command', 'invalid_args');
      return;
    }

    const saveRes = addContact(alias, phone, name);
    if (!saveRes.ok) {
      await sendWhatsAppMessage(from, `❌ ${saveRes.error}`);
      recordMessageMetric('command', 'failed');
      return;
    }

    await sendWhatsAppMessage(
      from,
      `✅ *Contact Saved!*\n• *Name:* ${saveRes.contact.name}\n• *Alias:* \`@${saveRes.contact.alias}\`\n• *Phone:* ${maskPhoneNumber(saveRes.contact.phone)}\n• *Mode:* 📨 Relay Only\n\n_💡 Send them a message with:_ \`/s ${saveRes.contact.alias} <your message>\``
    );
    recordMessageMetric('command', 'success');
    return;
  }

  if (
    effectiveCommand.startsWith('/c remove ') ||
    effectiveCommand.startsWith('/c delete ') ||
    effectiveCommand.startsWith('/contact remove ') ||
    effectiveCommand.startsWith('/contact delete ')
  ) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can delete contacts.');
      return;
    }
    const query = effectiveCommand.replace(/^\/(?:c|contact)\s+(?:remove|delete)\s+/, '').trim();
    const removeRes = removeContact(query);
    if (!removeRes.ok) {
      await sendWhatsAppMessage(from, `❌ ${removeRes.error}`);
      recordMessageMetric('command', 'failed');
      return;
    }
    await sendWhatsAppMessage(
      from,
      `🗑️ *Contact Removed:* \`@${removeRes.removed.alias}\` (${removeRes.removed.name}) was deleted from your contact book.`
    );
    recordMessageMetric('command', 'success');
    return;
  }

  if (effectiveCommand.startsWith('/c permit ') || effectiveCommand.startsWith('/contact permit ')) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can modify contact permissions.');
      return;
    }
    const rawArgs = effectiveCommand.replace(/^\/(?:c|contact)\s+permit\s+/, '').trim();
    const parts = rawArgs.split(/\s+/);
    const alias = parts[0];
    const flag = (parts[1] || '').toLowerCase();

    if (!alias || (flag !== 'on' && flag !== 'off')) {
      await sendWhatsAppMessage(
        from,
        '⚠️ *Usage:* `/c permit <alias> on|off`\n\n*Example:*\n• `/c permit mom on` (Allows contact to directly chat with Gemini AI)\n• `/c permit mom off` (Relay only: replies are forwarded to you)'
      );
      recordMessageMetric('command', 'invalid_args');
      return;
    }

    const permitRes = setContactAiAllowed(alias, flag === 'on');
    if (!permitRes.ok) {
      await sendWhatsAppMessage(from, `❌ ${permitRes.error}`);
      recordMessageMetric('command', 'failed');
      return;
    }

    const modeDescription = permitRes.contact.allowAiChat
      ? '🤖 Full AI Chat & Relay (Can chat directly with Gemini AI)'
      : '📨 Relay Only (All replies are forwarded directly to you)';

    await sendWhatsAppMessage(
      from,
      `✅ *Permission Updated!*\n• *Contact:* ${permitRes.contact.name} (\`@${permitRes.contact.alias}\`)\n• *Mode:* ${modeDescription}`
    );
    recordMessageMetric('command', 'success');
    return;
  }

  // Check for inline --voice flag
  const hasVoiceFlag = rawText.includes('--voice');
  const cleanRawText = rawText.replace(/--voice/gi, '').trim();
  const wantsVoice = isVoiceReplyEnabled(anonId) || hasVoiceFlag;

  // 10. Privacy Guard: Scan & Redact Sensitive Financial/Credential Information
  const { sanitizedText, hasRedactions, categories } = maskSensitiveInfo(cleanRawText);

  if (hasRedactions) {
    privacyLog('warn', 'SENSITIVE_DATA_DETECTED_REDACTED', {
      requestId,
      user: anonId,
      categories,
    });
  }

  // Fast Deterministic Learning: if user explicitly states a name, location, diet, or preference,
  // learn it immediately so prompt context and response reflect it in this very turn!
  if (messageType === 'text' && !cleanRawText.startsWith('/')) {
    const immediateFacts = extractDeterministicFacts(sanitizedText);
    for (const item of immediateFacts) {
      await addAutoMemoryFact(anonId, item.fact, {
        category: item.category,
        confidence: item.confidence,
      });
    }
  }

  // Check for webpage/article link summarization
  let articleHeader = null;
  const foundUrl =
    !mediaPart && messageType === 'text' && !cleanRawText.startsWith('/') ? extractUrl(cleanRawText) : null;

  let effectivePrompt = sanitizedText;

  if (foundUrl) {
    const userPromptAside = extractUserPromptAside(sanitizedText, foundUrl);
    const ytVideoId = extractYouTubeVideoId(foundUrl);
    const isYtDomain = isYouTubeDomain(foundUrl);

    if (ytVideoId) {
      const videoData = await fetchYouTubeVideoData(ytVideoId);

      if (!videoData.ok) {
        if (userPromptAside) {
          privacyLog('info', 'YOUTUBE_FETCH_FALLBACK_GROUNDING', { error: videoData.error, videoId: ytVideoId });
          forceGrounding = true;
          effectivePrompt = [
            `The user shared this YouTube video link: ${foundUrl}`,
            `User instruction: "${userPromptAside}"`,
            `Note: Direct video details could not be retrieved (${videoData.error || 'Video may be private, restricted, or unavailable'}). Use Google Search Grounding to assist the user with their request and any clues provided, and politely let them know the video details couldn't be loaded directly.`,
          ].join('\n\n');
        } else {
          await sendWhatsAppMessage(
            from,
            `⚠️ *YouTube Error:* Could not load video details (${videoData.error || 'Video may be private, restricted, or unavailable'}).`
          );
          return;
        }
      } else {
        effectivePrompt = buildYouTubeAiPrompt(videoData, userPromptAside);
        articleHeader = {
          title: `▶️ ${videoData.title} (${videoData.author})`,
          url: videoData.url,
        };
        if (!videoData.hasTranscript) {
          forceGrounding = true;
        }
      }
    } else if (isYtDomain) {
      // YouTube link with missing, truncated, or malformed video ID (e.g. truncated Shorts /shorts/4Mer-_)
      if (userPromptAside) {
        privacyLog('info', 'YOUTUBE_INCOMPLETE_LINK_FALLBACK_GROUNDING', { url: foundUrl });
        forceGrounding = true;
        effectivePrompt = [
          `The user shared this YouTube link: ${foundUrl}`,
          `User instruction: "${userPromptAside}"`,
          `Note: The YouTube link appears incomplete, truncated, or invalid (YouTube video IDs must be exactly 11 characters).`,
          `Use Google Search Grounding to assist the user with their request (for example, identifying songs, mix tracks, or artists from any lyrics or clues they provided). In your response, helpfully answer their question and politely mention that the YouTube link was cut short or couldn't be opened directly, inviting them to provide more lyrics, clues, or the complete link if needed.`,
        ].join('\n\n');
      } else {
        await sendWhatsAppMessage(
          from,
          `⚠️ *YouTube Notice:* The link appears incomplete or truncated (${foundUrl}). YouTube video links require an 11-character video ID (e.g. youtube.com/shorts/VIDEO_ID). Please check the link or share the video title/lyrics!`
        );
        return;
      }
    } else if (isInstagramUrl(foundUrl)) {
      const instaData = await fetchInstagramPostData(foundUrl);

      effectivePrompt = buildInstagramAiPrompt(instaData, userPromptAside);
      const mediaBadge = instaData.isReel ? 'Instagram Reel' : 'Instagram Post';
      articleHeader = {
        title: `📸 ${instaData.title || mediaBadge} (${instaData.author})`,
        url: instaData.url,
      };
      forceGrounding = true; // Google search grounding retrieves up-to-date venue details, dishes, and reviews
    } else {
      const article = await fetchAndExtractArticle(foundUrl);
      if (!article.ok) {
        if (article.reason === 'ssrf_blocked') {
          await sendWhatsAppMessage(
            from,
            '⚠️ *Security Alert:* Access to internal, loopback, or private network addresses is blocked for security.'
          );
          return;
        }
        if (article.reason === 'too_large') {
          await sendWhatsAppMessage(from, '⚠️ *Webpage Error:* Webpage content exceeds maximum allowed size (16MB).');
          return;
        }

        // For all other fetch failures (http_404, http_500, timeout, http_429, http_403, http_401, content_too_short):
        // If the user provided a question or instruction, NEVER abort! Ground the query and answer the user!
        if (userPromptAside) {
          privacyLog('info', 'WEBPAGE_FETCH_FALLBACK_GROUNDING', { reason: article.reason, url: foundUrl });
          forceGrounding = true;
          const failureNote =
            article.reason === 'http_404'
              ? 'Page not found (HTTP 404). The link may be broken, incomplete, or expired.'
              : article.reason === 'timeout'
                ? 'Webpage download timed out.'
                : `Direct HTML fetching was blocked or limited (${article.reason || 'Could not load URL'}).`;
          effectivePrompt = [
            `The user shared this link: ${foundUrl}`,
            `User instruction: "${userPromptAside}"`,
            `Note: ${failureNote} Use Google Search Grounding to look up details about this URL, topic, or any clues provided by the user, and answer their question clearly. Politely mention that the link couldn't be loaded directly if relevant.`,
          ].join('\n\n');
        } else if (
          article.reason === 'http_429' ||
          article.reason === 'content_too_short' ||
          article.reason === 'http_403' ||
          article.reason === 'http_401'
        ) {
          privacyLog('info', 'WEBPAGE_FETCH_FALLBACK_GROUNDING', { reason: article.reason, url: foundUrl });
          forceGrounding = true;
          effectivePrompt = [
            `The user shared this link: ${foundUrl}`,
            'Please summarize the content and topic of this webpage.',
            'Note: Direct HTML fetching was blocked or limited by the host server. Use Google Search Grounding to look up details about this URL and topic, providing clear highlights and key takeaway points for WhatsApp.',
          ].join('\n\n');
          articleHeader = {
            title: `🔗 ${foundUrl}`,
            url: foundUrl,
          };
        } else {
          const errorMsg =
            article.reason === 'http_404'
              ? `⚠️ *Webpage Notice:* The webpage was not found (HTTP 404). The link may be broken, incomplete, or deleted. Please check the URL and try again.`
              : article.reason === 'timeout'
                ? `⚠️ *Webpage Notice:* Webpage download timed out. Please verify the URL and try again.`
                : `⚠️ *Webpage Notice:* Failed to fetch webpage content (${article.reason || 'Could not load URL'}).`;
          await sendWhatsAppMessage(from, errorMsg);
          return;
        }
      } else {
        if (article.needsGrounding) {
          forceGrounding = true;
        }

        if (userPromptAside) {
          effectivePrompt = `The user shared this article: [${article.title || foundUrl}](${foundUrl})\n\nUser Question/Instruction: "${userPromptAside}"\n\nArticle Content:\n"""${article.text}"""`;
        } else {
          effectivePrompt = `Summarize this webpage clearly in 3-5 WhatsApp bullet points with key takeaways:\n\nTitle: ${article.title || 'Webpage'}\nURL: ${foundUrl}\n\nContent:\n"""${article.text}"""`;
        }
        articleHeader = { title: article.title || 'Webpage Summary', url: foundUrl };
      }
    }
  } else if (locationSnapshotPrompt) {
    effectivePrompt = locationSnapshotPrompt;
  }

  // Determine default prompts for multimodal media if no text was provided
  if (!effectivePrompt) {
    if (mediaPart && (messageType === 'audio' || messageType === 'voice')) {
      effectivePrompt =
        'Transcribe this voice note, then answer or act on it. If it is just a note, give a concise summary.';
    } else if (mediaPart && messageType === 'document') {
      effectivePrompt =
        'Summarize this document and highlight key points and findings, preserving important numbers and figures.';
    } else if (mediaPart && messageType === 'image') {
      effectivePrompt =
        'Analyze this image in detail. Identify any text, diagrams, code, questions, or problems, and provide a clear, comprehensive solution or explanation.';
    }
  }

  // Prepend quoted message context if present
  const fullPromptForGemini = quotedContextPrefix ? `${quotedContextPrefix}${effectivePrompt}` : effectivePrompt;

  // 11. Retrieve temporary conversational context
  const history = getConversation(anonId);

  // 12. Generate Gemini AI Response
  recordGeminiDailyUsage();
  recordGeminiMetric(getActiveModel(), 'success');
  const aiResponse = await generateAIResponse(fullPromptForGemini, history, mediaPart, {
    anonId,
    from,
    forceGrounding: Boolean(forceGrounding),
  });

  // 13. Save turn into volatile in-memory session
  const recordedTurnPrompt = mediaPart
    ? `[${messageType.toUpperCase()} Analyzed] ${sanitizedText}`.trim()
    : sanitizedText;
  saveTurn(anonId, recordedTurnPrompt, aiResponse);

  // 14. Construct final response with optional security warning
  let finalMessage = aiResponse;
  if (articleHeader) {
    finalMessage = `🔗 *${articleHeader.title}*\n_${articleHeader.url}_\n\n${aiResponse}`;
  }
  if (hasRedactions) {
    finalMessage += `\n\n⚠️ _Security Alert: Detected and redacted sensitive details (${categories.join(
      ', '
    )}) before processing. Never share passwords, PINs, or card details over WhatsApp._`;
  }

  // 15. Send response back to user
  await sendWhatsAppMessage(from, finalMessage);
  recordMessageMetric(messageType, 'success');

  // 15b. Cleanup temporary Gemini Files API upload if one was created
  if (mediaPart?.geminiFileName) {
    deleteGeminiFile(mediaPart.geminiFileName).catch(() => {});
  }

  // 15c. Post-response autonomous habit & workflow learning (0ms added user latency)
  if (config.NODE_ENV !== 'test') {
    autoLearnFromTurn({
      anonId,
      userMessage: sanitizedText,
      assistantReply: aiResponse,
      messageType,
    }).catch((err) => {
      privacyLog('debug', 'POST_TURN_AUTONOMOUS_LEARN_ERROR', { error: err.message });
    });
  }

  // 16. Synthesize & Send Voice Note Audio Reply if requested
  if (wantsVoice) {
    try {
      const synth = await synthesizeSpeech(aiResponse);
      if (synth && synth.ok && synth.buffer) {
        await sendWhatsAppAudio(from, synth.buffer);
        privacyLog('info', 'VOICE_REPLY_SENT', { user: anonId, bytes: synth.buffer.length });
      } else {
        privacyLog('warn', 'VOICE_SYNTH_FAILED', { user: anonId, error: synth?.error });
      }
    } catch (voiceErr) {
      privacyLog('error', 'VOICE_SEND_ERROR', { user: anonId, error: voiceErr.message });
    }
  }
}

// Wire the in-process work queue to the incoming message handler
messageQueue.setHandler(async ({ message, requestId }) => {
  await handleIncomingMessage(message, requestId);
});
