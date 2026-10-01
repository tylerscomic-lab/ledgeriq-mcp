import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── Business entity structure: federal tax comparison (tax year 2026) ───
// Compares sole proprietorship / single-member LLC, S-corporation election,
// and C-corporation on federal income tax, FICA/self-employment tax and
// estimated extra compliance cost. Federal only; state taxes are not
// modelled. Figures: IRS Rev. Proc. 2025-32 (brackets, standard deduction),
// Social Security wage base $184,500. Estimates for planning, not advice.

const r2 = (n) => Math.round(n * 100) / 100;
const reply = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const NOTE = 'Federal estimates for planning, tax year 2026. Excludes state and local taxes, credits, itemized deductions, retirement contributions, health insurance deductions and the QBI wage/property limits that apply at higher incomes. Compliance costs are rough market estimates. Have a CPA model your actual situation before electing.';

const WAGE_BASE = 184500;
const STD = { single: 16100, mfj: 32200 };
const BR = {
  single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
  mfj: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
};
const QBI_LIMIT = { single: 201775, mfj: 403550 };
const ADDL_MED = { single: 200000, mfj: 250000 };

function incomeTax(taxable, status) {
  let tax = 0, lower = 0;
  for (const [up, rate] of BR[status]) { if (taxable > lower) tax += (Math.min(taxable, up) - lower) * rate; lower = up; if (taxable <= up) break; }
  return tax;
}
function seTax(net, status) {
  if (net < 400) return { total: 0, half: 0 };
  const base = net * 0.9235;
  const total = Math.min(base, WAGE_BASE) * 0.124 + base * 0.029 + Math.max(0, base - ADDL_MED[status]) * 0.009;
  return { total, half: (Math.min(base, WAGE_BASE) * 0.124 + base * 0.029) / 2 };
}
function ficaOnSalary(salary, status) {
  const employee = Math.min(salary, WAGE_BASE) * 0.062 + salary * 0.0145 + Math.max(0, salary - ADDL_MED[status]) * 0.009;
  const employer = Math.min(salary, WAGE_BASE) * 0.062 + salary * 0.0145;
  return { employee, employer };
}

function soleProp(profit, status) {
  const se = seTax(profit, status);
  const agi = profit - se.half;
  const pre = Math.max(0, agi - STD[status]);
  const qbi = pre > QBI_LIMIT[status] ? 0 : Math.min((profit - se.half) * 0.2, pre * 0.2);
  const tax = incomeTax(Math.max(0, pre - qbi), status);
  return { incomeTax: tax, payrollOrSeTax: se.total, corporateTax: 0, extraCompliance: 0, total: tax + se.total, qbi, notes: pre > QBI_LIMIT[status] ? ['Taxable income is above the QBI phase-out start: QBI not applied (may still be partly available).'] : [] };
}
function sCorp(profit, salary, status, payrollCost) {
  const f = ficaOnSalary(salary, status);
  const adminCost = payrollCost;
  const k1 = Math.max(0, profit - salary - f.employer - adminCost);
  const agi = salary + k1;
  const pre = Math.max(0, agi - STD[status]);
  const qbi = pre > QBI_LIMIT[status] ? 0 : Math.min(k1 * 0.2, pre * 0.2);
  const tax = incomeTax(Math.max(0, pre - qbi), status);
  return { incomeTax: tax, payrollOrSeTax: f.employee + f.employer, corporateTax: 0, extraCompliance: adminCost, total: tax + f.employee + f.employer + adminCost, k1Income: k1, qbi, notes: pre > QBI_LIMIT[status] ? ['Taxable income is above the QBI phase-out start: QBI not applied. At these levels the W-2 wage limit matters.'] : [] };
}
function cCorp(profit, salary, status, payrollCost, distributeAll) {
  const f = ficaOnSalary(salary, status);
  const corpProfit = Math.max(0, profit - salary - f.employer - payrollCost);
  const corpTax = corpProfit * 0.21;
  const dividend = distributeAll ? corpProfit - corpTax : 0;
  const pre = Math.max(0, salary + dividend - STD[status]);
  // dividends taxed at a flat 15% assumption (qualified dividend 0/15/20% bands vary); salary at ordinary rates
  const ordinaryTaxable = Math.max(0, salary - STD[status]);
  const tax = incomeTax(ordinaryTaxable, status) + dividend * 0.15;
  const niit = Math.max(0, Math.min(dividend, salary + dividend - ({ single: 200000, mfj: 250000 })[status])) * 0.038;
  return { incomeTax: tax + niit, payrollOrSeTax: f.employee + f.employer, corporateTax: corpTax, extraCompliance: payrollCost, total: tax + niit + f.employee + f.employer + corpTax + payrollCost, retainedInCorp: distributeAll ? 0 : corpProfit - corpTax, dividendsPaid: dividend, notes: ['Dividends assumed taxed at a flat 15%; actual qualified-dividend bands are 0%, 15% or 20% depending on income.', distributeAll ? 'All after-tax profit is paid out as dividends (double taxation).' : 'After-tax profit is retained in the corporation, so no dividend tax is shown now, but it is taxed when eventually distributed or the company is sold.'] };
}

const STATE_COSTS = {
  CA: { llc: 'LLC: $800 minimum annual franchise tax plus a gross-receipts fee above $250,000 in income.', s_corp: 'S-corp: greater of $800 or 1.5% of net income in franchise tax.', c_corp: 'C-corp: greater of $800 or 8.84% of net income.', annualFixed: 800 },
  DE: { llc: 'LLC: $300 annual tax.', s_corp: 'Corporation: franchise tax with a minimum of about $175 plus a filing fee.', c_corp: 'Corporation: franchise tax with a minimum of about $175 plus a filing fee.', annualFixed: 300 },
  NY: { llc: 'LLC: biennial statement ($9) and a publication requirement in many counties that can cost $1,000 to $2,000 or more. Fixed-dollar minimum tax applies on LLC filing fee by receipts.', s_corp: 'S-corp: fixed-dollar minimum tax from $25 to $4,500 depending on receipts.', c_corp: 'C-corp: higher of capital, income or minimum tax bases.', annualFixed: 25 },
  TX: { llc: 'LLC: franchise tax report required annually; no tax due under the no-tax-due revenue threshold (roughly $2.5 million).', s_corp: 'Same franchise tax report; no tax due below the threshold.', c_corp: 'Same franchise tax report; no tax due below the threshold.', annualFixed: 0 },
  FL: { llc: 'LLC: $138.75 annual report fee.', s_corp: 'Corporation: $150 annual report fee.', c_corp: 'Corporation: $150 annual report fee; 5.5% state corporate income tax applies to C-corps.', annualFixed: 150 },
  WY: { llc: 'LLC: annual license tax of $60 minimum.', s_corp: 'Corporation: $60 minimum annual license tax.', c_corp: 'Corporation: $60 minimum annual license tax.', annualFixed: 60 },
  NV: { llc: 'State business license of about $200 a year plus an annual list.', s_corp: 'State business license of about $200 a year plus an annual list.', c_corp: 'State business license of about $200 a year plus an annual list.', annualFixed: 200 },
};

const CONVERSIONS = {
  'sole_prop->llc': ['Choose and check name availability with the Secretary of State.', 'File Articles of Organization and pay the state fee.', 'Get an EIN (a single-member LLC can often keep using the owner\'s SSN, but an EIN is advisable).', 'Open a business bank account and move money flows to it.', 'Sign an operating agreement.', 'Update licenses, permits, insurance and vendor/customer records.', 'No tax election needed: a single-member LLC is taxed as a sole proprietorship by default.'],
  'llc->s_corp': ['Confirm eligibility: US owners only, one class of stock, 100 or fewer shareholders.', 'Get an EIN and file Form 2553 (S election) with the IRS. Deadline: 2 months and 15 days after the start of the tax year the election takes effect, or late-election relief under Rev. Proc. 2013-30.', 'Set up payroll. Pay yourself a reasonable W-2 salary before taking distributions.', 'Run separate books, file Form 1120-S each year, issue K-1s.', 'Check state: some states tax S-corps differently (for example CA franchise tax, NYC, TN).', 'Add health insurance for 2%+ shareholders to W-2 wages correctly.'],
  'llc->c_corp': ['Choose state of incorporation (usually your home state unless raising venture capital).', 'File Articles of Incorporation, adopt bylaws, issue stock, hold an organizational meeting.', 'Get an EIN and set up corporate bank accounts and payroll.', 'File Form 1120 each year. Corporate rate is 21% flat.', 'Consider Section 351 so contributing property to the corporation is tax-free.'],
  'sole_prop->s_corp': ['Form an LLC or corporation first (see sole_prop->llc).', 'Then follow the llc->s_corp steps and file Form 2553.'],
  's_corp->llc': ['Terminating an S-corp may trigger tax on asset distributions: involve a CPA.', 'Revoke the S election (majority of shareholders consent), file the final Form 1120-S, then re-form as a default LLC.', 'Final payroll filings and state dissolution or conversion paperwork are required.'],
  'c_corp->s_corp': ['Confirm eligibility and that no built-in-gains tax issue surprises you (5-year recognition period).', 'File Form 2553 within 2 months and 15 days of the start of the year.', 'Accumulated earnings and profits can create passive-income and double-tax traps: have a CPA review.'],
};

function buildServer() {
  const server = new McpServer({ name: 'ledgeriq-entity', version: '2.0.0' });

  server.tool('compare_entity_structures',
    'Compares sole proprietorship / single-member LLC, S-corporation election and C-corporation side by side for a given business profit and filing status: federal income tax, self-employment or payroll tax, corporate tax, extra compliance cost and total, ranked cheapest first. Federal only (tax year 2026). Optionally lists state filing costs for CA, DE, NY, TX, FL, WY or NV.',
    {
      net_profit: z.number().positive().describe('Annual business profit before any owner pay'),
      filing_status: z.enum(['single', 'mfj']).default('single'),
      s_corp_salary: z.number().min(0).optional().describe('Reasonable owner salary. Default 45% of profit with a $40,000 floor (capped at profit).'),
      payroll_and_filing_cost: z.number().min(0).default(2000).describe('Estimated extra yearly cost of payroll service plus the entity tax return for an S or C corporation'),
      c_corp_distributes_profit: z.boolean().default(false).describe('Pay all after-tax corporate profit out as dividends'),
      state: z.string().length(2).optional().describe('Two-letter state for filing-cost notes'),
    },
    async (a) => {
      const salary = Math.min(a.net_profit, a.s_corp_salary ?? Math.max(40000, a.net_profit * 0.45));
      const sp = soleProp(a.net_profit, a.filing_status);
      const sc = sCorp(a.net_profit, salary, a.filing_status, a.payroll_and_filing_cost);
      const cc = cCorp(a.net_profit, salary, a.filing_status, a.payroll_and_filing_cost, a.c_corp_distributes_profit);
      const fmt = (name, x) => ({ structure: name, federalIncomeTax: r2(x.incomeTax), selfEmploymentOrPayrollTax: r2(x.payrollOrSeTax), corporateIncomeTax: r2(x.corporateTax), extraCompliance: r2(x.extraCompliance), totalFederalCost: r2(x.total), effectiveRatePct: r2(x.total / a.net_profit * 100), ...(x.retainedInCorp ? { profitRetainedInCorporation: r2(x.retainedInCorp) } : {}), notes: x.notes });
      const rows = [fmt('Sole proprietorship / single-member LLC (default)', sp), fmt(`S-corporation (salary $${Math.round(salary).toLocaleString()})`, sc), fmt('C-corporation', cc)].sort((x, y) => x.totalFederalCost - y.totalFederalCost);
      const state = a.state ? STATE_COSTS[a.state.toUpperCase()] : null;
      return reply({ netProfit: a.net_profit, filingStatus: a.filing_status, assumedOwnerSalary: Math.round(salary), ranked: rows, cheapest: rows[0].structure, ...(rows[0].structure.startsWith('C-corporation') && !a.c_corp_distributes_profit ? { cheapestCaveat: 'The C-corporation looks cheapest only because the after-tax profit is left in the company. Set c_corp_distributes_profit to true to see the cost when that money reaches you personally.' } : {}), savingsVsSoleProp: r2(sp.total - sc.total), ...(state ? { stateFilingCosts: state } : a.state ? { stateFilingCosts: `No built-in data for ${a.state.toUpperCase()}. Check the Secretary of State and Department of Revenue.` } : {}), considerations: ['The S-corp saving is mostly payroll tax on profit above a reasonable salary; the IRS expects a defensible salary, so a very low salary is an audit risk.', 'Below roughly $40,000 to $60,000 of profit the S-corp saving usually does not cover payroll and compliance cost.', 'A C-corporation usually costs more for a small owner-operator unless profit is retained for growth.', 'Cheapest on federal tax is not the only criterion: liability protection, raising capital, selling the business and state taxes also matter.'], note: NOTE });
    });

  server.tool('calculate_scorp_savings',
    'Estimated annual savings from converting a sole proprietor or single-member LLC to an S-corporation: self-employment tax avoided on profit above a reasonable salary, less employer payroll tax, extra payroll and compliance cost, and the effect on the 20% QBI deduction. Includes a break-even and a salary sensitivity table.',
    { net_profit: z.number().positive(), reasonable_salary: z.number().min(0).describe('The W-2 salary you would pay yourself'), filing_status: z.enum(['single', 'mfj']).default('single'), payroll_and_filing_cost: z.number().min(0).default(2000) },
    async ({ net_profit, reasonable_salary, filing_status, payroll_and_filing_cost }) => {
      const salary = Math.min(reasonable_salary, net_profit);
      const base = soleProp(net_profit, filing_status);
      const s = sCorp(net_profit, salary, filing_status, payroll_and_filing_cost);
      const save = base.total - s.total;
      const sens = [0.3, 0.4, 0.5, 0.6, 0.7].map((p) => { const sal = Math.round(net_profit * p); const x = sCorp(net_profit, sal, filing_status, payroll_and_filing_cost); return { salaryPctOfProfit: p * 100, salary: sal, totalFederalCost: r2(x.total), savingVsSoleProp: r2(base.total - x.total) }; });
      return reply({ netProfit: net_profit, salary, soleProprietorTotalFederalCost: r2(base.total), sCorpTotalFederalCost: r2(s.total), estimatedAnnualSavings: r2(save), seTaxAsSoleProp: r2(base.payrollOrSeTax), payrollTaxAsSCorp: r2(s.payrollOrSeTax), extraCompliance: payroll_and_filing_cost, worthIt: save > 0 ? (save < 2000 ? 'Marginal: savings are small relative to complexity and audit exposure.' : 'Likely worth modelling with a CPA.') : 'No saving at this salary and profit.', salarySensitivity: sens, warnings: ['Salary must be reasonable for the work you do. The IRS can recharacterise distributions as wages.', 'Lower W-2 salary also lowers Social Security benefits, retirement-plan contribution room and sometimes loan qualification.', 'State taxes (for example CA franchise tax) can erase part of the saving.', ...s.notes], note: NOTE });
    });

  server.tool('get_entity_compliance_costs',
    'Typical yearly compliance requirements and costs by entity type (sole proprietorship, LLC, S-corp, C-corp), with filing fees for CA, DE, NY, TX, FL, WY and NV. State figures are approximate and change; verify with the state.',
    { entity_type: z.enum(['sole_prop', 'llc', 's_corp', 'c_corp']), state: z.string().length(2).optional() },
    async ({ entity_type, state }) => {
      const base = {
        sole_prop: { federalForms: ['Schedule C with Form 1040', 'Schedule SE'], estimatedYearlyCost: '$0 to $500 beyond normal tax prep', requirements: ['Quarterly estimated taxes', 'Local business license where required'] },
        llc: { federalForms: ['Schedule C with Form 1040 (single member)', 'Form 1065 and K-1s (multi-member)'], estimatedYearlyCost: '$100 to $1,500 depending on state fees and filing complexity', requirements: ['State annual report or franchise tax', 'Registered agent', 'Operating agreement'] },
        s_corp: { federalForms: ['Form 1120-S and K-1s', 'Payroll: 941 quarterly, W-2, W-3, 940'], estimatedYearlyCost: '$1,500 to $4,000 for payroll service and corporate return', requirements: ['Reasonable W-2 salary', 'Separate corporate bank account and books', 'Annual shareholder meeting minutes', 'State annual report'] },
        c_corp: { federalForms: ['Form 1120', 'Payroll forms if paying wages', 'Form 1099-DIV for dividends'], estimatedYearlyCost: '$1,500 to $5,000 plus state franchise or income tax', requirements: ['Bylaws, board and shareholder records', 'Corporate bank account and books', 'State annual report and franchise tax'] },
      }[entity_type];
      const key = entity_type === 'llc' || entity_type === 'sole_prop' ? 'llc' : entity_type;
      const st = state ? STATE_COSTS[state.toUpperCase()] : null;
      return reply({ entityType: entity_type, ...base, ...(entity_type === 'sole_prop' ? {} : st ? { state: state.toUpperCase(), stateFilingCosts: st[key], approximateFixedAnnualFeeUsd: st.annualFixed } : state ? { state: state.toUpperCase(), stateFilingCosts: 'No built-in data for this state. Check the Secretary of State fee schedule.' } : {}), note: NOTE });
    });

  server.tool('get_conversion_steps',
    'Step-by-step checklist for converting between entity types (sole proprietorship to LLC, LLC to S-corp or C-corp, S-corp back to LLC, C-corp to S-corp), with the key IRS deadline for the S election (Form 2553, within 2 months and 15 days of the start of the tax year).',
    { from: z.enum(['sole_prop', 'llc', 's_corp', 'c_corp']), to: z.enum(['sole_prop', 'llc', 's_corp', 'c_corp']) },
    async ({ from, to }) => {
      const key = `${from}->${to}`;
      const steps = CONVERSIONS[key];
      if (!steps) return reply({ supported: Object.keys(CONVERSIONS), message: `No built-in checklist for ${key}. Closest options are listed. A CPA or attorney should handle conversions that involve assets, debt or multiple owners.`, note: NOTE });
      return reply({ conversion: key, steps, timeline: 'State formation: days to a few weeks. S election: effective as of the start of the tax year if Form 2553 is filed by March 15 for a calendar-year company.', note: NOTE });
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
httpServer.listen(PORT, () => console.log(`ledgeriq-entity listening on :${PORT}`));
