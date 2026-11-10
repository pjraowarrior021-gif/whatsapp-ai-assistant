/**
 * Adaptive Conversational Refinement & Dynamic Continuity Engine
 * Analyzes conversational progression, user pacing, technical depth, active threads,
 * and feedback signals to dynamically improve and evolve AI replies across chat turns.
 */
import { store } from './store/index.js';
import { privacyLog } from './privacy.js';

// In-memory cache for fast synchronous access (< 0.5ms) during Gemini prompt composition
// Map<anonId, { topics: Map<string, number>, activeProject?: string, preferredPacing?: string, lastUpdated: number }>
const userProfileCache = new Map();

/**
 * Technical lexicon regex patterns
 */
const ADVANCED_TECH_REGEX =
  /\b(architecture|distributed|concurrency|mutex|deadlock|kubernetes|k8s|docker|kernel|memory leak|heap|profiler|ast|bytecode|microservices|cqrs|grpc|protobuf|luhn|hmac|sha256|idempotent|idempotency|event-driven|sharding)\b/i;

const INTERMEDIATE_TECH_REGEX =
  /\b(function|api|database|query|async|await|promise|component|route|endpoint|react|node|express|sql|nosql|crud|rest|git|commit|pr|branch|class|object|method|typescript|python|javascript)\b/i;

/**
 * Feedback signals regex patterns for instant real-time response calibration
 */
const FEEDBACK_SIGNALS = [
  {
    type: 'brevity',
    regex: /\b(too long|too verbose|tldr|tl;dr|make it shorter|be brief|shorter|summarize briefly|keep it brief)\b/i,
    directive: 'User requested shorter replies. Be ultra-concise; omit pleasantries; explain in under 3 sentences.',
  },
  {
    type: 'detail',
    regex: /\b(more detail|explain in depth|elaborate|deep dive|step by step|give more context|explain more)\b/i,
    directive: 'User requested expanded depth. Provide a thorough, comprehensive step-by-step breakdown.',
  },
  {
    type: 'code_only',
    regex: /\b(code only|just the code|no explanation|only code|syntax only)\b/i,
    directive:
      'User requested code only. Output solely the code snippet within markdown backticks; no introductory or concluding text.',
  },
  {
    type: 'no_bullets',
    regex: /\b(no bullets|no bullet points|plain text only|in paragraphs)\b/i,
    directive: 'User requested no bullets. Format as clean conversational prose paragraphs without bullet points.',
  },
  {
    type: 'eli5',
    regex: /\b(eli5|explain like i'm 5|simple terms|in plain english|simple words)\b/i,
    directive:
      'User requested simple terms. Explain in plain, everyday language without technical jargon or complex analogies.',
  },
];

/**
 * Active project regex patterns
 */
const PROJECT_GOAL_REGEX =
  /\b(?:i am|i'm|currently)\s+(?:working on|building|creating|developing|deploying|learning|studying)\s+([a-zA-Z0-9\s_-]{3,35}?)(?=[.,!?]|\s+(?:and|but|with|for|using|in)|$)/i;

/**
 * Retrieves the in-memory adaptive user profile synchronously.
 *
 * @param {string} anonId
 * @returns {{ topics: Array<{ name: string, count: number }>, activeProject: string | null, preferredPacing: string | null, lastUpdated: number }}
 */
export function getUserProfile(anonId) {
  if (!anonId) {
    return { topics: [], activeProject: null, preferredPacing: null, lastUpdated: 0 };
  }

  let entry = userProfileCache.get(anonId);
  if (!entry) {
    entry = { topics: new Map(), activeProject: null, preferredPacing: null, lastUpdated: Date.now() };
    userProfileCache.set(anonId, entry);
  }

  const topicList = Array.from(entry.topics.entries()).map(([name, count]) => ({ name, count }));
  return {
    topics: topicList,
    activeProject: entry.activeProject || null,
    preferredPacing: entry.preferredPacing || null,
    lastUpdated: entry.lastUpdated,
  };
}

/**
 * Loads user profile from store into in-memory cache on startup.
 *
 * @param {string} anonId
 */
export async function loadUserProfile(anonId) {
  if (!anonId || userProfileCache.has(anonId)) return;

  try {
    const raw = await store.get(`user:profile:${anonId}`);
    if (raw && typeof raw === 'object') {
      const topicMap = new Map();
      if (Array.isArray(raw.topics)) {
        raw.topics.forEach((t) => {
          if (t && t.name) topicMap.set(t.name, t.count || 1);
        });
      }
      userProfileCache.set(anonId, {
        topics: topicMap,
        activeProject: raw.activeProject || null,
        preferredPacing: raw.preferredPacing || null,
        lastUpdated: raw.lastUpdated || Date.now(),
      });
    }
  } catch (err) {
    privacyLog('debug', 'LOAD_USER_PROFILE_FAILED', { error: err.message });
  }
}

/**
 * Updates user profile and persists asynchronously.
 *
 * @param {string} anonId
 * @param {object} updates
 */
export async function updateUserProfile(anonId, updates = {}) {
  if (!anonId) return;

  let entry = userProfileCache.get(anonId);
  if (!entry) {
    entry = { topics: new Map(), activeProject: null, preferredPacing: null, lastUpdated: Date.now() };
    userProfileCache.set(anonId, entry);
  }

  if (updates.activeProject) {
    entry.activeProject = updates.activeProject;
  }
  if (updates.preferredPacing) {
    entry.preferredPacing = updates.preferredPacing;
  }
  if (Array.isArray(updates.topics)) {
    for (const topic of updates.topics) {
      const clean = String(topic).toLowerCase().trim();
      if (clean) {
        const count = entry.topics.get(clean) || 0;
        entry.topics.set(clean, count + 1);
      }
    }
  }

  entry.lastUpdated = Date.now();

  // Persist to store asynchronously
  try {
    const serializable = {
      topics: Array.from(entry.topics.entries()).map(([name, count]) => ({ name, count })),
      activeProject: entry.activeProject,
      preferredPacing: entry.preferredPacing,
      lastUpdated: entry.lastUpdated,
    };
    await store.set(`user:profile:${anonId}`, serializable);
  } catch (err) {
    privacyLog('debug', 'SAVE_USER_PROFILE_FAILED', { error: err.message });
  }
}

/**
 * Completely clears the adaptive user profile (used by /delete).
 *
 * @param {string} anonId
 */
export async function clearUserProfile(anonId) {
  if (!anonId) return;
  userProfileCache.delete(anonId);
  try {
    await store.del(`user:profile:${anonId}`);
  } catch (err) {
    privacyLog('debug', 'CLEAR_USER_PROFILE_FAILED', { error: err.message });
  }
}

/**
 * Computes user pacing by strictly filtering conversation history by role: 'user'.
 * Prevents contamination from lengthy model responses.
 *
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history
 * @param {string} currentMessage
 * @returns {'terse' | 'balanced' | 'detailed'}
 */
export function computeUserPacing(history = [], currentMessage = '') {
  const userTexts = history.filter((m) => m.role === 'user').flatMap((m) => (m.parts || []).map((p) => p.text || ''));

  if (currentMessage && typeof currentMessage === 'string') {
    userTexts.push(currentMessage);
  }

  if (userTexts.length === 0) return 'balanced';

  const totalWords = userTexts.reduce((acc, text) => {
    const words = text
      .trim()
      .split(/\s+/)
      .filter((w) => Boolean(w) && !w.startsWith('/'));
    return acc + words.length;
  }, 0);

  const avgWords = Math.round(totalWords / userTexts.length);

  if (avgWords < 8) return 'terse';
  if (avgWords <= 30) return 'balanced';
  return 'detailed';
}

/**
 * Detects technical sophistication level from user queries.
 *
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history
 * @param {string} currentMessage
 * @returns {'advanced' | 'intermediate' | 'foundational'}
 */
export function detectTechnicalLevel(history = [], currentMessage = '') {
  const combined = [
    ...history.filter((m) => m.role === 'user').flatMap((m) => (m.parts || []).map((p) => p.text || '')),
    currentMessage,
  ].join(' ');

  if (ADVANCED_TECH_REGEX.test(combined)) {
    return 'advanced';
  }
  if (INTERMEDIATE_TECH_REGEX.test(combined)) {
    return 'intermediate';
  }
  return 'foundational';
}

/**
 * Detects immediate feedback signals in the current user message.
 *
 * @param {string} currentMessage
 * @returns {string | null} Specific feedback directive or null
 */
export function detectFeedbackSignals(currentMessage = '') {
  if (!currentMessage || typeof currentMessage !== 'string') return null;
  const clean = currentMessage.trim();

  for (const signal of FEEDBACK_SIGNALS) {
    if (signal.regex.test(clean)) {
      return signal.directive;
    }
  }
  return null;
}

/**
 * Extracts any active project or goal discussed in the current message.
 *
 * @param {string} currentMessage
 * @returns {string | null}
 */
export function detectActiveProject(currentMessage = '') {
  if (!currentMessage || typeof currentMessage !== 'string') return null;
  const match = currentMessage.match(PROJECT_GOAL_REGEX);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Computes high-density, context-aware prompt guidance for Gemini based on conversation progression.
 * Executes purely in-memory (< 0.5ms) without asynchronous operations or network calls.
 *
 * @param {string} [anonId]
 * @param {Array<{role: string, parts: Array<{text: string}>}>} [history=[]]
 * @param {string} [currentMessage='']
 * @returns {string} Formatted adaptation context or empty string if no adaptation needed
 */
export function getConversationAdaptationContext(anonId, history = [], currentMessage = '') {
  if (!anonId) return '';

  const userTurnsCount = history.filter((m) => m.role === 'user').length + 1;
  const pacing = computeUserPacing(history, currentMessage);
  const technicalLevel = detectTechnicalLevel(history, currentMessage);
  const feedbackDirective = detectFeedbackSignals(currentMessage);
  let detectedProject = detectActiveProject(currentMessage);
  const profile = userProfileCache.get(anonId);

  // If not in current message, look back through user history to maintain continuity
  if (!detectedProject && (!profile || !profile.activeProject)) {
    const userHistory = history.filter((m) => m.role === 'user');
    for (let i = userHistory.length - 1; i >= 0; i--) {
      const text = (userHistory[i].parts || []).map((p) => p.text || '').join(' ');
      const p = detectActiveProject(text);
      if (p) {
        detectedProject = p;
        break;
      }
    }
  }

  // Update in-memory profile if a project goal is detected
  if (detectedProject && profile && !profile.activeProject) {
    profile.activeProject = detectedProject;
  }

  const activeProject = detectedProject || (profile ? profile.activeProject : null);

  // On Turn 1 without explicit feedback, active project, or technical context, return empty string (zero token overhead)
  if (userTurnsCount === 1 && !feedbackDirective && !activeProject && technicalLevel === 'foundational') {
    return '';
  }

  const lines = ['[CONVERSATIONAL CONTINUITY & DYNAMIC ADAPTATION]'];

  // 1. Turn Depth & Progression Guidance
  if (userTurnsCount <= 2) {
    lines.push(`• Conversation Stage: Initial (Turn ${userTurnsCount}) -> Provide clear, high-signal fundamentals.`);
  } else if (userTurnsCount <= 5) {
    lines.push(
      `• Conversation Stage: Developing (Turn ${userTurnsCount}) -> Build directly on prior turns; avoid repeating established facts; maintain momentum.`
    );
  } else {
    lines.push(
      `• Conversation Stage: Deep Dialogue (Turn ${userTurnsCount}) -> High-attunement mode: bypass pleasantries, reference previous context effortlessly, and maintain continuous working flow.`
    );
  }

  // 2. User Pacing Calibration
  if (pacing === 'terse') {
    lines.push('• Pacing Match: User prefers brevity -> Keep reply crisp, punchy, and direct (1-3 sentences max).');
  } else if (pacing === 'detailed') {
    lines.push(
      '• Pacing Match: User communicates with depth -> Provide comprehensive explanations with clear structural breakdown.'
    );
  }

  // 3. Technical Depth Calibration
  if (technicalLevel === 'advanced') {
    lines.push(
      '• Technical Calibration: Advanced -> Use exact architectural and engineering terminology without basic introductory explanations.'
    );
  } else if (technicalLevel === 'intermediate') {
    lines.push(
      '• Technical Calibration: Intermediate -> Balance clear practical examples with standard engineering concepts.'
    );
  }

  // 4. Active Project Context
  if (activeProject) {
    lines.push(
      `• Active Thread Context: User is working on "${activeProject}" -> Ground recommendations and examples in this context.`
    );
  }

  // 5. Immediate Feedback Directive (Highest Precedence)
  if (feedbackDirective) {
    lines.push(`• Immediate Feedback Directive: ${feedbackDirective}`);
  }

  return lines.join('\n');
}
