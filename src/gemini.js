import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { privacyLog } from './privacy.js';
import { store } from './store/index.js';

let aiClient = null;
let activeModel = config.GEMINI_MODEL;
let searchGroundingEnabled = config.ENABLE_SEARCH_GROUNDING;

// In-Memory store for user persona preferences: Map<anonymizedUserId, string>
const userPersonas = new Map();

/**
 * WhatsApp-optimized System Instructions
 */
export const SYSTEM_INSTRUCTION = `You are a high-performing, private Personal AI Assistant on WhatsApp powered by Google Gemini.
Your core operating rules:
1. Provide concise, clear, and helpful answers optimized for quick mobile reading on WhatsApp.
2. Use WhatsApp formatting conventions:
   - *bold* for emphasis or titles
   - _italics_ for secondary notes or clarification
   - ~strikethrough~ where appropriate
   - \`\`\`code blocks\`\`\` for code or formatted data
   - Bulleted lists with emoji or hyphens for clean reading
   - Do NOT use HTML tags (e.g. <b>, <i>, <a>).
3. Be respectful, objective, and privacy-conscious:
   - NEVER request, verify, or store passwords, OTPs, UPI PINs, CVVs, or bank account credentials.
   - If a user mentions financial codes or credentials, remind them never to send sensitive credentials over messaging platforms.
4. If a user asks about privacy, data boundaries, or commands, remind them they can type /privacy or /help.
5. When analyzing images, diagrams, error messages, documents, or photos, inspect all visible details, transcribe relevant code or text, and provide fast, precise, and practical solutions.`;

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
  const activeInstruction = options.systemInstruction || personaConfig.instruction || SYSTEM_INSTRUCTION;
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
        }

        const generatePromise = client.models.generateContent({
          model: modelToTry,
          contents,
          config: genConfig,
        });

        // Dynamic circuit breaker:
        // Multi-page PDFs, large documents, audio, and large prompts require generous time (45s).
        // Web search grounding and images require 25s. Standard short text requires 15s.
        const isDocumentOrLarge =
          Boolean(imagePart && (imagePart.mimeType === 'application/pdf' || imagePart.fileUri)) ||
          (userMessage && userMessage.length > 2500);

        const timeoutMs = isDocumentOrLarge ? 45000 : shouldGround || Boolean(imagePart) ? 25000 : 15000;

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

      // Append search grounding sources if available
      const candidate = response.candidates?.[0];
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
