/**
 * Moderation case records, escalated to humans when uncertain.
 */
import { JsonFileStore } from './persistent-store.js';
import { normalizeGroupJid } from './jid.js';
import crypto from 'node:crypto';

function emptyData() {
  return { version: 1, events: [] };
}

export class ModerationStore {
  /**
   * @param {{ filePath: string, maxEvents?: number }} options
   */
  constructor({ filePath, maxEvents = 3000 } = {}) {
    this.file = new JsonFileStore(filePath, emptyData);
    this.maxEvents = maxEvents;
    this.initialized = false;
  }

  async init() {
    await this.file.init();
    await this.file.mutate((data) => {
      if (!Array.isArray(data.events)) data.events = [];
      if (data.events.length > this.maxEvents) data.events = data.events.slice(-this.maxEvents);
    });
    this.initialized = true;
    return this;
  }

  /**
   * @param {object} event
   * @returns {Promise<object>}
   */
  async record(event) {
    const groupJid = normalizeGroupJid(event.groupJid);
    if (!groupJid) throw new Error('Invalid group identifier');
    const entry = {
      id: `mod_${crypto.randomUUID()}`,
      groupJid,
      messageId: event.messageId ? String(event.messageId).slice(0, 200) : '',
      senderJid: event.senderJid ? String(event.senderJid).slice(0, 120) : '',
      categories: Array.isArray(event.categories) ? event.categories.slice(0, 10) : [],
      severity: String(event.severity || 'low'),
      reasons: Array.isArray(event.reasons) ? event.reasons.slice(0, 10) : [],
      action: String(event.action || 'escalate'),
      status: event.status || 'open',
      excerpt: String(event.excerpt || '').slice(0, 240),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      note: '',
    };

    return this.file.mutate((data) => {
      data.events.push(entry);
      if (data.events.length > this.maxEvents) data.events = data.events.slice(-this.maxEvents);
      return structuredClone(entry);
    });
  }

  /**
   * @param {{ groupJid?: string, limit?: number, status?: string }} [filter]
   */
  list({ groupJid, limit = 100, status } = {}) {
    let items = this.file.data?.events || [];
    if (groupJid) {
      const jid = normalizeGroupJid(groupJid);
      items = items.filter((e) => e.groupJid === jid);
    }
    if (status) items = items.filter((e) => e.status === status);
    return structuredClone(items.slice(-Math.max(1, Math.min(limit, this.maxEvents))).reverse());
  }

  /**
   * @param {string} id
   * @param {{ status: string, resolvedBy?: string, note?: string }} update
   */
  async resolve(id, { status = 'resolved', resolvedBy = 'dashboard', note = '' } = {}) {
    return this.file.mutate((data) => {
      const event = data.events.find((e) => e.id === id);
      if (!event) throw new Error('Moderation event not found');
      event.status = ['open', 'resolved', 'escalated', 'dismissed'].includes(status) ? status : 'resolved';
      event.resolvedAt = new Date().toISOString();
      event.resolvedBy = String(resolvedBy).slice(0, 120);
      event.note = String(note).slice(0, 1000);
      return structuredClone(event);
    });
  }

  /**
   * @param {string} groupJid
   * @returns {number}
   */
  countOpen(groupJid) {
    const jid = normalizeGroupJid(groupJid);
    return (this.file.data?.events || []).filter((e) => e.groupJid === jid && e.status === 'open').length;
  }

  /**
   * Deletes moderation history for one group only.
   * @param {string} groupJid
   */
  async clearGroup(groupJid) {
    const jid = normalizeGroupJid(groupJid);
    return this.file.mutate((data) => {
      const before = data.events.length;
      data.events = data.events.filter((e) => e.groupJid !== jid);
      return { removed: before - data.events.length };
    });
  }
}
