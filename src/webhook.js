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
} from './privacy.js';
import {
  generateAIResponse,
  getActiveModel,
  setActiveModel,
  isSearchGroundingEnabled,
  setSearchGrounding,
} from './gemini.js';
import {
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendWhatsAppButtons,
  markMessageAsRead,
  getMediaUrl,
  downloadMediaInMemory,
} from './whatsapp.js';
import { parseImagePrompt, generateImageUrl, generateCleanImage } from './image-gen.js';
import { scheduleReminder, listReminders, deleteReminder } from './reminders.js';
import { checkAndIncrementUserQuota, recordGeminiDailyUsage, getUserQuotaReport } from './quota.js';
import { recordMessageMetric, recordErrorMetric, recordMediaBytes, recordGeminiMetric } from './metrics.js';

export const webhookRouter = express.Router();

// In-Memory cache for message deduplication (messageId -> timestamp)
const processedMessageIds = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
  if (!appSecret) {
    // If secret not configured in dev, signature check is disabled
    return true;
  }
  if (!signatureHeader || !rawBody) {
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

  // 1. Signature Verification
  // If SKIP_SIGNATURE_VERIFICATION is enabled or WHATSAPP_APP_SECRET is a boilerplate test placeholder,
  // skip HMAC verification to prevent dropping real Meta webhooks when an app secret is not yet set.
  const isPlaceholderSecret = config.WHATSAPP_APP_SECRET && config.WHATSAPP_APP_SECRET.includes('test_meta_app_secret');
  const shouldSkipSig = Boolean(config.SKIP_SIGNATURE_VERIFICATION) || isPlaceholderSecret;

  if (!shouldSkipSig && config.WHATSAPP_APP_SECRET) {
    const isValid = verifyMetaSignature(req.rawBody, signature, config.WHATSAPP_APP_SECRET);
    if (!isValid) {
      privacyLog('warn', 'INVALID_WEBHOOK_SIGNATURE', {
        requestId,
        hasSignature: Boolean(signature),
      });
      recordErrorMetric('invalid_signature');
      return res.status(401).send('Unauthorized: Invalid HMAC signature.');
    }
  } else if (isPlaceholderSecret) {
    privacyLog('warn', 'HMAC_VERIFICATION_BYPASSED_PLACEHOLDER_SECRET', {
      requestId,
      note: 'WHATSAPP_APP_SECRET contains placeholder test_meta_app_secret. Update with your real Meta App Secret in production.',
    });
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

        // If status update (delivered/read receipt), log lightly and skip
        if (value.statuses) {
          privacyLog('debug', 'STATUS_RECEIPT_RECEIVED', {
            requestId,
            status: value.statuses[0]?.status,
          });
          continue;
        }

        const messages = value.messages;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          continue;
        }

        for (const message of messages) {
          privacyLog('info', 'PROCESSING_INCOMING_MESSAGE', {
            requestId,
            id: message.id,
            type: message.type,
            fromEnding: message.from ? message.from.slice(-4) : 'unknown',
          });
          await handleIncomingMessage(message, requestId);
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

const ALLOWED_DOCUMENT_MIMES = new Set(['application/pdf', 'text/plain', 'text/csv']);

/**
 * Dispatches an individual incoming WhatsApp message.
 * @param {object} message - WhatsApp message payload object
 * @param {string} requestId - Traceable request identifier
 */
async function handleIncomingMessage(message, requestId = crypto.randomUUID()) {
  const messageId = message.id;
  const from = message.from;
  const messageType = message.type;
  const anonId = getAnonymizedId(from);

  // 1. Deduplication Check
  if (messageId && processedMessageIds.has(messageId)) {
    privacyLog('debug', 'DUPLICATE_MESSAGE_SKIPPED', { requestId, user: anonId });
    return;
  }
  if (messageId) {
    processedMessageIds.set(messageId, Date.now());
  }

  // 2. Authorization Whitelist Check
  if (!isAuthorized(from)) {
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
  const supportedTypes = ['text', 'image', 'audio', 'voice', 'document', 'interactive'];
  if (!supportedTypes.includes(messageType)) {
    privacyLog('info', 'UNSUPPORTED_MESSAGE_TYPE', {
      requestId,
      user: anonId,
      type: messageType,
    });
    recordMessageMetric(messageType, 'rejected');
    await sendWhatsAppButtons(
      from,
      `ℹ️ _Supported formats: Text, Photos, Voice Notes, and Documents (PDF/TXT/CSV)._\nSend any text question or upload media for instant AI analysis.`,
      [
        { id: 'cmd_help', title: 'Help Manual' },
        { id: 'cmd_status', title: 'System Status' },
      ]
    );
    return;
  }

  let rawText = '';
  let mediaPart = null; // { mimeType, data }

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
  } else if (messageType === 'document') {
    const docObj = message.document;
    rawText = docObj?.caption?.trim() || '';
    const mediaId = docObj?.id;
    const reportedMime = (docObj?.mime_type || '').toLowerCase();

    // MIME type allowlist enforcement
    if (!ALLOWED_DOCUMENT_MIMES.has(reportedMime)) {
      privacyLog('warn', 'DOCUMENT_MIME_REJECTED', { requestId, mime: reportedMime });
      await sendWhatsAppMessage(
        from,
        `⚠️ *Document Error:* Unsupported format (\`${reportedMime || 'unknown'}\`).\nPlease upload PDF, TXT, or CSV files.`
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
        await sendWhatsAppMessage(from, '⚠️ *Document Error:* Document exceeds maximum size limit (16MB).');
      } else if (downloaded?.reason === 'timeout') {
        await sendWhatsAppMessage(from, '⚠️ *Document Error:* Download timed out. Please try sending again.');
      } else {
        await sendWhatsAppMessage(from, '⚠️ *Document Error:* Failed to download document.');
      }
      return;
    }

    recordMediaBytes(downloaded.buffer.length);
    mediaPart = {
      mimeType: reportedMime,
      data: downloaded.base64,
    };
  }

  // 8. Quoted-Reply Context Injection & Message Storage
  const messagePlaceholder = mediaPart
    ? messageType === 'image'
      ? '[image]'
      : messageType === 'audio' || messageType === 'voice'
        ? '[voice note]'
        : '[document]'
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

  // 9. Command Handlers
  const lowerText = rawText.toLowerCase().trim();

  // Normalize interactive button IDs to command format
  const effectiveCommand =
    lowerText === 'cmd_help'
      ? '/help'
      : lowerText === 'cmd_status'
        ? '/status'
        : lowerText === 'cmd_reset'
          ? '/reset'
          : lowerText === 'cmd_privacy'
            ? '/privacy'
            : lowerText === 'cmd_usage'
              ? '/usage'
              : lowerText === 'cmd_reminders'
                ? '/reminders'
                : lowerText;

  // 9a. Image Generation
  const imagePrompt = !mediaPart ? parseImagePrompt(rawText) : null;
  if (imagePrompt) {
    privacyLog('info', 'IMAGE_GENERATION_REQUESTED', {
      requestId,
      user: anonId,
      promptLength: imagePrompt.length,
    });

    const cleanImage = await generateCleanImage(imagePrompt);
    const caption = `🎨 *AI Generated Image*\n\n_Prompt:_ "${imagePrompt}"`;

    const result = cleanImage
      ? await sendWhatsAppImage(from, cleanImage, caption)
      : await sendWhatsAppImage(from, generateImageUrl(imagePrompt).imageUrl, caption);

    if (result.success) {
      saveTurn(anonId, rawText, `[Generated and sent image: ${imagePrompt}]`);
      recordMessageMetric('image_gen', 'success');
    } else {
      recordErrorMetric('image_gen');
      await sendWhatsAppMessage(
        from,
        `⚠️ *Image Generation Notice:*\nCould not deliver generated image: ${result.error || 'Server error'}. Please try again.`
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
      `• */image <prompt>* or */draw <prompt>* - Generate AI artwork`,
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
      `• 📸 *Photos & Images:* Send screenshots, diagrams, or math problems for instant analysis.`,
      `• 🎙️ *Voice Notes:* Send audio voice notes for automatic transcription and answers.`,
      `• 📄 *Documents:* Upload PDF, TXT, or CSV files for summaries and analysis.`,
      `• 💬 *Quoted Replies:* Reply directly to previous messages to maintain context.`,
      ``,
      `*Privacy Guardrails:*`,
      `• All chat history is held in volatile RAM (${config.SESSION_TIMEOUT_MINUTES}m idle timeout).`,
      `• *Zero conversations or images are saved to disk.*`,
    ].join('\n');

    await sendWhatsAppButtons(from, helpMessage, [
      { id: 'cmd_status', title: 'Status' },
      { id: 'cmd_usage', title: 'Daily Quota' },
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
    await sendWhatsAppMessage(
      from,
      `🗑️ *Data Purged:*\nAll temporary in-memory session data for your identifier has been completely wiped.`
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
    const requestedModel = rawText.substring(7).trim();
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
    const remArgs = rawText.substring(8).trim();
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

  // 10. Privacy Guard: Scan & Redact Sensitive Financial/Credential Information
  const { sanitizedText, hasRedactions, categories } = maskSensitiveInfo(rawText);

  if (hasRedactions) {
    privacyLog('warn', 'SENSITIVE_DATA_DETECTED_REDACTED', {
      requestId,
      user: anonId,
      categories,
    });
  }

  // Determine default prompts for multimodal media if no text was provided
  let effectivePrompt = sanitizedText;
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
  const aiResponse = await generateAIResponse(fullPromptForGemini, history, mediaPart);

  // 13. Save turn into volatile in-memory session
  const recordedTurnPrompt = mediaPart
    ? `[${messageType.toUpperCase()} Analyzed] ${sanitizedText}`.trim()
    : sanitizedText;
  saveTurn(anonId, recordedTurnPrompt, aiResponse);

  // 14. Construct final response with optional security warning
  let finalMessage = aiResponse;
  if (hasRedactions) {
    finalMessage += `\n\n⚠️ _Security Alert: Detected and redacted sensitive details (${categories.join(
      ', '
    )}) before processing. Never share passwords, PINs, or card details over WhatsApp._`;
  }

  // 15. Send response back to user
  await sendWhatsAppMessage(from, finalMessage);
  recordMessageMetric(messageType, 'success');
}
