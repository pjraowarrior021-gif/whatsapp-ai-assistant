/**
 * Personal Knowledge Graph (PKG) Module
 *
 * Implements a structured entity-relation knowledge graph for user memory,
 * preferences, active projects, tech stack, contacts, devices, and topics.
 * Supports temporal validity, confidence scoring, provenance tracking,
 * automated contradiction detection, and supersession resolution.
 */

import crypto from 'crypto';
import { store } from './store/index.js';
import { privacyLog } from './privacy.js';

// Knowledge Graph bounds
const MAX_ENTITIES_PER_USER = 60;
const MAX_RELATIONS_PER_USER = 120;
const MAX_STRING_LENGTH = 300;

// Supported core entity types
export const ENTITY_TYPES = Object.freeze({
  USER: 'User',
  PROJECT: 'Project',
  PREFERENCE: 'Preference',
  CONTACT: 'Contact',
  DEVICE: 'Device',
  TOPIC: 'Topic',
  ENVIRONMENT: 'Environment',
  LOCATION: 'Location',
  TOOL: 'Tool',
  ROLE: 'Role',
});

// Single-value / mutually exclusive relation categories for contradiction & supersession resolution
export const EXCLUSIVE_CATEGORIES = new Set([
  'location',
  'residence',
  'identity_name',
  'name',
  'diet',
  'editor',
  'theme',
  'output_brevity',
  'output_format',
  'output_emoji',
  'preferred_code_lang',
  'profession',
  'role',
]);

// Single-value predicates where a subject can only have one active target
export const SINGLE_VALUED_PREDICATES = new Set([
  'LOCATED_IN',
  'LIVES_IN',
  'HAS_NAME',
  'WORKS_AS',
  'PREFERS_THEME',
  'PREFERS_BREVITY',
  'PREFERS_EDITOR',
  'PREFERS_FORMAT',
]);

/**
 * Normalizes entity IDs to safe, deterministic string keys.
 * @param {string} type
 * @param {string} rawId
 * @returns {string}
 */
export function normalizeEntityId(type, rawId) {
  const clean = String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .slice(0, 80);
  if (!clean) {
    return `${(type || 'entity').toLowerCase()}_${crypto.randomBytes(3).toString('hex')}`;
  }
  if (clean.includes(':')) {
    return clean;
  }
  const prefix = (type || 'entity').toLowerCase();
  return `${prefix}:${clean}`;
}

/**
 * Validates and clamps confidence score between 0.0 and 1.0.
 * @param {number|undefined} val
 * @param {number} [fallback=1.0]
 * @returns {number}
 */
function clampConfidence(val, fallback = 1.0) {
  if (typeof val !== 'number' || Number.isNaN(val)) return fallback;
  return Math.max(0.0, Math.min(1.0, Math.round(val * 100) / 100));
}

/**
 * Personal Knowledge Graph implementation for a single user partition.
 */
export class PersonalKnowledgeGraph {
  /**
   * @param {string} anonId
   */
  constructor(anonId = 'default_user') {
    this.anonId = anonId;
    /** @type {Map<string, object>} */
    this.entities = new Map();
    /** @type {Map<string, object>} */
    this.relations = new Map();

    // Ensure root User entity always exists
    const rootUserId = `user:${anonId}`;
    this.entities.set(rootUserId, {
      id: rootUserId,
      type: ENTITY_TYPES.USER,
      name: 'User',
      attributes: { anonId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /**
   * Adds or updates an entity in the graph.
   *
   * @param {object} entity
   * @param {string} [entity.id]
   * @param {string} entity.type
   * @param {string} entity.name
   * @param {object} [entity.attributes]
   * @returns {object} The created/updated entity
   */
  addEntity(entity) {
    if (!entity || typeof entity !== 'object') {
      throw new Error('Entity must be a valid object');
    }

    const type = entity.type || ENTITY_TYPES.TOPIC;
    const name = String(entity.name || '')
      .trim()
      .substring(0, MAX_STRING_LENGTH);
    if (!name && !entity.id) {
      throw new Error('Entity requires a name or valid id');
    }

    const id = entity.id ? normalizeEntityId(type, entity.id) : normalizeEntityId(type, name);
    const existing = this.entities.get(id);

    if (existing) {
      existing.name = name || existing.name;
      existing.type = type || existing.type;
      existing.attributes = {
        ...existing.attributes,
        ...(entity.attributes || {}),
      };
      existing.updatedAt = Date.now();
      return existing;
    }

    this.pruneEntitiesIfNeeded();

    const newEntity = {
      id,
      type,
      name: name || id,
      attributes: { ...(entity.attributes || {}) },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.entities.set(id, newEntity);
    return newEntity;
  }

  /**
   * Retrieves an entity by ID.
   * @param {string} id
   * @returns {object|null}
   */
  getEntity(id) {
    if (!id) return null;
    return this.entities.get(id) || null;
  }

  /**
   * Checks if an entity exists.
   * @param {string} id
   * @returns {boolean}
   */
  hasEntity(id) {
    return Boolean(id && this.entities.has(id));
  }

  /**
   * Removes an entity and cascades deletion to connected relations.
   * @param {string} id
   * @returns {boolean}
   */
  removeEntity(id) {
    if (!id || !this.entities.has(id)) return false;

    // Do not allow deleting the root user entity
    if (id === `user:${this.anonId}`) return false;

    this.entities.delete(id);

    // Retract or remove all connected relations
    for (const [, rel] of this.relations.entries()) {
      if (rel.source === id || rel.target === id) {
        rel.temporal.status = 'retracted';
        rel.temporal.valid_until = Date.now();
        rel.updatedAt = Date.now();
      }
    }
    return true;
  }

  /**
   * Adds a relation triple (source -> predicate -> target) with automated contradiction
   * detection and supersession management.
   *
   * @param {object} relData
   * @param {string} relData.source
   * @param {string} relData.predicate
   * @param {string} relData.target
   * @param {string} [relData.category='general']
   * @param {number} [relData.confidence=1.0]
   * @param {'direct_message'|'user_command'|'inferred'} [relData.provenance='direct_message']
   * @param {object} [relData.metadata={}]
   * @param {object} [options]
   * @param {boolean} [options.exclusive]
   * @param {string[]} [options.supersedes]
   * @returns {object} The created or reinforced relation
   */
  addRelation(relData, options = {}) {
    if (!relData || !relData.source || !relData.predicate || !relData.target) {
      throw new Error('Relation requires source, predicate, and target');
    }

    const source = String(relData.source).trim();
    const predicate = String(relData.predicate).trim().toUpperCase();
    const target = String(relData.target).trim();
    const category = String(relData.category || 'general')
      .trim()
      .toLowerCase();
    const confidence = clampConfidence(relData.confidence, 1.0);
    const provenance = relData.provenance || 'direct_message';
    const metadata = relData.metadata || {};

    // Auto-create stub entities if they don't already exist
    if (!this.entities.has(source)) {
      this.addEntity({ id: source, type: ENTITY_TYPES.TOPIC, name: source });
    }
    if (!this.entities.has(target)) {
      this.addEntity({ id: target, type: ENTITY_TYPES.TOPIC, name: target });
    }

    const now = Date.now();

    // 1. Check for exact duplicate active relation -> Reinforce confidence and update timestamp
    for (const existing of this.relations.values()) {
      if (
        existing.temporal.status === 'active' &&
        existing.source === source &&
        existing.predicate === predicate &&
        existing.target === target &&
        existing.category === category
      ) {
        existing.confidence = Math.max(existing.confidence, confidence);
        existing.provenance = provenance;
        existing.updatedAt = now;
        existing.metadata = { ...existing.metadata, ...metadata };
        return existing;
      }
    }

    // 2. Automated Contradiction & Supersession Detection:
    // Determine if this relation conflicts with an existing active relation
    const isExclusiveCategory = EXCLUSIVE_CATEGORIES.has(category);
    const isSingleValuedPredicate = SINGLE_VALUED_PREDICATES.has(predicate);
    const shouldCheckExclusivity = options.exclusive === true || isExclusiveCategory || isSingleValuedPredicate;

    const supersededIds = new Set(options.supersedes || []);

    if (shouldCheckExclusivity) {
      for (const existing of this.relations.values()) {
        if (existing.temporal.status !== 'active') continue;

        const sameSource = existing.source === source;
        const matchingCategory = isExclusiveCategory && existing.category === category;
        const matchingPredicate = isSingleValuedPredicate && existing.predicate === predicate;

        if (sameSource && (matchingCategory || matchingPredicate)) {
          if (existing.target !== target) {
            supersededIds.add(existing.id);
          }
        }
      }
    }

    this.pruneRelationsIfNeeded();

    let relationId = relData.id || `fact_${crypto.randomBytes(3).toString('hex')}`;
    if (this.relations.has(relationId) && supersededIds.has(relationId)) {
      relationId = `rel_${crypto.randomBytes(4).toString('hex')}`;
    }

    const newRelation = {
      id: relationId,
      source,
      predicate,
      target,
      category,
      confidence,
      provenance,
      temporal: {
        valid_from: now,
        valid_until: null,
        status: 'active',
      },
      supersededBy: null,
      metadata: { ...metadata },
      createdAt: now,
      updatedAt: now,
    };

    // Apply supersession to conflicting older relations
    for (const oldId of supersededIds) {
      if (oldId === relationId) continue;
      const oldRel = this.relations.get(oldId);
      if (oldRel && oldRel.temporal.status === 'active') {
        oldRel.temporal.status = 'superseded';
        oldRel.temporal.valid_until = now;
        oldRel.supersededBy = relationId;
        oldRel.updatedAt = now;
        privacyLog('info', 'KNOWLEDGE_RELATION_SUPERSEDED', {
          oldId,
          supersededBy: relationId,
          category,
          predicate,
        });
      }
    }

    this.relations.set(relationId, newRelation);
    return newRelation;
  }

  /**
   * Retrieves a single relation by ID.
   * @param {string} id
   * @returns {object|null}
   */
  getRelation(id) {
    if (!id) return null;
    return this.relations.get(id) || null;
  }

  /**
   * Retrieves relations connected to an entity.
   *
   * @param {string} entityId
   * @param {object} [options]
   * @param {'out'|'in'|'both'} [options.direction='out']
   * @param {string} [options.predicate]
   * @param {string} [options.category]
   * @param {'active'|'superseded'|'retracted'|'all'} [options.status='active']
   * @param {number} [options.minConfidence=0.0]
   * @returns {object[]}
   */
  getRelations(entityId, options = {}) {
    if (!entityId) return [];

    const direction = options.direction || 'out';
    const status = options.status || 'active';
    const predicate = options.predicate ? options.predicate.toUpperCase() : null;
    const category = options.category ? options.category.toLowerCase() : null;
    const minConfidence = typeof options.minConfidence === 'number' ? options.minConfidence : 0.0;

    const results = [];

    for (const rel of this.relations.values()) {
      if (status !== 'all' && rel.temporal.status !== status) {
        continue;
      }
      if (rel.confidence < minConfidence) {
        continue;
      }
      if (predicate && rel.predicate !== predicate) {
        continue;
      }
      if (category && rel.category !== category) {
        continue;
      }

      let matches = false;
      if (direction === 'out' && rel.source === entityId) matches = true;
      if (direction === 'in' && rel.target === entityId) matches = true;
      if (direction === 'both' && (rel.source === entityId || rel.target === entityId)) matches = true;

      if (matches) {
        results.push(rel);
      }
    }

    return results;
  }

  /**
   * Retracts/deletes a fact/relation by ID.
   *
   * @param {string} id
   * @param {object} [options]
   * @param {boolean} [options.hardDelete=false]
   * @returns {boolean}
   */
  deleteFact(id, options = {}) {
    if (!id) return false;
    const rel = this.relations.get(id);
    if (!rel) return false;

    if (options.hardDelete) {
      return this.relations.delete(id);
    }

    rel.temporal.status = 'retracted';
    rel.temporal.valid_until = Date.now();
    rel.updatedAt = Date.now();
    return true;
  }

  /**
   * Searches the graph across entities, attributes, relations, categories, and predicates.
   *
   * @param {string} query
   * @param {object} [options]
   * @param {boolean} [options.activeOnly=true]
   * @param {number} [options.limit=15]
   * @returns {{ entities: object[], relations: object[] }}
   */
  searchGraph(query, options = {}) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) {
      return { entities: [], relations: [] };
    }

    const activeOnly = options.activeOnly !== false;
    const limit = options.limit || 15;

    const matchedEntities = [];
    for (const entity of this.entities.values()) {
      const nameMatch = entity.name.toLowerCase().includes(q);
      const idMatch = entity.id.toLowerCase().includes(q);
      const typeMatch = entity.type.toLowerCase().includes(q);
      const attrMatch = JSON.stringify(entity.attributes || {})
        .toLowerCase()
        .includes(q);

      if (nameMatch || idMatch || typeMatch || attrMatch) {
        matchedEntities.push(entity);
        if (matchedEntities.length >= limit) break;
      }
    }

    const matchedRelations = [];
    for (const rel of this.relations.values()) {
      if (activeOnly && rel.temporal.status !== 'active') {
        continue;
      }

      const predMatch = rel.predicate.toLowerCase().includes(q);
      const catMatch = rel.category.toLowerCase().includes(q);
      const srcMatch = rel.source.toLowerCase().includes(q);
      const tgtMatch = rel.target.toLowerCase().includes(q);
      const metaMatch = JSON.stringify(rel.metadata || {})
        .toLowerCase()
        .includes(q);

      if (predMatch || catMatch || srcMatch || tgtMatch || metaMatch) {
        matchedRelations.push(rel);
        if (matchedRelations.length >= limit) break;
      }
    }

    return { entities: matchedEntities, relations: matchedRelations };
  }

  /**
   * Traverses the graph from a topic or entity to find connected contextual facts.
   *
   * @param {string} topicOrEntityId
   * @param {object} [options]
   * @param {number} [options.maxDepth=2]
   * @param {boolean} [options.activeOnly=true]
   * @param {number} [options.limit=15]
   * @returns {{ rootEntities: object[], connectedEntities: object[], relations: object[], contextText: string }}
   */
  findRelatedContext(topicOrEntityId, options = {}) {
    const query = String(topicOrEntityId || '')
      .trim()
      .toLowerCase();
    if (!query) {
      return { rootEntities: [], connectedEntities: [], relations: [], contextText: '' };
    }

    const maxDepth = options.maxDepth || 2;
    const activeOnly = options.activeOnly !== false;
    const limit = options.limit || 15;

    // 1. Identify starting root entities
    const roots = [];
    for (const entity of this.entities.values()) {
      if (
        entity.id.toLowerCase() === query ||
        entity.name.toLowerCase().includes(query) ||
        entity.id.toLowerCase().includes(query)
      ) {
        roots.push(entity);
      }
    }

    // If query didn't match entity directly, search relations for target or source
    if (roots.length === 0) {
      for (const rel of this.relations.values()) {
        if (rel.predicate.toLowerCase().includes(query) || rel.category.toLowerCase().includes(query)) {
          const srcEnt = this.getEntity(rel.source);
          const tgtEnt = this.getEntity(rel.target);
          if (srcEnt && !roots.includes(srcEnt)) roots.push(srcEnt);
          if (tgtEnt && !roots.includes(tgtEnt)) roots.push(tgtEnt);
        }
      }
    }

    const visitedEntityIds = new Set(roots.map((r) => r.id));
    const collectedRelations = new Map();
    let currentFrontier = [...roots.map((r) => r.id)];

    // 2. Breadth-First Graph Traversal
    for (let depth = 0; depth < maxDepth; depth++) {
      if (currentFrontier.length === 0) break;
      const nextFrontier = [];

      for (const currentId of currentFrontier) {
        const relations = this.getRelations(currentId, {
          direction: 'both',
          status: activeOnly ? 'active' : 'all',
        });

        for (const rel of relations) {
          if (!collectedRelations.has(rel.id)) {
            collectedRelations.set(rel.id, rel);
            const neighborId = rel.source === currentId ? rel.target : rel.source;
            if (!visitedEntityIds.has(neighborId)) {
              visitedEntityIds.add(neighborId);
              nextFrontier.push(neighborId);
            }
          }
          if (collectedRelations.size >= limit) break;
        }
        if (collectedRelations.size >= limit) break;
      }

      currentFrontier = nextFrontier;
    }

    const connectedEntities = [];
    for (const entId of visitedEntityIds) {
      if (!roots.some((r) => r.id === entId)) {
        const ent = this.getEntity(entId);
        if (ent) connectedEntities.push(ent);
      }
    }

    const relationsArray = Array.from(collectedRelations.values());

    // 3. Construct natural language context snippet suitable for LLM injection
    const lines = [];
    for (const rel of relationsArray) {
      const srcName = this.getEntity(rel.source)?.name || rel.source;
      const tgtName = this.getEntity(rel.target)?.name || rel.target;
      const predicateFormatted = rel.predicate.toLowerCase().replace(/_/g, ' ');
      lines.push(`${srcName} ${predicateFormatted} ${tgtName} (${rel.category})`);
    }

    return {
      rootEntities: roots,
      connectedEntities,
      relations: relationsArray,
      contextText: lines.join('\n'),
    };
  }

  /**
   * Exports the entire graph as a serializable snapshot.
   * @returns {object}
   */
  exportGraph() {
    const entities = Array.from(this.entities.values());
    const relations = Array.from(this.relations.values());

    const stats = {
      totalEntities: entities.length,
      totalRelations: relations.length,
      activeRelations: relations.filter((r) => r.temporal.status === 'active').length,
      supersededRelations: relations.filter((r) => r.temporal.status === 'superseded').length,
      retractedRelations: relations.filter((r) => r.temporal.status === 'retracted').length,
    };

    return {
      anonId: this.anonId,
      entities,
      relations,
      stats,
      exportedAt: Date.now(),
    };
  }

  /**
   * Imports a graph snapshot into this instance.
   * @param {object} snapshot
   */
  importGraph(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    if (Array.isArray(snapshot.entities)) {
      for (const ent of snapshot.entities) {
        if (ent && ent.id) {
          this.entities.set(ent.id, ent);
        }
      }
    }

    if (Array.isArray(snapshot.relations)) {
      for (const rel of snapshot.relations) {
        if (rel && rel.id) {
          this.relations.set(rel.id, rel);
        }
      }
    }
  }

  /**
   * Enforces bounded capacity on entities.
   */
  pruneEntitiesIfNeeded() {
    if (this.entities.size < MAX_ENTITIES_PER_USER) return;

    const rootUserId = `user:${this.anonId}`;
    const candidates = Array.from(this.entities.values())
      .filter((e) => e.id !== rootUserId)
      .sort((a, b) => a.updatedAt - b.updatedAt);

    // Evict oldest unreferenced entities
    for (const cand of candidates) {
      const isReferenced = Array.from(this.relations.values()).some(
        (r) => (r.source === cand.id || r.target === cand.id) && r.temporal.status === 'active'
      );
      if (!isReferenced) {
        this.entities.delete(cand.id);
        if (this.entities.size < MAX_ENTITIES_PER_USER) break;
      }
    }
  }

  /**
   * Enforces bounded capacity on relations, evicting retracted/superseded first.
   */
  pruneRelationsIfNeeded() {
    if (this.relations.size < MAX_RELATIONS_PER_USER) return;

    const all = Array.from(this.relations.values());

    // 1. Evict retracted relations oldest first
    const retracted = all.filter((r) => r.temporal.status === 'retracted').sort((a, b) => a.updatedAt - b.updatedAt);
    for (const r of retracted) {
      this.relations.delete(r.id);
      if (this.relations.size < MAX_RELATIONS_PER_USER) return;
    }

    // 2. Evict superseded relations oldest first
    const superseded = all.filter((r) => r.temporal.status === 'superseded').sort((a, b) => a.updatedAt - b.updatedAt);
    for (const r of superseded) {
      this.relations.delete(r.id);
      if (this.relations.size < MAX_RELATIONS_PER_USER) return;
    }

    // 3. Evict lowest confidence active relations
    const active = all.filter((r) => r.temporal.status === 'active').sort((a, b) => a.confidence - b.confidence);
    for (const r of active) {
      this.relations.delete(r.id);
      if (this.relations.size < MAX_RELATIONS_PER_USER) return;
    }
  }
}

// In-memory cache of user Knowledge Graphs: Map<anonId, PersonalKnowledgeGraph>
const userGraphCache = new Map();

/**
 * Returns (or initializes) the in-memory knowledge graph instance for a user.
 * @param {string} [anonId='default_user']
 * @returns {PersonalKnowledgeGraph}
 */
export function getKnowledgeGraph(anonId = 'default_user') {
  const safeId = String(anonId || 'default_user');
  let graph = userGraphCache.get(safeId);
  if (!graph) {
    graph = new PersonalKnowledgeGraph(safeId);
    userGraphCache.set(safeId, graph);
  }
  return graph;
}

/**
 * Loads user knowledge graph from persistent store if available.
 * @param {string} anonId
 * @returns {Promise<PersonalKnowledgeGraph>}
 */
export async function loadKnowledgeGraph(anonId) {
  const graph = getKnowledgeGraph(anonId);
  try {
    const raw = await store.get(`user:kg:${anonId}`);
    if (raw && typeof raw === 'object') {
      graph.importGraph(raw);
    }
  } catch (err) {
    privacyLog('debug', 'LOAD_KNOWLEDGE_GRAPH_FAILED', { error: err.message });
  }
  return graph;
}

/**
 * Persists user knowledge graph to store.
 * @param {string} anonId
 * @returns {Promise<boolean>}
 */
export async function saveKnowledgeGraph(anonId) {
  const graph = getKnowledgeGraph(anonId);
  try {
    const data = graph.exportGraph();
    await store.set(`user:kg:${anonId}`, data);
    return true;
  } catch (err) {
    privacyLog('warn', 'SAVE_KNOWLEDGE_GRAPH_FAILED', { error: err.message });
    return false;
  }
}

/**
 * Clears knowledge graph for a user (both memory cache and persistent store).
 * @param {string} anonId
 * @param {object} [options]
 * @param {boolean} [options.memoryOnly=false]
 * @returns {Promise<boolean>}
 */
export async function clearKnowledgeGraph(anonId, options = {}) {
  const safeId = String(anonId || 'default_user');
  const existing = userGraphCache.get(safeId);
  if (existing) {
    existing.entities.clear();
    existing.relations.clear();
    const rootUserId = `user:${safeId}`;
    existing.entities.set(rootUserId, {
      id: rootUserId,
      type: ENTITY_TYPES.USER,
      name: 'User',
      attributes: { anonId: safeId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  userGraphCache.delete(safeId);
  if (!options.memoryOnly) {
    try {
      await store.del(`user:kg:${safeId}`);
    } catch (err) {
      privacyLog('debug', 'CLEAR_KNOWLEDGE_GRAPH_FAILED', { error: err.message });
    }
  }
  return true;
}

/**
 * Evicts in-memory graph cache without touching persistent store.
 * @param {string} anonId
 * @returns {boolean}
 */
export function evictKnowledgeGraphCache(anonId) {
  const safeId = String(anonId || 'default_user');
  return userGraphCache.delete(safeId);
}

// ---------------------------------------------------------------------------
// Ergonomic Top-Level Query & Action API
// ---------------------------------------------------------------------------

/**
 * Retrieves an entity either by (id, anonId) or (anonId, id).
 * @param {string} arg1 - id or anonId
 * @param {string} [arg2] - id or anonId
 * @returns {object|null}
 */
export function getEntity(arg1, arg2) {
  if (!arg1) return null;
  if (!arg2) {
    // Single arg: search in all cached graphs or default
    for (const graph of userGraphCache.values()) {
      const found = graph.getEntity(arg1);
      if (found) return found;
    }
    return getKnowledgeGraph('default_user').getEntity(arg1);
  }

  // Two args: determine which is anonId and which is entity id
  const g1 = userGraphCache.get(arg1);
  if (g1) return g1.getEntity(arg2);

  const g2 = userGraphCache.get(arg2);
  if (g2) return g2.getEntity(arg1);

  return getKnowledgeGraph(arg2).getEntity(arg1) || getKnowledgeGraph(arg1).getEntity(arg2);
}

/**
 * Retrieves relations for an entity.
 * @param {string} entityId
 * @param {object} [options]
 * @param {string} [anonId]
 * @returns {object[]}
 */
export function getRelations(entityId, options = {}, anonId) {
  const graph = getKnowledgeGraph(anonId || options.anonId || 'default_user');
  return graph.getRelations(entityId, options);
}

/**
 * Searches the graph.
 * @param {string} query
 * @param {object} [options]
 * @param {string} [anonId]
 * @returns {{ entities: object[], relations: object[] }}
 */
export function searchGraph(query, options = {}, anonId) {
  const graph = getKnowledgeGraph(anonId || options.anonId || 'default_user');
  return graph.searchGraph(query, options);
}

/**
 * Finds connected contextual facts for a topic.
 * @param {string} topic
 * @param {object} [options]
 * @param {string} [anonId]
 * @returns {{ rootEntities: object[], connectedEntities: object[], relations: object[], contextText: string }}
 */
export function findRelatedContext(topic, options = {}, anonId) {
  const graph = getKnowledgeGraph(anonId || options.anonId || 'default_user');
  return graph.findRelatedContext(topic, options);
}

/**
 * Exports the graph for a user.
 * @param {string} [anonId='default_user']
 * @returns {object}
 */
export function exportGraph(anonId = 'default_user') {
  return getKnowledgeGraph(anonId).exportGraph();
}

/**
 * Deletes/retracts a fact by ID.
 * @param {string} id
 * @param {string} [anonId='default_user']
 * @returns {boolean}
 */
export function deleteFact(id, anonId = 'default_user') {
  if (anonId && userGraphCache.has(anonId)) {
    return userGraphCache.get(anonId).deleteFact(id);
  }
  // Try searching all active graphs
  for (const graph of userGraphCache.values()) {
    if (graph.getRelation(id)) {
      return graph.deleteFact(id);
    }
  }
  return getKnowledgeGraph(anonId).deleteFact(id);
}

// ---------------------------------------------------------------------------
// Memory & Auto-Learner Synchronization Bridges
// ---------------------------------------------------------------------------

/**
 * Maps categories to canonical predicates and target entity types.
 */
const CATEGORY_PREDICATE_MAP = {
  identity_name: { predicate: 'HAS_NAME', targetType: ENTITY_TYPES.USER, exclusive: true },
  name: { predicate: 'HAS_NAME', targetType: ENTITY_TYPES.USER, exclusive: true },
  location: { predicate: 'LOCATED_IN', targetType: ENTITY_TYPES.LOCATION, exclusive: true },
  residence: { predicate: 'LIVES_IN', targetType: ENTITY_TYPES.LOCATION, exclusive: true },
  diet: { predicate: 'HAS_DIET', targetType: ENTITY_TYPES.PREFERENCE, exclusive: true },
  allergy: { predicate: 'ALLERGIC_TO', targetType: ENTITY_TYPES.PREFERENCE, exclusive: false },
  output_brevity: { predicate: 'PREFERS', targetType: ENTITY_TYPES.PREFERENCE, exclusive: true },
  output_format: { predicate: 'PREFERS', targetType: ENTITY_TYPES.PREFERENCE, exclusive: true },
  output_emoji: { predicate: 'PREFERS', targetType: ENTITY_TYPES.PREFERENCE, exclusive: true },
  preferred_code_lang: { predicate: 'PREFERS_LANGUAGE', targetType: ENTITY_TYPES.TOOL, exclusive: true },
  profession: { predicate: 'WORKS_AS', targetType: ENTITY_TYPES.ROLE, exclusive: true },
  project_goal: { predicate: 'WORKS_ON', targetType: ENTITY_TYPES.PROJECT, exclusive: false },
  general: { predicate: 'PREFERS', targetType: ENTITY_TYPES.PREFERENCE, exclusive: false },
};

/**
 * Infers category and target entity metadata from natural language fact text.
 * @param {string} text
 * @returns {string}
 */
export function inferFactCategory(text) {
  if (!text || typeof text !== 'string') return 'general';
  if (/\b(?:live in|based in|moved to|reside in)\s+([A-Za-z\s]+)/i.test(text)) return 'location';
  if (/\b(?:vegetarian|vegan|pescatarian|eggetarian|don't eat meat)\b/i.test(text)) return 'diet';
  if (/\ballergic to\s+([A-Za-z\s]+)/i.test(text)) return 'allergy';
  if (/\b(?:my name is|call me|i go by)\s+([A-Za-z]+)/i.test(text)) return 'identity_name';
  if (/\b(?:dark mode|light mode)\b/i.test(text)) return 'theme';
  if (/\b(?:working on|building|creating)\s+([A-Za-z0-9\s_-]+)/i.test(text)) return 'project_goal';
  if (/\b(?:concise|brief|short replies)\b/i.test(text)) return 'output_brevity';
  if (/\b(?:bullet points)\b/i.test(text)) return 'output_format';
  if (/\b(?:code in|code examples in)\s+([A-Za-z+]+)/i.test(text)) return 'preferred_code_lang';
  return 'general';
}

/**
 * Synchronizes an explicit or auto-learned memory fact item into the knowledge graph.
 *
 * @param {string} anonId
 * @param {object} factItem
 * @param {string} factItem.id
 * @param {string} factItem.text
 * @param {string} [factItem.category='general']
 * @param {number} [factItem.confidence=1.0]
 * @param {'manual'|'auto'} [factItem.origin='manual']
 * @returns {object|null} The created or updated graph relation
 */
export function syncMemoryFactToGraph(anonId, factItem) {
  if (!anonId || !factItem || !factItem.text) return null;

  try {
    const graph = getKnowledgeGraph(anonId);
    const userId = `user:${anonId}`;
    let category = String(factItem.category || 'general').toLowerCase();
    if (category === 'general') {
      const inferred = inferFactCategory(factItem.text);
      if (inferred !== 'general') {
        category = inferred;
      }
    }
    const mapping = CATEGORY_PREDICATE_MAP[category] || CATEGORY_PREDICATE_MAP.general;

    // Create target entity based on fact text
    const cleanText = factItem.text.trim();
    const targetEntityId = normalizeEntityId(mapping.targetType, cleanText);

    graph.addEntity({
      id: targetEntityId,
      type: mapping.targetType,
      name: cleanText,
      attributes: {
        rawFactId: factItem.id,
        category,
      },
    });

    const provenance = factItem.origin === 'auto' ? 'inferred' : 'user_command';

    const relation = graph.addRelation(
      {
        id: factItem.id ? `rel_${factItem.id}` : undefined,
        source: userId,
        predicate: mapping.predicate,
        target: targetEntityId,
        category,
        confidence: factItem.confidence ?? (factItem.origin === 'auto' ? 0.95 : 1.0),
        provenance,
        metadata: {
          factText: cleanText,
          memoryFactId: factItem.id,
        },
      },
      {
        exclusive: mapping.exclusive,
      }
    );

    return relation;
  } catch (err) {
    privacyLog('debug', 'SYNC_MEMORY_FACT_TO_GRAPH_FAILED', { error: err.message });
    return null;
  }
}

/**
 * Formats user Knowledge Graph active relations into structured context for LLM injection.
 *
 * @param {string} anonId
 * @param {object} [options]
 * @param {number} [options.limit=15]
 * @returns {string} Formatted context block
 */
export function formatKnowledgeGraphContext(anonId, options = {}) {
  const graph = getKnowledgeGraph(anonId);
  const relations = graph.getRelations(`user:${anonId}`, {
    direction: 'out',
    status: 'active',
  });

  if (relations.length === 0) return '';

  const limit = options.limit || 15;
  const items = relations.slice(0, limit).map((rel) => {
    const targetEnt = graph.getEntity(rel.target);
    const targetName = targetEnt ? targetEnt.name : rel.target;
    return `- ${rel.predicate.toLowerCase().replace(/_/g, ' ')}: ${targetName}`;
  });

  return `Knowledge Graph Context:\n${items.join('\n')}\n`;
}
