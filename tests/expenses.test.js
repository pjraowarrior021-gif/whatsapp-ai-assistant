import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logExpense,
  getUserExpenses,
  getMonthlyExpenseTotal,
  parseExpenseFromText,
  classifyExpenseCategory,
  formatExpenseCard,
} from '../src/expenses.js';

test('Expenses: logExpense and getUserExpenses record and fetch user expenses', async () => {
  const userId = `u_exp_test_${Date.now()}`;
  const res = await logExpense(userId, {
    amount: 1450.5,
    currency: '₹',
    merchant: 'Cafe Bistro',
    category: 'Food & Dining',
    notes: 'Team lunch',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.expense.amount, 1450.5);
  assert.strictEqual(res.expense.merchant, 'Cafe Bistro');
  assert.strictEqual(res.monthlyTotal, 1450.5);

  const list = await getUserExpenses(userId);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].merchant, 'Cafe Bistro');
});

test('Expenses: getMonthlyExpenseTotal aggregates monthly spending accurately', async () => {
  const userId = `u_monthly_${Date.now()}`;
  const now = new Date();
  const currentMonth = now.toISOString().substring(0, 7);

  await logExpense(userId, { amount: 500, merchant: 'Supermarket', date: `${currentMonth}-05T10:00:00Z` });
  await logExpense(userId, { amount: 1200, merchant: 'Fuel Station', date: `${currentMonth}-10T12:00:00Z` });
  await logExpense(userId, { amount: 300, merchant: 'Bakery', date: `${currentMonth}-12T08:00:00Z` });

  const totalSummary = await getMonthlyExpenseTotal(userId, currentMonth);
  assert.strictEqual(totalSummary.count, 3);
  assert.strictEqual(totalSummary.total, 2000);
  assert.strictEqual(totalSummary.month, currentMonth);
});

test('Expenses: parseExpenseFromText extracts amount, merchant, and category from receipt text', () => {
  const sampleText = `CAFE COFFEE DAY
Store #1042, Bangalore
Date: 14/11/2026
-------------------------
1x Cappuccino     220.00
1x Blueberry Muffin 180.00
-------------------------
GRAND TOTAL: ₹400.00
Paid via UPI`;

  const parsed = parseExpenseFromText(sampleText);
  assert.ok(parsed);
  assert.strictEqual(parsed.amount, 400);
  assert.strictEqual(parsed.currency, '₹');
  assert.ok(parsed.merchant.includes('CAFE') || parsed.merchant.includes('Coffee'));
  assert.strictEqual(parsed.category, 'Food & Dining');
});

test('Expenses: classifyExpenseCategory identifies standard spending categories', () => {
  assert.strictEqual(classifyExpenseCategory('Uber cab to airport'), 'Travel & Transport');
  assert.strictEqual(classifyExpenseCategory('Blinkit grocery delivery'), 'Groceries & Household');
  assert.strictEqual(classifyExpenseCategory('Apollo pharmacy medicines'), 'Healthcare & Pharmacy');
  assert.strictEqual(classifyExpenseCategory('Starbucks cold brew'), 'Food & Dining');
});

test('Expenses: formatExpenseCard renders clean mobile card for WhatsApp', () => {
  const card = formatExpenseCard(
    {
      amount: 450,
      currency: '₹',
      merchant: 'Corner Bakery',
      category: 'Food & Dining',
      date: '2026-11-14T10:00:00Z',
      notes: 'Breakfast with client',
    },
    8500
  );

  assert.ok(card.includes('🧾 *Expense Logged Successfully:*'));
  assert.ok(card.includes('• *Merchant:* Corner Bakery'));
  assert.ok(card.includes('• *Amount:* ₹450.00'));
  assert.ok(card.includes('• *Category:* Food & Dining'));
  assert.ok(card.includes('📊 *Month Total:* ₹8500.00'));
});
