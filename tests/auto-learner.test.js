import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeterministicFacts, inferInteractionType, autoLearnFromTurn } from '../src/auto-learner.js';
import {
  clearUserMemory,
  getMemoryContext,
  listMemoryFacts,
  setAutoMemoryEnabled,
  handleMemoryCommand,
} from '../src/memory.js';

test('AutoLearner: extracts deterministic user identity, residence, and diet facts', () => {
  // Name
  const name1 = extractDeterministicFacts('Hello! Call me PJ');
  assert.strictEqual(name1.length, 1);
  assert.strictEqual(name1[0].category, 'identity_name');
  assert.ok(name1[0].fact.includes('PJ'));

  // Residence / Location
  const loc1 = extractDeterministicFacts('I live in Bengaluru and love coffee');
  assert.strictEqual(loc1.length, 1);
  assert.strictEqual(loc1[0].category, 'location');
  assert.ok(loc1[0].fact.includes('Bengaluru'));

  // Diet
  const diet1 = extractDeterministicFacts("I'm vegetarian and never eat non-veg");
  assert.strictEqual(diet1.length, 1);
  assert.strictEqual(diet1[0].category, 'diet');
  assert.ok(diet1[0].fact.includes('vegetarian'));

  const diet2 = extractDeterministicFacts("I don't eat meat");
  assert.strictEqual(diet2.length, 1);
  assert.strictEqual(diet2[0].category, 'diet');

  // Allergy
  const allergy = extractDeterministicFacts('I am allergic to peanuts');
  assert.strictEqual(allergy.length, 1);
  assert.strictEqual(allergy[0].category, 'allergy');
  assert.ok(allergy[0].fact.includes('peanuts'));
});

test('AutoLearner: extracts formatting, brevity, and code preferences', () => {
  // Brevity
  const brief = extractDeterministicFacts('Please keep your replies concise and short');
  assert.strictEqual(brief.length, 1);
  assert.strictEqual(brief[0].category, 'output_brevity');

  // Bullet points
  const bullets = extractDeterministicFacts('Always reply in bullet points for me');
  assert.strictEqual(bullets.length, 1);
  assert.strictEqual(bullets[0].category, 'output_format');

  // No emojis
  const noEmoji = extractDeterministicFacts('Please no emojis in your answers');
  assert.strictEqual(noEmoji.length, 1);
  assert.strictEqual(noEmoji[0].category, 'output_emoji');

  // Preferred code language
  const codeLang = extractDeterministicFacts('Always provide code in TypeScript');
  assert.strictEqual(codeLang.length, 1);
  assert.strictEqual(codeLang[0].category, 'preferred_code_lang');
  assert.ok(codeLang[0].fact.includes('TypeScript'));
});

test('AutoLearner: rejects transient states, feelings, and conversational noise', () => {
  assert.strictEqual(extractDeterministicFacts('I am feeling so tired today').length, 0);
  assert.strictEqual(extractDeterministicFacts('I am sorry for the delay').length, 0);
  assert.strictEqual(extractDeterministicFacts("I'm in a cab heading home").length, 0);
  assert.strictEqual(extractDeterministicFacts('What is the weather in Delhi?').length, 0);
  assert.strictEqual(extractDeterministicFacts('Can you summarize this article?').length, 0);
});

test('AutoLearner: classifies interaction types accurately', () => {
  assert.strictEqual(inferInteractionType('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'text'), 'youtube_video');
  assert.strictEqual(inferInteractionType('https://www.instagram.com/reel/DKn-PT1PMnr/', 'text'), 'instagram_reel');
  assert.strictEqual(
    inferInteractionType('https://en.wikipedia.org/wiki/Artificial_intelligence', 'text'),
    'web_summary'
  );
  assert.strictEqual(inferInteractionType('/todo Buy groceries', 'text'), 'todo_action');
  assert.strictEqual(inferInteractionType('/remind submit report in 2 hours', 'text'), 'reminder_action');
  assert.strictEqual(inferInteractionType('```python\ndef hello():\n    print("hi")\n```', 'text'), 'code_query');
  assert.strictEqual(inferInteractionType('Can you explain quantum computing?', 'text'), 'chat');
});

test('AutoLearner: autoLearnFromTurn updates memory and resolves contradictions', async () => {
  const anonId = 'u_auto_learner_test';
  await clearUserMemory(anonId);

  // Turn 1: User discloses name and location
  const turn1 = await autoLearnFromTurn({
    anonId,
    userMessage: 'Hi! Call me PJ and I live in Bengaluru.',
    assistantReply: 'Nice to meet you PJ! How can I help you in Bengaluru today?',
    messageType: 'text',
  });
  assert.strictEqual(turn1.deterministicFactsLearned, 2);

  let context = getMemoryContext(anonId);
  assert.ok(context.includes('PJ'));
  assert.ok(context.includes('Bengaluru'));

  // Turn 2: User relocates (contradiction resolution)
  const turn2 = await autoLearnFromTurn({
    anonId,
    userMessage: 'Actually, I moved to London last month.',
    assistantReply: 'Hope you are enjoying London!',
    messageType: 'text',
  });
  assert.strictEqual(turn2.deterministicFactsLearned, 1);

  context = getMemoryContext(anonId);
  assert.ok(context.includes('London'));
  assert.ok(!context.includes('Bengaluru')); // Old location replaced!

  // Toggle auto-learning off
  await setAutoMemoryEnabled(anonId, false);
  const turn3 = await autoLearnFromTurn({
    anonId,
    userMessage: 'Call me Arthur',
    assistantReply: 'Sure',
    messageType: 'text',
  });
  assert.strictEqual(turn3.deterministicFactsLearned, 0);

  // Still retains PJ
  context = getMemoryContext(anonId);
  assert.ok(context.includes('PJ'));
  assert.ok(!context.includes('Arthur'));

  // Test /memory auto command routing
  const cmdOff = await handleMemoryCommand(anonId, '/memory auto off');
  assert.ok(cmdOff.includes('Paused'));

  const cmdOn = await handleMemoryCommand(anonId, '/memory auto on');
  assert.ok(cmdOn.includes('Enabled'));

  const listText = listMemoryFacts(anonId);
  assert.ok(listText.includes('Learned Preferences'));

  await clearUserMemory(anonId);
});
