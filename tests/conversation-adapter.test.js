import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  computeUserPacing,
  detectTechnicalLevel,
  detectFeedbackSignals,
  detectActiveProject,
  getConversationAdaptationContext,
  getUserProfile,
  updateUserProfile,
  clearUserProfile,
} from '../src/conversation-adapter.js';

test('ConversationAdapter: computeUserPacing filters out model turns and measures user velocity', () => {
  // History with lengthy model response (300 words) but short user turns
  const history = [
    { role: 'user', parts: [{ text: 'How do I start Docker?' }] }, // 5 words
    {
      role: 'model',
      parts: [
        {
          text: 'Docker is a platform designed to help developers build, share, and run modern applications... '.repeat(
            20
          ),
        },
      ],
    },
  ];

  // 1. Terse user turn (< 8 words)
  const tersePacing = computeUserPacing(history, 'Show commands.');
  assert.strictEqual(tersePacing, 'terse');

  // 2. Balanced user turn (8-30 words)
  const balancedPacing = computeUserPacing(
    history,
    'I want to build a Dockerfile for my Node.js application and expose port 3000 for local testing.'
  );
  assert.strictEqual(balancedPacing, 'balanced');

  // 3. Detailed user turn (> 30 words)
  const detailedText =
    'I am attempting to containerize a complex microservice application consisting of multiple background workers, a Redis queue, a Postgres database, and an Express web API. When deploying to Kubernetes, the pods crash with an OOM error after processing large batches of PDF files.';
  const detailedPacing = computeUserPacing([], detailedText);
  assert.strictEqual(detailedPacing, 'detailed');
});

test('ConversationAdapter: detectTechnicalLevel classifies complexity accurately', () => {
  // Advanced
  const adv1 = detectTechnicalLevel([], 'How do I prevent deadlocks and manage concurrency with a distributed mutex?');
  assert.strictEqual(adv1, 'advanced');

  const adv2 = detectTechnicalLevel([], 'We are migrating our monolith to Kubernetes microservices with gRPC.');
  assert.strictEqual(adv2, 'advanced');

  // Intermediate
  const int1 = detectTechnicalLevel([], 'How do I make an async API fetch call in Express?');
  assert.strictEqual(int1, 'intermediate');

  const int2 = detectTechnicalLevel([], 'Can you write a React component that connects to a SQL database?');
  assert.strictEqual(int2, 'intermediate');

  // Foundational
  const found1 = detectTechnicalLevel([], 'What is the capital of France?');
  assert.strictEqual(found1, 'foundational');

  const found2 = detectTechnicalLevel([], 'Tell me a funny story about a golden retriever.');
  assert.strictEqual(found2, 'foundational');
});

test('ConversationAdapter: detectFeedbackSignals recognizes meta-communication directives', () => {
  assert.ok(detectFeedbackSignals('Too long, please summarize').includes('shorter replies'));
  assert.ok(detectFeedbackSignals('TL;DR').includes('shorter replies'));
  assert.ok(detectFeedbackSignals('Give me more detail step by step').includes('expanded depth'));
  assert.ok(detectFeedbackSignals('Code only please').includes('Output solely the code snippet'));
  assert.ok(detectFeedbackSignals('No bullets, just paragraphs').includes('without bullet points'));
  assert.ok(detectFeedbackSignals('Explain like I am 5 in simple terms').includes('simple terms'));
  assert.strictEqual(detectFeedbackSignals('Hello there, how are you today?'), null);
});

test('ConversationAdapter: detectActiveProject captures ongoing projects and goals', () => {
  const p1 = detectActiveProject('I am working on an e-commerce platform using Node.js');
  assert.strictEqual(p1, 'an e-commerce platform');

  const p2 = detectActiveProject("I'm building a mobile finance tracker app with Flutter.");
  assert.strictEqual(p2, 'a mobile finance tracker app');

  const p3 = detectActiveProject('What is the weather in Mumbai?');
  assert.strictEqual(p3, null);
});

test('ConversationAdapter: getConversationAdaptationContext generates high-density directives and handles edge cases', () => {
  // 1. Null / undefined anonId returns empty string safely
  assert.strictEqual(getConversationAdaptationContext(null, [], 'Hello'), '');
  assert.strictEqual(getConversationAdaptationContext(undefined, [], 'Hello'), '');

  // 2. Turn 1 with standard question returns empty string (no token waste)
  assert.strictEqual(getConversationAdaptationContext('u_test_1', [], 'What is a prime number?'), '');

  // 3. Turn 1 with immediate feedback directive
  const ctx1 = getConversationAdaptationContext('u_test_1', [], 'Explain Docker, code only please.');
  assert.ok(ctx1.includes('[CONVERSATIONAL CONTINUITY & DYNAMIC ADAPTATION]'));
  assert.ok(ctx1.includes('Immediate Feedback Directive'));
  assert.ok(ctx1.includes('code snippet'));

  // 4. Developing Turn (Turn 3) with Terse Pacing & Advanced Technical Context
  const historyTurn3 = [
    { role: 'user', parts: [{ text: 'Kubernetes deployment' }] },
    { role: 'model', parts: [{ text: 'Here is a deployment YAML...' }] },
    { role: 'user', parts: [{ text: 'Add ingress' }] },
    { role: 'model', parts: [{ text: 'Here is the ingress config...' }] },
  ];
  const ctx3 = getConversationAdaptationContext('u_test_2', historyTurn3, 'Add TLS certificates');
  assert.ok(ctx3.includes('Turn 3'));
  assert.ok(ctx3.includes('Pacing Match: User prefers brevity'));
  assert.ok(ctx3.includes('Technical Calibration: Advanced'));

  // 5. Deep Dialogue (Turn 6+) with Active Project
  const historyTurn6 = [
    { role: 'user', parts: [{ text: 'I am building a chat app' }] },
    { role: 'model', parts: [{ text: 'Great project.' }] },
    { role: 'user', parts: [{ text: 'Next step' }] },
    { role: 'model', parts: [{ text: 'Set up auth.' }] },
    { role: 'user', parts: [{ text: 'Done' }] },
    { role: 'model', parts: [{ text: 'Next is database.' }] },
    { role: 'user', parts: [{ text: 'Done' }] },
    { role: 'model', parts: [{ text: 'Next is websockets.' }] },
    { role: 'user', parts: [{ text: 'Done' }] },
    { role: 'model', parts: [{ text: 'Now testing.' }] },
  ];
  const ctx6 = getConversationAdaptationContext('u_test_3', historyTurn6, 'How do I test websockets?');
  assert.ok(ctx6.includes('Deep Dialogue (Turn 6)'));
  assert.ok(ctx6.includes('High-attunement mode'));
  assert.ok(ctx6.includes('a chat app'));
});

test('ConversationAdapter: executes in sub-millisecond synchronous latency (< 0.5ms)', () => {
  const history = [
    { role: 'user', parts: [{ text: 'I am developing a distributed event bus with Kafka' }] },
    { role: 'model', parts: [{ text: 'Response from model' }] },
    { role: 'user', parts: [{ text: 'How do I ensure idempotency in consumer handlers?' }] },
    { role: 'model', parts: [{ text: 'Use a deduplication store.' }] },
  ];

  const start = performance.now();
  for (let i = 0; i < 50; i++) {
    getConversationAdaptationContext('u_perf_user', history, 'Make it shorter and give code only');
  }
  const avgDuration = (performance.now() - start) / 50;

  assert.ok(avgDuration < 0.5, `Average duration was ${avgDuration.toFixed(4)}ms (expected < 0.5ms)`);
});

test('ConversationAdapter: profile lifecycle (get, update, clear)', async () => {
  const anonId = 'u_profile_lifecycle';
  await clearUserProfile(anonId);

  // Initial state
  const initial = getUserProfile(anonId);
  assert.strictEqual(initial.activeProject, null);
  assert.strictEqual(initial.topics.length, 0);

  // Update profile
  await updateUserProfile(anonId, {
    activeProject: 'Portfolio Website',
    topics: ['react', 'nextjs', 'tailwind'],
    preferredPacing: 'terse',
  });

  const updated = getUserProfile(anonId);
  assert.strictEqual(updated.activeProject, 'Portfolio Website');
  assert.strictEqual(updated.preferredPacing, 'terse');
  assert.ok(updated.topics.some((t) => t.name === 'react'));
  assert.ok(updated.topics.some((t) => t.name === 'nextjs'));

  // Clear profile
  await clearUserProfile(anonId);
  const cleared = getUserProfile(anonId);
  assert.strictEqual(cleared.activeProject, null);
  assert.strictEqual(cleared.topics.length, 0);
});
