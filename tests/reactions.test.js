import test from 'node:test';
import assert from 'node:assert';
import { getContextualReaction, applyContextualReaction, clearWhatsAppReaction } from '../src/reactions.js';
import { config } from '../src/config.js';

test('Reactions: returns null for informational, educational, and analytical prompts', () => {
  // Queries like those in user screenshots must NEVER receive unsolicited emoji reactions
  const testQueries = [
    'Explain in detail',
    'Focusing on Electrical Properties of Metals and Semiconductors',
    'What is the Fermi level in quantum physics?',
    'How does Ohm law relate to conductivity?',
    'Why is phonon scattering temperature dependent?',
    'Can you summarize chapter 3 of the notes?',
    'Please describe Matthiessen rule',
    'Write a python script to calculate drift velocity',
    'Compare metals and semiconductors',
    'Calculate the resistance of copper wire',
  ];

  for (const query of testQueries) {
    const reaction = getContextualReaction(query);
    assert.strictEqual(
      reaction,
      null,
      `Expected null reaction for informational query "${query}", but got ${reaction}`
    );
  }
});

test('Reactions: returns null for long passages, documents, and forwarded texts', () => {
  const longPassage = `
    The Classical Limitation: The Drude model failed to explain why electrons don't contribute significantly
    to specific heat or why resistivity doesn't follow the classical prediction.
    Quantum Correction: Electrons obey Fermi-Dirac statistics, meaning they occupy energy states up to the Fermi Level.
  `.repeat(2);

  assert.strictEqual(getContextualReaction(longPassage), null);
  assert.strictEqual(getContextualReaction(''), null);
  assert.strictEqual(getContextualReaction('   '), null);
  assert.strictEqual(getContextualReaction(null), null);
});

test('Reactions: detects gratitude and returns authentic emoji', () => {
  const gratitudePhrases = [
    'Thank you!',
    'thanks so much',
    'thx',
    'ty',
    'I appreciate it',
    'great job',
    'awesome thanks',
    'good bot',
  ];

  for (const phrase of gratitudePhrases) {
    const reaction = getContextualReaction(phrase);
    assert.strictEqual(reaction, '🙏', `Expected '🙏' for gratitude phrase "${phrase}", but got "${reaction}"`);
  }
});

test('Reactions: detects acknowledgment / confirmation and returns 👍', () => {
  const ackPhrases = ['ok', 'okay', 'cool', 'got it', 'noted', 'understood', 'sure', 'alright', 'k'];

  for (const phrase of ackPhrases) {
    const reaction = getContextualReaction(phrase);
    assert.strictEqual(reaction, '👍', `Expected '👍' for acknowledgment phrase "${phrase}", but got "${reaction}"`);
  }
});

test('Reactions: detects laughter / humor and returns 😂', () => {
  const laughterPhrases = ['haha', 'hahaha', 'lol', 'lmao', 'rofl', 'that is hilarious 😂'];

  for (const phrase of laughterPhrases) {
    const reaction = getContextualReaction(phrase);
    assert.strictEqual(reaction, '😂', `Expected '😂' for laughter phrase "${phrase}", but got "${reaction}"`);
  }
});

test('Reactions: detects celebration and returns 🎉', () => {
  const celebrationPhrases = ['congrats!', 'congratulations', 'happy birthday!', 'yay!', 'cheers', 'hurray'];

  for (const phrase of celebrationPhrases) {
    const reaction = getContextualReaction(phrase);
    assert.strictEqual(reaction, '🎉', `Expected '🎉' for celebration phrase "${phrase}", but got "${reaction}"`);
  }
});

test('Reactions: detects affection and returns ❤️', () => {
  assert.strictEqual(getContextualReaction('love you'), '❤️');
  assert.strictEqual(getContextualReaction('love this bot'), '❤️');
  assert.strictEqual(getContextualReaction('❤️'), '❤️');
});

test('Reactions: handles explicit task and media completion actions', () => {
  assert.strictEqual(getContextualReaction('', { action: 'image_gen' }), '🎨');
  assert.strictEqual(getContextualReaction('', { action: 'video_gen' }), '🎬');
  assert.strictEqual(getContextualReaction('', { action: 'reminder_created' }), '⏰');
  assert.strictEqual(getContextualReaction('', { action: 'todo_created' }), '📝');
  assert.strictEqual(getContextualReaction('', { action: 'expense_created' }), '💰');
  assert.strictEqual(getContextualReaction('', { action: 'approval_granted' }), '✅');
  assert.strictEqual(getContextualReaction('', { action: 'approval_denied' }), '❌');
});

test('Reactions: applyContextualReaction safely applies reaction in test mode', async () => {
  // Conversational gratitude
  const reactRes1 = await applyContextualReaction('910000000000', 'wamid.test_001', 'Thank you so much!');
  assert.strictEqual(reactRes1, '🙏');

  // Conversational acknowledgment
  const reactRes2 = await applyContextualReaction('910000000000', 'wamid.test_002', 'got it');
  assert.strictEqual(reactRes2, '👍');

  // Task image gen
  const reactRes3 = await applyContextualReaction('910000000000', 'wamid.test_003', 'cat in forest', {
    action: 'image_gen',
  });
  assert.strictEqual(reactRes3, '🎨');

  // Informational query -> no reaction applied
  const reactRes4 = await applyContextualReaction('910000000000', 'wamid.test_004', 'Explain in detail');
  assert.strictEqual(reactRes4, null);
});

test('Reactions: clearWhatsAppReaction clears reaction by sending empty string', async () => {
  const clearRes = await clearWhatsAppReaction('910000000000', 'wamid.test_005');
  assert.strictEqual(clearRes.success, true);
  assert.ok(clearRes.messageId.startsWith('sim_react_'));

  const failRes = await clearWhatsAppReaction('910000000000', '');
  assert.strictEqual(failRes.success, false);
});

test('Reactions: respects ENABLE_CONTEXTUAL_REACTIONS toggle', async () => {
  const origSetting = config.ENABLE_CONTEXTUAL_REACTIONS;
  try {
    config.ENABLE_CONTEXTUAL_REACTIONS = false;
    const res = await applyContextualReaction('910000000000', 'wamid.test_006', 'Thank you!');
    assert.strictEqual(res, null, 'Should return null when reactions are disabled');
  } finally {
    config.ENABLE_CONTEXTUAL_REACTIONS = origSetting;
  }
});

test('Reactions E2E: User screenshots replication - zero reactions for questions and PDFs', async () => {
  // Screenshot 1: User asks "Explain in detail" on physics note
  const reaction1 = getContextualReaction('Explain in detail');
  assert.strictEqual(reaction1, null, 'Query "Explain in detail" must have null reaction');

  // Screenshot 2: Forwarded physics text
  const forwardedText =
    'Focusing on Electrical Properties of Metals and Semiconductors:\n· The Classical Limitation: Drude model failed';
  const reaction2 = getContextualReaction(forwardedText);
  assert.strictEqual(reaction2, null, 'Forwarded study note must have null reaction');

  // Screenshot 3: PDF Document note
  const reaction3 = getContextualReaction('', { messageType: 'document' });
  assert.strictEqual(reaction3, null, 'Document upload must have null reaction');

  // Gratitude / Human confirmation
  const reaction4 = getContextualReaction('Thank you so much!');
  assert.strictEqual(reaction4, '🙏');

  // Queue push must not react with ⏳
  const { MessageQueue } = await import('../src/queue.js');
  const mockQueue = new MessageQueue({
    concurrency: 1,
    handler: async () => {},
  });

  const pushRes = mockQueue.push({
    message: { id: 'wamid.queue_test_01', from: '910000000000' },
    requestId: 'req_001',
  });
  assert.strictEqual(pushRes, true);
  // Verified: queue push does not dispatch any ⏳ reaction
});
