/**
 * Expense & Receipt Tracking Module
 *
 * Parses receipts, invoices, and expense logs from natural text and multimodal OCR,
 * stores them per user with running monthly totals, and formats clean WhatsApp receipt cards.
 */
import { store } from './store/index.js';
import { formatForWhatsApp } from './formatter.js';
import { privacyLog } from './privacy.js';

const EXPENSE_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year retention

/**
 * Standard expense categories with keyword classification.
 */
export const EXPENSE_CATEGORIES = Object.freeze({
  food: {
    name: 'Food & Dining',
    keywords: [
      'restaurant',
      'cafe',
      'bistro',
      'coffee',
      'starbucks',
      'brew',
      'tea',
      'lunch',
      'dinner',
      'breakfast',
      'bar',
      'swiggy',
      'zomato',
      'burger',
      'pizza',
      'dining',
      'kitchen',
    ],
  },
  groceries: {
    name: 'Groceries & Household',
    keywords: [
      'grocery',
      'supermarket',
      'mart',
      'vegetables',
      'fruits',
      'milk',
      'bread',
      'blinkit',
      'zepto',
      'instamart',
    ],
  },
  travel: {
    name: 'Travel & Transport',
    keywords: [
      'uber',
      'ola',
      'taxi',
      'cab',
      'metro',
      'fuel',
      'petrol',
      'diesel',
      'flight',
      'airline',
      'toll',
      'parking',
    ],
  },
  shopping: {
    name: 'Shopping & Retail',
    keywords: ['amazon', 'flipkart', 'clothing', 'apparel', 'shoes', 'electronics', 'mall', 'store', 'retail'],
  },
  health: {
    name: 'Healthcare & Pharmacy',
    keywords: ['pharmacy', 'chemist', 'hospital', 'clinic', 'medicine', 'apollo', 'doctor', 'lab', 'test'],
  },
  utilities: {
    name: 'Bills & Utilities',
    keywords: ['electricity', 'water', 'gas', 'internet', 'wifi', 'broadband', 'recharge', 'mobile', 'rent'],
  },
  entertainment: {
    name: 'Entertainment & Leisure',
    keywords: ['movie', 'cinema', 'theatre', 'netflix', 'spotify', 'games', 'concert', 'show'],
  },
});

/**
 * Automatically classifies merchant or description into an expense category.
 *
 * @param {string} text
 * @returns {string} Category name
 */
export function classifyExpenseCategory(text = '') {
  const lower = String(text).toLowerCase();
  for (const cat of Object.values(EXPENSE_CATEGORIES)) {
    if (cat.keywords.some((kw) => lower.includes(kw))) {
      return cat.name;
    }
  }
  return 'General Expense';
}

/**
 * Heuristically parses an expense from OCR text or chat message.
 *
 * @param {string} text
 * @returns {{ amount: number, currency: string, merchant: string, category: string, date: string } | null}
 */
export function parseExpenseFromText(text = '') {
  if (!text || typeof text !== 'string') return null;

  // 1. Detect Currency
  let currency = '₹';
  if (/\$|usd/i.test(text)) currency = '$';
  else if (/€|eur/i.test(text)) currency = '€';
  else if (/£|gbp/i.test(text)) currency = '£';

  // 2. Extract Amount (look for total, amount, grand total, or standalone price)
  const totalRegex =
    /(?:total|grand\s+total|amount\s+paid|bill\s+amount|net\s+amount|sum)[\s:=]*[^\d\n]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i;
  const generalPriceRegex =
    /(?:₹|rs\.?|inr|\$|€|£)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i;

  let amount = null;
  const totalMatch = text.match(totalRegex);
  if (totalMatch) {
    amount = parseFloat(totalMatch[1].replace(/,/g, ''));
  } else {
    const priceMatch = text.match(generalPriceRegex);
    if (priceMatch) {
      amount = parseFloat(priceMatch[1].replace(/,/g, ''));
    }
  }

  if (amount === null || isNaN(amount) || amount <= 0) {
    return null;
  }

  // 3. Extract Merchant (common patterns: "at <Merchant>", "from <Merchant>", or top line of receipt)
  let merchant = 'Unknown Merchant';
  const merchantMatch = text.match(
    /(?:at|from|paid to|vendor|store|merchant)[\s:]+([A-Za-z0-9\s&'-]{2,30}?)(?=[,\n\.]|$)/i
  );
  if (merchantMatch) {
    merchant = merchantMatch[1].trim();
  } else {
    // If text has multiple lines, first non-empty line often represents the merchant name on a receipt
    const firstLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length >= 3 && !/receipt|invoice|bill|order|date|tax/i.test(l));
    if (firstLine && firstLine.length <= 40) {
      merchant = firstLine;
    }
  }

  // 4. Extract Category
  const category = classifyExpenseCategory(`${merchant} ${text}`);

  return {
    amount,
    currency,
    merchant,
    category,
    date: new Date().toISOString(),
  };
}

/**
 * Logs a new expense item for a user.
 *
 * @param {string} userId - User phone or anonymous ID
 * @param {object} expense
 * @param {number} expense.amount
 * @param {string} [expense.currency='₹']
 * @param {string} [expense.merchant='Unknown']
 * @param {string} [expense.category]
 * @param {string} [expense.date]
 * @param {string} [expense.notes]
 * @returns {Promise<{ success: boolean, expense: object, monthlyTotal: number }>}
 */
export async function logExpense(userId, expense) {
  if (!userId || typeof expense?.amount !== 'number' || isNaN(expense.amount)) {
    return { success: false, error: 'Invalid expense amount or user' };
  }

  const expenseItem = {
    id: `exp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    amount: Math.round(expense.amount * 100) / 100,
    currency: expense.currency || '₹',
    merchant: String(expense.merchant || 'Store').trim(),
    category: expense.category || classifyExpenseCategory(expense.merchant),
    date: expense.date || new Date().toISOString(),
    notes: expense.notes ? String(expense.notes).trim() : undefined,
  };

  const key = `expenses:user:${userId}`;
  const existingRaw = await store.get(key);
  let list = [];
  if (existingRaw) {
    if (Array.isArray(existingRaw)) {
      list = existingRaw;
    } else if (typeof existingRaw === 'string') {
      try {
        list = JSON.parse(existingRaw);
        if (!Array.isArray(list)) list = [];
      } catch {
        list = [];
      }
    }
  }

  list.push(expenseItem);
  await store.set(key, JSON.stringify(list), EXPENSE_TTL_SECONDS);

  const month = expenseItem.date.substring(0, 7); // "YYYY-MM"
  const monthlyTotal = list
    .filter((e) => (e.date || '').startsWith(month))
    .reduce((acc, curr) => acc + (curr.amount || 0), 0);

  privacyLog('info', 'EXPENSE_LOGGED', {
    user: userId,
    merchant: expenseItem.merchant,
    amount: expenseItem.amount,
    monthlyTotal,
  });

  return {
    success: true,
    expense: expenseItem,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
  };
}

/**
 * Returns all expenses recorded for a user, optionally filtered by month (YYYY-MM).
 *
 * @param {string} userId
 * @param {{ limit?: number, month?: string }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function getUserExpenses(userId, options = {}) {
  if (!userId) return [];
  const raw = await store.get(`expenses:user:${userId}`);
  if (!raw) return [];

  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
  }

  if (options.month) {
    list = list.filter((e) => (e.date || '').startsWith(options.month));
  }

  list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (options.limit && options.limit > 0) {
    list = list.slice(0, options.limit);
  }
  return list;
}

/**
 * Computes total expense spent in a specific month for a user.
 *
 * @param {string} userId
 * @param {string} [month] - e.g. "2026-11" (defaults to current month)
 * @returns {Promise<{ month: string, count: number, total: number, currency: string }>}
 */
export async function getMonthlyExpenseTotal(userId, month) {
  const targetMonth = month || new Date().toISOString().substring(0, 7);
  const expenses = await getUserExpenses(userId, { month: targetMonth });

  const total = expenses.reduce((sum, item) => sum + (item.amount || 0), 0);
  const currency = expenses[0]?.currency || '₹';

  return {
    month: targetMonth,
    count: expenses.length,
    total: Math.round(total * 100) / 100,
    currency,
  };
}

/**
 * Formats a clean WhatsApp card for a newly logged expense.
 *
 * @param {object} expense
 * @param {number} [monthlyTotal]
 * @returns {string}
 */
export function formatExpenseCard(expense, monthlyTotal) {
  const formattedDate = new Date(expense.date).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const lines = [
    '🧾 *Expense Logged Successfully:*',
    `• *Merchant:* ${expense.merchant}`,
    `• *Amount:* ${expense.currency}${expense.amount.toFixed(2)}`,
    `• *Category:* ${expense.category}`,
    `• *Date:* ${formattedDate}`,
  ];

  if (expense.notes) {
    lines.push(`• *Notes:* ${expense.notes}`);
  }

  if (typeof monthlyTotal === 'number') {
    lines.push('');
    lines.push(`📊 *Month Total:* ${expense.currency}${monthlyTotal.toFixed(2)}`);
  }

  return formatForWhatsApp(lines.join('\n'));
}
