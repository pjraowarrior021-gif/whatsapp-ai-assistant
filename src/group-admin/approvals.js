/**
 * Human approval queue for high-impact group actions.
 *
 * An approval record is created BEFORE the action is attempted. Execution only
 * happens after an explicit human resolution, and success is only reported if
 * the transport verifies the action.
 */
import { JsonFileStore } from './persistent-store.js';
import { normalizeGroupJid } from './jid.js';
import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function emptyData() {
  return { version: 1, approvals: [] };
}

export class ApprovalStore {
  /**
   * @param {{ filePath: string, clock?: () => number, maxEntries?: number }} options
   */
  constructor({ filePath, clock = () => Date.now(), maxEntries = 1000 } = {}) {
    this.file = new JsonFileStore(filePath, emptyData);
    this.clock = clock;
    this.maxEntries = maxEntries;
    this.initialized = false;
  }

  async init() {
    await this.file.init();
    await this.file.mutate((data) => {
      if (!Array.isArray(data.approvals)) data.approvals = [];
    });
    this.initialized = true;
    return this;
  }

  /**
   * @param {{ groupJid: string, type: string, payload?: object, requestedBy?: string, reason?: string }} input
   * @returns {Promise<object>}
   */
  async create({ groupJid, type, payload = {}, requestedBy = 'system', reason = '' }) {
    const jid = normalizeGroupJid(groupJid);
    if (!jid) throw new Error('Invalid group identifier');
    if (!type) throw new Error('Approval type is required');
    const now = this.clock();
    const entry = {
      id: `apr_${crypto.randomUUID()}`,
      groupJid: jid,
      type: String(type).slice(0, 80),
      payload: sanitizePayload(payload),
      reason: String(reason).slice(0, 500),
      requestedBy: String(requestedBy).slice(0, 120),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      result: null,
    };
    return this.file.mutate((data) => {
      data.approvals.push(entry);
      if (data.approvals.length > this.maxEntries) data.approvals = data.approvals.slice(-this.maxEntries);
      return structuredClone(entry);
    });
  }

  /**
   * @param {{ groupJid?: string, status?: string, limit?: number }} [filter]
   */
  list({ groupJid, status, limit = 100 } = {}) {
    const now = this.clock();
    let items = this.file.data?.approvals || [];
    if (groupJid) {
      const jid = normalizeGroupJid(groupJid);
      items = items.filter((a) => a.groupJid === jid);
    }
    if (status) items = items.filter((a) => a.status === status);
    return structuredClone(
      items
        .map((a) => ({
          ...a,
          expired: a.status === 'pending' && new Date(a.expiresAt).getTime() <= now,
        }))
        .slice(-Math.max(1, Math.min(limit, this.maxEntries)))
        .reverse()
    );
  }

  /**
   * @param {string} id
   */
  get(id) {
    const entry = (this.file.data?.approvals || []).find((a) => a.id === id);
    return entry ? structuredClone(entry) : null;
  }

  /**
   * @param {string} id
   * @param {{ approved: boolean, resolvedBy?: string, result?: object }} resolution
   * @returns {Promise<object>}
   */
  async resolve(id, { approved, resolvedBy = 'dashboard', result = null }) {
    const now = this.clock();
    return this.file.mutate((data) => {
      const entry = data.approvals.find((a) => a.id === id);
      if (!entry) throw new Error('Approval not found');
      if (entry.status !== 'pending') throw new Error(`Approval already ${entry.status}`);
      if (new Date(entry.expiresAt).getTime() <= now) {
        entry.status = 'expired';
        throw new Error('Approval has expired');
      }
      entry.status = approved ? 'approved' : 'rejected';
      entry.resolvedAt = new Date(now).toISOString();
      entry.resolvedBy = String(resolvedBy).slice(0, 120);
      if (result) entry.result = result;
      return structuredClone(entry);
    });
  }
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(payload).slice(0, 20)) {
    if (['targetJid', 'participantJid', 'topic', 'text', 'action', 'value'].includes(key)) {
      out[key] = String(value).slice(0, 2000);
    }
  }
  return out;
}
