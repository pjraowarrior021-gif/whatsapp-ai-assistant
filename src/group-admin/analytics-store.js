/**
 * Per-group, per-day counters used by the dashboard and daily/weekly reports.
 */
import { JsonFileStore } from './persistent-store.js';
import { normalizeGroupJid } from './jid.js';

const COUNTER_KEYS = new Set([
  'messagesSeen',
  'aiReplies',
  'moderationEvents',
  'warnings',
  'escalations',
  'memberJoins',
  'summaries',
  'reports',
  'promptTokens',
  'completionTokens',
  'costMicroUsd',
]);

function emptyData() {
  return { version: 1, days: {} };
}

export class AnalyticsStore {
  /**
   * @param {{ filePath: string, retentionDays?: number, clock?: () => number }} options
   */
  constructor({ filePath, retentionDays = 90, clock = () => Date.now() } = {}) {
    this.file = new JsonFileStore(filePath, emptyData);
    this.retentionDays = retentionDays;
    this.clock = clock;
    this.initialized = false;
  }

  async init() {
    await this.file.init();
    await this.file.mutate((data) => {
      if (!data.days || typeof data.days !== 'object') data.days = {};
      this.#prune(data);
    });
    this.initialized = true;
    return this;
  }

  /**
   * @param {string} groupInput
   * @param {string} key
   * @param {number} [amount]
   * @param {{ date?: string }} [options]
   */
  async record(groupInput, key, amount = 1, { date } = {}) {
    const jid = normalizeGroupJid(groupInput);
    if (!jid) throw new Error('Invalid group identifier');
    if (!COUNTER_KEYS.has(key)) throw new Error(`Unknown counter: ${key}`);
    const day = date || new Date(this.clock()).toISOString().slice(0, 10);

    return this.file.mutate((data) => {
      if (!data.days[day]) data.days[day] = { groups: {}, totals: {} };
      const bucket = data.days[day];
      if (!bucket.groups[jid]) bucket.groups[jid] = {};
      if (!bucket.totals) bucket.totals = {};
      const groups = bucket.groups[jid];
      groups[key] = round((groups[key] || 0) + (Number(amount) || 0));
      bucket.totals[key] = round((bucket.totals[key] || 0) + (Number(amount) || 0));
      groups.lastActivityAt = new Date(this.clock()).toISOString();
      return structuredClone(groups);
    });
  }

  /**
   * @param {string} groupInput
   * @param {{ days?: number }} [options]
   * @returns {object}
   */
  getGroupSummary(groupInput, { days = 7 } = {}) {
    const jid = normalizeGroupJid(groupInput);
    if (!jid) throw new Error('Invalid group identifier');
    const since = new Date(this.clock() - days * 86400000).toISOString().slice(0, 10);
    const totals = {};
    const daily = [];
    const allDays = this.file.data?.days || {};
    for (const [date, bucket] of Object.entries(allDays)) {
      if (date < since) continue;
      const group = bucket.groups?.[jid];
      if (!group) continue;
      daily.push({ date, ...group });
      for (const [key, value] of Object.entries(group)) {
        if (key === 'lastActivityAt') continue;
        totals[key] = round((totals[key] || 0) + (Number(value) || 0));
      }
    }
    daily.sort((a, b) => a.date.localeCompare(b.date));
    return { groupJid: jid, days, totals, daily };
  }

  /**
   * @param {{ days?: number }} [options]
   */
  getOverview({ days = 7 } = {}) {
    const since = new Date(this.clock() - days * 86400000).toISOString().slice(0, 10);
    const totals = {};
    const perGroup = {};
    const daily = [];
    const allDays = this.file.data?.days || {};
    for (const [date, bucket] of Object.entries(allDays)) {
      if (date < since) continue;
      const dayAgg = {};
      for (const [jid, group] of Object.entries(bucket.groups || {})) {
        if (!perGroup[jid]) perGroup[jid] = {};
        for (const [key, value] of Object.entries(group)) {
          if (key === 'lastActivityAt') continue;
          const num = Number(value) || 0;
          totals[key] = round((totals[key] || 0) + num);
          perGroup[jid][key] = round((perGroup[jid][key] || 0) + num);
          dayAgg[key] = round((dayAgg[key] || 0) + num);
        }
      }
      daily.push({ date, ...dayAgg });
    }
    daily.sort((a, b) => a.date.localeCompare(b.date));
    return { days, totals, perGroup, daily };
  }

  #prune(data) {
    const cutoff = new Date(this.clock() - this.retentionDays * 86400000).toISOString().slice(0, 10);
    for (const date of Object.keys(data.days)) {
      if (date < cutoff) delete data.days[date];
    }
  }
}

function round(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}
