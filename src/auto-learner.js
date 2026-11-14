/**
 * Autonomous User Fact & Preference Learner
 * Automatically analyzes user replies to extract personal facts, preferences,
 * constraints, and corrections during natural conversational turns.
 */
import { addAutoMemoryFact, isAutoMemoryEnabled } from './memory.js';
import { recordUserInteraction } from './workflow-learner.js';
import { extractYouTubeVideoId } from './youtube.js';
import { isInstagramUrl } from './instagram.js';
import { extractUrl } from './web-scraper.js';
import { updateUserProfile, detectActiveProject } from './conversation-adapter.js';
import { processImageFollowUpFeedback } from './image-learner.js';
import { getKnowledgeGraph, ENTITY_TYPES } from './knowledge-graph.js';
import { privacyLog } from './privacy.js';
import { store } from './store/index.js';

/**
 * High-precision deterministic regular expressions for fast, 0ms fact extraction.
 * Rejects transient states, feelings, or third-party entities.
 */
const DETERMINISTIC_PATTERNS = [
  // 1. Preferred Name / Identity
  {
    category: 'identity_name',
    regex:
      /\b(?:my name is|call me|i go by)\s+([A-Za-z]{2,15}(?:\s+(?!and\b|or\b|but\b|who\b|with\b|for\b|at\b|i\b)[A-Za-z]{2,15})?)\b/i,
    transform: (match) => {
      const name = match[1].trim();
      // Exclude common false positives
      if (/^(sorry|tired|happy|busy|ready|trying|wondering|here|now|later)$/i.test(name)) return null;
      return `User prefers to be called ${name}`;
    },
    confidence: 0.98,
  },
  // 2. Residence / Location
  {
    category: 'location',
    regex:
      /\b(?:i live in|i am based in|i'm based in|i moved to)\s+([A-Za-z\s]{2,25}?)(?=\s+(?:last|this|recently|now|with|since|and|but|for|\.|$)|[.,!?]|$)/i,
    transform: (match) => {
      const city = match[1].trim();
      if (!city || /^(a cab|a rush|the office|traffic|bed|pain)$/i.test(city)) return null;
      return `User lives in ${city}`;
    },
    confidence: 0.95,
  },
  // 3. Dietary Preferences
  {
    category: 'diet',
    regex: /\b(?:i am|i'm)\s+(?:a\s+)?(vegetarian|vegan|eggetarian|pescatarian)\b/i,
    transform: (match) => `User is ${match[1].toLowerCase()}`,
    confidence: 0.98,
  },
  {
    category: 'diet',
    regex: /\bi don't eat meat\b/i,
    transform: () => 'User does not eat meat (vegetarian)',
    confidence: 0.98,
  },
  // 4. Allergies
  {
    category: 'allergy',
    regex: /\b(?:i am|i'm)\s+allergic to\s+([A-Za-z\s]{2,30})\b/i,
    transform: (match) => `User is allergic to ${match[1].trim()}`,
    confidence: 0.98,
  },
  // 5. Output Brevity & Style Constraints
  {
    category: 'output_brevity',
    regex: /\b(?:keep (?:your )?replies|be|reply)\s+(?:very )?(?:concise|short|brief)\b/i,
    transform: () => 'Prefers concise, brief replies without conversational fluff',
    confidence: 0.95,
  },
  {
    category: 'output_format',
    regex: /\b(?:always )?reply in bullet points\b/i,
    transform: () => 'Prefers structured bullet points for readability',
    confidence: 0.95,
  },
  {
    category: 'output_emoji',
    regex: /\b(?:no emojis|don't use emojis)\b/i,
    transform: () => 'Prefers responses without emojis',
    confidence: 0.95,
  },
  {
    category: 'preferred_code_lang',
    regex: /\b(?:always provide code in|code in)\s+(typescript|python|javascript|golang|go|rust|java|c\+\+)\b/i,
    transform: (match) => `Prefers code examples in ${match[1]}`,
    confidence: 0.95,
  },
  // 6. Professional Role
  {
    category: 'profession',
    regex:
      /\b(?:i work as an?|i am an?)\s+(software engineer|developer|designer|product manager|data scientist|doctor|lawyer|teacher|student|architect|researcher)\b/i,
    transform: (match) => `User works as a ${match[1].toLowerCase()}`,
    confidence: 0.95,
  },
  // 7. Active Project / Goal
  {
    category: 'project_goal',
    regex:
      /\b(?:i am|i'm|currently)\s+(?:working on|building|creating|developing|deploying|learning|studying)\s+([A-Za-z0-9\s_-]{3,35})(?=[.,!?]|\s+(?:and|but|with|for)|$)/i,
    transform: (match) => `User is currently working on ${match[1].trim()}`,
    confidence: 0.95,
  },
];

/**
 * Extracts high-confidence deterministic facts from a user's text message.
 *
 * @param {string} text
 * @returns {Array<{ category: string, fact: string, confidence: number }>}
 */
export function extractDeterministicFacts(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.trim();
  const results = [];

  for (const pattern of DETERMINISTIC_PATTERNS) {
    const match = clean.match(pattern.regex);
    if (match) {
      const fact = pattern.transform(match);
      if (fact) {
        results.push({
          category: pattern.category,
          fact,
          confidence: pattern.confidence,
        });
      }
    }
  }

  return results;
}

/**
 * Deterministic patterns for detecting explicit user corrections.
 */
export const USER_CORRECTION_PATTERNS = [
  {
    scope: 'tool',
    regex: /\b(?:no,?|not that,?|instead of \w+,?)\s*(?:use|run|switch to)\s+([A-Za-z0-9_-]+)/i,
    transform: (m) => `Use ${m[1].trim()} instead`,
  },
  {
    scope: 'format',
    regex: /\b(?:always|please always)\s+(?:format|format as|show as|output in|reply in)\s+([A-Za-z0-9\s_-]{3,40})/i,
    transform: (m) => `Always format as ${m[1].trim()}`,
  },
  {
    scope: 'format',
    regex: /\bnever\s+(?:use|format|include|show)\s+([A-Za-z0-9\s_-]{3,40})/i,
    transform: (m) => `Never use ${m[1].trim()}`,
  },
  {
    scope: 'general',
    regex: /\bprefer\s+([A-Za-z0-9\s_-]{3,30})\s+(?:over|instead of)\s+([A-Za-z0-9\s_-]{3,30})/i,
    transform: (m) => `Prefer ${m[1].trim()} over ${m[2].trim()}`,
  },
  {
    scope: 'general',
    regex: /\b(?:correction|actually),?\s+([A-Za-z0-9\s_-]{5,60})/i,
    transform: (m) => `Correction: ${m[1].trim()}`,
  },
];

/**
 * Extracts explicit user corrections and preference rules from chat input.
 * @param {string} text
 * @returns {Array<{ rule: string, scope: 'tool'|'format'|'general', confidence: number }>}
 */
export function extractUserCorrections(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.trim();
  const corrections = [];

  for (const item of USER_CORRECTION_PATTERNS) {
    const match = clean.match(item.regex);
    if (match) {
      const rule = item.transform(match);
      if (rule) {
        corrections.push({
          rule,
          scope: item.scope,
          confidence: 0.95,
        });
      }
    }
  }

  return corrections;
}

const PREF_TTL_SECONDS = 90 * 86400; // 90 days

/**
 * Persists a scoped user preference rule into Redis/Store.
 *
 * @param {string} anonId
 * @param {string} rule
 * @param {'tool'|'format'|'general'} [scope='general']
 * @returns {Promise<{ success: boolean, ruleId?: string }>}
 */
export async function addScopedUserPreference(anonId, rule, scope = 'general') {
  if (!anonId || !rule) return { success: false };
  const key = `user:preferences:${anonId}`;
  const existing = await getScopedUserPreferences(anonId);

  const cleanRule = String(rule).trim();
  const ruleId = `pref_${Date.now().toString(36)}`;

  // Deduplicate against identical existing rules
  if (existing.some((p) => p.rule.toLowerCase() === cleanRule.toLowerCase())) {
    return { success: true };
  }

  existing.push({
    id: ruleId,
    rule: cleanRule,
    scope,
    createdAt: Date.now(),
  });

  // Keep max 20 active preference rules
  if (existing.length > 20) {
    existing.shift();
  }

  await store.set(key, JSON.stringify(existing), PREF_TTL_SECONDS);
  privacyLog('info', 'USER_PREFERENCE_RULE_LEARNED', { user: anonId, scope });
  return { success: true, ruleId };
}

/**
 * Retrieves all active scoped preference rules for a user.
 * @param {string} anonId
 * @returns {Promise<Array<object>>}
 */
export async function getScopedUserPreferences(anonId) {
  if (!anonId) return [];
  const raw = await store.get(`user:preferences:${anonId}`);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Clears scoped preferences for an anonymized user.
 * @param {string} anonId
 */
export async function clearScopedUserPreferences(anonId) {
  if (anonId) {
    await store.del(`user:preferences:${anonId}`);
  }
}

/**
 * Classifies an incoming message into an interaction category for workflow learning.
 *
 * @param {string} text
 * @param {string} messageType
 * @returns {'youtube_video' | 'instagram_reel' | 'todo_action' | 'reminder_action' | 'code_query' | 'web_summary' | 'image_gen' | 'video_gen' | 'chat'}
 */
export function inferInteractionType(text, messageType) {
  if (messageType === 'image') return 'chat';

  const clean = String(text || '').trim();
  const foundUrl = extractUrl(clean);

  if (foundUrl) {
    if (extractYouTubeVideoId(foundUrl)) return 'youtube_video';
    if (isInstagramUrl(foundUrl)) return 'instagram_reel';
    return 'web_summary';
  }

  if (/^\/todo|\badd todo\b|\bto-do list\b/i.test(clean)) return 'todo_action';
  if (/^\/remind|\bremind me\b|\breminder\b/i.test(clean)) return 'reminder_action';
  if (/^\/(?:video|vid|animate|motion|reel)|\bgenerate video\b|\bmake a video\b|\banimate\b/i.test(clean)) {
    return 'video_gen';
  }
  if (/^\/image|\bgenerate image\b|\bdraw a\b|\bpicture of\b/i.test(clean)) return 'image_gen';
  if (
    /```|\berror\b|\bstack trace\b|\bfunction\b|\bconst \b|\bdef \b|\bclass \b|\bimport \b|\bcompile error\b/i.test(
      clean
    )
  ) {
    return 'code_query';
  }

  return 'chat';
}

/**
 * Executes post-response autonomous learning from a conversational turn.
 * Runs asynchronously after the WhatsApp message has already been dispatched to ensure 0ms user-facing latency.
 *
 * @param {object} params
 * @param {string} params.anonId
 * @param {string} params.userMessage
 * @param {string} params.assistantReply
 * @param {string} params.messageType
 * @returns {Promise<{ deterministicFactsLearned: number, interactionType: string }>}
 */
export async function autoLearnFromTurn({ anonId, userMessage, _assistantReply, messageType = 'text' }) {
  if (!anonId || !userMessage) {
    return { deterministicFactsLearned: 0, interactionType: 'chat' };
  }

  // 1. Classify & record workflow interaction
  const interactionType = inferInteractionType(userMessage, messageType);
  await recordUserInteraction(anonId, interactionType);

  // 1b. Self-improving image model feedback & critique evaluation
  try {
    processImageFollowUpFeedback(anonId, userMessage);
  } catch (imgFeedbackErr) {
    privacyLog('debug', 'AUTO_LEARN_IMAGE_FEEDBACK_FAILED', { error: imgFeedbackErr.message });
  }

  // 2. Check if auto memory learning is permitted for this user
  if (!isAutoMemoryEnabled(anonId)) {
    return { deterministicFactsLearned: 0, interactionType };
  }

  // 3. Fast Deterministic Fact Extraction
  const deterministicFacts = extractDeterministicFacts(userMessage);
  let learnedCount = 0;

  for (const item of deterministicFacts) {
    try {
      const res = await addAutoMemoryFact(anonId, item.fact, {
        category: item.category,
        confidence: item.confidence,
      });
      if (res && res.success) {
        learnedCount++;
      }
    } catch (err) {
      privacyLog('debug', 'AUTO_LEARN_FACT_SAVE_FAILED', { error: err.message });
    }
  }

  // 3b. User Correction & Preference Extraction
  try {
    const corrections = extractUserCorrections(userMessage);
    for (const corr of corrections) {
      await addScopedUserPreference(anonId, corr.rule, corr.scope);
    }
  } catch (corrErr) {
    privacyLog('debug', 'AUTO_LEARN_CORRECTION_FAILED', { error: corrErr.message });
  }

  // 4. Continuous Adaptive Profile Learning (Topics of Interest & Active Projects)
  try {
    const activeProject = detectActiveProject(userMessage);
    const topicMatches = userMessage.match(
      /\b(docker|kubernetes|k8s|aws|azure|gcp|react|nextjs|flutter|vue|node|express|fastapi|django|postgres|mongodb|redis|graphql|typescript|python|rust|golang|ai|llm|gemini|devops|security|crypto|fitness|finance)\b/gi
    );
    const uniqueTopics = topicMatches ? Array.from(new Set(topicMatches.map((t) => t.toLowerCase()))) : [];

    if (activeProject || uniqueTopics.length > 0) {
      await updateUserProfile(anonId, {
        activeProject: activeProject || undefined,
        topics: uniqueTopics,
      });

      // Synchronize active project and interest topics into Knowledge Graph
      try {
        const kg = getKnowledgeGraph(anonId);
        if (activeProject) {
          const projId = `proj:${activeProject.toLowerCase()}`;
          kg.addEntity({ id: projId, type: ENTITY_TYPES.PROJECT, name: activeProject });
          kg.addRelation({
            source: `user:${anonId}`,
            predicate: 'WORKS_ON',
            target: projId,
            category: 'project',
            provenance: 'inferred',
          });
        }
        for (const topic of uniqueTopics) {
          const topicId = `topic:${topic}`;
          kg.addEntity({ id: topicId, type: ENTITY_TYPES.TOPIC, name: topic });
          kg.addRelation({
            source: `user:${anonId}`,
            predicate: 'INTERESTED_IN',
            target: topicId,
            category: 'topic',
            provenance: 'inferred',
          });
        }
      } catch {
        // Fail-safe
      }
    }
  } catch (profErr) {
    privacyLog('debug', 'AUTO_LEARN_PROFILE_UPDATE_FAILED', { error: profErr.message });
  }

  return { deterministicFactsLearned: learnedCount, interactionType };
}
