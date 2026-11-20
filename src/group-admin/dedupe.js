/**
 * Persistent duplicate-message protection.
 *
 * WhatsApp may redeliver messages after a reconnect or process restart. The
 * ring is bounded and stored on disk so a restart cannot re-trigger AI replies.
 */
import { JsonFileStore } from './persistent-store.js';

export class DedupeStore {
  /**
   * @param {{ filePath: string, maxEntries?: number }} options
   */
  constructor({ filePath, maxEntries = 5000 } = {}) {
    this.file = new JsonFileStore(filePath, () => ({ ids: [] }));
    this.maxEntries = maxEntries;
    this.memory = new Set();
    this.initialized = false;
  }

  async init() {
    await this.file.init();
    await this.file.read((data) => {
      if (!Array.isArray(data.ids)) data.ids = [];
      this.memory = new Set(data.ids.slice(-this.maxEntries));
    });
    this.initialized = true;
    return this;
  }

  /**
   * Returns false if this message id was already processed.
   * The id is recorded immediately so concurrent handlers cannot both pass.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async claim(key) {
    if (!key) return true;
    const normalized = String(key);
    if (this.memory.has(normalized)) return false;
    this.memory.add(normalized);

    await this.file.mutate((data) => {
      if (!Array.isArray(data.ids)) data.ids = [];
      data.ids.push(normalized);
      if (data.ids.length > this.maxEntries) {
        data.ids = data.ids.slice(-this.maxEntries);
      }
    });
    return true;
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.memory.has(String(key));
  }
}
