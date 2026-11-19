/**
 * Group-scoped durable memory.
 *
 * Isolation is enforced structurally: every public method requires a group JID
 * and only ever touches `data.groups[jid]`. There is no API that can read two
 * groups at once, so cross-group leakage cannot happen by accident.
 */
import { JsonFileStore } from './persistent-store.js';
import { normalizeGroupJid } from './jid.js';
import crypto from 'node:crypto';

function emptyData() {
  return { version: 1, groups: {} };
}

function emptyGroup() {
  return {
    rules: [],
    facts: [],
    faqs: [],
    summaries: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export class GroupMemoryStore {
  /**
   * @param {{ filePath: string }} options
   */
  constructor({ filePath }) {
    this.file = new JsonFileStore(filePath, emptyData);
    this.initialized = false;
  }

  async init() {
    await this.file.init();
    await this.file.mutate((data) => {
      if (!data.groups || typeof data.groups !== 'object') data.groups = {};
      for (const jid of Object.keys(data.groups)) {
        if (!normalizeGroupJid(jid)) delete data.groups[jid];
      }
    });
    this.initialized = true;
    return this;
  }

  #jid(input) {
    const jid = normalizeGroupJid(input);
    if (!jid) throw new Error('Invalid group identifier');
    return jid;
  }

  #group(data, jid) {
    if (!data.groups[jid]) data.groups[jid] = emptyGroup();
    return data.groups[jid];
  }

  /**
   * @param {string} groupInput
   * @param {string[]} rules
   * @param {{ actor?: string }} [options]
   */
  async setRules(groupInput, rules, { actor = 'dashboard' } = {}) {
    const jid = this.#jid(groupInput);
    const cleaned = (Array.isArray(rules) ? rules : [])
      .map((r) => String(r).trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 50);
    return this.file.mutate((data) => {
      const group = this.#group(data, jid);
      group.rules = cleaned;
      group.updatedAt = new Date().toISOString();
      group.rulesUpdatedBy = String(actor).slice(0, 120);
      return structuredClone({ jid, rules: group.rules });
    });
  }

  /**
   * @param {string} groupInput
   * @param {{ text: string, category?: string, source?: string, addedBy?: string }} fact
   * @param {{ maxFacts?: number }} [options]
   */
  async addFact(groupInput, fact, { maxFacts = 200 } = {}) {
    const jid = this.#jid(groupInput);
    const text = String(fact?.text || '')
      .trim()
      .slice(0, 1000);
    if (!text) throw new Error('Fact text is required');
    return this.file.mutate((data) => {
      const group = this.#group(data, jid);
      const normalized = text.toLowerCase();
      const existing = group.facts.find((f) => f.text.toLowerCase() === normalized);
      if (existing) return structuredClone(existing);
      const entry = {
        id: `fact_${crypto.randomUUID()}`,
        text,
        category: String(fact.category || 'general').slice(0, 40),
        source: String(fact.source || 'manual').slice(0, 60),
        addedBy: String(fact.addedBy || 'dashboard').slice(0, 120),
        addedAt: new Date().toISOString(),
      };
      group.facts.push(entry);
      if (group.facts.length > maxFacts) group.facts.splice(0, group.facts.length - maxFacts);
      group.updatedAt = new Date().toISOString();
      return structuredClone(entry);
    });
  }

  /**
   * @param {string} groupInput
   * @param {{ question: string, answer: string, addedBy?: string }} faq
   */
  async addFaq(groupInput, faq) {
    const jid = this.#jid(groupInput);
    const question = String(faq?.question || '')
      .trim()
      .slice(0, 500);
    const answer = String(faq?.answer || '')
      .trim()
      .slice(0, 2000);
    if (!question || !answer) throw new Error('FAQ question and answer are required');
    return this.file.mutate((data) => {
      const group = this.#group(data, jid);
      const entry = {
        id: `faq_${crypto.randomUUID()}`,
        question,
        answer,
        addedBy: String(faq.addedBy || 'dashboard').slice(0, 120),
        addedAt: new Date().toISOString(),
      };
      group.faqs.push(entry);
      if (group.faqs.length > 500) group.faqs.splice(0, group.faqs.length - 500);
      group.updatedAt = new Date().toISOString();
      return structuredClone(entry);
    });
  }

  /**
   * @param {string} groupInput
   * @param {{ text: string, period?: string }} summary
   */
  async addSummary(groupInput, summary) {
    const jid = this.#jid(groupInput);
    const text = String(summary?.text || '')
      .trim()
      .slice(0, 8000);
    if (!text) throw new Error('Summary text is required');
    return this.file.mutate((data) => {
      const group = this.#group(data, jid);
      const entry = {
        id: `sum_${crypto.randomUUID()}`,
        text,
        period: String(summary.period || 'adhoc').slice(0, 40),
        createdAt: new Date().toISOString(),
      };
      group.summaries.push(entry);
      if (group.summaries.length > 100) group.summaries.splice(0, group.summaries.length - 100);
      group.updatedAt = new Date().toISOString();
      return structuredClone(entry);
    });
  }

  /**
   * @param {string} groupInput
   * @returns {object}
   */
  getGroupMemory(groupInput) {
    const jid = this.#jid(groupInput);
    const raw = this.file.data?.groups?.[jid];
    return raw ? structuredClone(raw) : emptyGroup();
  }

  /**
   * Keyword retrieval over this group's memory only.
   * @param {string} groupInput
   * @param {string} query
   * @param {{ limit?: number }} [options]
   * @returns {Array<{ type: string, text: string, score: number }>}
   */
  search(groupInput, query, { limit = 6 } = {}) {
    const jid = this.#jid(groupInput);
    const group = this.file.data?.groups?.[jid];
    if (!group) return [];
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const candidates = [];
    for (const rule of group.rules || []) candidates.push({ type: 'rule', text: rule });
    for (const faq of group.faqs || []) candidates.push({ type: 'faq', text: `Q: ${faq.question}\nA: ${faq.answer}` });
    for (const fact of group.facts || []) candidates.push({ type: 'fact', text: fact.text, category: fact.category });
    for (const summary of group.summaries || []) candidates.push({ type: 'summary', text: summary.text });

    const scored = candidates
      .map((c) => ({ ...c, score: overlapScore(terms, tokenize(c.text)) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 20)));

    return scored;
  }

  /**
   * @param {string} groupInput
   * @returns {string}
   */
  getContext(groupInput) {
    const memory = this.getGroupMemory(groupInput);
    const parts = [];
    if (memory.rules?.length) parts.push(`Group rules:\n${memory.rules.map((r) => `• ${r}`).join('\n')}`);
    if (memory.faqs?.length) {
      parts.push(
        `Known FAQs:\n${memory.faqs
          .slice(-10)
          .map((f) => `• Q: ${f.question}\n  A: ${f.answer}`)
          .join('\n')}`
      );
    }
    if (memory.facts?.length) {
      parts.push(`Remembered facts:\n${memory.facts.map((f) => `• ${f.text}`).join('\n')}`);
    }
    const latestSummary = memory.summaries?.[memory.summaries.length - 1];
    if (latestSummary) parts.push(`Previous conversation summary:\n${latestSummary.text}`);
    return parts.join('\n\n');
  }

  /**
   * @param {string} groupInput
   * @param {'facts'|'faqs'|'summaries'|'rules'} type
   * @param {string} id
   */
  async deleteItem(groupInput, type, id) {
    const jid = this.#jid(groupInput);
    return this.file.mutate((data) => {
      const group = this.#group(data, jid);
      const before = group[type]?.length || 0;
      if (type === 'rules') {
        if (id === '*') group.rules = [];
      } else if (Array.isArray(group[type])) {
        group[type] = group[type].filter((item) => item.id !== id);
      } else {
        throw new Error('Unknown memory type');
      }
      group.updatedAt = new Date().toISOString();
      return { removed: before - (group[type]?.length || 0) };
    });
  }

  /**
   * Deletes all stored group data for one group only.
   * @param {string} groupInput
   */
  async clear(groupInput) {
    const jid = this.#jid(groupInput);
    return this.file.mutate((data) => {
      const existed = Boolean(data.groups[jid]);
      delete data.groups[jid];
      return { cleared: existed };
    });
  }

  /**
   * Removes memory for groups that are no longer present in the activation
   * store (used by explicit admin cleanup, never automatically).
   * @param {string[]} activeJids
   */
  async pruneOrphans(activeJids) {
    const keep = new Set(activeJids.map((j) => normalizeGroupJid(j)).filter(Boolean));
    return this.file.mutate((data) => {
      let removed = 0;
      for (const jid of Object.keys(data.groups)) {
        if (!keep.has(jid)) {
          delete data.groups[jid];
          removed++;
        }
      }
      return { removed };
    });
  }
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 200);
}

function overlapScore(terms, docTerms) {
  if (docTerms.length === 0) return 0;
  const docSet = new Set(docTerms);
  let hits = 0;
  for (const term of new Set(terms)) {
    if (docSet.has(term)) hits++;
  }
  return hits / Math.sqrt(docTerms.length);
}
