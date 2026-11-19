/**
 * Persistent, per-group activation store.
 *
 * Security invariants enforced here:
 *  - Every group is created disabled.
 *  - Only an explicit setEnabled(jid, true, actor) enables processing.
 *  - Group identity is the canonical JID, never the display name.
 *  - Global emergency stop overrides every per-group setting.
 */
import path from 'node:path';
import { JsonFileStore } from './persistent-store.js';
import { normalizeGroupJid } from './jid.js';
import { defaultGroupSettings, mergeGroupSettings } from './defaults.js';

const VERSION = 1;

function emptyData() {
  return {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    groups: {},
    global: {
      aiPaused: false,
      pausedAt: null,
      pausedReason: '',
      pausedBy: null,
    },
    legacyImported: false,
  };
}

export class GroupActivationStore {
  /**
   * @param {{ filePath: string, clock?: () => number }} options
   */
  constructor({ filePath, clock = () => Date.now() } = {}) {
    if (!filePath) throw new Error('GroupActivationStore requires filePath');
    this.clock = clock;
    this.file = new JsonFileStore(filePath, emptyData);
    this.initialized = false;
  }

  async init() {
    await this.file.init();
    // Repair/migrate the document defensively.
    await this.file.mutate((data) => {
      if (!data.groups || typeof data.groups !== 'object') data.groups = {};
      if (!data.global || typeof data.global !== 'object') {
        data.global = emptyData().global;
      }
      if (typeof data.legacyImported !== 'boolean') data.legacyImported = false;
      data.version = VERSION;
      for (const [jid, group] of Object.entries(data.groups)) {
        if (!group || typeof group !== 'object') {
          delete data.groups[jid];
          continue;
        }
        group.settings = mergeGroupSettings(group.settings || {}, defaultGroupSettings());
        // Fail closed: only an explicit boolean true keeps a group enabled.
        group.enabled = group.enabled === true;
      }
    });
    this.initialized = true;
    return this;
  }

  #assertJid(input) {
    const jid = normalizeGroupJid(input);
    if (!jid) throw new Error('Invalid group identifier');
    return jid;
  }

  /**
   * Records a group discovered through a transport. Never enables it.
   * @param {{ jid: string, name?: string, transport?: string, metadata?: object }} input
   * @returns {Promise<{ group: object, created: boolean }>}
   */
  async registerDiscoveredGroup({ jid: input, name = '', transport = 'cloud', metadata = {} } = {}) {
    const jid = this.#assertJid(input);
    const nowIso = new Date(this.clock()).toISOString();
    let created = false;

    const group = await this.file.mutate((data) => {
      let entry = data.groups[jid];
      if (!entry) {
        created = true;
        entry = {
          jid,
          transport: transport === 'personal' ? 'personal' : 'cloud',
          name: String(name || '').slice(0, 120),
          enabled: false,
          discoveredAt: nowIso,
          enabledAt: null,
          disabledAt: null,
          lastSeenAt: nowIso,
          metadata: sanitizeMetadata(metadata),
          settings: defaultGroupSettings(),
        };
        data.groups[jid] = entry;
      } else {
        if (name && String(name).slice(0, 120) !== entry.name) entry.name = String(name).slice(0, 120);
        if (transport === 'personal' || transport === 'cloud') entry.transport = transport;
        entry.lastSeenAt = nowIso;
        if (metadata && Object.keys(metadata).length > 0) {
          entry.metadata = { ...entry.metadata, ...sanitizeMetadata(metadata) };
        }
      }
      data.updatedAt = nowIso;
      return structuredClone(entry);
    });

    return { group, created };
  }

  /**
   * @param {string} input
   * @returns {object|null}
   */
  getGroup(input) {
    const jid = normalizeGroupJid(input);
    if (!jid || !this.initialized) return null;
    // Reads are synchronous after init; callers must await init first.
    const raw = this.file.data?.groups?.[jid];
    return raw ? structuredClone(raw) : null;
  }

  /**
   * @param {string} input
   * @returns {boolean}
   */
  isEnabled(input) {
    const group = this.getGroup(input);
    return Boolean(group && group.enabled === true);
  }

  /**
   * @returns {boolean}
   */
  isGloballyPaused() {
    return Boolean(this.initialized && this.file.data?.global?.aiPaused === true);
  }

  /**
   * @param {string} input
   * @returns {object|null}
   */
  getSettings(input) {
    const group = this.getGroup(input);
    return group ? group.settings : null;
  }

  /**
   * @returns {Array<object>}
   */
  listGroups() {
    if (!this.initialized) return [];
    const groups = Object.values(this.file.data?.groups || {});
    return structuredClone(
      groups.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return String(a.name || a.jid).localeCompare(String(b.name || b.jid));
      })
    );
  }

  /**
   * Explicitly enables or disables a group.
   * @param {string} input
   * @param {boolean} enabled
   * @param {{ actor?: string, reason?: string }} [options]
   * @returns {Promise<object>}
   */
  async setEnabled(input, enabled, { actor = 'dashboard', reason = '' } = {}) {
    const jid = this.#assertJid(input);
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const nowIso = new Date(this.clock()).toISOString();

    return this.file.mutate((data) => {
      const entry = data.groups[jid];
      if (!entry) throw new Error('Group not found. Discover it first.');
      if (enabled === true) {
        if (entry.enabled !== true) {
          entry.enabled = true;
          entry.enabledAt = nowIso;
          entry.disabledAt = null;
          entry.enabledBy = String(actor).slice(0, 120);
          entry.enableReason = String(reason || '').slice(0, 500);
        }
      } else {
        // Disable is idempotent and always wins.
        entry.enabled = false;
        entry.disabledAt = nowIso;
        entry.enabledBy = null;
        entry.enableReason = '';
      }
      data.updatedAt = nowIso;
      return structuredClone(entry);
    });
  }

  /**
   * @param {string} input
   * @param {object} patch
   * @param {{ actor?: string }} [options]
   * @returns {Promise<object>}
   */
  async updateSettings(input, patch, { actor = 'dashboard' } = {}) {
    const jid = this.#assertJid(input);
    const nowIso = new Date(this.clock()).toISOString();
    return this.file.mutate((data) => {
      const entry = data.groups[jid];
      if (!entry) throw new Error('Group not found');
      entry.settings = mergeGroupSettings(patch, mergeGroupSettings(entry.settings || {}, defaultGroupSettings()));
      entry.settingsUpdatedAt = nowIso;
      entry.settingsUpdatedBy = String(actor).slice(0, 120);
      data.updatedAt = nowIso;
      return structuredClone(entry);
    });
  }

  /**
   * Imports legacy ALLOWED_GROUP_IDS as enabled groups. These were an explicit
   * operator opt-in in the previous configuration format. Runs at most once.
   * @param {Iterable<string>} ids
   * @param {{ actor?: string }} [options]
   * @returns {Promise<{ imported: number, skipped: number }>}
   */
  async importLegacyGroups(ids, { actor = 'legacy-env' } = {}) {
    const nowIso = new Date(this.clock()).toISOString();
    return this.file.mutate((data) => {
      if (data.legacyImported) return { imported: 0, skipped: 0 };
      let imported = 0;
      let skipped = 0;
      for (const raw of ids || []) {
        const jid = normalizeGroupJid(raw);
        if (!jid) {
          skipped++;
          continue;
        }
        const existing = data.groups[jid];
        if (existing) {
          skipped++;
          continue;
        }
        data.groups[jid] = {
          jid,
          transport: 'cloud',
          name: '',
          enabled: true,
          discoveredAt: nowIso,
          enabledAt: nowIso,
          disabledAt: null,
          lastSeenAt: nowIso,
          enabledBy: actor,
          enableReason: 'Imported from legacy ALLOWED_GROUP_IDS',
          metadata: {},
          settings: {
            ...defaultGroupSettings(),
            responseMode: 'prefix',
          },
        };
        imported++;
      }
      data.legacyImported = true;
      data.updatedAt = nowIso;
      return { imported, skipped };
    });
  }

  /**
   * Immediate global AI shutdown / resume.
   * @param {boolean} paused
   * @param {{ actor?: string, reason?: string }} [options]
   * @returns {Promise<object>}
   */
  async setGlobalPause(paused, { actor = 'dashboard', reason = '' } = {}) {
    const nowIso = new Date(this.clock()).toISOString();
    return this.file.mutate((data) => {
      data.global = {
        aiPaused: paused === true,
        pausedAt: paused === true ? nowIso : null,
        pausedReason: paused === true ? String(reason || 'Emergency stop').slice(0, 500) : '',
        pausedBy: paused === true ? String(actor).slice(0, 120) : null,
      };
      data.updatedAt = nowIso;
      return structuredClone(data.global);
    });
  }

  /**
   * @returns {object}
   */
  getGlobalState() {
    return structuredClone(this.file.data?.global || emptyData().global);
  }

  /**
   * @param {string} dataDir
   * @returns {string}
   */
  static defaultFilePath(dataDir) {
    return path.join(dataDir, 'groups.json');
  }
}

function sanitizeMetadata(metadata) {
  const out = {};
  if (!metadata || typeof metadata !== 'object') return out;
  if (metadata.participantCount !== undefined) out.participantCount = Number(metadata.participantCount) || 0;
  if (Array.isArray(metadata.adminJids)) {
    out.adminJids = metadata.adminJids.map((j) => String(j).slice(0, 120)).slice(0, 100);
  }
  if (typeof metadata.subjectOwner === 'string') out.subjectOwner = metadata.subjectOwner.slice(0, 120);
  return out;
}
