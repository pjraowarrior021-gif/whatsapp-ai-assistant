import express from 'express';
import crypto from 'crypto';
import { config, normalizePhoneNumber } from './config.js';
import { getGroupAdminService } from './group-admin/registry.js';
import { envelopeFromCloudMessage, cloudGroupEventFromChange } from './transports/cloud-api.js';
import {
  isAuthorized,
  getAnonymizedId,
  maskSensitiveInfo,
  privacyLog,
  getConversation,
  saveTurn,
  checkUserRateLimit,
  rememberMessage,
  getRememberedMessage,
  isVoiceReplyEnabled,
} from './privacy.js';
import { generateAIResponse, getActiveModel, uploadGeminiFileInMemory, deleteGeminiFile } from './gemini.js';
import { isDocumentSupported, resolveDocumentMime, extractDocumentContent } from './document.js';
import {
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  sendWhatsAppButtons,
  markMessageAsRead,
  getMediaUrl,
  downloadMediaInMemory,
} from './whatsapp.js';
import { processImageReaction } from './image-gen.js';
import { deleteReminder, snoozeReminder, completeReminder } from './reminders.js';
import {
  saveUserLocation,
  getUserLocation,
  searchNearbyPlaces,
  formatPlacesSummary,
  LOCATION_CATEGORIES,
} from './location.js';
import { synthesizeSpeech } from './tts.js';
import { checkAndIncrementUserQuota, recordGeminiDailyUsage } from './quota.js';
import { recordMessageMetric, recordErrorMetric, recordMediaBytes, recordGeminiMetric } from './metrics.js';
import { messageQueue } from './queue.js';
import { addAutoMemoryFact } from './memory.js';
import { autoLearnFromTurn, extractDeterministicFacts } from './auto-learner.js';
import { getContact, isPrimaryAdmin, getPrimaryAdminNumber, maskPhoneNumber } from './contacts.js';
import { dispatchBuiltInCommand } from './handlers/command-handler.js';
import { resolveUrlPrompt } from './handlers/link-handler.js';

export { messageQueue };
export const webhookRouter = express.Router();

import { store } from './store/index.js';
import { transcribeAudioBuffer } from './stt.js';
import { getPendingApproval, resolveApproval, isHumanHandoffActive, setHumanHandoff } from './approval.js';
import { recordLastInboundInteraction } from './templates.js';
import { evaluateInputGuardrails } from './guardrails.js';
import { applyContextualReaction } from './reactions.js';

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
        const safeChallenge = String(challenge || '').replace(/[^\w-]/g, '');
        return res.status(200).type('text/plain').send(safeChallenge);
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
          // Groups API metadata webhooks (create/delete/participants/settings/
          // suspension) carry `value.groups` instead of `value.messages`.
          const groupEvent = cloudGroupEventFromChange(change);
          if (groupEvent) {
            const groupAdmin = getGroupAdminService();
            if (groupAdmin?.initialized && typeof groupAdmin.handleCloudGroupEvent === 'function') {
              const result = await groupAdmin.handleCloudGroupEvent(groupEvent);
              privacyLog('debug', 'CLOUD_GROUP_EVENT', {
                requestId,
                field: groupEvent.field,
                processed: result.processed,
              });
            }
          }
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
            contacts: Array.isArray(value.contacts) ? value.contacts : [],
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
    cmd_briefing: '/briefing',
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
    briefing: '/briefing',
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
    'briefing ',
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
export async function handleIncomingMessage(message, requestId = crypto.randomUUID(), contacts = []) {
  const messageId = message.id;
  const from = message.from;
  const messageType = message.type;
  const isGroup = Boolean(
    message.group_id || (from && (from.includes('@g.us') || from.includes('-group') || message.author))
  );
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

  // 1a. Autonomous group administrator. Once initialized, it is the ONLY path
  // for group messages: disabled groups must never fall through to the legacy
  // prefix pipeline, otherwise a disabled group could still trigger AI.
  if (isGroup) {
    const groupAdmin = getGroupAdminService();
    if (groupAdmin?.initialized) {
      const envelope = envelopeFromCloudMessage(message, contacts);
      if (envelope) {
        const result = await groupAdmin.handleInbound(envelope);
        privacyLog('debug', 'GROUP_ADMIN_DISPATCH', { requestId, reason: result.reason, handled: result.handled });
      }
      return;
    }
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
            if (message?.id) {
              applyContextualReaction(from, message.id, '', { action: 'approval_granted' }).catch((err) =>
                privacyLog('debug', 'APPROVAL_REACTION_FAILED', { error: err?.message })
              );
            }
          } else {
            await sendWhatsAppMessage(from, resolution.message || '❌ Action cancelled.');
            if (message?.id) {
              applyContextualReaction(from, message.id, '', { action: 'approval_denied' }).catch((err) =>
                privacyLog('debug', 'APPROVAL_REACTION_FAILED', { error: err?.message })
              );
            }
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
    markMessageAsRead(messageId).catch((err) => privacyLog('debug', 'MARK_READ_FAILED', { error: err?.message }));
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
  const commandHandled = await dispatchBuiltInCommand({
    effectiveCommand,
    rawText,
    from,
    anonId,
    message,
    mediaPart,
    messageType,
    messageId,
    requestId,
  });
  if (commandHandled) {
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
  const urlResult = await resolveUrlPrompt({
    from,
    sanitizedText,
    cleanRawText,
    mediaPart,
    messageType,
  });
  if (urlResult.aborted) {
    return;
  }

  const articleHeader = urlResult.articleHeader;
  let effectivePrompt = urlResult.effectivePrompt;
  if (urlResult.forceGrounding) {
    forceGrounding = true;
  }

  if (locationSnapshotPrompt) {
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

  // 15a. Contextual Reaction: React authentically only when intent/sentiment warrants (gratitude, agreement, laughter, celebration)
  // Queries, educational questions ("Explain in detail"), documents, and general text return null (clean messages)
  if (message?.id) {
    applyContextualReaction(from, message.id, sanitizedText || rawText).catch((err) =>
      privacyLog('debug', 'CONTEXTUAL_REACTION_ERROR', { error: err?.message })
    );
  }

  // 15b. Cleanup temporary Gemini Files API upload if one was created
  if (mediaPart?.geminiFileName) {
    deleteGeminiFile(mediaPart.geminiFileName).catch((err) =>
      privacyLog('debug', 'GEMINI_FILE_CLEANUP_FAILED', { error: err?.message })
    );
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
messageQueue.setHandler(async ({ message, requestId, contacts }) => {
  await handleIncomingMessage(message, requestId, contacts || []);
});
