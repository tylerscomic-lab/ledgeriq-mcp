import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── Double-entry journal assistant ───────────────────────────────────────
// A deterministic rule engine, not a language model: transaction wording is
// matched against a table of common small-business events, and each match
// yields balanced debits and credits with the reasoning. When nothing
// matches confidently it says so instead of guessing. Account names follow
// a standard chart; map them to your own chart of accounts.

const r2 = (n) => Math.round(n * 100) / 100;
const reply = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const NOTE = 'Rule-based suggestions using standard accrual accounting (US GAAP style). Map account names to your chart of accounts, and have an accountant review anything unusual. Not accounting or tax advice.';

// Each rule: patterns (all must be satisfied by `all`, any by `any`), entry builder.
const RULES = [
  { id: 'owner_contribution', any: [/owner('?s)? (contribution|investment)/, /(invest(ed)?|contributed|deposited).*(own|personal) (money|funds|cash)/, /capital contribution/], build: (a) => [['Cash', a, 0], ['Owner\'s Capital (Equity)', 0, a]], why: 'Owner puts money into the business: cash increases (debit), owner equity increases (credit).' },
  { id: 'owner_draw', any: [/owner('?s)? (draw|withdrawal|distribution)/, /(took|withdrew).*(personal|for myself)/, /distribution to (owner|member|shareholder)/], build: (a) => [['Owner\'s Draw (Equity)', a, 0], ['Cash', 0, a]], why: 'Owner takes money out: draws reduce equity (debit) and cash (credit). Not an expense.' },
  { id: 'loan_received', any: [/(received|got|took out|borrowed|obtained).*(loan|line of credit)/, /loan proceeds/], build: (a) => [['Cash', a, 0], ['Loan Payable (Liability)', 0, a]], why: 'Borrowing increases cash and creates a liability.' },
  { id: 'loan_payment', any: [/(paid|payment).*(loan|note payable|line of credit)/, /loan (payment|repayment)/], build: (a, ctx) => ctx.interest ? [['Loan Payable (Liability)', r2(a - ctx.interest), 0], ['Interest Expense', ctx.interest, 0], ['Cash', 0, a]] : [['Loan Payable (Liability)', a, 0], ['Cash', 0, a]], why: 'Repaying principal reduces the liability; any interest portion is an expense. Pass interest_portion to split a payment.' },
  { id: 'equipment_cash', all: [/(bought|purchased|buy|purchase|acquired)/, /(equipment|machinery|vehicle|truck|computer|laptop|printer|furniture|tools?)/], not: [/(on account|on credit|financ|loan|note)/], build: (a) => [['Equipment (Asset)', a, 0], ['Cash', 0, a]], why: 'Long-lived items are capitalised as assets, not expensed immediately. Depreciate them over time (see the depreciation server). Many businesses expense small items under the de minimis safe harbor ($2,500 per item or invoice).' },
  { id: 'equipment_financed', all: [/(bought|purchased|buy|purchase|acquired)/, /(equipment|machinery|vehicle|truck|computer|laptop|printer|furniture|tools?)/, /(financ|loan|note|on credit|on account)/], build: (a, ctx) => ctx.down ? [['Equipment (Asset)', a, 0], ['Cash', 0, ctx.down], ['Notes Payable (Liability)', 0, r2(a - ctx.down)]] : [['Equipment (Asset)', a, 0], ['Notes Payable (Liability)', 0, a]], why: 'Financed purchase: the asset is recorded at full cost, paid partly in cash (down payment) and partly by a liability.' },
  { id: 'inventory_credit', all: [/(bought|purchased|buy|purchase)/, /(inventory|merchandise|goods|stock for resale)/, /(on account|on credit|invoice|net ?\d+)/], build: (a) => [['Inventory (Asset)', a, 0], ['Accounts Payable (Liability)', 0, a]], why: 'Inventory bought on terms: asset up, payable up.' },
  { id: 'inventory_cash', all: [/(bought|purchased|buy|purchase|paid for)/, /(inventory|merchandise|goods for resale)/], build: (a) => [['Inventory (Asset)', a, 0], ['Cash', 0, a]], why: 'Inventory is an asset until sold; cost moves to COGS when the sale is recorded.' },
  { id: 'pay_payable', any: [/paid.*(accounts payable|vendor (bill|invoice)|supplier (invoice|bill))/, /payment on account to/, /paid (the )?(invoice|bill) from/], build: (a) => [['Accounts Payable (Liability)', a, 0], ['Cash', 0, a]], why: 'Paying a bill already recorded: reduces the payable and cash. No expense now, it was recorded when the bill arrived.' },
  { id: 'collect_receivable', any: [/(collected|received).*(accounts receivable|on account|from customer.*(invoice|owed))/, /customer (paid|payment).*(invoice|owed|on account)/, /payment (received )?on invoice/], build: (a) => [['Cash', a, 0], ['Accounts Receivable (Asset)', 0, a]], why: 'Collecting an earlier sale: cash up, receivable down. Revenue was recorded when the sale was made.' },
  { id: 'sale_credit', all: [/(sold|sale|billed|invoiced|invoice(d)?|provided|performed|completed)/, /(on account|on credit|invoice|net ?\d+|billed|to be paid)/], not: [/(collected|received payment)/], build: (a) => [['Accounts Receivable (Asset)', a, 0], ['Sales / Service Revenue', 0, a]], why: 'Accrual basis: revenue is recognised when earned, even if cash arrives later.' },
  { id: 'customer_deposit', any: [/(customer|client)? ?(deposit|prepayment|advance payment|retainer|paid in advance)/, /unearned/], build: (a) => [['Cash', a, 0], ['Unearned Revenue (Liability)', 0, a]], why: 'Money received before work is done is a liability until earned.' },
  { id: 'sale_cash', any: [/(customer|client).{0,20}paid.{0,30}(service|product|work|goods)/, /(cash|card|received) (sale|payment).*(customer|client|service|product)/, /(sold|sale of).*(for cash|cash)/, /(received|collected) \$?[\d,.]+ (for|from).*(service|sale|work|customer|client)/, /(earned|received).*(service )?(revenue|income|fees?)/, /(cash|card) sale/], build: (a) => [['Cash', a, 0], ['Sales / Service Revenue', 0, a]], why: 'Cash received for goods or services delivered now: cash up, revenue up.' },
  { id: 'prepaid_insurance', all: [/(paid|prepaid|pay)/, /insurance/, /(year|annual|12 months|6 months|six months|policy|premium in advance|advance)/], build: (a) => [['Prepaid Insurance (Asset)', a, 0], ['Cash', 0, a]], why: 'Insurance paid for future coverage is an asset that you expense month by month (adjusting entry).' },
  { id: 'prepaid_rent', all: [/(paid|prepaid|pay)/, /rent/, /(advance|prepaid|next (month|quarter|year)|deposit|3 months|6 months|annual)/], build: (a) => [['Prepaid Rent (Asset)', a, 0], ['Cash', 0, a]], why: 'Rent for future periods is an asset until the period arrives. A refundable security deposit goes to a Deposits asset instead.' },
  { id: 'rent', all: [/(paid|pay|payment)/, /(rent|lease)/], build: (a) => [['Rent Expense', a, 0], ['Cash', 0, a]], why: 'Rent for the current period is an operating expense.' },
  { id: 'salaries', any: [/(paid|pay).*(salar|wages|payroll|employee)/, /payroll/], build: (a) => [['Salaries & Wages Expense', a, 0], ['Cash', 0, a]], why: 'Gross wages are the expense. If you withhold taxes, record the withholdings as liabilities and add employer payroll tax expense (the entry here shows net pay only as a simple cash payment).' },
  { id: 'utilities', any: [/(paid|pay).*(utilit|electric|water|gas bill|internet|phone|telephone)/, /(electric|water|internet|phone) bill/], build: (a) => [['Utilities Expense', a, 0], ['Cash', 0, a]], why: 'Operating expense.' },
  { id: 'supplies_expense', any: [/(bought|purchased|paid for).*(supplies|office supplies|materials)/], build: (a) => [['Supplies Expense', a, 0], ['Cash', 0, a]], why: 'Supplies used up promptly are expensed. If you hold a significant stock, record Supplies (Asset) and adjust at period end.' },
  { id: 'advertising', any: [/(paid|pay).*(advertis|marketing|promotion|ads?\b|facebook ads|google ads)/], build: (a) => [['Advertising Expense', a, 0], ['Cash', 0, a]], why: 'Operating expense.' },
  { id: 'professional_fees', any: [/(paid|pay).*(attorney|lawyer|legal|accountant|accounting|cpa|bookkeep|consult)/], build: (a) => [['Professional Fees Expense', a, 0], ['Cash', 0, a]], why: 'Operating expense. Legal costs to acquire an asset may need to be capitalised instead.' },
  { id: 'bank_fees', any: [/(bank|service|merchant|processing|stripe|paypal|square) fees?/, /fees? (charged|deducted) by/], build: (a) => [['Bank & Processing Fees', a, 0], ['Cash', 0, a]], why: 'Operating expense.' },
  { id: 'interest_paid', any: [/(paid|pay).*interest/], build: (a) => [['Interest Expense', a, 0], ['Cash', 0, a]], why: 'Financing cost, shown below operating income.' },
  { id: 'expense_on_account', all: [/(received|got|recorded|incurred).*(bill|invoice)/, /(for|from)/], build: (a) => [['Expense (choose account)', a, 0], ['Accounts Payable (Liability)', 0, a]], why: 'A bill received but not yet paid: record the expense now (accrual basis) and a payable.' },
  { id: 'depreciation', any: [/depreciation/], build: (a) => [['Depreciation Expense', a, 0], ['Accumulated Depreciation (Contra-Asset)', 0, a]], why: 'Allocates an asset\'s cost over its life with no cash movement.' },
  { id: 'sales_tax_collected', any: [/sales tax (collected|charged)/], build: (a) => [['Cash', a, 0], ['Sales Tax Payable (Liability)', 0, a]], why: 'Sales tax collected from customers belongs to the state, not to revenue.' },
  { id: 'sales_tax_paid', any: [/(paid|remitted).*sales tax/], build: (a) => [['Sales Tax Payable (Liability)', a, 0], ['Cash', 0, a]], why: 'Remitting collected tax clears the liability.' },
  { id: 'bad_debt', any: [/(write.?off|uncollectible|bad debt)/], build: (a) => [['Bad Debt Expense', a, 0], ['Accounts Receivable (Asset)', 0, a]], why: 'Direct write-off method. (If you keep an allowance for doubtful accounts, debit the allowance instead.)' },
  { id: 'refund_customer', any: [/(refund(ed)?|returned money).*(customer|client)/, /customer refund/], build: (a) => [['Sales Returns & Refunds (Contra-Revenue)', a, 0], ['Cash', 0, a]], why: 'Reduces revenue.' },
];

function matchRule(desc) {
  const d = desc.toLowerCase();
  const hits = [];
  for (const r of RULES) {
    let ok = false;
    if (r.all) ok = r.all.every((re) => re.test(d));
    else if (r.any) ok = r.any.some((re) => re.test(d));
    if (ok && r.not && r.not.some((re) => re.test(d))) ok = false;
    if (ok) hits.push(r);
  }
  return hits;
}

function fmtEntry(lines) {
  const debits = r2(lines.reduce((s, l) => s + l[1], 0));
  const credits = r2(lines.reduce((s, l) => s + l[2], 0));
  return { lines: lines.filter((l) => l[1] || l[2]).map(([account, debit, credit]) => ({ account, debit: debit || 0, credit: credit || 0 })), totalDebits: debits, totalCredits: credits, balanced: debits === credits };
}

// ── account classification ──
const ACCOUNTS = [
  ['cash|checking|savings|petty cash|bank account', 'Asset', 'Debit', 'Balance sheet', 'Current asset'],
  ['accounts receivable|receivables|a/r', 'Asset', 'Debit', 'Balance sheet', 'Current asset'],
  ['allowance for doubtful|accumulated depreciation|accumulated amortization', 'Contra-asset', 'Credit', 'Balance sheet', 'Reduces the related asset'],
  ['inventory|merchandise', 'Asset', 'Debit', 'Balance sheet', 'Current asset'],
  ['prepaid', 'Asset', 'Debit', 'Balance sheet', 'Current asset'],
  ['supplies', 'Asset', 'Debit', 'Balance sheet', 'Current asset (expense when used)'],
  ['equipment|vehicle|machinery|furniture|building|land|computer', 'Asset', 'Debit', 'Balance sheet', 'Property, plant and equipment (land is not depreciated)'],
  ['goodwill|patent|trademark|intangible', 'Asset', 'Debit', 'Balance sheet', 'Intangible asset'],
  ['accounts payable|payables|a/p', 'Liability', 'Credit', 'Balance sheet', 'Current liability'],
  ['accrued|wages payable|salaries payable|interest payable|taxes payable|sales tax payable', 'Liability', 'Credit', 'Balance sheet', 'Current liability'],
  ['unearned|deferred revenue|customer deposit', 'Liability', 'Credit', 'Balance sheet', 'Current liability'],
  ['loan|notes? payable|mortgage|bonds? payable|line of credit', 'Liability', 'Credit', 'Balance sheet', 'Current or long-term depending on due date'],
  ['owner.?s? ?(draw|withdrawal)|drawings|dividends? (declared|paid)|distributions', 'Equity (contra)', 'Debit', 'Statement of owner\'s equity', 'Reduces equity, not an expense'],
  ['capital|common stock|paid.in|retained earnings|owner.?s equity|members?.? equity', 'Equity', 'Credit', 'Balance sheet', 'Owner\'s claim on assets'],
  ['sales returns|returns and allowances|sales discounts', 'Contra-revenue', 'Debit', 'Income statement', 'Reduces revenue'],
  ['revenue|sales|service fees?|income|fees earned|interest income|rental income', 'Revenue', 'Credit', 'Income statement', 'Operating revenue (interest and gains are often non-operating)'],
  ['cost of goods|cogs|cost of sales', 'Expense', 'Debit', 'Income statement', 'Cost of goods sold'],
  ['expense|salaries|wages|rent|utilities|insurance|advertising|depreciation|amortization|supplies expense|fees|interest expense|bad debt|repairs|travel|meals', 'Expense', 'Debit', 'Income statement', 'Operating expense (interest expense is non-operating)'],
];
function classify(name) {
  const n = name.toLowerCase();
  // contra and specific buckets are listed before general ones; first match wins
  for (const [pat, type, normal, statement, note] of ACCOUNTS) if (new RegExp(pat).test(n)) return { account: name, type, normalBalance: normal, statement, note, confidence: 'rule match' };
  return { account: name, type: 'Unknown', normalBalance: null, statement: null, note: 'No rule matched. Tell me what this account holds (asset, liability, equity, revenue or expense) and I can classify it.', confidence: 'none' };
}

const ADJUSTING = {
  prepaid_expense_used: (d) => ({ title: 'Prepaid expense used up', entry: [[d.expense_account || 'Insurance/Rent Expense', d.amount, 0], [d.prepaid_account || 'Prepaid Asset', 0, d.amount]], why: 'Move the portion of the prepaid asset consumed this period to expense.', howToCompute: 'Prepaid cost / months covered x months elapsed.' }),
  supplies_used: (d) => ({ title: 'Supplies used', entry: [['Supplies Expense', d.amount, 0], ['Supplies (Asset)', 0, d.amount]], why: 'Beginning supplies + purchases - ending count = supplies used.' }),
  depreciation: (d) => ({ title: 'Depreciation', entry: [['Depreciation Expense', d.amount, 0], ['Accumulated Depreciation', 0, d.amount]], why: 'Allocates asset cost to the period.' }),
  accrued_expense: (d) => ({ title: 'Accrued expense (incurred, not yet paid)', entry: [[d.expense_account || 'Wages/Interest Expense', d.amount, 0], [d.liability_account || 'Wages/Interest Payable', 0, d.amount]], why: 'Expense belongs to the period even though no bill or payment exists yet.' }),
  accrued_revenue: (d) => ({ title: 'Accrued revenue (earned, not yet billed)', entry: [['Accounts Receivable / Unbilled Revenue', d.amount, 0], ['Service Revenue', 0, d.amount]], why: 'Work completed but not invoiced is still revenue of this period.' }),
  unearned_revenue_earned: (d) => ({ title: 'Unearned revenue now earned', entry: [['Unearned Revenue', d.amount, 0], ['Service Revenue', 0, d.amount]], why: 'Deferred revenue is recognised as the service is delivered.' }),
  bad_debt_allowance: (d) => ({ title: 'Estimated bad debts (allowance method)', entry: [['Bad Debt Expense', d.amount, 0], ['Allowance for Doubtful Accounts', 0, d.amount]], why: 'Estimate uncollectible receivables, for example a percent of sales or an aging schedule.' }),
};

function buildServer() {
  const server = new McpServer({ name: 'ledgeriq-journal', version: '2.0.0' });

  server.tool('get_journal_entry',
    'Turns a plain-English transaction (for example "paid $1,200 rent", "sold services on account for $3,000", "bought a laptop for $1,800 with a loan") into a balanced debit/credit journal entry with the reasoning. Rule-based and deterministic: if the wording is ambiguous or unrecognised it says so and lists what to clarify, rather than guessing.',
    { description: z.string().min(4).describe('What happened, in plain words'), amount: z.number().positive().describe('Transaction amount in dollars'), interest_portion: z.number().min(0).optional().describe('For loan payments: the interest part of the payment'), down_payment: z.number().min(0).optional().describe('For financed purchases: cash paid up front') },
    async ({ description, amount, interest_portion, down_payment }) => {
      const hits = matchRule(description);
      if (!hits.length) return reply({ matched: false, message: 'No confident match. Say whether cash changed hands or it was on credit, and what it was for (sale, expense, asset purchase, loan, owner investment or withdrawal).', examples: ['Paid $1,200 rent for October', 'Sold services on account for $3,000', 'Collected $3,000 from a customer invoice', 'Bought a laptop for $1,800 with a loan'], note: NOTE });
      const best = hits[0];
      const entry = fmtEntry(best.build(amount, { interest: interest_portion, down: down_payment }));
      return reply({ matched: true, ruleId: best.id, entry, whyThisEntry: best.why, alternatives: hits.slice(1, 3).map((h) => ({ ruleId: h.id, entry: fmtEntry(h.build(amount, { interest: interest_portion, down: down_payment })), why: h.why })), ...(hits.length > 1 ? { ambiguity: 'More than one pattern matched. The first is the best fit by specificity; check the alternatives if the facts differ.' } : {}), note: NOTE });
    });

  server.tool('get_adjusting_entries',
    'Month-end or year-end adjusting entry templates for the standard cases: prepaid expense used, supplies used, depreciation, accrued expense, accrued revenue, unearned revenue earned, and bad debt estimate. Returns the balanced entry, why it is needed and how to compute the amount. Pass the adjustment types you need.',
    { adjustments: z.array(z.object({ type: z.enum(Object.keys(ADJUSTING)), amount: z.number().positive(), expense_account: z.string().optional(), prepaid_account: z.string().optional(), liability_account: z.string().optional() })).min(1).max(20) },
    async ({ adjustments }) => reply({ entries: adjustments.map((a) => { const e = ADJUSTING[a.type](a); return { type: a.type, title: e.title, ...fmtEntry(e.entry), why: e.why, ...(e.howToCompute ? { howToCompute: e.howToCompute } : {}) }; }), reminder: 'Adjusting entries are posted before the adjusted trial balance and the financial statements. They never touch the Cash account.', note: NOTE }));

  server.tool('get_account_classification',
    'Classifies an account name: type (asset, liability, equity, revenue, expense and contra variants), normal balance (debit or credit), and which financial statement it appears on. Pass one or several account names.',
    { accounts: z.array(z.string().min(2)).min(1).max(50).describe('Account names, e.g. ["Accounts Receivable","Owner Draw","Unearned Revenue"]') },
    async ({ accounts }) => reply({ results: accounts.map(classify), rule: 'Assets and expenses increase with debits. Liabilities, equity and revenue increase with credits. Contra accounts carry the opposite balance of their parent.', note: NOTE }));

  server.tool('get_closing_entries',
    'Year-end closing entries that reset temporary accounts: close revenue to Income Summary, close expenses to Income Summary, close Income Summary to retained earnings (or owner capital), then close owner draws or dividends. Computes net income and returns the four balanced entries.',
    { revenues: z.array(z.object({ account: z.string(), amount: z.number().min(0) })).min(1), expenses: z.array(z.object({ account: z.string(), amount: z.number().min(0) })).min(1), owner_draws_or_dividends: z.number().min(0).default(0), entity: z.enum(['sole_prop_or_partnership', 'corporation']).default('sole_prop_or_partnership').describe('Decides whether income closes to Owner\'s Capital or Retained Earnings') },
    async ({ revenues, expenses, owner_draws_or_dividends, entity }) => {
      const rev = r2(revenues.reduce((s, x) => s + x.amount, 0));
      const exp = r2(expenses.reduce((s, x) => s + x.amount, 0));
      const net = r2(rev - exp);
      const equity = entity === 'corporation' ? 'Retained Earnings' : 'Owner\'s Capital';
      const drawAcct = entity === 'corporation' ? 'Dividends' : 'Owner\'s Draw';
      const entries = [
        { step: 1, title: 'Close revenue accounts to Income Summary', ...fmtEntry([...revenues.map((x) => [x.account, x.amount, 0]), ['Income Summary', 0, rev]]) },
        { step: 2, title: 'Close expense accounts to Income Summary', ...fmtEntry([['Income Summary', exp, 0], ...expenses.map((x) => [x.account, 0, x.amount])]) },
        { step: 3, title: `Close Income Summary to ${equity}`, ...(net >= 0 ? fmtEntry([['Income Summary', net, 0], [equity, 0, net]]) : fmtEntry([[equity, -net, 0], ['Income Summary', 0, -net]])) },
      ];
      if (owner_draws_or_dividends > 0) entries.push({ step: 4, title: `Close ${drawAcct} to ${equity}`, ...fmtEntry([[equity, owner_draws_or_dividends, 0], [drawAcct, 0, owner_draws_or_dividends]]) });
      return reply({ totalRevenue: rev, totalExpenses: exp, netIncome: net, result: net >= 0 ? 'Net income' : 'Net loss', entries, afterClosing: 'Revenue, expense, Income Summary and draw/dividend accounts have zero balances. Only balance sheet accounts carry forward.', note: NOTE });
    });

  return server;
}

const PORT = process.env.PORT || 8080;
const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url !== '/' && !req.url?.startsWith('/mcp')) { res.writeHead(404); res.end(); return; }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});
httpServer.listen(PORT, () => console.log(`ledgeriq-journal listening on :${PORT}`));
