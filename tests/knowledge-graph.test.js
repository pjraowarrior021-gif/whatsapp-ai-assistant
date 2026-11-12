import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PersonalKnowledgeGraph,
  getKnowledgeGraph,
  loadKnowledgeGraph,
  saveKnowledgeGraph,
  clearKnowledgeGraph,
  getEntity,
  getRelations,
  searchGraph,
  findRelatedContext,
  exportGraph,
  deleteFact,
  syncMemoryFactToGraph,
  formatKnowledgeGraphContext,
  ENTITY_TYPES,
  normalizeEntityId,
} from '../src/knowledge-graph.js';
import { clearUserMemory, addMemoryFact, handleMemoryCommand } from '../src/memory.js';
import { autoLearnFromTurn } from '../src/auto-learner.js';

test('KnowledgeGraph: Entity lifecycle, normalization, and bounds', () => {
  const anonId = 'u_kg_ent_test';
  const kg = new PersonalKnowledgeGraph(anonId);

  // Root User entity exists by default
  const rootUser = kg.getEntity(`user:${anonId}`);
  assert.ok(rootUser);
  assert.strictEqual(rootUser.type, ENTITY_TYPES.USER);
  assert.strictEqual(rootUser.attributes.anonId, anonId);

  // Normalization
  assert.strictEqual(normalizeEntityId('Project', 'Alpha Beta'), 'project:alpha_beta');
  assert.strictEqual(normalizeEntityId('Topic', 'Node.js'), 'topic:node_js');
  assert.strictEqual(normalizeEntityId('Custom', 'custom:existing_id'), 'custom:existing_id');

  // Add Project entity
  const proj = kg.addEntity({
    type: ENTITY_TYPES.PROJECT,
    name: 'Project Phoenix',
    attributes: { repo: 'phoenix-core', language: 'TypeScript' },
  });
  assert.strictEqual(proj.id, 'project:project_phoenix');
  assert.strictEqual(proj.type, ENTITY_TYPES.PROJECT);
  assert.strictEqual(proj.name, 'Project Phoenix');
  assert.strictEqual(proj.attributes.language, 'TypeScript');

  // Add Device & Preference entities
  const dev = kg.addEntity({
    id: 'device:macbook_pro',
    type: ENTITY_TYPES.DEVICE,
    name: 'MacBook Pro M2',
    attributes: { os: 'macOS' },
  });
  assert.ok(dev);
  assert.strictEqual(kg.hasEntity('device:macbook_pro'), true);
  assert.strictEqual(kg.getEntity('device:macbook_pro').name, 'MacBook Pro M2');

  // Update existing entity
  const updatedDev = kg.addEntity({
    id: 'device:macbook_pro',
    name: 'MacBook Pro M3 Max',
    attributes: { ram: '64GB' },
  });
  assert.strictEqual(updatedDev.name, 'MacBook Pro M3 Max');
  assert.strictEqual(updatedDev.attributes.os, 'macOS');
  assert.strictEqual(updatedDev.attributes.ram, '64GB');

  // Entity deletion
  const removed = kg.removeEntity('device:macbook_pro');
  assert.strictEqual(removed, true);
  assert.strictEqual(kg.hasEntity('device:macbook_pro'), false);
  assert.strictEqual(kg.getEntity('device:macbook_pro'), null);

  // Cannot delete root User entity
  const userRemoved = kg.removeEntity(`user:${anonId}`);
  assert.strictEqual(userRemoved, false);
  assert.ok(kg.getEntity(`user:${anonId}`));
});

test('KnowledgeGraph: Relation triples, confidence, provenance, and duplicate reinforcement', () => {
  const anonId = 'u_kg_rel_test';
  const kg = new PersonalKnowledgeGraph(anonId);
  const userId = `user:${anonId}`;

  // Add relations: USER -> WORKS_ON -> ProjectX, ProjectX -> USES -> Node.js
  const rel1 = kg.addRelation({
    source: userId,
    predicate: 'WORKS_ON',
    target: 'project:alpha',
    category: 'project',
    confidence: 0.9,
    provenance: 'direct_message',
    metadata: { role: 'Lead Architect' },
  });
  assert.ok(rel1.id);
  assert.strictEqual(rel1.predicate, 'WORKS_ON');
  assert.strictEqual(rel1.source, userId);
  assert.strictEqual(rel1.target, 'project:alpha');
  assert.strictEqual(rel1.temporal.status, 'active');
  assert.strictEqual(rel1.temporal.valid_until, null);
  assert.strictEqual(rel1.confidence, 0.9);

  const rel2 = kg.addRelation({
    source: 'project:alpha',
    predicate: 'USES',
    target: 'topic:nodejs',
    category: 'tech_stack',
    confidence: 0.95,
    provenance: 'inferred',
  });
  assert.ok(rel2.id);
  assert.strictEqual(rel2.predicate, 'USES');

  // Duplicate reinforcement: adding exact same relation updates confidence and does not duplicate
  const rel1Reinforced = kg.addRelation({
    source: userId,
    predicate: 'WORKS_ON',
    target: 'project:alpha',
    category: 'project',
    confidence: 0.99,
  });
  assert.strictEqual(rel1Reinforced.id, rel1.id);
  assert.strictEqual(rel1Reinforced.confidence, 0.99);

  // Query relations by direction
  const userOutRelations = kg.getRelations(userId, { direction: 'out' });
  assert.strictEqual(userOutRelations.length, 1);
  assert.strictEqual(userOutRelations[0].target, 'project:alpha');

  const projInRelations = kg.getRelations('project:alpha', { direction: 'in' });
  assert.strictEqual(projInRelations.length, 1);
  assert.strictEqual(projInRelations[0].source, userId);

  const projBothRelations = kg.getRelations('project:alpha', { direction: 'both' });
  assert.strictEqual(projBothRelations.length, 2);
});

test('KnowledgeGraph: Contradiction & Supersession detection for mutually exclusive categories', () => {
  const anonId = 'u_kg_supersession_test';
  const kg = new PersonalKnowledgeGraph(anonId);
  const userId = `user:${anonId}`;

  // Fact 1: User prefers VS Code (editor category is mutually exclusive)
  const relEditor1 = kg.addRelation({
    source: userId,
    predicate: 'PREFERS',
    target: 'tool:vscode',
    category: 'editor',
    confidence: 0.9,
    provenance: 'user_command',
  });
  assert.strictEqual(relEditor1.temporal.status, 'active');
  assert.strictEqual(relEditor1.supersededBy, null);

  // Fact 2: User switches from VS Code to Neovim
  const relEditor2 = kg.addRelation({
    source: userId,
    predicate: 'PREFERS',
    target: 'tool:neovim',
    category: 'editor',
    confidence: 0.95,
    provenance: 'direct_message',
  });

  // Verify that older relation was marked superseded
  const oldRel = kg.getRelation(relEditor1.id);
  assert.strictEqual(oldRel.temporal.status, 'superseded');
  assert.ok(oldRel.temporal.valid_until > 0);
  assert.strictEqual(oldRel.supersededBy, relEditor2.id);

  // Verify new relation is active
  assert.strictEqual(relEditor2.temporal.status, 'active');
  assert.strictEqual(relEditor2.temporal.valid_until, null);

  // Querying active relations returns only Neovim
  const activeEditor = kg.getRelations(userId, { category: 'editor', status: 'active' });
  assert.strictEqual(activeEditor.length, 1);
  assert.strictEqual(activeEditor[0].target, 'tool:neovim');

  // Querying superseded relations returns VS Code
  const supersededEditor = kg.getRelations(userId, { category: 'editor', status: 'superseded' });
  assert.strictEqual(supersededEditor.length, 1);
  assert.strictEqual(supersededEditor[0].target, 'tool:vscode');

  // Querying all relations returns both
  const allEditor = kg.getRelations(userId, { category: 'editor', status: 'all' });
  assert.strictEqual(allEditor.length, 2);

  // Location supersession test (Single-valued predicate LOCATED_IN)
  const loc1 = kg.addRelation({
    source: userId,
    predicate: 'LOCATED_IN',
    target: 'loc:bengaluru',
    category: 'location',
  });
  assert.strictEqual(loc1.temporal.status, 'active');

  const loc2 = kg.addRelation({
    source: userId,
    predicate: 'LOCATED_IN',
    target: 'loc:london',
    category: 'location',
  });
  assert.strictEqual(kg.getRelation(loc1.id).temporal.status, 'superseded');
  assert.strictEqual(kg.getRelation(loc1.id).supersededBy, loc2.id);
  assert.strictEqual(loc2.temporal.status, 'active');
});

test('KnowledgeGraph: Fact deletion and retraction lifecycle', () => {
  const anonId = 'u_kg_del_test';
  const kg = new PersonalKnowledgeGraph(anonId);
  const userId = `user:${anonId}`;

  const rel = kg.addRelation({
    source: userId,
    predicate: 'HAS_DIET',
    target: 'pref:vegan',
    category: 'diet',
  });

  // Soft retraction by default
  const retracted = kg.deleteFact(rel.id);
  assert.strictEqual(retracted, true);

  const afterRetract = kg.getRelation(rel.id);
  assert.strictEqual(afterRetract.temporal.status, 'retracted');
  assert.ok(afterRetract.temporal.valid_until > 0);

  // Retracted facts are excluded from default active queries
  assert.strictEqual(kg.getRelations(userId, { status: 'active' }).length, 0);

  // Hard delete option removes relation completely
  const hardDeleted = kg.deleteFact(rel.id, { hardDelete: true });
  assert.strictEqual(hardDeleted, true);
  assert.strictEqual(kg.getRelation(rel.id), null);
});

test('KnowledgeGraph: Search and Multi-hop Graph Traversal (findRelatedContext)', () => {
  const anonId = 'u_kg_traversal_test';
  const kg = new PersonalKnowledgeGraph(anonId);
  const userId = `user:${anonId}`;

  // Build interconnected graph:
  // USER -> WORKS_ON -> ProjectAlpha
  // ProjectAlpha -> USES -> Node.js
  // ProjectAlpha -> DEPLOYED_TO -> AWS
  // USER -> PREFERS -> Dark Mode
  kg.addEntity({ id: 'project:alpha', type: ENTITY_TYPES.PROJECT, name: 'Project Alpha' });
  kg.addEntity({ id: 'topic:nodejs', type: ENTITY_TYPES.TOPIC, name: 'Node.js' });
  kg.addEntity({ id: 'env:aws', type: ENTITY_TYPES.ENVIRONMENT, name: 'Amazon Web Services' });
  kg.addEntity({ id: 'pref:dark_mode', type: ENTITY_TYPES.PREFERENCE, name: 'Dark Mode' });

  kg.addRelation({
    source: userId,
    predicate: 'WORKS_ON',
    target: 'project:alpha',
    category: 'project',
  });
  kg.addRelation({
    source: 'project:alpha',
    predicate: 'USES',
    target: 'topic:nodejs',
    category: 'tech_stack',
  });
  kg.addRelation({
    source: 'project:alpha',
    predicate: 'DEPLOYED_TO',
    target: 'env:aws',
    category: 'cloud',
  });
  kg.addRelation({
    source: userId,
    predicate: 'PREFERS',
    target: 'pref:dark_mode',
    category: 'preference',
  });

  // searchGraph
  const searchResults = kg.searchGraph('Alpha');
  assert.ok(searchResults.entities.some((e) => e.name === 'Project Alpha'));
  assert.ok(searchResults.relations.some((r) => r.target === 'project:alpha'));

  // findRelatedContext from topic 'Node.js' traverses back to Project Alpha and User
  const context = kg.findRelatedContext('Node.js', { maxDepth: 2 });
  assert.ok(context.rootEntities.some((e) => e.name === 'Node.js'));
  assert.ok(context.connectedEntities.some((e) => e.name === 'Project Alpha'));
  assert.ok(context.contextText.includes('uses Node.js'));

  // findRelatedContext from Project Alpha
  const projContext = kg.findRelatedContext('Project Alpha', { maxDepth: 2 });
  assert.ok(projContext.contextText.includes('uses Node.js'));
  assert.ok(projContext.contextText.includes('deployed to Amazon Web Services'));
});

test('KnowledgeGraph: Export and import graph snapshots', () => {
  const anonId = 'u_kg_export_test';
  const kg = new PersonalKnowledgeGraph(anonId);
  const userId = `user:${anonId}`;

  kg.addRelation({
    source: userId,
    predicate: 'HAS_CONTACT',
    target: 'contact:alice',
    category: 'contact',
  });

  const snapshot = kg.exportGraph();
  assert.strictEqual(snapshot.anonId, anonId);
  assert.ok(snapshot.stats.totalEntities >= 2);
  assert.strictEqual(snapshot.stats.activeRelations, 1);

  // Restore snapshot into fresh graph
  const freshKg = new PersonalKnowledgeGraph('restored_user');
  freshKg.importGraph(snapshot);
  assert.strictEqual(freshKg.getRelations(userId, { status: 'active' }).length, 1);
});

test('KnowledgeGraph: Top-level API and multi-user isolation', () => {
  const userA = 'u_kg_user_a';
  const userB = 'u_kg_user_b';

  const kgA = getKnowledgeGraph(userA);
  const kgB = getKnowledgeGraph(userB);

  kgA.addRelation({
    source: `user:${userA}`,
    predicate: 'WORKS_ON',
    target: 'project:secret_a',
    category: 'project',
  });

  kgB.addRelation({
    source: `user:${userB}`,
    predicate: 'WORKS_ON',
    target: 'project:secret_b',
    category: 'project',
  });

  // Zero cross-user leakage
  assert.strictEqual(kgA.getRelations(`user:${userA}`).length, 1);
  assert.strictEqual(kgA.getRelations(`user:${userB}`).length, 0);

  // Top-level exported functions work seamlessly
  const topEnt = getEntity(`user:${userA}`, userA);
  assert.ok(topEnt);

  const topRels = getRelations(`user:${userA}`, {}, userA);
  assert.strictEqual(topRels.length, 1);
  assert.strictEqual(topRels[0].target, 'project:secret_a');

  const topContext = findRelatedContext('secret_a', {}, userA);
  assert.ok(topContext.contextText.includes('secret_a'));

  const searched = searchGraph('secret_a', {}, userA);
  assert.ok(searched.relations.length >= 1);

  const ctxStr = formatKnowledgeGraphContext(userA);
  assert.ok(ctxStr.includes('secret_a'));

  const synced = syncMemoryFactToGraph(userA, { id: 'test_sync', text: 'I love TypeScript', category: 'general' });
  assert.ok(synced);

  const exported = exportGraph(userA);
  assert.strictEqual(exported.anonId, userA);

  const delResult = deleteFact(topRels[0].id, userA);
  assert.strictEqual(delResult, true);
});

test('KnowledgeGraph: Persistence hooks (save, load, clear)', async () => {
  const anonId = 'u_kg_persist_test';
  await clearKnowledgeGraph(anonId);

  const kg = getKnowledgeGraph(anonId);
  kg.addRelation({
    source: `user:${anonId}`,
    predicate: 'PREFERS',
    target: 'pref:dark_mode',
    category: 'theme',
  });

  const saved = await saveKnowledgeGraph(anonId);
  assert.strictEqual(saved, true);

  // Clear in-memory cache and re-load from persistent store
  await clearKnowledgeGraph(anonId, { memoryOnly: true });
  const loadedKg = await loadKnowledgeGraph(anonId);
  const rels = loadedKg.getRelations(`user:${anonId}`, { status: 'active' });
  assert.strictEqual(rels.length, 1);
  assert.strictEqual(rels[0].target, 'pref:dark_mode');

  await clearKnowledgeGraph(anonId);
});

test('KnowledgeGraph: Integration with Memory and Auto-Learner with contradiction supersession', async () => {
  const anonId = 'u_kg_integration_test';
  await clearUserMemory(anonId);
  await clearKnowledgeGraph(anonId);

  // 1. Add manual memory fact
  const add1 = await addMemoryFact(anonId, 'I live in Paris');
  assert.strictEqual(add1.success, true);

  const kg = getKnowledgeGraph(anonId);
  const rels1 = kg.getRelations(`user:${anonId}`, { status: 'active', category: 'location' });
  assert.strictEqual(rels1.length, 1);
  assert.ok(rels1[0].target.includes('paris'));

  // 2. Autonomous learning turn with contradiction
  await autoLearnFromTurn({
    anonId,
    userMessage: 'Actually, I moved to Tokyo last week.',
    assistantReply: 'Tokyo is an incredible city!',
    messageType: 'text',
  });

  // Knowledge graph should reflect Tokyo as active, and Paris as superseded!
  const activeLocs = kg.getRelations(`user:${anonId}`, { status: 'active', category: 'location' });
  assert.strictEqual(activeLocs.length, 1);
  assert.ok(activeLocs[0].target.includes('tokyo'));

  const supersededLocs = kg.getRelations(`user:${anonId}`, { status: 'superseded', category: 'location' });
  assert.strictEqual(supersededLocs.length, 1);
  assert.ok(supersededLocs[0].target.includes('paris'));
  assert.strictEqual(supersededLocs[0].supersededBy, activeLocs[0].id);

  // 3. /memory graph command
  const graphCmdRes = await handleMemoryCommand(anonId, '/memory graph');
  assert.ok(graphCmdRes.includes('Personal Knowledge Graph'));
  assert.ok(graphCmdRes.includes('Tokyo') || graphCmdRes.includes('tokyo'));

  // 4. Memory deletion cascading to graph
  await addMemoryFact(anonId, 'Vegetarian diet only');
  const dietRels = kg.getRelations(`user:${anonId}`, { status: 'active', category: 'diet' });
  assert.strictEqual(dietRels.length, 1);

  // 5. Cleanup
  await clearUserMemory(anonId);
  assert.strictEqual(kg.getRelations(`user:${anonId}`, { status: 'active' }).length, 0);
});
