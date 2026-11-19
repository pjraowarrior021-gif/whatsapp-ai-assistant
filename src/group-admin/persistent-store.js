/**
 * Small, dependency-free JSON persistence helper.
 *
 * - Loads once at init.
 * - Serializes all writes (no lost updates inside one process).
 * - Writes atomically via temp file + rename so a crash cannot leave a
 *   half-written configuration file.
 * - Never stores secrets; callers are responsible for redaction.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonFileStore {
  /**
   * @param {string} filePath
   * @param {() => object} defaultFactory
   */
  constructor(filePath, defaultFactory = () => ({})) {
    if (!filePath) throw new Error('JsonFileStore requires a file path');
    this.filePath = filePath;
    this.defaultFactory = defaultFactory;
    this.data = null;
    this.ready = null;
    this.writeChain = Promise.resolve();
    this.lastError = null;
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        let raw;
        try {
          raw = await fs.readFile(this.filePath, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') {
            this.data = this.defaultFactory();
            await this.#persist();
            return this;
          }
          throw err;
        }

        try {
          const parsed = JSON.parse(raw);
          this.data = parsed && typeof parsed === 'object' ? parsed : this.defaultFactory();
        } catch {
          // Corrupt file: preserve it for inspection instead of silently discarding operator configuration.
          try {
            await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
          } catch {
            // best effort
          }
          this.data = this.defaultFactory();
          await this.#persist();
        }
        return this;
      } catch (fatalErr) {
        this.ready = null;
        throw fatalErr;
      }
    })();
    return this.ready;
  }

  async #ensureReady() {
    if (!this.ready) await this.init();
    else await this.ready;
  }

  async #persist(targetData = this.data) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(targetData, null, 2);
    await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /**
   * Reads a projection of the data without mutating it.
   * @template T
   * @param {(data: object) => T} fn
   * @returns {Promise<T>}
   */
  async read(fn) {
    await this.#ensureReady();
    return fn(this.data);
  }

  /**
   * Serialized read-modify-write. The mutator may be async.
   * If the mutator throws, nothing is written.
   * @template T
   * @param {(data: object) => T | Promise<T>} mutator
   * @returns {Promise<T>}
   */
  async mutate(mutator) {
    await this.#ensureReady();
    const run = this.writeChain.then(async () => {
      const draft = structuredClone(this.data);
      const result = await mutator(draft);
      await this.#persist(draft);
      this.data = draft;
      return result;
    });
    // Keep the chain alive after failures so one bad write does not wedge
    // every later write.
    this.writeChain = run.catch((err) => {
      this.lastError = err;
    });
    return run;
  }
}
