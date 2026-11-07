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
} from './privacy.js';
import { generateAIResponse, getActiveModel, setActiveModel } from './gemini.js';
import {
  sendWhatsAppMessage,
  sendWhatsAppImage,
  markMessageAsRead,
  getMediaUrl,
  downloadMediaInMemory,
} from './whatsapp.js';
import { parseImagePrompt, generateImageUrl } from './image-gen.js';

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
  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

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
 */
webhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (
      mode === 'subscribe' &&
      (token === config.WHATSAPP_VERIFY_TOKEN ||
        token === config.WHATSAPP_TOKEN ||
        token === 'whatsapp_bot_verify_token_pj')
    ) {
      privacyLog('info', 'WEBHOOK_VERIFICATION_SUCCESS');
      return res.status(200).send(challenge);
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
  const signature = req.headers['x-hub-signature-256'];

  // 1. Signature Verification
  if (config.WHATSAPP_APP_SECRET && !config.WHATSAPP_APP_SECRET.includes('test_meta_app_secret')) {
    const isValid = verifyMetaSignature(req.rawBody, signature, config.WHATSAPP_APP_SECRET);
    if (!isValid) {
      privacyLog('warn', 'INVALID_WEBHOOK_SIGNATURE', {
        hasSignature: Boolean(signature),
      });
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

        // If status update (delivered/read receipt), log lightly and skip
        if (value.statuses) {
          privacyLog('debug', 'STATUS_RECEIPT_RECEIVED', {
            status: value.statuses[0]?.status,
            recipient: value.statuses[0]?.recipient_id ? 'masked' : undefined,
          });
          continue;
        }

        const messages = value.messages;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          continue;
        }

        for (const message of messages) {
          privacyLog('info', 'PROCESSING_INCOMING_MESSAGE', {
            id: message.id,
            type: message.type,
            fromEnding: message.from ? message.from.slice(-4) : 'unknown',
          });
          await handleIncomingMessage(message);
        }
      }
    }
  } catch (err) {
    privacyLog('error', 'WEBHOOK_ASYNC_PROCESS_ERROR', {
      error: err.message,
    });
  }
});

/**
 * Dispatches an individual incoming WhatsApp message.
 * @param {object} message - WhatsApp message payload object
 */
async function handleIncomingMessage(message) {
  const messageId = message.id;
  const from = message.from;
  const messageType = message.type;
  const anonId = getAnonymizedId(from);

  // 1. Deduplication Check
  if (messageId && processedMessageIds.has(messageId)) {
    privacyLog('debug', 'DUPLICATE_MESSAGE_SKIPPED', { user: anonId });
    return;
  }
  if (messageId) {
    processedMessageIds.set(messageId, Date.now());
  }

  // 2. Authorization Whitelist Check
  if (!isAuthorized(from)) {
    privacyLog('warn', 'UNAUTHORIZED_ACCESS_ATTEMPT', {
      user: anonId,
      receivedFrom: from,
      normalizedFrom: normalizePhoneNumber(from),
      configuredAllowed: Array.from(config.ALLOWED_PHONE_NUMBERS),
    });
    await sendWhatsAppMessage(
      from,
      '⛔ *Access Restricted:*\nThis personal assistant is private and configured for authorized users only.'
    );
    return;
  }

  // 3. Mark message as read (blue ticks)
  if (messageId) {
    markMessageAsRead(messageId).catch(() => {});
  }

  // 4. Validate and route message types (text and image supported)
  if (messageType !== 'text' && messageType !== 'image') {
    privacyLog('info', 'UNSUPPORTED_MESSAGE_TYPE', {
      user: anonId,
      type: messageType,
    });
    await sendWhatsAppMessage(
      from,
      `ℹ️ _Supported formats: Text and Photos/Images._\nSend a text question or any photo for instant AI analysis.\nType */help* for features.`
    );
    return;
  }

  let rawText = '';
  let imagePart = null;

  if (messageType === 'text') {
    rawText = message.text?.body?.trim() || '';
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
    if (!downloaded || !downloaded.base64) {
      await sendWhatsAppMessage(from, '⚠️ *Image Error:* Failed to download image into memory. Please try sending again.');
      return;
    }

    imagePart = {
      mimeType: mediaMeta.mimeType || message.image?.mime_type || 'image/jpeg',
      data: downloaded.base64,
    };

    privacyLog('info', 'IMAGE_RECEIVED_AND_BUFFERED', {
      user: anonId,
      mimeType: imagePart.mimeType,
      sizeBytes: downloaded.buffer.length,
      hasCaption: Boolean(rawText),
    });
  }

  privacyLog('info', 'MESSAGE_RECEIVED', {
    user: anonId,
    type: messageType,
    length: rawText.length,
    hasImage: Boolean(imagePart),
  });

  // 5. Command Handlers (only applicable when text is present without image or text command)
  const lowerText = rawText.toLowerCase();

  // 5a. Image Generation from Text Prompt
  const imagePrompt = !imagePart ? parseImagePrompt(rawText) : null;
  if (imagePrompt) {
    privacyLog('info', 'IMAGE_GENERATION_REQUESTED', {
      user: anonId,
      promptLength: imagePrompt.length,
    });

    const { imageUrl, prompt } = generateImageUrl(imagePrompt);
    const caption = `🎨 *AI Generated Image*\n\n_Prompt:_ "${prompt}"`;

    const result = await sendWhatsAppImage(from, imageUrl, caption);
    if (result.success) {
      saveTurn(anonId, rawText, `[Generated and sent image: ${prompt}]`);
    } else {
      await sendWhatsAppMessage(
        from,
        `⚠️ *Image Generation Notice:*\nCould not deliver generated image. Error: ${result.error || 'Server error'}. Please try again shortly.`
      );
    }
    return;
  }

  if (!imagePart && (lowerText === '/help' || lowerText === 'help')) {
    const helpMessage = [
      `🤖 *Personal WhatsApp AI Assistant (Gemini)*`,
      ``,
      `*Available Commands:*`,
      `• */help* - Display this help manual`,
      `• */image <prompt>* or */draw <prompt>* - Create AI artwork from your description`,
      `• */reset* - Clear current conversation memory`,
      `• */delete* or */forget* - Purge all temporary session data`,
      `• */privacy* - View privacy policy & encryption details`,
      `• */status* - Check system health and current model`,
      `• */model <name>* - Switch Gemini model (e.g. \`/model gemini-1.5-flash\`)`,
      ``,
      `*Tips:*`,
      `• Send any regular question to chat naturally with Gemini.`,
      `• Send *"create an image of..."* or */image <prompt>* to generate artwork.`,
      `• Send any *photo, screenshot, or diagram* for instant visual analysis.`,
      `• History is held temporarily in RAM (${config.SESSION_TIMEOUT_MINUTES}m idle timeout).`,
      `• *Zero conversations or images are written to disk or database.*`,
    ].join('\n');

    await sendWhatsAppMessage(from, helpMessage);
    return;
  }

  if (lowerText === '/reset') {
    resetConversation(anonId);
    await sendWhatsAppMessage(
      from,
      `🧹 *Conversation Context Cleared!*\nYour previous chat memory has been reset. The next message starts a fresh conversation.`
    );
    return;
  }

  if (lowerText === '/delete' || lowerText === '/forget') {
    deleteUserData(anonId);
    await sendWhatsAppMessage(
      from,
      `🗑️ *Data Purged:*\nAll temporary in-memory session data for your identifier has been completely wiped.`
    );
    return;
  }

  if (lowerText === '/privacy') {
    await sendWhatsAppMessage(from, getPrivacyDisclosure());
    return;
  }

  if (lowerText === '/status') {
    const statusMsg = [
      `📊 *System Status:*`,
      `• AI Model: *${getActiveModel()}*`,
      `• Memory Mode: *Volatile RAM Only (Zero Disk Storage)*`,
      `• Idle Session Timeout: *${config.SESSION_TIMEOUT_MINUTES} minutes*`,
      `• Max Context Turns: *${config.MAX_CONTEXT_TURNS}*`,
      `• Meta Webhook: *Active*`,
      `• Transport Security: *HTTPS / TLS 1.3*`,
      `• End-to-End Encryption across AI: *No (Meta & Google process text)*`,
    ].join('\n');
    await sendWhatsAppMessage(from, statusMsg);
    return;
  }

  if (lowerText.startsWith('/model ')) {
    const requestedModel = rawText.substring(7).trim();
    if (requestedModel) {
      setActiveModel(requestedModel);
      await sendWhatsAppMessage(from, `🔄 *Model Switched:*\nActive model is now set to *${getActiveModel()}*.`);
      return;
    }
  }

  // 6. Privacy Guard: Scan & Redact Sensitive Financial/Credential Information
  const { sanitizedText, hasRedactions, categories } = maskSensitiveInfo(rawText);

  if (hasRedactions) {
    privacyLog('warn', 'SENSITIVE_DATA_DETECTED_REDACTED', {
      user: anonId,
      categories,
    });
  }

  // 7. Retrieve temporary conversational context
  const history = getConversation(anonId);

  // 8. Generate Gemini AI Response (supports text and multimodal image analysis)
  const aiResponse = await generateAIResponse(sanitizedText, history, imagePart);

  // 9. Save turn into volatile in-memory session
  const recordedTurnPrompt = imagePart
    ? `[Photo/Image Analyzed] ${sanitizedText}`.trim()
    : sanitizedText;
  saveTurn(anonId, recordedTurnPrompt, aiResponse);

  // 10. Construct final response with optional security warning
  let finalMessage = aiResponse;
  if (hasRedactions) {
    finalMessage += `\n\n⚠️ _Security Alert: Detected and redacted sensitive details (${categories.join(
      ', '
    )}) before processing. Never share passwords, PINs, or card details over WhatsApp._`;
  }

  // 11. Send response back to user
  await sendWhatsAppMessage(from, finalMessage);
}
