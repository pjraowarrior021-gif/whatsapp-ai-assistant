/**
 * Per-group rolling conversation context and anti-loop reply guards.
 *
 * Conversation history is deliberately RAM-only and bounded, matching the
 * project's privacy posture. Durable memory lives in GroupMemoryStore and must
 * be explicitly curated.
 */
import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class ConversationStore {
  /**
   * @param {{ ttlMs?: number, maxMessages?: number }} [options]
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, maxMessages = 40 } = {}) {
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.groups = new Map(); // jid -> state
  }

  #state(jid, now = Date.now()) {
    let state = this.groups.get(jid);
    if (!state) {
      state = {
        turns: [],
        replies: [],
        lastReplyAt: 0,
        lastReplyHash: '',
        botTurnsSinceHuman: 0,
        updatedAt: now,
      };
      this.groups.set(jid, state);
    }
    if (now - state.updatedAt > this.ttlMs) {
      state.turns = [];
      state.replies = [];
      state.lastReplyAt = 0;
      state.botTurnsSinceHuman = 0;
      state.updatedAt = now;
    }
    return state;
  }

  /**
   * @param {string} jid
   * @param {{ role: 'user'|'assistant', text: string, senderJid?: string, messageId?: string }} turn
   */
  addTurn(jid, turn, now = Date.now()) {
    if (!jid || !turn || !turn.text) return;
    const state = this.#state(jid, now);
    state.turns.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      text: String(turn.text).slice(0, 4000),
      senderJid: turn.senderJid ? String(turn.senderJid).slice(0, 120) : '',
      messageId: turn.messageId ? String(turn.messageId).slice(0, 200) : '',
      at: now,
    });
    if (state.turns.length > this.maxMessages) {
      state.turns.splice(0, state.turns.length - this.maxMessages);
    }
    state.botTurnsSinceHuman = turn.role === 'assistant' ? state.botTurnsSinceHuman + 1 : 0;
    state.updatedAt = now;
  }

  /**
   * @param {string} jid
   * @returns {Array<object>}
   */
  getTurns(jid, now = Date.now()) {
    const state = this.groups.get(jid);
    if (!state) return [];
    if (now - state.updatedAt > this.ttlMs) {
      this.groups.delete(jid);
      return [];
    }
    return state.turns.map((t) => ({ ...t }));
  }

  clear(jid) {
    this.groups.delete(jid);
  }

  clearAll() {
    this.groups.clear();
  }

  /**
   * Decides whether the bot may speak now. This is a safety guard, not a
   * trigger check.
   * @param {string} jid
   * @param {{ replyCooldownMs?: number, maxRepliesPerHour?: number }} settings
   * @returns {{ allowed: boolean, reason: string }}
   */
  canReply(jid, settings = {}, now = Date.now()) {
    const state = this.#state(jid, now);
    const cooldown = Number(settings.replyCooldownMs) || 0;
    if (cooldown > 0 && now - state.lastReplyAt < cooldown) {
      return { allowed: false, reason: 'cooldown' };
    }

    const hourAgo = now - 60 * 60 * 1000;
    state.replies = state.replies.filter((r) => (typeof r === 'number' ? r : r.at) > hourAgo);
    const maxPerHour = Number(settings.maxRepliesPerHour) || 30;
    if (state.replies.length >= maxPerHour) {
      return { allowed: false, reason: 'hourly_cap' };
    }

    // Hard stop on runaway loops: three consecutive bot turns with no human
    // message between them.
    if (state.botTurnsSinceHuman >= 3) {
      return { allowed: false, reason: 'loop_guard' };
    }

    return { allowed: true, reason: 'ok' };
  }

  /**
   * @param {string} jid
   * @param {string} text
   * @returns {{ duplicate: boolean, hash: string }}
   */
  recordReply(jid, text, now = Date.now()) {
    const state = this.#state(jid, now);
    const hash = hashText(text);
    const duplicate = state.replies.some((r) => r.hash === hash) || state.lastReplyHash === hash;
    state.lastReplyAt = now;
    state.lastReplyHash = hash;
    state.replies.push({ hash, at: now });
    if (state.replies.length > 100) state.replies = state.replies.slice(-100);
    state.updatedAt = now;
    return { duplicate, hash };
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(
      String(text || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
    )
    .digest('hex');
}
