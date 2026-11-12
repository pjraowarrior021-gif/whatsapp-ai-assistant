import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentOrchestrator } from '../src/agents/orchestrator.js';

test('Orchestrator: initializes with all 6 specialized agents', () => {
  const o = new AgentOrchestrator();
  const agents = o.listAgents();

  assert.strictEqual(agents.length, 6);
  const names = agents.map((a) => a.name);
  assert.ok(names.includes('conversation'));
  assert.ok(names.includes('research'));
  assert.ok(names.includes('coding'));
  assert.ok(names.includes('document'));
  assert.ok(names.includes('media'));
  assert.ok(names.includes('productivity'));
});

test('Orchestrator: fast-path executes greetings immediately with zero agent hops', async () => {
  const o = new AgentOrchestrator();

  const greetings = ['Hi', 'Hello!', 'good morning', 'hey there', 'how are you?', 'thanks a lot', 'ok cool'];

  for (const greeting of greetings) {
    const isFast = o.isFastPath(greeting);
    assert.strictEqual(isFast, true, `Expected "${greeting}" to trigger fast-path`);

    const result = await o.handleRequest({ message: greeting });
    assert.strictEqual(result.fastPath, true);
    assert.strictEqual(result.hops, 0);
    assert.strictEqual(result.agentUsed, 'conversation');
    assert.strictEqual(result.modelUsed, 'instant-fast-path');
    assert.ok(result.text.length > 0);
  }
});

test('Orchestrator: non-greeting conversational questions route normally without fast-path', async () => {
  const o = new AgentOrchestrator();

  const result = await o.handleRequest({
    message: 'What is your opinion on renewable energy?',
    runner: async ({ prompt }) => ({ text: `Grounded perspective on ${prompt}` }),
  });

  assert.strictEqual(result.fastPath, false);
  assert.strictEqual(result.agentUsed, 'conversation');
  assert.strictEqual(result.hops, 1);
  assert.ok(result.text.includes('renewable energy'));
});

test('Orchestrator: routes coding requests to CodingAgent', async () => {
  const o = new AgentOrchestrator();

  const codeRequests = [
    '```js\nconsole.log(undefined.x);\n```',
    'Write a python script to parse JSON and sort by timestamp',
    'Fix this TypeError: null is not an object',
    'Explain how to optimize this SQL query with an index',
  ];

  for (const msg of codeRequests) {
    const intent = o.classifyIntent(msg);
    assert.strictEqual(intent.agentName, 'coding', `Failed on: ${msg}`);

    const res = await o.handleRequest({
      message: msg,
      runner: async () => ({ text: '```python\n# Solution\n```' }),
    });

    assert.strictEqual(res.agentUsed, 'coding');
    assert.strictEqual(res.hops, 1);
    assert.strictEqual(res.fastPath, false);
    assert.ok(res.text.includes('```'));
  }
});

test('Orchestrator: routes research requests to ResearchAgent', async () => {
  const o = new AgentOrchestrator();

  const researchRequests = [
    'Who is the current prime minister of Australia?',
    'Search for the latest news on Artemis moon mission',
    'Research the history of quantum computing algorithms',
    'https://example.com/article check this out',
  ];

  for (const msg of researchRequests) {
    const intent = o.classifyIntent(msg);
    assert.strictEqual(intent.agentName, 'research', `Failed on: ${msg}`);

    const res = await o.handleRequest({
      message: msg,
      runner: async ({ prompt }) => ({ text: `Synthesized research: ${prompt}` }),
    });

    assert.strictEqual(res.agentUsed, 'research');
  }
});

test('Orchestrator: routes document queries to DocumentAgent', async () => {
  const o = new AgentOrchestrator();

  // 1. Through context document flag
  const resFromContext = await o.handleRequest({
    message: 'Extract summary and action items',
    context: { isDocument: true, mimeType: 'application/pdf' },
  });
  assert.strictEqual(resFromContext.agentUsed, 'document');

  // 2. Through document keywords
  const resFromKeyword = await o.handleRequest({
    message: 'Summarize document and extract tables from the quarterly report',
  });
  assert.strictEqual(resFromKeyword.agentUsed, 'document');
});

test('Orchestrator: routes vision and audio to MediaAgent', async () => {
  const o = new AgentOrchestrator();

  // Image input
  const resImage = await o.handleRequest({
    message: 'What is shown here?',
    context: { hasImage: true, mimeType: 'image/jpeg' },
  });
  assert.strictEqual(resImage.agentUsed, 'media');

  // Audio input
  const resAudio = await o.handleRequest({
    message: '',
    context: { hasAudio: true, mimeType: 'audio/ogg' },
  });
  assert.strictEqual(resAudio.agentUsed, 'media');

  // Generative image prompt
  const resGen = await o.handleRequest({
    message: 'Generate an image of a futuristic floating city in sunset',
  });
  assert.strictEqual(resGen.agentUsed, 'media');
});

test('Orchestrator: routes productivity requests to ProductivityAgent and triggers tools', async () => {
  const o = new AgentOrchestrator();
  const executedTools = [];

  const mockToolExecutor = async (name, args) => {
    executedTools.push({ name, args });
    if (name === 'schedule_reminder') {
      return { success: true, message: 'Reminder set for 18:00' };
    }
    if (name === 'add_todo_task') {
      return { success: true, task_id: 'task_abc123' };
    }
    if (name === 'get_current_time') {
      return { current_time: '18:30:00', timezone: args.timezone || 'Asia/Kolkata' };
    }
    if (name === 'get_current_weather') {
      return { condition: 'Sunny', temperature: '28°C' };
    }
    return { status: 'success' };
  };

  // 1. Reminder
  const remRes = await o.handleRequest({
    message: 'remind me to call accountant at 18:00',
    customToolExecutor: mockToolExecutor,
  });
  assert.strictEqual(remRes.agentUsed, 'productivity');
  assert.ok(remRes.text.includes('Reminder Scheduled'));
  assert.ok(remRes.toolsExecuted.includes('schedule_reminder'));

  // 2. Todo
  const todoRes = await o.handleRequest({
    message: 'add todo: Buy groceries and almond milk',
    customToolExecutor: mockToolExecutor,
  });
  assert.strictEqual(todoRes.agentUsed, 'productivity');
  assert.ok(todoRes.text.includes('Task Added to To-Do List'));
  assert.ok(todoRes.toolsExecuted.includes('add_todo_task'));

  // 3. Time
  const timeRes = await o.handleRequest({
    message: 'what time is it in Asia/Tokyo?',
    customToolExecutor: mockToolExecutor,
  });
  assert.strictEqual(timeRes.agentUsed, 'productivity');
  assert.ok(timeRes.text.includes('Current Time'));
  assert.ok(timeRes.toolsExecuted.includes('get_current_time'));

  // 4. Weather
  const weatherRes = await o.handleRequest({
    message: 'what is the weather in Mumbai?',
    customToolExecutor: mockToolExecutor,
  });
  assert.strictEqual(weatherRes.agentUsed, 'productivity');
  assert.ok(weatherRes.text.includes('Weather in Mumbai'));
  assert.ok(weatherRes.toolsExecuted.includes('get_current_weather'));
});

test('Orchestrator: enforces strict tool permission boundaries across agents', async () => {
  const o = new AgentOrchestrator();

  const codingAgent = o.getAgent('coding');
  const convAgent = o.getAgent('conversation');
  const prodAgent = o.getAgent('productivity');

  // CodingAgent allowed tools
  assert.strictEqual(codingAgent.isToolAllowed('format_code'), true);
  assert.strictEqual(codingAgent.isToolAllowed('schedule_reminder'), false);
  assert.strictEqual(codingAgent.isToolAllowed('web_search'), false);

  // ConversationAgent allowed tools (empty set)
  assert.strictEqual(convAgent.isToolAllowed('schedule_reminder'), false);
  assert.strictEqual(convAgent.isToolAllowed('format_code'), false);

  // ProductivityAgent allowed tools
  assert.strictEqual(prodAgent.isToolAllowed('schedule_reminder'), true);
  assert.strictEqual(prodAgent.isToolAllowed('format_code'), false);

  // Tool permission execution rejection
  await assert.rejects(
    async () => {
      await o.executeToolWithPermission(codingAgent, 'schedule_reminder', { when: 'now' });
    },
    (err) => {
      assert.ok(err.message.includes('[PERMISSION_DENIED]'));
      assert.ok(err.message.includes("not permitted for agent 'coding'"));
      return true;
    }
  );
});

test('Orchestrator: loop protection halts delegation at maxAgentHops (3)', async () => {
  const o = new AgentOrchestrator({ maxAgentHops: 3 });

  // Custom agent that recursively delegates
  class LoopingAgent {
    constructor(name, nextTarget) {
      this.name = name;
      this.role = 'Looping test agent';
      this.allowedTools = new Set();
      this.nextTarget = nextTarget;
    }
    isToolAllowed() {
      return false;
    }
    canHandle() {
      return 0.99;
    }
    async execute({ message, delegateTo }) {
      if (typeof delegateTo === 'function') {
        const delRes = await delegateTo(this.nextTarget, `Delegated from ${this.name}: ${message}`);
        return {
          text: `Final from ${this.name} (child: ${delRes.text})`,
          loopHalted: delRes.halted || false,
        };
      }
      return { text: `Terminated at ${this.name}` };
    }
  }

  // Register cyclical agents A -> B -> C -> A
  o.registerAgent('agent_a', new LoopingAgent('agent_a', 'agent_b'));
  o.registerAgent('agent_b', new LoopingAgent('agent_b', 'agent_c'));
  o.registerAgent('agent_c', new LoopingAgent('agent_c', 'agent_a'));

  const result = await o.handleRequest({
    message: 'Start loop test',
    runner: async () => ({ text: 'mock' }),
  });

  // Must halt at max hops = 3
  assert.strictEqual(result.hops, 3);
  assert.strictEqual(result.loopHalted, true);
  assert.strictEqual(result.delegations.length, 2);
  assert.ok(result.text.includes('Loop safeguard triggered'));
});
