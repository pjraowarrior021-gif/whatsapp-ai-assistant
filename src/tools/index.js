/**
 * Agentic AI Tools & Function Calling Registry
 * Declares function schemas for Google Gemini and executes corresponding handlers.
 */
import { getCurrentTime } from './time.js';
import { getWeather } from './weather.js';
import { scheduleReminder } from '../reminders.js';
import { addTodo } from '../todos.js';
import { privacyLog } from '../privacy.js';
import { mcpManager } from './mcp-client.js';

export { mcpManager };

export function getCombinedToolDeclarations() {
  return [...toolDeclarations, ...mcpManager.getGeminiDeclarations()];
}

export const toolDeclarations = [
  {
    name: 'get_current_time',
    description: 'Returns the current real-time clock, date, and day of the week in a specified timezone.',
    parameters: {
      type: 'OBJECT',
      properties: {
        timezone: {
          type: 'STRING',
          description: 'IANA timezone name (e.g. "Asia/Kolkata", "America/New_York", "Europe/London", "UTC").',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_current_weather',
    description: 'Retrieves real-time weather information and conditions for a city or region worldwide.',
    parameters: {
      type: 'OBJECT',
      properties: {
        location: {
          type: 'STRING',
          description: 'City, state, or country name (e.g. "Mumbai", "Tokyo", "London, UK", "Bengaluru").',
        },
      },
      required: ['location'],
    },
  },
  {
    name: 'schedule_reminder',
    description: 'Schedules a persistent reminder for the user at a specified time or relative duration.',
    parameters: {
      type: 'OBJECT',
      properties: {
        when: {
          type: 'STRING',
          description:
            'When the reminder should trigger: relative (e.g. "10m", "2h", "1d") or absolute 24h time ("14:30") or date ("25-12-2026 09:00").',
        },
        description: {
          type: 'STRING',
          description: 'What the user needs to be reminded about.',
        },
      },
      required: ['when', 'description'],
    },
  },
  {
    name: 'add_todo_task',
    description: "Adds a task to the user's personal to-do list.",
    parameters: {
      type: 'OBJECT',
      properties: {
        task: {
          type: 'STRING',
          description: 'The task title or description to add.',
        },
      },
      required: ['task'],
    },
  },
];

/**
 * Dispatches a tool invocation and returns sanitized output.
 *
 * @param {string} name - Function name
 * @param {object} args - Arguments passed by Gemini
 * @param {object} context - Execution context { from, anonId }
 * @returns {Promise<object>}
 */
export async function executeToolCall(name, args = {}, context = {}) {
  const { from = '', anonId = '' } = context;

  privacyLog('info', 'TOOL_INVOKED', { tool: name, user: anonId });

  try {
    switch (name) {
      case 'get_current_time':
        return await getCurrentTime(args);

      case 'get_current_weather':
        return await getWeather(args);

      case 'schedule_reminder': {
        const res = scheduleReminder(from, anonId, args.when, args.description);
        return {
          status: res.success ? 'success' : 'failed',
          message: res.message,
          reminder_id: res.reminder?.id,
        };
      }

      case 'add_todo_task': {
        const res = addTodo(anonId, args.task);
        return {
          status: res.success ? 'success' : 'failed',
          message: res.message,
          task_id: res.id,
        };
      }

      default: {
        const mcpHandler = mcpManager.findToolHandler(name);
        if (mcpHandler) {
          return await mcpHandler.client.callTool(name, args);
        }
        return { status: 'error', message: `Unknown function '${name}'` };
      }
    }
  } catch (err) {
    privacyLog('error', 'TOOL_EXECUTION_ERROR', { tool: name, error: err.message });
    return { status: 'error', message: `Execution failed: ${err.message}` };
  }
}
