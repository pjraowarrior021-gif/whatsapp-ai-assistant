/**
 * Long-Term Personal Memory Module
 * Stores user-specified biographical preferences and contextual facts,
 * injecting them into Gemini's system instructions for persistent personalization.
 */
import crypto from 'crypto';
import { store } from './store/index.js';
import { privacyLog } from './privacy.js';

const MAX_FACTS_PER_USER = 15;
const MAX_FACT_LENGTH = 300;

// Memory cache: Map<anonId, { enabled: boolean, facts: Array<{ id: string, text: string, createdAt: number }> }>
const userMemoryCache = new Map();

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

    const facts = Array.isArray(rawFacts) ? rawFacts : [];
    const enabled = rawEnabled !== false && rawEnabled !== 'false';

    const entry = { enabled, facts };
    userMemoryCache.set(anonId, entry);
    return entry;
  } catch (err) {
    privacyLog('debug', 'LOAD_USER_MEMORY_FAILED', { error: err.message });
    const fallback = { enabled: true, facts: [] };
    userMemoryCache.set(anonId, fallback);
    return fallback;
  }
}

/**
 * Gets cached memory entry for user.
 * @param {string} anonId
 * @returns {{ enabled: boolean, facts: Array<{ id: string, text: string, createdAt: number }> }}
 */
function getMemoryEntry(anonId) {
  let entry = userMemoryCache.get(anonId);
  if (!entry) {
    entry = { enabled: true, facts: [] };
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
  } catch (err) {
    privacyLog('warn', 'SAVE_USER_MEMORY_FAILED', { error: err.message });
  }
}

/**
 * Adds a new fact to user's memory.
 * @param {string} anonId
 * @param {string} factText
 * @returns {Promise<{ success: boolean, message: string, id?: string }>}
 */
export async function addMemoryFact(anonId, factText) {
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
  if (entry.facts.length >= MAX_FACTS_PER_USER) {
    return {
      success: false,
      message: `⚠️ *Memory Full:* You have saved the maximum of ${MAX_FACTS_PER_USER} facts. Remove old ones with \`/memory delete <id>\`.`,
    };
  }

  const id = crypto.randomBytes(2).toString('hex');
  const factItem = {
    id,
    text: clean,
    createdAt: Date.now(),
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
 * Lists all memory facts for user.
 * @param {string} anonId
 * @returns {string}
 */
export function listMemoryFacts(anonId) {
  const entry = getMemoryEntry(anonId);
  const status = entry.enabled ? '🟢 *Active*' : '⏸️ *Paused*';

  if (entry.facts.length === 0) {
    return [
      '🧠 *Personal Memory:*',
      `Status: ${status}`,
      '',
      'You have no saved facts yet.',
      'Teach the assistant things about you using:',
      '• `/memory add <fact>`',
      '• _Example:_ `/memory add I live in Bangalore and work as a software engineer`',
      '• _Example:_ `/memory add Always provide code examples in TypeScript`',
    ].join('\n');
  }

  const lines = ['🧠 *Your Saved Facts & Preferences:*', `Status: ${status}`, ''];
  entry.facts.forEach((f, i) => {
    lines.push(`${i + 1}. \`[${f.id}]\` ${f.text}`);
  });

  lines.push('');
  lines.push('_To add:_ `/memory add <fact>`');
  lines.push('_To remove:_ `/memory delete <id>`');
  lines.push('_To clear all:_ `/memory clear`');
  lines.push('_To toggle:_ `/memory on` | `/memory off`');

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

  const factsList = entry.facts.map((f) => `- ${f.text}`).join('\n');
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
