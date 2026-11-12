/**
 * Multi-Agent Orchestrator
 * Central coordinator for specialized AI agents with instant fast-path greetings,
 * loop protection (maxAgentHops: 3), and strict tool permission boundaries.
 */
import { privacyLog } from '../privacy.js';
import { modelRouter } from '../model-router.js';
import { ConversationAgent } from './conversation.js';
import { ResearchAgent } from './research.js';
import { CodingAgent } from './coding.js';
import { DocumentAgent } from './document.js';
import { MediaAgent } from './media.js';
import { ProductivityAgent } from './productivity.js';

export class AgentOrchestrator {
  constructor(options = {}) {
    this.maxAgentHops = Number(options.maxAgentHops) || 3;
    this.modelRouter = options.modelRouter || modelRouter;
    this.agents = new Map();
    this.toolExecutor = options.toolExecutor || null;

    // Register built-in specialized agents
    this.registerAgent('conversation', new ConversationAgent(options.conversationOptions));
    this.registerAgent('research', new ResearchAgent(options.researchOptions));
    this.registerAgent('coding', new CodingAgent(options.codingOptions));
    this.registerAgent('document', new DocumentAgent(options.documentOptions));
    this.registerAgent('media', new MediaAgent(options.mediaOptions));
    this.registerAgent('productivity', new ProductivityAgent(options.productivityOptions));
  }

  /**
   * Registers an agent in the orchestrator.
   * @param {string} name
   * @param {object} agentInstance
   */
  registerAgent(name, agentInstance) {
    if (!name || !agentInstance) {
      throw new Error('Agent name and instance are required');
    }
    this.agents.set(name, agentInstance);
  }

  /**
   * Retrieves an agent by name.
   * @param {string} name
   * @returns {object|null}
   */
  getAgent(name) {
    return this.agents.get(name) || null;
  }

  /**
   * Lists all registered agents and their roles.
   * @returns {Array<{ name: string, role: string, taskType: string, allowedTools: string[] }>}
   */
  listAgents() {
    return Array.from(this.agents.entries()).map(([name, agent]) => ({
      name,
      role: agent.role,
      taskType: agent.taskType,
      allowedTools: Array.from(agent.allowedTools || []),
    }));
  }

  /**
   * Fast-path check: returns true if the request can be answered instantly
   * by the ConversationAgent with zero planning or multi-hop overhead (< 1 turn).
   * @param {string} message
   * @param {object} context
   * @returns {boolean}
   */
  isFastPath(message = '', context = {}) {
    if (context.hasImage || context.hasAudio || context.isDocument || context.media) {
      return false;
    }
    const convAgent = this.getAgent('conversation');
    return Boolean(convAgent && convAgent.isGreeting(message));
  }

  /**
   * Classifies user intent and selects the optimal primary agent.
   * @param {string} message
   * @param {object} context
   * @returns {{ agentName: string, confidence: number, reason: string }}
   */
  classifyIntent(message = '', context = {}) {
    // 1. Fast-path greeting
    if (this.isFastPath(message, context)) {
      return {
        agentName: 'conversation',
        confidence: 1.0,
        reason: 'Fast-path greeting or conversational acknowledgement',
      };
    }

    // 2. Score across all registered agents
    const candidates = [];
    for (const [name, agent] of this.agents.entries()) {
      const score = typeof agent.canHandle === 'function' ? agent.canHandle(message, context) : 0.0;
      candidates.push({ agentName: name, confidence: score, agent });
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];

    if (best && best.confidence >= 0.5) {
      return {
        agentName: best.agentName,
        confidence: best.confidence,
        reason: `Matched specialized agent '${best.agentName}' with confidence ${best.confidence}`,
      };
    }

    // Default: conversational agent
    return {
      agentName: 'conversation',
      confidence: 0.5,
      reason: 'Default general conversation handler',
    };
  }

  /**
   * Strictly enforces tool permission boundaries.
   * Throws a PermissionDenied error if an agent attempts to invoke an unauthorized tool.
   * @param {object} agent
   * @param {string} toolName
   * @param {object} args
   * @param {object} context
   * @returns {Promise<any>}
   */
  async executeToolWithPermission(agent, toolName, args = {}, context = {}) {
    if (!agent || typeof agent.isToolAllowed !== 'function' || !agent.isToolAllowed(toolName)) {
      const errorMsg = `[PERMISSION_DENIED] Tool '${toolName}' is not permitted for agent '${agent?.name || 'unknown'}'.`;
      privacyLog('warn', 'AGENT_TOOL_PERMISSION_DENIED', {
        agent: agent?.name,
        tool: toolName,
      });
      throw new Error(errorMsg);
    }

    if (typeof this.toolExecutor === 'function') {
      return await this.toolExecutor(toolName, args, context);
    }

    // Default mock success if no external executor bound
    return { status: 'success', tool: toolName, executed: true };
  }

  /**
   * Main Orchestrator request dispatcher.
   * Orchestrates agents with fast-path bypass, loop protection (maxAgentHops),
   * strict tool boundaries, and model fallback integration.
   *
   * @param {object} params - { message, user, context, runner, customToolExecutor }
   * @returns {Promise<{ text: string, agentUsed: string, fastPath: boolean, hops: number, modelUsed: string, latencyMs: number, toolsExecuted: string[], delegations: Array }>}
   */
  async handleRequest({ message = '', user = 'default_user', context = {}, runner = null, customToolExecutor = null }) {
    const startTime = Date.now();
    const effectiveToolExecutor = customToolExecutor || this.toolExecutor;

    // --- Fast-Path Greeting Evaluation (< 1 turn) ---
    if (this.isFastPath(message, context)) {
      const convAgent = this.getAgent('conversation');
      const fastResult = await convAgent.execute({ message, context });
      const latencyMs = Date.now() - startTime;

      return {
        text: fastResult.text,
        agentUsed: 'conversation',
        fastPath: true,
        hops: 0,
        modelUsed: 'instant-fast-path',
        latencyMs,
        toolsExecuted: [],
        delegations: [],
      };
    }

    // --- Intent Classification ---
    const intent = this.classifyIntent(message, context);
    let currentAgentName = intent.agentName;
    let currentAgent = this.getAgent(currentAgentName);

    if (!currentAgent) {
      currentAgentName = 'conversation';
      currentAgent = this.getAgent('conversation');
    }

    let hops = 1;
    const delegations = [];
    const allToolsExecuted = [];
    let loopHalted = false;
    let finalModelUsed = 'unknown';

    // Model execution wrapper using modelRouter fallback
    const safeRunner = async ({ taskType, systemInstruction, prompt, tools = [] }) => {
      const optimalRoute = this.modelRouter.routeTask(taskType, {
        requireTools: tools.length > 0,
        userId: user,
      });

      if (typeof runner === 'function') {
        const res = await runner({
          model: optimalRoute.modelId,
          taskType,
          systemInstruction,
          prompt,
          context,
          tools,
        });
        finalModelUsed = optimalRoute.modelId;
        return res;
      }

      // Default fallback mock response
      finalModelUsed = optimalRoute.modelId;
      return {
        text: `Response processed by ${currentAgentName} using ${optimalRoute.modelId}.`,
        tokens: { prompt: 20, completion: 30 },
      };
    };

    // Safe tool call function bound to current agent
    const makeSafeToolCaller =
      (agent) =>
      async (toolName, args = {}) => {
        allToolsExecuted.push(toolName);
        if (typeof agent.isToolAllowed === 'function' && !agent.isToolAllowed(toolName)) {
          throw new Error(`[PERMISSION_DENIED] Tool '${toolName}' is not permitted for agent '${agent.name}'.`);
        }
        if (typeof effectiveToolExecutor === 'function') {
          return await effectiveToolExecutor(toolName, args, { ...context, user, from: user });
        }
        return { status: 'success', tool: toolName, executed: true };
      };

    // Safe delegation handler with strict loop protection (maxAgentHops: 3)
    const delegateTo = async (targetAgentName, delegatedMessage) => {
      if (hops >= this.maxAgentHops) {
        loopHalted = true;
        privacyLog('warn', 'AGENT_LOOP_PROTECTION_ACTIVATED', {
          hops,
          maxAgentHops: this.maxAgentHops,
          currentAgent: currentAgentName,
          targetAgent: targetAgentName,
        });
        return {
          text: `[Loop safeguard triggered: max hops of ${this.maxAgentHops} reached]`,
          halted: true,
        };
      }

      const targetAgent = this.getAgent(targetAgentName);
      if (!targetAgent) {
        throw new Error(`Target agent '${targetAgentName}' not found`);
      }

      hops++;
      delegations.push({ from: currentAgentName, to: targetAgentName, message: delegatedMessage, hop: hops });

      return await targetAgent.execute({
        message: delegatedMessage,
        context,
        runner: safeRunner,
        callTool: makeSafeToolCaller(targetAgent),
        delegateTo,
      });
    };

    // Execute primary agent
    const result = await currentAgent.execute({
      message,
      context,
      runner: safeRunner,
      callTool: makeSafeToolCaller(currentAgent),
      delegateTo,
    });

    const latencyMs = Date.now() - startTime;

    return {
      text: result.text,
      agentUsed: currentAgentName,
      fastPath: false,
      hops,
      loopHalted,
      modelUsed: finalModelUsed,
      latencyMs,
      toolsExecuted: Array.from(new Set(allToolsExecuted.concat(result.toolsExecuted || []))),
      delegations,
    };
  }
}

// Export singleton instance
export const orchestrator = new AgentOrchestrator();
