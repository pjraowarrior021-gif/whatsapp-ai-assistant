/**
 * Long-Term Personal Memory & Autonomous Learning Module
 * Stores user-specified biographical preferences and contextual facts,
 * alongside autonomously learned habits, injecting them into Gemini's
 * system instructions for persistent, humanized personalization.
 */
import crypto from 'crypto';
import { store } from './store/index.js';
import { privacyLog } from './privacy.js';

const MAX_MANUAL_FACTS_PER_USER = 15;
const MAX_AUTO_FACTS_PER_USER = 15;
const MAX_FACT_LENGTH = 300;

// Memory cache: Map<anonId, { enabled: boolean, autoEnabled: boolean, facts: Array<FactItem> }>
const userMemoryCache = new Map();

/**
 * @typedef {Object} FactItem
 * @property {string} id
 * @property {string} text
 * @property {number} createdAt
 * @property {number} [updatedAt]
 * @property {'manual' | 'auto'} [origin]
 * @property {string} [category]
 * @property {number} [confidence]
 */

/**
 * Loads user memory state from storage into in-memory cache.
 * @param {string} anonId
 */
export async function loadUserMemory(anonId) {
  if (userMemoryCache.has(anonId)) {
    return userMemoryCache.get(anonId);
  }

  try {
    const rawFacts = await store.get(`user:memory:${anonId}`);
    const rawEnabled = await store.get(`user:memory_enabled:${anonId}`);
    const rawAutoEnabled = await store.get(`user:memory_auto_enabled:${anonId}`);

    const facts = Array.isArray(rawFacts) ? rawFacts : [];
    const enabled = rawEnabled !== false && rawEnabled !== 'false';
    const autoEnabled = rawAutoEnabled !== false && rawAutoEnabled !== 'false';

    const entry = { enabled, autoEnabled, facts };
    userMemoryCache.set(anonId, entry);
    return entry;
  } catch (err) {
    privacyLog('debug', 'LOAD_USER_MEMORY_FAILED', { error: err.message });
    const fallback = { enabled: true, autoEnabled: true, facts: [] };
    userMemoryCache.set(anonId, fallback);
    return fallback;
  }
}

/**
 * Gets cached memory entry for user.
 * @param {string} anonId
 * @returns {{ enabled: boolean, autoEnabled: boolean, facts: Array<FactItem> }}
 */
function getMemoryEntry(anonId) {
  let entry = userMemoryCache.get(anonId);
  if (!entry) {
    entry = { enabled: true, autoEnabled: true, facts: [] };
    userMemoryCache.set(anonId, entry);
  }
  return entry;
}

/**
 * Saves user memory to store.
 * @param {string} anonId
 */
async function saveUserMemory(anonId) {
  const entry = getMemoryEntry(anonId);
  try {
    await store.set(`user:memory:${anonId}`, entry.facts);
    await store.set(`user:memory_enabled:${anonId}`, entry.enabled);
    await store.set(`user:memory_auto_enabled:${anonId}`, entry.autoEnabled);
  } catch (err) {
    privacyLog('warn', 'SAVE_USER_MEMORY_FAILED', { error: err.message });
  }
}

/**
 * Adds a new explicit fact to user's memory (manual origin).
 *
 * @param {string} anonId
 * @param {string} factText
 * @param {object} [options]
 * @returns {Promise<{ success: boolean, message: string, id?: string }>}
 */
export async function addMemoryFact(anonId, factText, options = {}) {
  const clean = String(factText || '')
    .trim()
    .substring(0, MAX_FACT_LENGTH);
  if (!clean) {
    return {
      success: false,
      message: '⚠️ *Usage:* `/memory add <fact>` (e.g. `/memory add I prefer concise bullet-point replies`)',
    };
  }

  const entry = getMemoryEntry(anonId);
  const manualCount = entry.facts.filter((f) => f.origin !== 'auto').length;
  if (manualCount >= MAX_MANUAL_FACTS_PER_USER) {
    return {
      success: false,
      message: `⚠️ *Memory Full:* You have saved the maximum of ${MAX_MANUAL_FACTS_PER_USER} facts. Remove old ones with \`/memory delete <id>\`.`,
    };
  }

  const id = crypto.randomBytes(2).toString('hex');
  const factItem = {
    id,
    text: clean,
    createdAt: Date.now(),
    origin: options.origin || 'manual',
    category: options.category || 'general',
    confidence: options.confidence ?? 1.0,
  };

  entry.facts.push(factItem);
  await saveUserMemory(anonId);
  privacyLog('info', 'MEMORY_FACT_ADDED', { user: anonId, id });

  return {
    success: true,
    id,
    message: `🧠 *Memory Saved:*\n• *ID:* \`${id}\`\n• *Fact:* "${clean}"\n\n_The assistant will keep this in mind during conversations._`,
  };
}

/**
 * Autonomously adds or updates a learned fact with contradiction resolution.
 *
 * @param {string} anonId
 * @param {string} factText
 * @param {object} options
 * @param {string} options.category
 * @param {number} [options.confidence=0.9]
 * @returns {Promise<{ success: boolean, id?: string, updated?: boolean, reason?: string }>}
 */
export async function addAutoMemoryFact(anonId, factText, options = {}) {
  const clean = String(factText || '')
    .trim()
    .substring(0, MAX_FACT_LENGTH);
  if (!clean) return { success: false, reason: 'empty_text' };

  const entry = getMemoryEntry(anonId);
  if (entry.autoEnabled === false || entry.enabled === false) {
    return { success: false, reason: 'auto_learning_disabled' };
  }

  const category = options.category || 'general';
  const confidence = options.confidence ?? 0.9;

  // 1. Contradiction Resolution / In-Place Update:
  // If we already have an auto-learned fact for this specific category (e.g. location, name, diet),
  // update the existing fact rather than adding a contradictory or duplicate entry.
  if (category !== 'general') {
    const existingIdx = entry.facts.findIndex((f) => f.origin === 'auto' && f.category === category);
    if (existingIdx !== -1) {
      const existing = entry.facts[existingIdx];
      existing.text = clean;
      existing.confidence = confidence;
      existing.updatedAt = Date.now();
      await saveUserMemory(anonId);
      privacyLog('info', 'MEMORY_AUTO_FACT_UPDATED', { user: anonId, category, id: existing.id });
      return { success: true, id: existing.id, updated: true };
    }
  }

  // 2. FIFO Eviction if auto-facts capacity is reached
  const autoFacts = entry.facts.filter((f) => f.origin === 'auto');
  if (autoFacts.length >= MAX_AUTO_FACTS_PER_USER) {
    const oldest = autoFacts.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    if (oldest) {
      const idx = entry.facts.findIndex((f) => f.id === oldest.id);
      if (idx !== -1) {
        entry.facts.splice(idx, 1);
      }
    }
  }

  const id = crypto.randomBytes(2).toString('hex');
  const factItem = {
    id,
    text: clean,
    createdAt: Date.now(),
    origin: 'auto',
    category,
    confidence,
  };

  entry.facts.push(factItem);
  await saveUserMemory(anonId);
  privacyLog('info', 'MEMORY_AUTO_FACT_LEARNED', { user: anonId, id, category });

  return { success: true, id, created: true };
}

/**
 * Removes a memory fact by ID.
 * @param {string} anonId
 * @param {string} factId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function deleteMemoryFact(anonId, factId) {
  const cleanId = String(factId || '')
    .trim()
    .toLowerCase();
  const entry = getMemoryEntry(anonId);

  const idx = entry.facts.findIndex((f) => f.id === cleanId);
  if (idx === -1) {
    return {
      success: false,
      message: `⚠️ *Not Found:* No memory fact found with ID \`${cleanId}\`. Type \`/memory\` to list all.`,
    };
  }

  const removed = entry.facts.splice(idx, 1)[0];
  await saveUserMemory(anonId);
  privacyLog('info', 'MEMORY_FACT_DELETED', { user: anonId, id: cleanId });

  return {
    success: true,
    message: `🗑️ *Memory Deleted:*\nRemoved: "${removed.text}"`,
  };
}

/**
 * Clears all memory facts for a user.
 * @param {string} anonId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function clearUserMemory(anonId) {
  const entry = getMemoryEntry(anonId);
  const count = entry.facts.length;
  entry.facts = [];
  await saveUserMemory(anonId);
  privacyLog('info', 'MEMORY_CLEARED', { user: anonId, count });

  return {
    success: true,
    message: `🧹 *Memory Cleared:* Removed ${count} saved fact(s).`,
  };
}

/**
 * Sets memory enabled state.
 * @param {string} anonId
 * @param {boolean} enabled
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function setMemoryEnabled(anonId, enabled) {
  const entry = getMemoryEntry(anonId);
  entry.enabled = Boolean(enabled);
  await saveUserMemory(anonId);
  privacyLog('info', 'MEMORY_TOGGLED', { user: anonId, enabled: entry.enabled });

  return {
    success: true,
    message: entry.enabled
      ? '🧠 *Long-Term Memory Enabled:* Saved facts will be remembered in future conversations.'
      : '⏸️ *Long-Term Memory Paused:* Saved facts will temporarily NOT be included in prompts.',
  };
}

/**
 * Sets autonomous memory learning enabled state.
 * @param {string} anonId
 * @param {boolean} enabled
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function setAutoMemoryEnabled(anonId, enabled) {
  const entry = getMemoryEntry(anonId);
  entry.autoEnabled = Boolean(enabled);
  await saveUserMemory(anonId);
  privacyLog('info', 'MEMORY_AUTO_TOGGLED', { user: anonId, autoEnabled: entry.autoEnabled });

  return {
    success: true,
    message: entry.autoEnabled
      ? '🤖 *Autonomous Learning Enabled:* The assistant will automatically adapt to your preferences and workflow.'
      : '⏸️ *Autonomous Learning Paused:* The assistant will only remember facts you manually add via `/memory add`.',
  };
}

/**
 * Checks if auto-learning is enabled for user.
 * @param {string} anonId
 * @returns {boolean}
 */
export function isAutoMemoryEnabled(anonId) {
  const entry = getMemoryEntry(anonId);
  return entry.enabled && entry.autoEnabled !== false;
}

/**
 * Lists all memory facts for user.
 * @param {string} anonId
 * @returns {string}
 */
export function listMemoryFacts(anonId) {
  const entry = getMemoryEntry(anonId);
  const status = entry.enabled ? '🟢 *Active*' : '⏸️ *Paused*';
  const autoStatus = entry.autoEnabled !== false ? '🟢 *Active*' : '⏸️ *Paused*';

  const manualFacts = entry.facts.filter((f) => f.origin !== 'auto');
  const autoFacts = entry.facts.filter((f) => f.origin === 'auto');

  if (entry.facts.length === 0) {
    return [
      '🧠 *Personal Memory:*',
      `• *Status:* ${status}`,
      `• *Auto-Learning:* ${autoStatus}`,
      '',
      'You have no saved facts yet.',
      'Teach the assistant things about you using:',
      '• `/memory add <fact>`',
      '• _Example:_ `/memory add I live in Bangalore and work as a software engineer`',
      '• Or simply converse naturally—the assistant learns your preferences automatically!',
    ].join('\n');
  }

  const lines = ['🧠 *Personal Memory & Preferences:*', `• *Status:* ${status} | *Auto-Learning:* ${autoStatus}`, ''];

  if (manualFacts.length > 0) {
    lines.push('📌 *Your Saved Facts:*');
    manualFacts.forEach((f, i) => {
      lines.push(`${i + 1}. \`[${f.id}]\` ${f.text}`);
    });
    lines.push('');
  }

  if (autoFacts.length > 0) {
    lines.push('💡 *Learned Preferences & Habits:*');
    autoFacts.forEach((f, i) => {
      lines.push(`${i + 1}. \`[${f.id}]\` ${f.text}`);
    });
    lines.push('');
  }

  lines.push('_To add:_ `/memory add <fact>`');
  lines.push('_To remove:_ `/memory delete <id>`');
  lines.push('_To clear all:_ `/memory clear`');
  lines.push('_To toggle:_ `/memory on` | `/memory off`');
  lines.push('_To toggle auto-learning:_ `/memory auto on` | `/memory auto off`');

  return lines.join('\n');
}

/**
 * Formats user facts for injection into Gemini system instruction.
 * @param {string} anonId
 * @returns {string}
 */
export function getMemoryContext(anonId) {
  const entry = getMemoryEntry(anonId);
  if (!entry.enabled || entry.facts.length === 0) {
    return '';
  }

  // Sanitize and filter any potential injection attempts
  const safeFacts = entry.facts
    .map((f) => f.text.replace(/[\r\n]+/g, ' ').trim())
    .filter((text) => !/^(?:system|instruction|admin):/i.test(text));

  if (safeFacts.length === 0) return '';

  const factsList = safeFacts.map((t) => `- ${t}`).join('\n');
  return `User Profile & Known Context (Personal Memory):\n${factsList}\n`;
}

/**
 * Handles `/memory` command routing.
 * @param {string} anonId
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function handleMemoryCommand(anonId, text) {
  const trimmed = String(text || '').trim();
  const parts = trimmed.split(/\s+/);
  const action = (parts[1] || '').toLowerCase();
  const rest = parts.slice(2).join(' ');

  if (!action || action === 'list') {
    return listMemoryFacts(anonId);
  }
  if (action === 'on') {
    const res = await setMemoryEnabled(anonId, true);
    return res.message;
  }
  if (action === 'off') {
    const res = await setMemoryEnabled(anonId, false);
    return res.message;
  }
  if (action === 'auto') {
    const sub = (parts[2] || '').toLowerCase();
    if (sub === 'off') {
      const res = await setAutoMemoryEnabled(anonId, false);
      return res.message;
    }
    const res = await setAutoMemoryEnabled(anonId, true);
    return res.message;
  }
  if (action === 'clear' || action === 'reset') {
    const res = await clearUserMemory(anonId);
    return res.message;
  }
  if (action === 'add' || action === 'remember') {
    const res = await addMemoryFact(anonId, rest);
    return res.message;
  }
  if (action === 'delete' || action === 'remove' || action === 'del') {
    const res = await deleteMemoryFact(anonId, rest);
    return res.message;
  }

  // If user just typed `/memory <some fact>` directly
  const directFact = parts.slice(1).join(' ');
  const res = await addMemoryFact(anonId, directFact);
  return res.message;
}
