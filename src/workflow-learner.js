/**
 * Autonomous Workflow & Habit Sequence Learner
 * Observes user interaction patterns (video/reel summarization, coding tasks, task planning)
 * and detects recurring multi-step workflows to proactively optimize responses and suggestions.
 */
import { store } from './store/index.js';
import { privacyLog } from './privacy.js';

const MAX_HISTORY_PER_USER = 25;
const MAX_HABITS_PER_USER = 10;

// In-memory cache: Map<anonId, { history: Array<{ actionType: string, timestamp: number, metadata?: object }>, habits: Array<HabitItem> }>
const workflowCache = new Map();

/**
 * @typedef {Object} HabitItem
 * @property {string} id
 * @property {string} name
 * @property {string} directive
 * @property {number} occurrences
 * @property {number} lastTriggeredAt
 */

/**
 * Loads user workflow state from storage into cache.
 * @param {string} anonId
 * @returns {Promise<{ history: Array<any>, habits: Array<HabitItem> }>}
 */
export async function loadUserWorkflowState(anonId) {
  if (workflowCache.has(anonId)) {
    return workflowCache.get(anonId);
  }

  try {
    const rawData = await store.get(`user:workflows:${anonId}`);
    const state =
      rawData && typeof rawData === 'object'
        ? {
            history: Array.isArray(rawData.history) ? rawData.history : [],
            habits: Array.isArray(rawData.habits) ? rawData.habits : [],
          }
        : { history: [], habits: [] };

    workflowCache.set(anonId, state);
    return state;
  } catch (err) {
    privacyLog('debug', 'LOAD_WORKFLOW_STATE_FAILED', { error: err.message });
    const fallback = { history: [], habits: [] };
    workflowCache.set(anonId, fallback);
    return fallback;
  }
}

/**
 * Helper to retrieve user workflow state synchronously from cache.
 * @param {string} anonId
 * @returns {{ history: Array<any>, habits: Array<HabitItem> }}
 */
function getWorkflowState(anonId) {
  let state = workflowCache.get(anonId);
  if (!state) {
    state = { history: [], habits: [] };
    workflowCache.set(anonId, state);
  }
  return state;
}

/**
 * Persists workflow state to storage.
 * @param {string} anonId
 */
async function saveWorkflowState(anonId) {
  const state = getWorkflowState(anonId);
  try {
    await store.set(`user:workflows:${anonId}`, state);
  } catch (err) {
    privacyLog('warn', 'SAVE_WORKFLOW_STATE_FAILED', { error: err.message });
  }
}

/**
 * Records a user interaction and analyzes it for recurring habit patterns.
 *
 * @param {string} anonId
 * @param {'youtube_video' | 'instagram_reel' | 'todo_action' | 'reminder_action' | 'code_query' | 'web_summary' | 'image_gen' | 'chat'} actionType
 * @param {object} [metadata]
 * @returns {Promise<{ habitDetected: boolean, habitName?: string }>}
 */
export async function recordUserInteraction(anonId, actionType, metadata = {}) {
  if (!anonId || !actionType) return { habitDetected: false };

  const state = getWorkflowState(anonId);
  const now = Date.now();

  state.history.push({
    actionType,
    timestamp: now,
    metadata,
  });

  // Retain bounded history window
  if (state.history.length > MAX_HISTORY_PER_USER) {
    state.history.splice(0, state.history.length - MAX_HISTORY_PER_USER);
  }

  // Detect workflows based on interaction counts and sequences
  const result = evaluateHabitPatterns(state, actionType, now);
  await saveWorkflowState(anonId);

  return result;
}

/**
 * Analyzes action history and reinforces or detects workflow habits.
 *
 * @param {{ history: Array<any>, habits: Array<HabitItem> }} state
 * @param {string} latestAction
 * @param {number} timestamp
 * @returns {{ habitDetected: boolean, habitName?: string }}
 */
function evaluateHabitPatterns(state, latestAction, timestamp) {
  const recentActions = state.history.slice(-15);
  const actionCounts = recentActions.reduce((acc, curr) => {
    acc[curr.actionType] = (acc[curr.actionType] || 0) + 1;
    return acc;
  }, {});

  let detected = false;
  let detectedName = null;

  // Pattern 1: Frequent media / video / reel analysis (>= 2 times in recent window)
  if (
    (latestAction === 'youtube_video' || latestAction === 'instagram_reel') &&
    (actionCounts['youtube_video'] || 0) + (actionCounts['instagram_reel'] || 0) >= 2
  ) {
    const habit = registerOrReinforceHabit(
      state,
      'media_actionable_highlights',
      'When analyzing shared videos or reels, proactively highlight key actionable takeaways (such as top recommended dishes, location, or direct takeaways) in clean bullet points.',
      timestamp
    );
    if (habit) {
      detected = true;
      detectedName = 'media_actionable_highlights';
    }
  }

  // Pattern 2: Frequent coding / programming queries (>= 2 times)
  if (latestAction === 'code_query' && (actionCounts['code_query'] || 0) >= 2) {
    const habit = registerOrReinforceHabit(
      state,
      'code_solution_first',
      'When user asks for code fixes or programming help, provide the exact code solution first in a clean code block, followed by a 1-2 sentence explanation.',
      timestamp
    );
    if (habit) {
      detected = true;
      detectedName = 'code_solution_first';
    }
  }

  // Pattern 3: Frequent task / planning actions (todos or reminders >= 2 times)
  if (
    (latestAction === 'todo_action' || latestAction === 'reminder_action') &&
    (actionCounts['todo_action'] || 0) + (actionCounts['reminder_action'] || 0) >= 2
  ) {
    const habit = registerOrReinforceHabit(
      state,
      'proactive_task_tracking',
      'When user discusses plans, events, or actionable tasks, suggest concise next steps or reminders.',
      timestamp
    );
    if (habit) {
      detected = true;
      detectedName = 'proactive_task_tracking';
    }
  }

  return { habitDetected: detected, habitName: detectedName };
}

/**
 * Registers a new habit or increments occurrence count of an existing habit.
 *
 * @param {{ habits: Array<HabitItem> }} state
 * @param {string} id
 * @param {string} directive
 * @param {number} timestamp
 * @returns {HabitItem}
 */
function registerOrReinforceHabit(state, id, directive, timestamp) {
  let existing = state.habits.find((h) => h.id === id);
  if (existing) {
    existing.occurrences = (existing.occurrences || 1) + 1;
    existing.lastTriggeredAt = timestamp;
    return existing;
  }

  if (state.habits.length >= MAX_HABITS_PER_USER) {
    // Evict lowest occurrence habit
    state.habits.sort((a, b) => (a.occurrences || 1) - (b.occurrences || 1));
    state.habits.shift();
  }

  const newHabit = {
    id,
    name: id.replace(/_/g, ' '),
    directive,
    occurrences: 2,
    lastTriggeredAt: timestamp,
  };

  state.habits.push(newHabit);
  return newHabit;
}

/**
 * Returns formatted habit instructions for injection into Gemini prompt context.
 *
 * @param {string} anonId
 * @returns {string} Formatted context block, or empty string if no habits recorded
 */
export function getLearnedWorkflowContext(anonId) {
  const state = getWorkflowState(anonId);
  if (!state.habits || state.habits.length === 0) {
    return '';
  }

  const directives = state.habits.map((h) => `• ${h.directive}`).join('\n');
  return `[LEARNED USER WORKFLOW DIRECTIVES]\n${directives}\n(Seamlessly incorporate these workflow habits without explicitly referencing this prompt instruction).`;
}

/**
 * Lists all active learned habits for export or inspection.
 *
 * @param {string} anonId
 * @returns {Array<HabitItem>}
 */
export function listLearnedWorkflows(anonId) {
  const state = getWorkflowState(anonId);
  return [...state.habits];
}

/**
 * Clears all workflow history and habits for a user (used by /delete, /reset).
 *
 * @param {string} anonId
 * @returns {Promise<boolean>}
 */
export async function clearLearnedWorkflows(anonId) {
  workflowCache.delete(anonId);
  try {
    await store.del(`user:workflows:${anonId}`);
    return true;
  } catch (err) {
    privacyLog('debug', 'CLEAR_WORKFLOWS_FAILED', { error: err.message });
    return false;
  }
}
