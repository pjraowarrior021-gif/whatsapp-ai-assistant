/**
 * Productivity Agent
 * Specialist for tasks, todos, reminders, schedules, calendar,
 * timezones, weather, and contact lookups.
 */
import { TASK_TYPES } from '../model-router.js';

export const PRODUCTIVITY_TOOLS = Object.freeze([
  'schedule_reminder',
  'add_todo_task',
  'get_current_time',
  'get_current_weather',
  'lookup_contact',
  'search_nearby',
  'log_expense',
  'get_monthly_expenses',
  'create_calendar_invite',
  'share_contact_card',
]);

export class ProductivityAgent {
  constructor(options = {}) {
    this.name = 'productivity';
    this.role = 'Personal organization, tasks, reminders, time, and scheduling specialist';
    this.taskType = TASK_TYPES.CHAT;
    this.allowedTools = new Set(PRODUCTIVITY_TOOLS);
    this.systemInstruction =
      options.systemInstruction ||
      `You are an efficient Personal Productivity Specialist.
Your goals:
1. Help the user organize their day, tasks, and deadlines.
2. When scheduling reminders or creating to-dos, confirm the exact time, description, and action clearly.
3. Keep notifications and confirmations brief and actionable.`;
  }

  /**
   * Checks if a tool is permitted for this agent.
   * @param {string} toolName
   * @returns {boolean}
   */
  isToolAllowed(toolName) {
    if (this.allowedTools.has(toolName)) return true;
    if (
      toolName.startsWith('calendar_') ||
      toolName.startsWith('gmail_') ||
      toolName.startsWith('notion_') ||
      toolName.startsWith('mcp_')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Confidence scoring for productivity requests.
   * @param {string} message
   * @param {object} context
   * @returns {number} 0.0 - 1.0
   */
  canHandle(message = '', _context = {}) {
    const text = String(message || '').toLowerCase();
    const keywords = [
      'remind me',
      'set a reminder',
      'schedule a reminder',
      'add to my todo',
      'add todo',
      'new task',
      'to-do list',
      'what time is it',
      'current time',
      'time in',
      'weather in',
      'what is the weather',
      'lookup contact',
      'find contact',
      'my schedule',
      'near me',
      'nearby',
      'places to eat',
      'coffee shop',
      'pharmacy near',
      'atm near',
      'spent',
      'logged expense',
      'my expenses',
      'total spent',
      'calendar invite',
      'meeting invite',
      'send contact',
      'share contact',
      'vcard',
    ];

    if (keywords.some((kw) => text.includes(kw))) {
      return 0.95;
    }

    return 0.1;
  }

  /**
   * Executes productivity tasks and dispatches tools.
   * @param {object} params
   * @returns {Promise<{ text: string, fastPath: boolean, toolsExecuted: string[], tokens?: object }>}
   */
  async execute({ message, context = {}, runner = null, callTool = null }) {
    const text = String(message || '').toLowerCase();
    const toolsExecuted = [];

    // 1. Direct deterministic reminder scheduling check
    const reminderMatch = message.match(/remind\s+me\s+(?:to\s+)?(.+?)\s+(?:in|at|on)\s+(.+)/i);
    if (reminderMatch && typeof callTool === 'function' && this.isToolAllowed('schedule_reminder')) {
      const description = reminderMatch[1].trim();
      const when = reminderMatch[2].trim();
      toolsExecuted.push('schedule_reminder');
      try {
        const res = await callTool('schedule_reminder', { description, when });
        return {
          text: `⏰ *Reminder Scheduled!*\n• Description: ${description}\n• When: ${when}\n${res?.message ? `• Note: ${res.message}` : ''}`,
          fastPath: false,
          toolsExecuted,
          tokens: { prompt: 10, completion: 20 },
        };
      } catch (err) {
        return {
          text: `Failed to schedule reminder: ${err.message}`,
          fastPath: false,
          toolsExecuted,
          tokens: { prompt: 10, completion: 15 },
        };
      }
    }

    // 2. Direct deterministic todo adding check
    const todoMatch = message.match(/(?:add\s+todo|add\s+to\s+my\s+todo|add\s+task|new\s+task)[:\s]+(.+)/i);
    if (todoMatch && typeof callTool === 'function' && this.isToolAllowed('add_todo_task')) {
      const task = todoMatch[1].trim();
      toolsExecuted.push('add_todo_task');
      try {
        const res = await callTool('add_todo_task', { task });
        return {
          text: `✅ *Task Added to To-Do List*\n• Task: ${task}\n${res?.task_id ? `• ID: \`${res.task_id}\`` : ''}`,
          fastPath: false,
          toolsExecuted,
          tokens: { prompt: 10, completion: 20 },
        };
      } catch (err) {
        return {
          text: `Failed to add task: ${err.message}`,
          fastPath: false,
          toolsExecuted,
          tokens: { prompt: 10, completion: 15 },
        };
      }
    }

    // 3. Time query check
    if (
      /\b(time in|current time|what time is)\b/i.test(text) &&
      typeof callTool === 'function' &&
      this.isToolAllowed('get_current_time')
    ) {
      toolsExecuted.push('get_current_time');
      const tzMatch = text.match(/in\s+([a-zA-Z/_]+)/i);
      const timezone = tzMatch ? tzMatch[1].trim() : 'Asia/Kolkata';
      try {
        const res = await callTool('get_current_time', { timezone });
        return {
          text: `🕒 *Current Time*: ${res?.current_time || 'N/A'}${res?.timezone ? ` (${res.timezone})` : ''}`,
          fastPath: false,
          toolsExecuted,
          tokens: { prompt: 10, completion: 15 },
        };
      } catch {
        // Fallback
      }
    }

    // 4. Weather query check
    if (
      /\b(weather in|forecast for)\b/i.test(text) &&
      typeof callTool === 'function' &&
      this.isToolAllowed('get_current_weather')
    ) {
      toolsExecuted.push('get_current_weather');
      const locMatch = message.match(/(?:weather in|forecast for)\s+([a-zA-Z\s,]+)/i);
      const rawLocation = locMatch ? locMatch[1].trim().replace(/[?.,!]+$/, '') : 'Mumbai';
      const location = rawLocation.charAt(0).toUpperCase() + rawLocation.slice(1);
      try {
        const res = await callTool('get_current_weather', { location });
        return {
          text: `🌤️ *Weather in ${location}*: ${res?.condition || 'Clear'}, ${res?.temperature || '25°C'}`,
          fastPath: false,
          toolsExecuted,
          tokens: { prompt: 10, completion: 15 },
        };
      } catch {
        // Fallback
      }
    }

    // 5. Runner execution for complex productivity queries
    if (typeof runner === 'function') {
      const result = await runner({
        taskType: this.taskType,
        systemInstruction: this.systemInstruction,
        prompt: message,
        context,
        tools: Array.from(this.allowedTools),
      });

      return {
        text: typeof result === 'string' ? result : result.text || result.output || '',
        fastPath: false,
        toolsExecuted,
        tokens: result.tokens || { prompt: 20, completion: 30 },
      };
    }

    return {
      text: `Productivity action processed for: ${message}`,
      fastPath: false,
      toolsExecuted,
      tokens: { prompt: 10, completion: 15 },
    };
  }
}
