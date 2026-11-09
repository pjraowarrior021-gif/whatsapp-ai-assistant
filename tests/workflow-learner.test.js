import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordUserInteraction,
  getLearnedWorkflowContext,
  listLearnedWorkflows,
  clearLearnedWorkflows,
} from '../src/workflow-learner.js';

test('WorkflowLearner: records interactions and reinforces habits based on sequences', async () => {
  const anonId = 'u_workflow_test';
  await clearLearnedWorkflows(anonId);

  // Initial state: no habits
  assert.strictEqual(getLearnedWorkflowContext(anonId), '');
  assert.strictEqual(listLearnedWorkflows(anonId).length, 0);

  // 1st media interaction
  const res1 = await recordUserInteraction(anonId, 'youtube_video', { url: 'https://youtu.be/abc' });
  assert.strictEqual(res1.habitDetected, false);

  // 2nd media interaction -> triggers media_actionable_highlights
  const res2 = await recordUserInteraction(anonId, 'instagram_reel', { url: 'https://instagram.com/reel/xyz' });
  assert.strictEqual(res2.habitDetected, true);
  assert.strictEqual(res2.habitName, 'media_actionable_highlights');

  // Context now includes workflow directive
  const context = getLearnedWorkflowContext(anonId);
  assert.ok(context.includes('LEARNED USER WORKFLOW DIRECTIVES'));
  assert.ok(context.includes('actionable takeaways'));

  // 1st code query
  const code1 = await recordUserInteraction(anonId, 'code_query');
  assert.strictEqual(code1.habitDetected, false);

  // 2nd code query -> triggers code_solution_first
  const code2 = await recordUserInteraction(anonId, 'code_query');
  assert.strictEqual(code2.habitDetected, true);
  assert.strictEqual(code2.habitName, 'code_solution_first');

  // Verify list
  const habits = listLearnedWorkflows(anonId);
  assert.strictEqual(habits.length, 2);
  assert.ok(habits.some((h) => h.id === 'media_actionable_highlights'));
  assert.ok(habits.some((h) => h.id === 'code_solution_first'));

  // Clear workflows
  await clearLearnedWorkflows(anonId);
  assert.strictEqual(getLearnedWorkflowContext(anonId), '');
  assert.strictEqual(listLearnedWorkflows(anonId).length, 0);
});
