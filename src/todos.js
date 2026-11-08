import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { privacyLog } from './privacy.js';

/**
 * In-Memory To-Do Store:
 * Map<anonymizedUserId, Array<{ id: string, text: string, completed: boolean, createdAt: number }>>
 */
const todoStore = new Map();

const PERSISTENCE_DIR = path.resolve('.data');
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, 'todos.json');

/**
 * Loads persisted todos from disk on startup if REMINDERS_PERSIST is enabled.
 */
export function initTodos() {
  if (!config.REMINDERS_PERSIST) return;

  try {
    if (!fs.existsSync(PERSISTENCE_FILE)) return;
    const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.user && item.id && item.text) {
          const list = todoStore.get(item.user) || [];
          list.push({
            id: item.id,
            text: item.text,
            completed: Boolean(item.completed),
            createdAt: item.createdAt || Date.now(),
          });
          todoStore.set(item.user, list);
        }
      }
      privacyLog('info', 'TODOS_LOADED_FROM_DISK', { count: parsed.length });
    }
  } catch (err) {
    privacyLog('warn', 'TODOS_LOAD_FAILED', { error: err.message });
  }
}

/**
 * Persists all in-memory todos atomically to disk if REMINDERS_PERSIST is enabled.
 */
export function persistTodos() {
  if (!config.REMINDERS_PERSIST) return;

  try {
    if (!fs.existsSync(PERSISTENCE_DIR)) {
      fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
    }

    const flatList = [];
    for (const [user, list] of todoStore.entries()) {
      for (const t of list) {
        flatList.push({
          user,
          id: t.id,
          text: t.text,
          completed: t.completed,
          createdAt: t.createdAt,
        });
      }
    }

    const tmpPath = `${PERSISTENCE_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(flatList, null, 2), 'utf-8');
    fs.renameSync(tmpPath, PERSISTENCE_FILE);
  } catch (err) {
    privacyLog('warn', 'TODOS_PERSIST_FAILED', { error: err.message });
  }
}

/**
 * Adds a new task to the user's to-do list.
 *
 * @param {string} anonId
 * @param {string} taskText
 * @returns {{ success: boolean, id?: string, task?: object, message: string }}
 */
export function addTodo(anonId, taskText) {
  const cleanText = String(taskText || '').trim();
  if (!cleanText) {
    return {
      success: false,
      message: '⚠️ *Usage:* `/todo <task name>` (e.g. `/todo Buy groceries`)',
    };
  }

  const id = crypto.randomBytes(3).toString('hex');
  const item = {
    id,
    text: cleanText,
    completed: false,
    createdAt: Date.now(),
  };

  const list = todoStore.get(anonId) || [];
  list.push(item);
  todoStore.set(anonId, list);

  privacyLog('info', 'TODO_ADDED', { user: anonId, todoId: id });
  persistTodos();

  return {
    success: true,
    id,
    task: item,
    message: `📝 *Task Added!* (ID: \`${id}\`)\n[ ] ${cleanText}\n\n_Mark done:_ \`/done ${id}\``,
  };
}

/**
 * Returns raw to-do array for an anonymized user.
 * @param {string} anonId
 * @returns {Array<{ id: string, text: string, completed: boolean, createdAt: number }>}
 */
export function getTodos(anonId) {
  return todoStore.get(anonId) || [];
}

/**
 * Returns formatted to-do list markdown for an anonymized user.
 * @param {string} anonId
 * @returns {string}
 */
export function listTodos(anonId) {
  const list = getTodos(anonId);
  return formatTodoList(list);
}

/**
 * Marks a task as completed by ID.
 * @param {string} anonId
 * @param {string} id
 * @returns {{ success: boolean, task?: object, message: string }}
 */
export function markTodoDone(anonId, id) {
  const cleanId = String(id || '')
    .trim()
    .toLowerCase();
  const list = todoStore.get(anonId) || [];
  const target = list.find((t) => t.id.toLowerCase() === cleanId);

  if (!target) {
    return {
      success: false,
      message: `⚠️ *Task Not Found:* No task found with ID \`${cleanId}\`. Type */todos* to view your list.`,
    };
  }

  target.completed = true;
  privacyLog('info', 'TODO_MARKED_DONE', { user: anonId, todoId: target.id });
  persistTodos();

  return {
    success: true,
    task: target,
    message: `✅ *Task Completed!* ~${target.text}~`,
  };
}

/**
 * Clears all completed tasks for an anonymized user.
 * @param {string} anonId
 * @returns {{ success: boolean, clearedCount: number, message: string }}
 */
export function clearCompletedTodos(anonId) {
  const list = todoStore.get(anonId) || [];
  const remaining = list.filter((t) => !t.completed);
  const clearedCount = list.length - remaining.length;

  if (clearedCount === 0) {
    return {
      success: true,
      clearedCount: 0,
      message: 'ℹ️ *No completed tasks to clear.*',
    };
  }

  if (remaining.length === 0) {
    todoStore.delete(anonId);
  } else {
    todoStore.set(anonId, remaining);
  }

  privacyLog('info', 'TODOS_CLEARED', { user: anonId, clearedCount });
  persistTodos();

  return {
    success: true,
    clearedCount,
    message: `🧹 *Cleaned Up:* Cleared ${clearedCount} completed task${clearedCount > 1 ? 's' : ''}.`,
  };
}

/**
 * Formats a user's to-do list into readable WhatsApp markdown.
 * @param {Array<{ id: string, text: string, completed: boolean, createdAt: number }>} todos
 * @returns {string}
 */
export function formatTodoList(todos) {
  if (!todos || todos.length === 0) {
    return '📝 *Your to-do list is empty!*\n\nUse */todo <task>* to add a task (e.g. `/todo Buy groceries`).';
  }

  const pending = todos.filter((t) => !t.completed);
  const completed = todos.filter((t) => t.completed);

  const lines = [`📝 *Quick To-Do List (${pending.length} pending)*`, ''];

  if (pending.length > 0) {
    lines.push('*Pending:*');
    for (const item of pending) {
      lines.push(`[ ] \`${item.id}\` - ${item.text}`);
    }
  }

  if (completed.length > 0) {
    if (pending.length > 0) lines.push('');
    lines.push('*Completed:*');
    for (const item of completed) {
      lines.push(`[x] \`${item.id}\` - ~${item.text}~`);
    }
  }

  lines.push('');
  lines.push('_Complete item:_ `/done <id>` | _Clear done:_ `/clear_todos`');
  return lines.join('\n');
}
