import test from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, listTodos, markTodoDone, clearCompletedTodos, formatTodoList, initTodos } from '../src/todos.js';

test('Todos: addTodo, listTodos, markTodoDone, and clearCompletedTodos lifecycle', () => {
  const anonId = 'u_todo_lifecycle_user';
  initTodos();

  // Initially empty
  const emptyList = listTodos(anonId);
  assert.ok(emptyList.includes('Your to-do list is empty'));

  // Add 1st task
  const add1 = addTodo(anonId, 'Buy groceries and fruits');
  assert.strictEqual(add1.success, true);
  assert.ok(add1.id);
  assert.ok(add1.message.includes('Task Added'));

  // Add 2nd task
  const add2 = addTodo(anonId, 'Review pull requests');
  assert.strictEqual(add2.success, true);
  assert.ok(add2.id);

  // List tasks
  const currentList = listTodos(anonId);
  assert.ok(currentList.includes('[ ]'));
  assert.ok(currentList.includes('Buy groceries and fruits'));
  assert.ok(currentList.includes('Review pull requests'));
  assert.ok(currentList.includes(add1.id));
  assert.ok(currentList.includes(add2.id));

  // Mark 1st task completed
  const doneResult = markTodoDone(anonId, add1.id);
  assert.strictEqual(doneResult.success, true);
  assert.ok(doneResult.message.includes('Completed'));

  // List again to verify [x] checkbox
  const updatedList = listTodos(anonId);
  assert.ok(updatedList.includes('[x]'));
  assert.ok(updatedList.includes('~Buy groceries and fruits~'));
  assert.ok(updatedList.includes('[ ]'));
  assert.ok(updatedList.includes('Review pull requests'));

  // Clear completed tasks
  const clearResult = clearCompletedTodos(anonId);
  assert.strictEqual(clearResult.success, true);
  assert.ok(clearResult.message.includes('Cleared 1 completed'));

  // List again - completed task should be gone, uncompleted task should remain
  const finalList = listTodos(anonId);
  assert.ok(!finalList.includes('Buy groceries'));
  assert.ok(finalList.includes('[ ]'));
  assert.ok(finalList.includes('Review pull requests'));

  // Clean up
  markTodoDone(anonId, add2.id);
  clearCompletedTodos(anonId);
});

test('Todos: formatTodoList handles multiple states gracefully', () => {
  const dummyTodos = [
    { id: 'a1b2', text: 'First task', completed: false, createdAt: Date.now() },
    { id: 'c3d4', text: 'Second task', completed: true, createdAt: Date.now() },
  ];

  const formatted = formatTodoList(dummyTodos);
  assert.ok(formatted.includes('[ ] `a1b2` - First task'));
  assert.ok(formatted.includes('[x] `c3d4` - ~Second task~'));
  assert.ok(formatted.includes('*Quick To-Do List (1 pending)*'));
});
