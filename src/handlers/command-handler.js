import { config } from '../config.js';
import {
  privacyLog,
  saveTurn,
  resetConversation,
  deleteUserData,
  getPrivacyDisclosure,
  isVoiceReplyEnabled,
  setVoiceReplyEnabled,
} from '../privacy.js';
import {
  getActiveModel,
  setActiveModel,
  isSearchGroundingEnabled,
  setSearchGrounding,
  getPersona,
  setPersona,
  listPersonas,
} from '../gemini.js';
import {
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendWhatsAppVideo,
  sendWhatsAppButtons,
  sendWhatsAppDocument,
  sendWhatsAppTypingIndicator,
} from '../whatsapp.js';
import {
  parseImagePrompt,
  parseImagePromptOptions,
  generateImageUrl,
  generateCleanImage,
  recordImageGeneration,
  resetImageLearner,
  cacheImageMediaId,
  selectImageModel,
} from '../image-gen.js';
import { parseVideoPrompt, parseVideoPromptOptions, generateVideo } from '../video-gen.js';
import { scheduleReminder, listReminders, deleteReminder } from '../reminders.js';
import { addTodo, listTodos, markTodoDone, clearCompletedTodos } from '../todos.js';
import { getUserQuotaReport } from '../quota.js';
import { recordMessageMetric, recordErrorMetric } from '../metrics.js';
import { handleLanguageCommand } from '../language.js';
import { handleMemoryCommand, clearUserMemory } from '../memory.js';
import { clearLearnedWorkflows } from '../workflow-learner.js';
import { clearUserProfile } from '../conversation-adapter.js';
import { exportUserData } from '../export.js';
import { handleBriefingCommand } from '../briefing.js';
import {
  addContact,
  removeContact,
  formatContactsList,
  setContactAiAllowed,
  sendOutboundContactMessage,
  isPrimaryAdmin,
  maskPhoneNumber,
  getPrimaryAdminNumber,
} from '../contacts.js';
import { applyContextualReaction } from '../reactions.js';

// Maps anonymized IDs to their latest WhatsApp sender address for scheduled briefings
const briefingRecipientPhones = new Map();

export function registerBriefingRecipient(anonId, phone) {
  if (anonId && phone) {
    briefingRecipientPhones.set(anonId, phone);
  }
}

export function resolveBriefingPhone(userId) {
  return briefingRecipientPhones.get(userId) || getPrimaryAdminNumber() || '';
}

function logNonFatal(event, err) {
  privacyLog('debug', event, { error: err?.message || String(err) });
}

/**
 * Handles image generation commands cleanly.
 */
async function handleImageGenCommand({
  effectiveCommand,
  rawText,
  from,
  anonId,
  mediaPart,
  message,
  messageId,
  requestId,
}) {
  const imagePrompt = !mediaPart ? parseImagePrompt(effectiveCommand || rawText) : null;
  if (!imagePrompt) return false;

  const parsedOptions = parseImagePromptOptions(imagePrompt);
  const selectedModel = parsedOptions.hasExplicitModel ? parsedOptions.model : selectImageModel(imagePrompt);

  privacyLog('info', 'IMAGE_GENERATION_REQUESTED', {
    requestId,
    user: anonId,
    promptLength: parsedOptions.prompt.length,
    model: selectedModel,
    dimensions: `${parsedOptions.width}x${parsedOptions.height}`,
    isLossless: parsedOptions.isLossless,
  });

  const modelBadge =
    selectedModel === 'gemini-3-pro-image'
      ? '👑 Gemini 3 Pro (Studio HD)'
      : selectedModel === 'gemini-3.1-flash-image'
        ? '⚡ Gemini 3.1 Flash Image'
        : selectedModel === 'turbo'
          ? '⚡ SDXL-Turbo (Fast)'
          : selectedModel === 'kontext'
            ? '✨ FLUX.1 Kontext Pro'
            : selectedModel === 'realism'
              ? '📸 FLUX Realism'
              : '✨ FLUX.1 (HD)';
  const dimBadge = `${parsedOptions.width}x${parsedOptions.height}${parsedOptions.isLossless ? ' [Lossless HD]' : ''}`;

  if (messageId) {
    await sendWhatsAppTypingIndicator(messageId).catch((err) => logNonFatal('TYPING_INDICATOR_FAILED', err));
  }

  const cleanImage = await generateCleanImage(imagePrompt, {
    anonId,
    model: selectedModel,
    isLossless: parsedOptions.isLossless,
  });
  const caption = [
    `🎨 *AI Generated Image* (${modelBadge})`,
    `📐 _Size:_ ${dimBadge}`,
    ``,
    `_Prompt:_ "${parsedOptions.prompt}"`,
  ].join('\n');

  let result;
  if (cleanImage?.cachedMediaId) {
    result = await sendWhatsAppImage(from, { mediaId: cleanImage.cachedMediaId }, caption);
  } else if (cleanImage && cleanImage.isLossless && cleanImage.buffer) {
    result = await sendWhatsAppDocument(from, cleanImage.buffer, 'image_hd.png', caption, 'image/png');
  } else if (cleanImage && cleanImage.buffer) {
    result = await sendWhatsAppImage(from, cleanImage, caption);
  } else {
    result = await sendWhatsAppImage(from, generateImageUrl(imagePrompt, parsedOptions).imageUrl, caption);
  }

  if (result.success) {
    if (cleanImage?.cacheKey && result.mediaId) {
      await cacheImageMediaId(cleanImage.cacheKey, result.mediaId);
    }
    saveTurn(anonId, rawText, `[Generated and sent image: ${parsedOptions.prompt}]`);
    recordMessageMetric('image_gen', 'success');
    if (message?.id) {
      applyContextualReaction(from, message.id, imagePrompt, { action: 'image_gen' }).catch((err) =>
        logNonFatal('REACTION_SEND_FAILED', err)
      );
    }
    recordImageGeneration(anonId, {
      id: result.messageId || requestId,
      prompt: parsedOptions.prompt,
      enhancedPrompt: cleanImage?.enhancedPrompt || imagePrompt,
      model: selectedModel,
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
  return true;
}

/**
 * Handles text-to-video and image-to-video generation commands.
 */
async function handleVideoGenCommand({
  effectiveCommand,
  rawText,
  from,
  anonId,
  mediaPart,
  messageType,
  message,
  requestId,
}) {
  const isImageToVideo = Boolean(mediaPart && messageType === 'image');
  const videoPrompt = !mediaPart || isImageToVideo ? parseVideoPrompt(effectiveCommand || rawText) : null;
  if (!videoPrompt) return false;

  const parsedVidOptions = parseVideoPromptOptions(videoPrompt);
  privacyLog('info', 'VIDEO_GENERATION_REQUESTED', {
    requestId,
    user: anonId,
    promptLength: parsedVidOptions.prompt.length,
    duration: parsedVidOptions.duration,
    dimensions: `${parsedVidOptions.width}x${parsedVidOptions.height}`,
    isImageToVideo,
  });

  await sendWhatsAppMessage(
    from,
    isImageToVideo
      ? '🎬 *Animating your photo...*\n_Directing AI motion & synthesizing follow-up scenes. This usually takes 15–30 seconds. Hang tight!_'
      : '🎬 *Generating your video...*\n_Directing cinematography & rendering frames. This usually takes 15–30 seconds. Hang tight!_'
  );

  try {
    const vidOptions = isImageToVideo && mediaPart?.data ? { imageBuffer: Buffer.from(mediaPart.data, 'base64') } : {};
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
        if (message?.id) {
          applyContextualReaction(from, message.id, rawText, { action: 'video_gen' }).catch((err) =>
            logNonFatal('REACTION_SEND_FAILED', err)
          );
        }
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
  return true;
}

/**
 * Dispatches built-in slash commands and returns true if the message was handled.
 */
export async function dispatchBuiltInCommand({
  effectiveCommand,
  rawText,
  from,
  anonId,
  message,
  mediaPart,
  messageType,
  messageId,
  requestId,
}) {
  if (
    await handleImageGenCommand({ effectiveCommand, rawText, from, anonId, mediaPart, message, messageId, requestId })
  ) {
    return true;
  }

  if (
    await handleVideoGenCommand({ effectiveCommand, rawText, from, anonId, mediaPart, messageType, message, requestId })
  ) {
    return true;
  }

  if (!mediaPart && (effectiveCommand === '/help' || effectiveCommand === 'help')) {
    const helpMessage = [
      `🤖 *Personal WhatsApp AI Assistant (Gemini)*`,
      ``,
      `*Available Commands:*`,
      `• */help* - Display this help manual`,
      `• */briefing* [on|off|time HH:MM|status] - Daily digest summary & scheduler`,
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
      `• Chat history is held with ${config.SESSION_TIMEOUT_MINUTES}m idle timeout and PII redaction.`,
      `• State backend: *${config.STATE_BACKEND || 'memory'}*.`,
    ].join('\n');

    await sendWhatsAppMessage(from, helpMessage);
    await sendWhatsAppButtons(from, '⚡ *Quick Actions:*', [
      { id: 'cmd_status', title: 'Status' },
      { id: 'cmd_todos', title: 'To-Dos' },
      { id: 'cmd_reset', title: 'Clear History' },
    ]);
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand === '/reset') {
    resetConversation(anonId);
    await sendWhatsAppMessage(
      from,
      `🧹 *Conversation Context Cleared!*\nYour previous chat memory has been reset. The next message starts a fresh conversation.`
    );
    recordMessageMetric('command', 'success');
    return true;
  }

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
    return true;
  }

  if (effectiveCommand === '/privacy') {
    await sendWhatsAppMessage(from, getPrivacyDisclosure());
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand === '/status') {
    const quota = getUserQuotaReport(anonId);
    const searchStatus = isSearchGroundingEnabled() ? 'Enabled (Google Search)' : 'Disabled';
    const memoryModeLabel =
      config.STATE_BACKEND === 'redis'
        ? 'Redis Distributed Store'
        : config.REMINDERS_PERSIST
          ? 'Hybrid (RAM Sessions + Disk Store)'
          : 'Volatile RAM Only (Zero Disk Chat Logs)';
    const statusMsg = [
      `📊 *System Status:*`,
      `• AI Model: *${getActiveModel()}*`,
      `• Active Persona: *${getPersona(anonId)}*`,
      `• Voice Replies: *${isVoiceReplyEnabled(anonId) ? 'Enabled' : 'Disabled'}*`,
      `• Search Grounding: *${searchStatus}*`,
      `• Remaining Daily Quota: *${quota.userMax - quota.userCount} / ${quota.userMax}*`,
      `• Memory Mode: *${memoryModeLabel}*`,
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
    return true;
  }

  if (effectiveCommand.startsWith('/model ')) {
    const requestedModel = effectiveCommand.substring(7).trim();
    if (requestedModel) {
      setActiveModel(requestedModel);
      await sendWhatsAppMessage(from, `🔄 *Model Switched:*\nActive model is now set to *${getActiveModel()}*.`);
      recordMessageMetric('command', 'success');
      return true;
    }
  }

  if (effectiveCommand === '/search on') {
    setSearchGrounding(true);
    await sendWhatsAppMessage(
      from,
      '🌐 *Google Search Grounding Enabled:*\nGemini will now retrieve live web information and append verified sources.'
    );
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand === '/search off') {
    setSearchGrounding(false);
    await sendWhatsAppMessage(
      from,
      '🌐 *Google Search Grounding Disabled:*\nGemini will now respond using internal model knowledge.'
    );
    recordMessageMetric('command', 'success');
    return true;
  }

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
    return true;
  }

  if (effectiveCommand.startsWith('/remind ')) {
    const remArgs = effectiveCommand.substring(8).trim();
    if (remArgs.toLowerCase().startsWith('delete ')) {
      const deleteId = remArgs.substring(7).trim();
      const delResult = deleteReminder(anonId, deleteId);
      await sendWhatsAppMessage(from, delResult.message);
      return true;
    }

    const parts = remArgs.split(/\s+/);
    let whenStr = '';
    let reminderText = '';
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
    if (schedResult.success && message?.id) {
      applyContextualReaction(from, message.id, reminderText, { action: 'reminder_created' }).catch((err) =>
        logNonFatal('REACTION_SEND_FAILED', err)
      );
    }
    return true;
  }

  if (effectiveCommand === '/reminders') {
    const listMsg = listReminders(anonId);
    await sendWhatsAppMessage(from, listMsg);
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand.startsWith('/todo ')) {
    const taskText = effectiveCommand.substring(6).trim();
    const result = addTodo(anonId, taskText);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('todo', result.success ? 'success' : 'rejected');
    if (result.success && message?.id) {
      applyContextualReaction(from, message.id, taskText, { action: 'todo_created' }).catch((err) =>
        logNonFatal('REACTION_SEND_FAILED', err)
      );
    }
    return true;
  }

  if (effectiveCommand === '/todos') {
    const listMsg = listTodos(anonId);
    await sendWhatsAppButtons(from, listMsg, [
      { id: 'cmd_help', title: 'Help' },
      { id: 'cmd_status', title: 'Status' },
    ]);
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand.startsWith('/done ')) {
    const todoId = effectiveCommand.substring(6).trim();
    const result = markTodoDone(anonId, todoId);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('todo', result.success ? 'success' : 'rejected');
    return true;
  }

  if (effectiveCommand === '/clear_todos') {
    const result = clearCompletedTodos(anonId);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('todo', 'success');
    return true;
  }

  if (effectiveCommand === '/briefing' || effectiveCommand.startsWith('/briefing ')) {
    registerBriefingRecipient(anonId, from);
    const reply = await handleBriefingCommand(anonId, effectiveCommand);
    await sendWhatsAppMessage(from, reply);
    recordMessageMetric('command', 'success');
    return true;
  }

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
    return true;
  }

  if (effectiveCommand === '/voice on') {
    setVoiceReplyEnabled(anonId, true);
    await sendWhatsAppMessage(
      from,
      '🎙️ *Voice Mode Enabled:*\nAssistant replies will now also be synthesized into audio voice messages.\nType */voice off* anytime to return to text-only.'
    );
    recordMessageMetric('command', 'success');
    return true;
  }
  if (effectiveCommand === '/voice off') {
    setVoiceReplyEnabled(anonId, false);
    await sendWhatsAppMessage(from, '💬 *Voice Mode Disabled:*\nAssistant replies will now be delivered as text only.');
    recordMessageMetric('command', 'success');
    return true;
  }
  if (effectiveCommand === '/voice' || effectiveCommand === '/voice status') {
    const isVoice = isVoiceReplyEnabled(anonId);
    await sendWhatsAppMessage(
      from,
      `🎙️ *Voice Mode Status:* *${isVoice ? 'Enabled (Audio replies ON)' : 'Disabled (Text-only)'}*\n\n• Type */voice on* to receive voice audio replies.\n• Type */voice off* for text-only replies.\n• Or append \`--voice\` to any single message.`
    );
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand === '/language' || effectiveCommand.startsWith('/language ')) {
    const langArg = effectiveCommand.length > 9 ? effectiveCommand.substring(9).trim() : '';
    const reply = await handleLanguageCommand(anonId, langArg);
    await sendWhatsAppMessage(from, reply);
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand === '/memory' || effectiveCommand.startsWith('/memory ')) {
    const reply = await handleMemoryCommand(anonId, effectiveCommand);
    await sendWhatsAppMessage(from, reply);
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand === '/export' || effectiveCommand.startsWith('/export')) {
    await exportUserData(from, anonId);
    recordMessageMetric('command', 'success');
    return true;
  }

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
      return true;
    }

    const target = args.slice(0, firstSpaceIdx).trim();
    const messageToSend = args.slice(firstSpaceIdx + 1).trim();
    const result = await sendOutboundContactMessage(from, target, messageToSend);
    await sendWhatsAppMessage(from, result.message);
    recordMessageMetric('command', result.ok ? 'success' : 'failed');
    return true;
  }

  if (
    effectiveCommand === '/c' ||
    effectiveCommand === '/contacts' ||
    effectiveCommand === '/contact' ||
    effectiveCommand === '/contact list' ||
    effectiveCommand === '/c list'
  ) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can manage contacts.');
      return true;
    }
    await sendWhatsAppMessage(from, formatContactsList());
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand.startsWith('/c add ') || effectiveCommand.startsWith('/contact add ')) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can add contacts.');
      return true;
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
      return true;
    }
    const saveRes = addContact(alias, phone, name);
    if (!saveRes.ok) {
      await sendWhatsAppMessage(from, `❌ ${saveRes.error}`);
      recordMessageMetric('command', 'failed');
      return true;
    }
    await sendWhatsAppMessage(
      from,
      `✅ *Contact Saved!*\n• *Name:* ${saveRes.contact.name}\n• *Alias:* \`@${saveRes.contact.alias}\`\n• *Phone:* ${maskPhoneNumber(saveRes.contact.phone)}\n• *Mode:* 📨 Relay Only\n\n_💡 Send them a message with:_ \`/s ${saveRes.contact.alias} <your message>\``
    );
    recordMessageMetric('command', 'success');
    return true;
  }

  if (
    effectiveCommand.startsWith('/c remove ') ||
    effectiveCommand.startsWith('/c delete ') ||
    effectiveCommand.startsWith('/contact remove ') ||
    effectiveCommand.startsWith('/contact delete ')
  ) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can delete contacts.');
      return true;
    }
    const query = effectiveCommand.replace(/^\/(?:c|contact)\s+(?:remove|delete)\s+/, '').trim();
    const removeRes = removeContact(query);
    if (!removeRes.ok) {
      await sendWhatsAppMessage(from, `❌ ${removeRes.error}`);
      recordMessageMetric('command', 'failed');
      return true;
    }
    await sendWhatsAppMessage(
      from,
      `🗑️ *Contact Removed:* \`@${removeRes.removed.alias}\` (${removeRes.removed.name}) was deleted from your contact book.`
    );
    recordMessageMetric('command', 'success');
    return true;
  }

  if (effectiveCommand.startsWith('/c permit ') || effectiveCommand.startsWith('/contact permit ')) {
    if (!isPrimaryAdmin(from)) {
      await sendWhatsAppMessage(from, '⛔ *Access Denied:* Only the bot administrator can modify contact permissions.');
      return true;
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
      return true;
    }
    const permitRes = setContactAiAllowed(alias, flag === 'on');
    if (!permitRes.ok) {
      await sendWhatsAppMessage(from, `❌ ${permitRes.error}`);
      recordMessageMetric('command', 'failed');
      return true;
    }
    const modeDescription = permitRes.contact.allowAiChat
      ? '🤖 Full AI Chat & Relay (Can chat directly with Gemini AI)'
      : '📨 Relay Only (All replies are forwarded directly to you)';
    await sendWhatsAppMessage(
      from,
      `✅ *Permission Updated!*\n• *Contact:* ${permitRes.contact.name} (\`@${permitRes.contact.alias}\`)\n• *Mode:* ${modeDescription}`
    );
    recordMessageMetric('command', 'success');
    return true;
  }

  return false;
}
