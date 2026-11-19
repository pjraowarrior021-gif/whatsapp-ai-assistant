/**
 * Append-only audit log for security-relevant group actions.
 * Message bodies are never stored — only structured metadata.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET_KEY_PATTERN = /(token|key|secret|password|authorization|cookie)/i;

export class AuditLog {
  /**
   * @param {{ filePath: string, maxEntries?: number }} options
   */
  constructor({ filePath, maxEntries = 2000 } = {}) {
    if (!filePath) throw new Error('AuditLog requires filePath');
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.ready = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        const raw = await fs.readFile(this.filePath, 'utf8');
        const lines = raw.split('\n').filter(Boolean).slice(-this.maxEntries);
        this.entries = lines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Start a fresh audit log rather than refusing to boot; the error is
          // surfaced through lastError.
          this.lastError = err;
        }
        this.entries = [];
      }
      return this;
    })();
    return this.ready;
  }

  /**
   * @param {{ actor?: string, action: string, groupJid?: string|null, outcome?: string, detail?: object }} entry
   * @returns {Promise<object>}
   */
  async record({ actor = 'system', action, groupJid = null, outcome = 'success', detail = {} }) {
    await (this.ready || this.init());
    const safeDetail = redact(detail);
    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor: String(actor).slice(0, 120),
      action: String(action).slice(0, 120),
      groupJid: groupJid ? String(groupJid).slice(0, 140) : null,
      outcome: String(outcome).slice(0, 40),
      detail: safeDetail,
    };

    this.entries.push(record);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    const run = this.writeChain.then(async () => {
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      return record;
    });
    this.writeChain = run.catch((err) => {
      this.lastError = err;
    });
    return run;
  }

  /**
   * @param {{ limit?: number, groupJid?: string, action?: string }} [filter]
   * @returns {Array<object>}
   */
  list({ limit = 100, groupJid = null, action = null } = {}) {
    let items = this.entries;
    if (groupJid) items = items.filter((e) => e.groupJid === groupJid);
    if (action) items = items.filter((e) => e.action === action);
    return structuredClone(items.slice(-Math.max(1, Math.min(limit, this.maxEntries))).reverse());
  }
}

/**
 * Redacts secret-looking values and clamps strings/arrays.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 60)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return String(value);
}
