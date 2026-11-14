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
import { searchNearbyPlaces, getUserLocation, formatPlacesSummary } from '../location.js';
import { logExpense, getMonthlyExpenseTotal, formatExpenseCard } from '../expenses.js';
import { sendCalendarInvite, sendContactCard } from '../export.js';

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
  {
    name: 'search_nearby',
    description: 'Searches for nearby places (cafes, restaurants, pharmacies, ATMs, fuel, groceries) around the user.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: {
          type: 'STRING',
          description: 'Category of place: "cafe", "food", "pharmacy", "atm", "fuel", "grocery".',
        },
        query: {
          type: 'STRING',
          description: 'Specific place name or keyword (e.g. "Starbucks", "Indian restaurant", "chemist").',
        },
        radiusMeters: {
          type: 'NUMBER',
          description: 'Search radius in meters (default 3000).',
        },
      },
      required: [],
    },
  },
  {
    name: 'log_expense',
    description:
      'Records a new personal expense with merchant, amount, and category, returning running monthly totals.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: {
          type: 'NUMBER',
          description: 'The numerical expense amount spent.',
        },
        merchant: {
          type: 'STRING',
          description: 'The name of the store, vendor, restaurant, or service.',
        },
        category: {
          type: 'STRING',
          description: 'Expense category (e.g. "Food & Dining", "Travel & Transport", "Groceries", "Shopping").',
        },
        notes: {
          type: 'STRING',
          description: 'Optional details or remarks.',
        },
        currency: {
          type: 'STRING',
          description: 'Currency symbol (default "₹").',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'get_monthly_expenses',
    description: 'Retrieves total expenses spent by the user for a specified month (e.g. "2026-11").',
    parameters: {
      type: 'OBJECT',
      properties: {
        month: {
          type: 'STRING',
          description: 'Target month in format "YYYY-MM" (defaults to current month).',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_calendar_invite',
    description: 'Generates and delivers an interactive .ics calendar file to WhatsApp for 1-tap import.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: {
          type: 'STRING',
          description: 'Title of the event or meeting.',
        },
        startTime: {
          type: 'STRING',
          description: 'ISO start date-time or string (e.g. "2026-11-20T10:00:00").',
        },
        durationMinutes: {
          type: 'NUMBER',
          description: 'Duration of the event in minutes (default 60).',
        },
        location: {
          type: 'STRING',
          description: 'Location or video call link.',
        },
        description: {
          type: 'STRING',
          description: 'Meeting notes or agenda.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'share_contact_card',
    description: 'Generates and sends a vCard (.vcf) contact file to WhatsApp for 1-tap saving to phone book.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: {
          type: 'STRING',
          description: 'Full name of the contact.',
        },
        phone: {
          type: 'STRING',
          description: 'Phone number.',
        },
        email: {
          type: 'STRING',
          description: 'Email address.',
        },
        organization: {
          type: 'STRING',
          description: 'Company or organization name.',
        },
        title: {
          type: 'STRING',
          description: 'Job title or role.',
        },
      },
      required: ['name'],
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
  const userIdentifier = from || anonId;

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

      case 'search_nearby': {
        let lat = args.latitude;
        let lng = args.longitude;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
          const loc = await getUserLocation(userIdentifier);
          if (loc) {
            lat = loc.latitude;
            lng = loc.longitude;
          } else {
            // Default to Bangalore center if no location shared yet
            lat = 12.9716;
            lng = 77.5946;
          }
        }
        const places = await searchNearbyPlaces({
          latitude: lat,
          longitude: lng,
          query: args.query,
          category: args.category || 'cafe',
          radiusMeters: args.radiusMeters || 3000,
        });
        return {
          status: 'success',
          placesCount: places.length,
          places,
          formatted: formatPlacesSummary(places, `📍 Nearby Recommendations (${args.category || 'Places'})`),
        };
      }

      case 'log_expense': {
        const res = await logExpense(userIdentifier, args);
        if (res.success) {
          return {
            status: 'success',
            expense: res.expense,
            monthlyTotal: res.monthlyTotal,
            formatted: formatExpenseCard(res.expense, res.monthlyTotal),
          };
        }
        return { status: 'failed', error: res.error };
      }

      case 'get_monthly_expenses': {
        const summary = await getMonthlyExpenseTotal(userIdentifier, args.month);
        return {
          status: 'success',
          ...summary,
          formatted: `📊 *Monthly Expense Summary (${summary.month}):*\n• *Total Spent:* ${summary.currency}${summary.total.toFixed(2)}\n• *Transactions:* ${summary.count}`,
        };
      }

      case 'create_calendar_invite': {
        if (!from) return { status: 'failed', error: 'Missing recipient phone' };
        const res = await sendCalendarInvite(from, args);
        return {
          status: res.success ? 'success' : 'failed',
          messageId: res.messageId,
          message: `📅 Calendar invite for "${args.title}" sent as a document.`,
        };
      }

      case 'share_contact_card': {
        if (!from) return { status: 'failed', error: 'Missing recipient phone' };
        const res = await sendContactCard(from, args);
        return {
          status: res.success ? 'success' : 'failed',
          messageId: res.messageId,
          message: `👤 Contact card for "${args.name}" sent as a vCard.`,
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
