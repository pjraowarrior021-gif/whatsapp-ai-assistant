/**
 * Durable, secret-free AI usage accounting.
 *
 * Costs are stored as integer micro-USD so no floating point arithmetic is
 * involved in aggregation.
 */
import { JsonFileStore } from '../group-admin/persistent-store.js';

function emptyData() {
  return { version: 1, days: {}, recentErrors: [] };
}

export class AIUsageStore {
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
      if (!Array.isArray(data.recentErrors)) data.recentErrors = [];
      this.#prune(data);
    });
    this.initialized = true;
    return this;
  }

  /**
   * @param {{ provider: string, model: string, task: string, groupJid?: string, promptTokens?: number, completionTokens?: number, costMicroUsd?: number, latencyMs?: number }} entry
   */
  async record(entry) {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    return this.file.mutate((data) => {
      if (!data.days[day]) data.days[day] = { providers: {}, groups: {}, totals: {} };
      const bucket = data.days[day];
      const providerKey = `${entry.provider}:${entry.model}`;
      const p = (bucket.providers[providerKey] ||= {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costMicroUsd: 0,
      });
      p.requests += 1;
      p.promptTokens += Number(entry.promptTokens) || 0;
      p.completionTokens += Number(entry.completionTokens) || 0;
      p.costMicroUsd += Number(entry.costMicroUsd) || 0;
      p.lastLatencyMs = Number(entry.latencyMs) || 0;

      if (entry.groupJid) {
        const g = (bucket.groups[entry.groupJid] ||= {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          costMicroUsd: 0,
        });
        g.requests += 1;
        g.promptTokens += Number(entry.promptTokens) || 0;
        g.completionTokens += Number(entry.completionTokens) || 0;
        g.costMicroUsd += Number(entry.costMicroUsd) || 0;
      }

      const t = (bucket.totals[entry.task] ||= { requests: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 });
      t.requests += 1;
      t.promptTokens += Number(entry.promptTokens) || 0;
      t.completionTokens += Number(entry.completionTokens) || 0;
      t.costMicroUsd += Number(entry.costMicroUsd) || 0;

      return { day, providerKey };
    });
  }

  /**
   * @param {{ error: string, provider?: string, model?: string }} entry
   */
  async recordError(entry) {
    return this.file.mutate((data) => {
      data.recentErrors.push({
        at: new Date(this.clock()).toISOString(),
        provider: String(entry.provider || '').slice(0, 80),
        model: String(entry.model || '').slice(0, 120),
        error: String(entry.error || '').slice(0, 300),
      });
      if (data.recentErrors.length > 200) data.recentErrors = data.recentErrors.slice(-200);
      return { ok: true };
    });
  }

  /**
   * @param {{ days?: number }} [options]
   */
  getSummary({ days = 7 } = {}) {
    const since = new Date(this.clock() - days * 86400000).toISOString().slice(0, 10);
    const totals = { requests: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 };
    const providers = {};
    const groups = {};
    const daily = [];
    for (const [date, bucket] of Object.entries(this.file.data?.days || {})) {
      if (date < since) continue;
      const day = { date, requests: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 };
      for (const [key, value] of Object.entries(bucket.providers || {})) {
        const p = (providers[key] ||= { requests: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 });
        for (const field of Object.keys(p)) {
          p[field] += Number(value[field]) || 0;
          totals[field] += Number(value[field]) || 0;
          if (day[field] !== undefined) day[field] += Number(value[field]) || 0;
        }
      }
      for (const [jid, value] of Object.entries(bucket.groups || {})) {
        const g = (groups[jid] ||= { requests: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 });
        for (const field of Object.keys(g)) g[field] += Number(value[field]) || 0;
      }
      daily.push(day);
    }
    daily.sort((a, b) => a.date.localeCompare(b.date));
    return {
      days,
      totals,
      totalsUsd: microToUsd(totals.costMicroUsd),
      providers,
      groups,
      daily,
      recentErrors: structuredClone(this.file.data?.recentErrors || []),
    };
  }

  #prune(data) {
    const cutoff = new Date(this.clock() - this.retentionDays * 86400000).toISOString().slice(0, 10);
    for (const date of Object.keys(data.days)) {
      if (date < cutoff) delete data.days[date];
    }
  }
}

export function microToUsd(micro) {
  const value = Number(micro) || 0;
  return Math.round(value) / 1e6;
}
