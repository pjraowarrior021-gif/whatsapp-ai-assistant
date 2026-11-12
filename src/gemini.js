import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { privacyLog } from './privacy.js';
import { store } from './store/index.js';
import { getUserLanguage, getLanguageInstruction } from './language.js';
import { getMemoryContext } from './memory.js';
import { getLearnedWorkflowContext } from './workflow-learner.js';
import { getConversationAdaptationContext } from './conversation-adapter.js';
import { toolDeclarations, executeToolCall } from './tools/index.js';

let aiClient = null;
let activeModel = config.GEMINI_MODEL;
let searchGroundingEnabled = config.ENABLE_SEARCH_GROUNDING;

// In-Memory store for user persona preferences: Map<anonymizedUserId, string>
const userPersonas = new Map();

/**
 * WhatsApp-optimized System Instructions
 */
export const SYSTEM_INSTRUCTION = `You are a thoughtful, intelligent, and highly capable human companion on WhatsApp powered by Google Gemini.
You speak like a sharp, trusted friend or executive chief of staff—warm, natural, direct, and completely free of robotic AI clichés.

Core Conversational Guidelines:
1. WhatsApp Cadence & Brevity:
   - Write in short, bite-sized paragraphs (1 to 3 sentences maximum per block) separated by blank lines.
   - Mobile readability is paramount: never dump huge, unformatted blocks of text.
   - Match the user's energy and conciseness: if they ask a quick question, give a swift, direct answer.

2. Zero Robotic AI Filler:
   - NEVER open with robotic preambles like "Certainly!", "Sure thing!", "I'd be glad to help with that!", "As an AI language model...", or "Here is what you requested:".
   - NEVER conclude with clichéd sign-offs like "Feel free to ask if you have any questions!", "I hope this helps!", or "Let me know if there's anything else!".
   - Jump straight into the helpful content or use natural human conversational acknowledgments ("Got it", "On it", "Makes sense", "Done").

3. Tasteful WhatsApp Formatting:
   - Use *bold* sparingly for key highlights and titles.
   - Use bullet points for clear lists, options, or checklists.
   - Place emojis naturally (1-2 per message max where a human would place them, not as robotic prefixes on every single line).
   - Use \`\`\`code blocks\`\`\` for code or command-line syntax.
   - Never use raw HTML tags (e.g. <b>, <i>, <a>).

4. Strict Privacy & Boundaries:
   - NEVER ask for, verify, or store bank PINs, OTPs, CVVs, passwords, or payment credentials. If mentioned, remind the user to keep credentials private.
   - The user can type /help or /privacy at any time.

5. Visual, Media & Document Intelligence:
   - When inspecting images, diagrams, errors, or documents, inspect visible details thoroughly and give practical, actionable solutions.`;

/**
 * Built-in Persona configurations
 */
export const PERSONAS = {
  default: {
    name: 'default',
    title: 'Balanced Assistant',
    description: 'Standard balanced, friendly, and helpful personal assistant.',
    instruction: SYSTEM_INSTRUCTION,
  },
  coder: {
    name: 'coder',
    title: 'Expert Software Engineer',
    description: 'Ultra-concise, technical, code-first answers with syntax blocks.',
    instruction: `${SYSTEM_INSTRUCTION}

[PERSONA OVERRIDE: CODER]
- Deliver ultra-concise, technical, and code-first answers.
- Provide complete, correct, production-grade code snippets with proper language tags in markdown.
- Skip fluff, pleasantries, or unnecessary preambles.
- When diagnosing bugs, provide root cause analysis followed immediately by the patch.`,
  },
  tutor: {
    name: 'tutor',
    title: 'Patient Socratic Tutor',
    description: 'Patient, pedagogical, step-by-step explanations with analogies.',
    instruction: `${SYSTEM_INSTRUCTION}

[PERSONA OVERRIDE: TUTOR]
- Act as a patient, encouraging, and clear teacher.
- Break down complex concepts into step-by-step explanations.
- Use relatable real-world analogies and intuitive examples.
- Check for understanding and encourage curiosity.`,
  },
  executive: {
    name: 'executive',
    title: 'Executive Briefing Specialist',
    description: 'Bulleted, data-driven executive briefings with high-level summaries.',
    instruction: `${SYSTEM_INSTRUCTION}

[PERSONA OVERRIDE: EXECUTIVE]
- Deliver bottom-line-up-front (BLUF), high-impact executive summaries.
- Use structured bullet points, metrics, and actionable takeaways.
- Focus on decisions, trade-offs, and strategic implications.
- Keep sentences concise, direct, and professional.`,
  },
};

/**
 * Returns the active persona for a user.
 * @param {string} [anonId]
 * @returns {string} Persona key (e.g. 'default', 'coder', 'tutor', 'executive')
 */
export function getPersona(anonId) {
  if (!anonId) return 'default';
  return userPersonas.get(anonId) || 'default';
}

/**
 * Sets the active persona for a user.
 * @param {string} anonId
 * @param {string} personaName
 * @returns {{ success: boolean, persona?: object, error?: string }}
 */
export function setPersona(anonId, personaName) {
  if (!anonId) return { success: false, error: 'User identifier required' };
  const key = (personaName || '').trim().toLowerCase();
  if (!PERSONAS[key]) {
    return {
      success: false,
      error: `Unknown persona "${personaName}". Available personas: ${Object.keys(PERSONAS).join(', ')}`,
    };
  }
  userPersonas.set(anonId, key);
  store.set(`persona:${anonId}`, key).catch(() => {});
  privacyLog('info', 'PERSONA_SWITCHED', { user: anonId, persona: key });
  return { success: true, persona: PERSONAS[key] };
}

/**
 * Resets the persona for a user back to default.
 * @param {string} anonId
 */
export function resetPersona(anonId) {
  if (anonId) {
    userPersonas.delete(anonId);
    store.del(`persona:${anonId}`).catch(() => {});
  }
}

/**
 * Returns all available personas.
 * @returns {Record<string, { name: string, title: string, description: string }>}
 */
export function listPersonas() {
  return PERSONAS;
}

/**
 * Initializes or returns the Google Gen AI SDK client.
 * @returns {GoogleGenAI}
 */
export function getGeminiClient() {
  if (!aiClient) {
    if (!config.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    aiClient = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }
  return aiClient;
}

/**
 * Injects a mock Gemini client for hermetic offline testing.
 * @param {object|null} mockClient
 */
export function setGeminiClient(mockClient) {
  aiClient = mockClient;
}

/**
 * Allows runtime model switching (e.g. gemini-3.5-flash-lite, gemini-3.5-flash).
 * @param {string} modelName
 */
export function setActiveModel(modelName) {
  if (modelName && typeof modelName === 'string') {
    activeModel = modelName.trim();
    privacyLog('info', 'GEMINI_MODEL_SWITCHED', { model: activeModel });
  }
}

/**
 * Returns current active model name.
 * @returns {string}
 */
export function getActiveModel() {
  return activeModel;
}

/**
 * Returns current search grounding state.
 * @returns {boolean}
 */
export function isSearchGroundingEnabled() {
  return searchGroundingEnabled;
}

/**
 * Toggles search grounding at runtime.
 * @param {boolean} enabled
 */
export function setSearchGrounding(enabled) {
  searchGroundingEnabled = Boolean(enabled);
  store.set('search_grounding', searchGroundingEnabled).catch(() => {});
}

/**
 * Initializes and restores Gemini preferences from store on startup.
 */
export async function initGeminiStore() {
  try {
    const personaKeys = await store.keys('persona:*');
    for (const key of personaKeys) {
      const anonId = key.substring(8);
      const val = await store.get(key);
      if (anonId && val && PERSONAS[val]) {
        userPersonas.set(anonId, val);
      }
    }

    const grounding = await store.get('search_grounding');
    if (typeof grounding === 'boolean') {
      searchGroundingEnabled = grounding;
    }
  } catch (err) {
    privacyLog('warn', 'GEMINI_STORE_INIT_FAILED', { error: err.message });
  }
}

/**
 * Builds candidate model list: activeModel followed by de-duplicated fallbacks.
 * @returns {string[]}
 */
export function getCandidateModels() {
  const fallbacks = Array.isArray(config.GEMINI_FALLBACK_MODELS) ? config.GEMINI_FALLBACK_MODELS : [];
  return [activeModel, ...fallbacks.filter((m) => m !== activeModel)];
}

/**
 * Formats groundingMetadata into a compact WhatsApp *Sources:* list.
 * @param {object} groundingMetadata
 * @returns {string}
 */
export function formatGroundingSources(groundingMetadata) {
  if (!groundingMetadata) return '';
  const chunks = groundingMetadata.groundingChunks || [];
  const sources = [];
  const seenUris = new Set();

  for (const chunk of chunks) {
    if (chunk.web && chunk.web.uri && !seenUris.has(chunk.web.uri)) {
      seenUris.add(chunk.web.uri);
      const title = chunk.web.title ? chunk.web.title.trim() : chunk.web.uri;
      sources.push({ title, uri: chunk.web.uri });
    }
  }

  if (sources.length === 0) return '';
  const topSources = sources.slice(0, 3);
  const formatted = topSources.map((s, idx) => `${idx + 1}. [${s.title}](${s.uri})`).join('\n');
  return `\n\n*Sources:*\n${formatted}`;
}

/**
 * Generates an AI response using the Google Gemini API with conversational context and optional image input.
 *
 * @param {string} userMessage - The sanitized user input or image caption
 * @param {Array<{role: string, parts: Array<{text: string}>}>} conversationHistory - Prior turns from in-memory session
 * @param {{ mimeType: string, data: string } | null} [imagePart=null] - Optional base64-encoded image
 * @param {{ anonId?: string, forceGrounding?: boolean, persona?: string }} [options={}] - Optional request options
 * @returns {Promise<string>} The assistant's response text
 */
export async function generateAIResponse(userMessage, conversationHistory = [], imagePart = null, options = {}) {
  const startTime = Date.now();
  const client = getGeminiClient();

  const personaKey = options.persona || (options.anonId ? getPersona(options.anonId) : 'default');
  const personaConfig = PERSONAS[personaKey] || PERSONAS.default;
  let activeInstruction = options.systemInstruction || personaConfig.instruction || SYSTEM_INSTRUCTION;

  if (options.anonId) {
    const memory = getMemoryContext(options.anonId);
    if (memory) {
      activeInstruction += `\n\n${memory}`;
    }
    const workflows = getLearnedWorkflowContext(options.anonId);
    if (workflows) {
      activeInstruction += `\n\n${workflows}`;
    }
    const adaptiveContext = getConversationAdaptationContext(options.anonId, conversationHistory, userMessage);
    if (adaptiveContext) {
      activeInstruction += `\n\n${adaptiveContext}`;
    }
    const userLang = getUserLanguage(options.anonId);
    const langDirective = getLanguageInstruction(userLang);
    if (langDirective) {
      activeInstruction += `\n\n${langDirective}`;
    }
  }

  const shouldGround = searchGroundingEnabled || Boolean(options.forceGrounding);

  const userParts = [];
  if (imagePart && imagePart.data) {
    userParts.push({
      inlineData: {
        mimeType: imagePart.mimeType || 'image/jpeg',
        data: imagePart.data,
      },
    });
  } else if (imagePart && imagePart.fileUri) {
    userParts.push({
      fileData: {
        fileUri: imagePart.fileUri,
        mimeType: imagePart.mimeType || 'application/pdf',
      },
    });
  }

  const promptText =
    userMessage && userMessage.trim().length > 0
      ? userMessage.trim()
      : 'Analyze this image in detail. Identify any text, diagrams, code, questions, or problems, and provide a clear, comprehensive solution or explanation.';

  userParts.push({ text: promptText });

  // Construct context payload: prior turns + current user message/image
  const contents = [
    ...conversationHistory,
    {
      role: 'user',
      parts: userParts,
    },
  ];

  // Try active model first, then gracefully cascade through fallbacks if quota/overload occurs
  const candidateModels = getCandidateModels();

  let lastError = null;

  for (const modelToTry of candidateModels) {
    try {
      const runGeneration = async (enableSearch) => {
        const genConfig = {
          systemInstruction: activeInstruction,
          temperature: config.GEMINI_TEMPERATURE,
          maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
        };

        if (enableSearch) {
          genConfig.tools = [{ googleSearch: {} }];
        } else if (config.ENABLE_AI_TOOLS) {
          genConfig.tools = [{ functionDeclarations: toolDeclarations }];
        }

        const generatePromise = client.models.generateContent({
          model: modelToTry,
          contents,
          config: genConfig,
        });

        // Dynamic circuit breaker:
        // Multi-page PDFs, large documents, audio, and large prompts require generous time (45s).
        // Web search grounding and images require 20s. Standard short text cascades quickly (8s).
        const isDocumentOrLarge =
          Boolean(imagePart && (imagePart.mimeType === 'application/pdf' || imagePart.fileUri)) ||
          (userMessage && userMessage.length > 2500);

        const timeoutMs = isDocumentOrLarge ? 45000 : shouldGround || Boolean(imagePart) ? 20000 : 8000;

        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Timeout: ${modelToTry} did not respond within ${timeoutMs}ms`)),
            timeoutMs
          );
        });

        return Promise.race([generatePromise, timeoutPromise]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
      };

      let response;
      if (shouldGround) {
        try {
          response = await runGeneration(true);
        } catch (searchErr) {
          privacyLog('warn', 'GEMINI_SEARCH_GROUNDING_FAILED_RETRIEVING_WITHOUT', {
            model: modelToTry,
            error: searchErr?.message?.substring(0, 100),
          });
          response = await runGeneration(false);
        }
      } else {
        response = await runGeneration(false);
      }

      const latencyMs = Date.now() - startTime;
      let responseText = response.text ? response.text.trim() : '';

      // Handle Gemini Function/Tool Calls
      const candidate = response.candidates?.[0];
      const candidateParts = candidate?.content?.parts || [];
      const functionCalls = candidateParts.filter((p) => p.functionCall).map((p) => p.functionCall);

      if (functionCalls.length > 0 && config.ENABLE_AI_TOOLS) {
        const toolResponses = [];
        for (const call of functionCalls) {
          const toolResult = await executeToolCall(call.name, call.args, {
            anonId: options.anonId,
            from: options.from,
          });
          toolResponses.push({
            functionResponse: {
              name: call.name,
              response: toolResult,
            },
          });
        }

        const followUpContents = [
          ...contents,
          { role: 'model', parts: candidateParts },
          { role: 'user', parts: toolResponses },
        ];

        let followUpTimeoutId;
        const followUpTimeoutPromise = new Promise((_, reject) => {
          followUpTimeoutId = setTimeout(
            () => reject(new Error(`Timeout: ${modelToTry} tool follow-up did not respond within 20000ms`)),
            20000
          );
        });

        const followUpRes = await Promise.race([
          client.models.generateContent({
            model: modelToTry,
            contents: followUpContents,
            config: {
              systemInstruction: activeInstruction,
              temperature: config.GEMINI_TEMPERATURE,
              maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
            },
          }),
          followUpTimeoutPromise,
        ]).finally(() => {
          if (followUpTimeoutId) clearTimeout(followUpTimeoutId);
        });

        if (followUpRes.text) {
          responseText = followUpRes.text.trim();
        }
      }

      // Append search grounding sources if available
      if (candidate?.groundingMetadata) {
        const sourcesText = formatGroundingSources(candidate.groundingMetadata);
        if (sourcesText) {
          responseText += sourcesText;
        }
      }

      privacyLog('info', 'GEMINI_RESPONSE_GENERATED', {
        model: modelToTry,
        historyLength: conversationHistory.length,
        inputLength: userMessage.length,
        outputLength: responseText.length,
        latencyMs,
      });

      if (responseText) {
        return responseText;
      }
    } catch (error) {
      lastError = error;
      const errorMessage = error?.message || String(error);

      privacyLog('warn', 'GEMINI_MODEL_ATTEMPT_FAILED', {
        model: modelToTry,
        errorMessage: errorMessage.substring(0, 150).replace(/key=[^&\s]+/gi, 'key=REDACTED'),
      });
    }
  }

  const latencyMs = Date.now() - startTime;
  const errorMsg = lastError?.message || String(lastError || 'Unknown error');

  privacyLog('error', 'GEMINI_ALL_MODELS_FAILED', {
    attemptedModels: candidateModels,
    latencyMs,
  });

  if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
    return '⏳ *Rate Limit Notice:* Gemini API request limit reached. Please wait a minute before sending your next message.';
  }

  if (errorMsg.includes('quota') || errorMsg.includes('QUOTA_EXCEEDED')) {
    return '⚠️ *Quota Exceeded:* The Gemini API free quota has been temporarily reached. Please try again later or check your API limits at https://aistudio.google.com.';
  }

  return '⚠️ *Error:* Unable to generate an AI response right now. Please try again in a few moments.';
}

/**
 * Runs a lightweight test connection against the Gemini API to verify API key validity.
 * @returns {Promise<{ success: boolean, model: string, latencyMs: number, error?: string }>}
 */
export async function testGeminiConnection() {
  const start = Date.now();
  try {
    const client = getGeminiClient();
    const response = await client.models.generateContent({
      model: activeModel,
      contents: 'Ping: Reply with single word PONG',
    });

    const latencyMs = Date.now() - start;
    const reply = response.text ? response.text.trim() : '';
    const success = Boolean(reply && reply.length > 0);

    return {
      success,
      model: activeModel,
      latencyMs,
      reply,
    };
  } catch (err) {
    return {
      success: false,
      model: activeModel,
      latencyMs: Date.now() - start,
      error: (err.message || String(err)).replace(/key=[^&\s]+/gi, 'key=REDACTED'),
    };
  }
}

/**
 * Uses Gemini to enrich short image prompts with visual, lighting, and camera details for FLUX.1.
 *
 * @param {string} prompt - Raw user prompt
 * @returns {Promise<string>} Enhanced detailed prompt
 */
export async function enhanceImagePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return prompt;
  const trimmed = prompt.trim();
  // Don't expand if already very long or detailed (> 250 chars)
  if (trimmed.length > 250) return trimmed;

  try {
    const instruction = [
      'You are a professional generative AI prompt engineer for the FLUX.1 text-to-image model.',
      'Enrich the user input into a vivid, photorealistic, highly detailed image generation prompt (max 35 words).',
      'Focus on lighting, atmospheric mood, cinematic camera perspective, and artistic fidelity.',
      'Ensure the composition is pristine, watermark-free, with no logos, no text, and no captions.',
      'Preserve the core subject.',
      'Output ONLY the enhanced prompt string. Do NOT add conversational filler, markdown formatting, or quotes.',
    ].join(' ');

    const enhanced = await generateAIResponse(`Prompt: ${trimmed}`, [], null, {
      systemInstruction: instruction,
    });

    const cleaned = (enhanced || '').replace(/^["'`]|["'`]$/g, '').trim();
    if (
      cleaned.length > 5 &&
      !cleaned.toLowerCase().includes("i'm currently") &&
      !cleaned.toLowerCase().includes('cannot generate')
    ) {
      return cleaned;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Uses Gemini to enrich short video prompts with cinematic camera motion, lighting, and temporal visual cues.
 *
 * @param {string} prompt - Raw user video prompt
 * @param {string | null} [motion=null] - Optional motion preset (drone, pan, zoom, orbit)
 * @returns {Promise<string>} Enhanced video generation prompt
 */
export async function enhanceVideoPrompt(prompt, motion = null) {
  if (!prompt || typeof prompt !== 'string') return prompt;
  const trimmed = prompt.trim();
  if (trimmed.length > 250) return trimmed;

  try {
    const motionDirective = motion
      ? `Incorporate dynamic ${motion} camera movement.`
      : 'Describe fluid cinematic motion and dynamic scene progression.';
    const instruction = [
      'You are a professional generative AI video director and prompt engineer.',
      'Enrich the user input into a vivid, cinematic text-to-video prompt (max 30 words).',
      motionDirective,
      'Focus on temporal movement, cinematic lighting, realistic physics, and camera angle.',
      'Ensure the cinematography is pristine, watermark-free, with no logos, no text overlay, and no timestamps.',
      'Preserve the core subject.',
      'Output ONLY the enhanced video prompt string without quotes or conversational filler.',
    ].join(' ');

    const enhanced = await generateAIResponse(`Video Prompt: ${trimmed}`, [], null, {
      systemInstruction: instruction,
    });

    const cleaned = (enhanced || '').replace(/^["'`]|["'`]$/g, '').trim();
    if (
      cleaned.length > 5 &&
      !cleaned.toLowerCase().includes("i'm currently") &&
      !cleaned.toLowerCase().includes('cannot generate')
    ) {
      return cleaned;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Deterministic fallback storyboard builder when LLM is unavailable.
 * Generates 4 progressive chronological narrative prompts preserving subject and style.
 *
 * @param {string} rawPrompt
 * @param {string | null} [motion=null]
 * @returns {string[]} Exactly 4 progressive prompt strings
 */
export function buildFallbackStoryboard(rawPrompt, motion = null) {
  const base = (rawPrompt || 'Cinematic scene').trim();
  const motionPrefix = motion ? `${motion} camera motion, ` : '';
  const cleanSuffix =
    '8k, ultra-detailed, photorealistic, cinematic lighting, masterpiece, no watermarks, no text overlay';

  return [
    `Stage 1 (Opening): Establishing shot of ${base}, ${motionPrefix}initial calm posture, wide angle, ${cleanSuffix}`,
    `Stage 2 (Development): Dynamic motion starts, ${base} accelerates into motion, medium shot, shifting perspective, ${cleanSuffix}`,
    `Stage 3 (Climax): Full kinetic movement, dramatic angle, ${base} in active traversal, high velocity, ${cleanSuffix}`,
    `Stage 4 (Resolution): Grand cinematic conclusion, ${base} arriving at dramatic viewpoint, golden hour light, epic framing, ${cleanSuffix}`,
  ];
}

/**
 * Deconstructs a video prompt into a 4-stage chronological narrative storyboard
 * for genuine multi-keyframe AI video generation (10-15s sequence).
 *
 * @param {string} userPrompt - User prompt
 * @param {object} [options]
 * @param {string} [options.motion] - Optional motion preset
 * @returns {Promise<string[]>} Array of 4 progressive keyframe prompts
 */
export async function generateVideoStoryboard(userPrompt, options = {}) {
  const trimmed = (userPrompt || '').trim();
  if (!trimmed || options.mock || (config.NODE_ENV === 'test' && !options.allowLiveNetwork)) {
    return buildFallbackStoryboard(trimmed || 'A scenic cinematic view', options.motion);
  }

  try {
    const motionHint = options.motion ? `incorporating ${options.motion} motion` : 'with dynamic cinematic motion';
    const systemInstruction = [
      'You are a cinematic AI video director.',
      'Deconstruct the user prompt into a continuous 4-stage chronological narrative for a 12-second video,',
      motionHint + '.',
      'Maintain absolute temporal consistency: keep the exact same subject, art style, color palette, and lighting across all 4 stages.',
      'Stage 1 (t=0s): Initial scene establishment and posture.',
      'Stage 2 (t=3.5s): Action initiates, perspective begins panning or zooming.',
      'Stage 3 (t=7s): Peak kinetic motion or traversal.',
      'Stage 4 (t=11s): Climax and dramatic resolution framing.',
      'Ensure every stage includes: "photorealistic, cinematic lighting, 8k, no watermarks, no text".',
      'Return a valid JSON array of exactly 4 strings: ["stage 1 prompt", "stage 2 prompt", "stage 3 prompt", "stage 4 prompt"]. Output ONLY the JSON array without markdown formatting.',
    ].join(' ');

    const rawResponse = await generateAIResponse(`Video Prompt: "${trimmed}"`, [], null, {
      systemInstruction,
    });

    if (rawResponse) {
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length >= 4) {
          return parsed.slice(0, 4).map((s) => String(s).trim());
        }
      }
    }
  } catch (err) {
    privacyLog('warn', 'STORYBOARD_LLM_FALLBACK', { error: err.message });
  }

  return buildFallbackStoryboard(trimmed, options.motion);
}

/**
 * Generates a 4-stage narrative storyboard from an uploaded user image (Image-to-Video).
 * Uses Gemini Vision to analyze the image and project 3 chronological follow-up beats.
 *
 * @param {Buffer} imageBuffer - In-memory image buffer
 * @param {string} [caption=''] - User caption or instruction
 * @param {object} [options]
 * @returns {Promise<string[]>} Array of 4 progressive prompts
 */
export async function generateVideoStoryboardFromImage(imageBuffer, caption = '', options = {}) {
  const userCaption = (caption || '').trim();
  const fallback = buildFallbackStoryboard(userCaption || 'The subject in the image', options.motion);

  if (
    !imageBuffer ||
    !Buffer.isBuffer(imageBuffer) ||
    options.mock ||
    (config.NODE_ENV === 'test' && !options.allowLiveNetwork)
  ) {
    return fallback;
  }

  try {
    const systemInstruction = [
      'You are an expert film director specializing in Image-to-Video generation.',
      'Analyze the provided image and generate 3 consecutive follow-up narrative beats that logically animate what happens next over 12 seconds.',
      'Beat 1 is the existing image.',
      'Beat 2 (t=3.5s): Subject starts moving, slight angle shift.',
      'Beat 3 (t=7s): Main dynamic action, traversal, or camera pan.',
      'Beat 4 (t=11s): Climax and dramatic resolution.',
      'Preserve the exact visual identity, colors, background, and character details from the image.',
      'Return a valid JSON array of 3 strings for Beats 2, 3, and 4: ["beat 2", "beat 3", "beat 4"]. Output ONLY the JSON array.',
    ].join(' ');

    const promptText = userCaption
      ? `User animation instruction: "${userCaption}". Project what happens next.`
      : 'Project the natural 12-second cinematic continuation of this scene.';

    const rawResponse = await generateAIResponse(
      promptText,
      [],
      { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') },
      { systemInstruction }
    );

    if (rawResponse) {
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const beats = JSON.parse(jsonMatch[0]);
        if (Array.isArray(beats) && beats.length >= 3) {
          return [
            userCaption || 'Initial scene establishment matching reference image',
            String(beats[0]).trim(),
            String(beats[1]).trim(),
            String(beats[2]).trim(),
          ];
        }
      }
    }
  } catch (err) {
    privacyLog('warn', 'IMAGE_TO_VIDEO_STORYBOARD_FALLBACK', { error: err.message });
  }

  return fallback;
}

/**
 * Uploads an in-memory document/file buffer to Gemini Files API for large payloads (>20MB).
 *
 * @param {Buffer} buffer - In-memory file buffer
 * @param {string} mimeType - File MIME type
 * @param {string} [displayName='document'] - Friendly display name
 * @returns {Promise<{ uri: string, name: string, mimeType: string } | null>}
 */
export async function uploadGeminiFileInMemory(buffer, mimeType, displayName = 'document') {
  try {
    const client = getGeminiClient();
    const blob = new Blob([buffer], { type: mimeType });
    const uploadResult = await client.files.upload({
      file: blob,
      config: {
        mimeType,
        displayName: (displayName || 'document').substring(0, 50),
      },
    });

    return {
      uri: uploadResult.uri,
      name: uploadResult.name,
      mimeType: uploadResult.mimeType || mimeType,
    };
  } catch (err) {
    privacyLog('error', 'GEMINI_FILE_UPLOAD_FAILED', {
      error: (err.message || String(err)).replace(/key=[^&\s]+/gi, 'key=REDACTED'),
    });
    return null;
  }
}

/**
 * Deletes a file from Gemini Files API by resource name (e.g. "files/xyz").
 *
 * @param {string} name - The file resource name returned by uploadGeminiFileInMemory
 * @returns {Promise<boolean>}
 */
export async function deleteGeminiFile(name) {
  if (!name) return false;
  try {
    const client = getGeminiClient();
    await client.files.delete({ name });
    return true;
  } catch (err) {
    privacyLog('warn', 'GEMINI_FILE_DELETE_FAILED', {
      name,
      error: err.message,
    });
    return false;
  }
}
