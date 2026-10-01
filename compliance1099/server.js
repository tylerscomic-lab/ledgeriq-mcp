import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── 1099 / W-2 compliance rules ──────────────────────────────────────────
// Reporting thresholds (OBBBA raised 1099-NEC and most 1099-MISC thresholds
// from $600 to $2,000 for payments made after 12/31/2025), filing deadlines
// with weekend/holiday roll-forward, backup withholding (24%) and information
// return penalty tiers. Rules are summarised from IRS General Instructions
// for Certain Information Returns; edge cases exist. Not tax advice.

const r2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const reply = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const NOTE = 'Based on IRS General Instructions for Certain Information Returns and the One Big Beautiful Bill Act threshold change. Summarised rules with exceptions omitted; confirm unusual situations with a tax professional or the IRS instructions for the specific form. Not tax advice.';

// Federal holidays that can land on a filing deadline (Jan 1 observed, MLK, Presidents Day, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas)
function nthWeekday(year, month, weekday, n) { const d = new Date(Date.UTC(year, month, 1)); const off = (weekday - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(year, month, 1 + off + (n - 1) * 7)); }
function holidays(year) {
  const fixed = (m, day) => { const d = new Date(Date.UTC(year, m, day)); if (d.getUTCDay() === 6) return new Date(Date.UTC(year, m, day - 1)); if (d.getUTCDay() === 0) return new Date(Date.UTC(year, m, day + 1)); return d; };
  const lastMon = () => { const d = new Date(Date.UTC(year, 5, 0)); return new Date(Date.UTC(year, 4, d.getUTCDate() - ((d.getUTCDay() + 6) % 7))); };
  return new Set([fixed(0, 1), nthWeekday(year, 0, 1, 3), nthWeekday(year, 1, 1, 3), lastMon(), fixed(5, 19), fixed(6, 4), nthWeekday(year, 8, 1, 1), nthWeekday(year, 9, 1, 2), fixed(10, 11), nthWeekday(year, 10, 4, 4), fixed(11, 25)].map(iso));
}
function rollForward(y, m, day) {
  let d = new Date(Date.UTC(y, m, day));
  const hol = new Set([...holidays(y), ...holidays(y + 1)]);
  let rolled = false;
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || hol.has(iso(d))) { d = new Date(d.getTime() + 86400000); rolled = true; }
  return { date: iso(d), rolledFromWeekendOrHoliday: rolled };
}

const PAYMENT_TYPES = {
  contractor_services: { form: '1099-NEC', box: 'Box 1 nonemployee compensation', threshold: { 2025: 600, 2026: 2000 }, note: 'Services by someone who is not your employee, in the course of your trade or business.' },
  rent: { form: '1099-MISC', box: 'Box 1 rents', threshold: { 2025: 600, 2026: 2000 }, note: 'Rent for office space, equipment, machinery. Rent paid to a real estate agent or property manager is generally reported by them, not you.' },
  royalties: { form: '1099-MISC', box: 'Box 2 royalties', threshold: { 2025: 10, 2026: 10 }, note: 'Royalties of $10 or more.' },
  prizes_awards: { form: '1099-MISC', box: 'Box 3 other income', threshold: { 2025: 600, 2026: 2000 }, note: 'Prizes, awards and other income not for services.' },
  medical_health: { form: '1099-MISC', box: 'Box 6 medical and health care payments', threshold: { 2025: 600, 2026: 2000 }, note: 'Payments to physicians and other providers, including corporations.' },
  attorney_gross_proceeds: { form: '1099-MISC', box: 'Box 10 gross proceeds paid to an attorney', threshold: { 2025: 600, 2026: 600 }, note: 'Settlement or claim proceeds paid to an attorney, reportable even to a corporation. Separate from fees for legal services (use contractor_services).' },
  attorney_fees: { form: '1099-NEC', box: 'Box 1 nonemployee compensation', threshold: { 2025: 600, 2026: 2000 }, note: 'Legal fees for services are reportable even when the law firm is a corporation.' },
  interest: { form: '1099-INT', box: 'Box 1 interest income', threshold: { 2025: 10, 2026: 10 }, note: 'Interest of $10 or more.' },
  dividends: { form: '1099-DIV', box: 'Box 1a ordinary dividends', threshold: { 2025: 10, 2026: 10 }, note: 'Dividends of $10 or more.' },
};

function check1099({ payment_type, amount, payee_entity, payment_method, tax_year, payee_is_us_person, is_personal }) {
  const p = PAYMENT_TYPES[payment_type];
  const year = tax_year >= 2026 ? 2026 : 2025;
  const reasons = [];
  if (is_personal) return { required: false, reasons: ['Payments for personal (non-business) purposes are not reportable.'] };
  if (payment_method === 'credit_card' || payment_method === 'payment_app') {
    return { required: false, form: null, reasons: ['Payments made by credit card, debit card or a third-party network (PayPal, Venmo business, Stripe) are reported by the payment processor on Form 1099-K, not by you on a 1099-NEC or 1099-MISC.'], nextStep: 'No 1099-NEC/MISC from you for this payment. Keep the receipt.' };
  }
  const corpExempt = ['c_corp', 's_corp'].includes(payee_entity) && !['attorney_fees', 'attorney_gross_proceeds', 'medical_health'].includes(payment_type);
  if (corpExempt) reasons.push(`Payments to a ${payee_entity === 'c_corp' ? 'C' : 'S'} corporation are generally exempt from 1099-NEC/MISC reporting. (Exceptions: attorneys, medical and health care payments. Keep the W-9 that shows corporate status.)`);
  const over = amount >= p.threshold[year];
  if (!over) reasons.push(`The total of $${amount} for the year is below the ${year === 2026 ? '2026' : 'pre-2026'} reporting threshold of $${p.threshold[year]} (aggregate payments to this payee for the calendar year, not per invoice).`);
  const required = !corpExempt && over;
  const out = {
    required, form: required ? p.form : null, taxYear: tax_year, box: required ? p.box : null,
    threshold: p.threshold[year], amountEntered: amount,
    reasons: required ? [`$${amount} paid for ${payment_type.replace(/_/g, ' ')} meets or exceeds the $${p.threshold[year]} threshold.`, p.note] : reasons,
  };
  if (payee_is_us_person === false && required) out.warning = 'Payments to non-US persons for services performed outside the US are generally not reported on 1099-NEC; they may require Form 1042-S and withholding instead. Get a W-8BEN.';
  out.alwaysDo = ['Collect a Form W-9 from every US payee before paying them.', 'Withhold 24% backup withholding if the payee refuses to provide a TIN (see check_backup_withholding).', 'Aggregate all payments to the payee for the calendar year before comparing to the threshold.'];
  if (tax_year === 2025 && amount >= 600 && amount < 2000) out.thresholdNote = 'Payments made in 2025 use the old $600 threshold. The $2,000 threshold applies to payments made after December 31, 2025.';
  return out;
}

function deadlines(form, taxYear) {
  const fy = taxYear + 1; // filing year
  const jan31 = rollForward(fy, 0, 31);
  const feb28 = rollForward(fy, 1, 28);
  const mar31 = rollForward(fy, 2, 31);
  const common = { taxYear, filingYear: fy, nonCompliancePenaltyNote: 'Late filing penalties apply per return, see calculate_late_filing_penalties.' };
  switch (form) {
    case '1099-NEC': return { ...common, form, recipientCopy: jan31, irsFiling: jan31, notes: ['Both the recipient copy and the IRS copy are due the same day, with no extended paper deadline.', 'E-filing is required if you file 10 or more information returns in total (aggregated across types).'] };
    case '1099-MISC': return { ...common, form, recipientCopy: jan31, irsPaper: feb28, irsElectronic: mar31, notes: ['Royalties and broker payments in lieu (Box 8) and substitute payments: recipient copy due Feb 15.', 'E-filing is required if you file 10 or more information returns in total.'] };
    case 'W-2': return { ...common, form, recipientCopy: jan31, ssaFiling: jan31, notes: ['W-2 copies go to employees and to the Social Security Administration by the same date, paper or electronic.', 'E-file required at 10 or more information returns.'] };
    case '1099-K': return { ...common, form, recipientCopy: jan31, irsPaper: feb28, irsElectronic: mar31, notes: ['Filed by payment settlement entities and platforms, not by most small businesses.'] };
    default: return { error: 'Supported forms: 1099-NEC, 1099-MISC, W-2, 1099-K' };
  }
}

// Information return penalties (IRC 6721/6722). Amounts adjust each year.
const PENALTY = { 2026: { d30: 60, aug1: 130, late: 340, intentional: 680, label: 'returns due in 2026 (tax year 2025)' } };

function buildServer() {
  const server = new McpServer({ name: 'ledgeriq-1099-w2-compliance', version: '2.0.0' });

  server.tool('check_1099_required',
    'Is a 1099 required for this payment, and which form and box? Applies the 2026 rules: $2,000 threshold for 1099-NEC and most 1099-MISC for payments made after 2025 (the old $600 for 2025), $10 royalties, corporation exemption with its attorney and medical exceptions, card and payment-app payments pushed to 1099-K, personal payments, and non-US payees.',
    {
      payment_type: z.enum(Object.keys(PAYMENT_TYPES)).describe('What the payment was for'),
      amount: z.number().min(0).describe('Total paid to this payee during the calendar year'),
      payee_entity: z.enum(['individual_or_sole_prop', 'llc_single_member', 'llc_partnership', 'partnership', 's_corp', 'c_corp', 'unknown']).default('unknown').describe('Payee tax classification from their W-9'),
      payment_method: z.enum(['check_or_ach_or_cash', 'credit_card', 'payment_app']).default('check_or_ach_or_cash'),
      tax_year: z.number().int().min(2024).max(2027).default(2026).describe('Calendar year the payment was made'),
      payee_is_us_person: z.boolean().default(true),
      is_personal: z.boolean().default(false).describe('Payment was for personal, non-business purposes'),
    },
    async (a) => reply({ ...check1099(a), note: NOTE }));

  server.tool('get_1099_deadlines',
    'Filing and recipient-copy deadlines for 1099-NEC, 1099-MISC, W-2 and 1099-K for a tax year, automatically rolled forward when the date falls on a weekend or federal holiday (for example Jan 31, 2027 is a Sunday, so the deadline is Feb 1, 2027).',
    { form_type: z.enum(['1099-NEC', '1099-MISC', 'W-2', '1099-K']), tax_year: z.number().int().min(2024).max(2030).default(2026) },
    async ({ form_type, tax_year }) => reply({ ...deadlines(form_type, tax_year), note: NOTE }));

  server.tool('check_backup_withholding',
    'Does backup withholding apply, and how much? The 24% rate applies to reportable payments when a payee does not provide a TIN, provides an obviously incorrect one, or the IRS has sent a B-notice or underreporting notice. Returns the amount to withhold and the amount to pay the payee.',
    {
      amount: z.number().positive().describe('Reportable payment amount'),
      payee_provided_tin: z.boolean().describe('Did the payee give you a TIN (W-9)?'),
      irs_b_notice_received: z.boolean().default(false).describe('Did the IRS send you a notice that the payee TIN is incorrect or that the payee underreported?'),
      payee_is_exempt: z.boolean().default(false).describe('Exempt payee, for example a corporation (generally exempt on 1099-NEC/MISC)'),
      payment_method: z.enum(['check_or_ach_or_cash', 'credit_card', 'payment_app']).default('check_or_ach_or_cash'),
    },
    async (a) => {
      const reasons = [];
      let applies = false;
      if (a.payment_method !== 'check_or_ach_or_cash') reasons.push('Card and payment-app payments are handled by the processor on Form 1099-K; backup withholding applies there, not to you.');
      else if (a.payee_is_exempt) reasons.push('Exempt payees (such as most corporations) are not subject to backup withholding.');
      else {
        if (!a.payee_provided_tin) { applies = true; reasons.push('No TIN provided. Backup withholding is required until you receive one.'); }
        if (a.irs_b_notice_received) { applies = true; reasons.push('IRS B-notice received: begin withholding no later than 30 business days after the notice date unless the payee certifies a correct TIN (first notice) or provides an IRS validation (second notice).'); }
        if (!applies) reasons.push('A TIN was provided and no IRS notice was received, so backup withholding does not apply.');
      }
      const withheld = applies ? r2(a.amount * 0.24) : 0;
      return reply({ backupWithholdingApplies: applies, rate: applies ? '24%' : null, amountToWithhold: withheld, amountToPayPayee: r2(a.amount - withheld), reasons, obligations: applies ? ['Deposit the withheld amount with the IRS (Form 945 annual return, with deposits per the deposit schedule).', 'Report the withholding in Box 4 of the 1099 you file for this payee.', 'Withheld amounts count as a tax payment credited to the payee.'] : [], note: NOTE });
    });

  server.tool('calculate_late_filing_penalties',
    'Penalty exposure for filing or furnishing information returns late or incorrectly: $60 per return within 30 days, $130 per return from day 31 through August 1, $340 per return after that or never filed, $680 per return for intentional disregard (rates for returns due in 2026; they adjust yearly). Counts the filing penalty and the separate penalty for failing to furnish recipient copies.',
    {
      number_of_returns: z.number().int().min(1).describe('How many returns are late or incorrect'),
      days_late: z.number().int().min(0).describe('Days after the due date when filed or corrected. Use a large number if never filed.'),
      intentional_disregard: z.boolean().default(false),
      also_late_to_recipient: z.boolean().default(false).describe('Recipient copies were also late, which triggers a second, separate penalty of the same size'),
      corrected_within_30_days_and_few_errors: z.boolean().default(false).describe('Errors corrected within 30 days and the number of errors is within the de minimis exception (the greater of 10 returns or 0.5% of returns)'),
    },
    async (a) => {
      const P = PENALTY[2026];
      if (a.corrected_within_30_days_and_few_errors) return reply({ perReturn: 0, totalPenalty: 0, reason: 'The de minimis exception treats these corrected returns as timely filed: no penalty.', note: NOTE });
      let per, tier;
      if (a.intentional_disregard) { per = P.intentional; tier = 'Intentional disregard (greater of $680 or 10% of the amount that should have been reported, no annual cap)'; }
      else if (a.days_late <= 30) { per = P.d30; tier = 'Corrected within 30 days of the due date'; }
      else if (a.days_late <= 183) { per = P.aug1; tier = 'Corrected after 30 days but by August 1'; }
      else { per = P.late; tier = 'Filed after August 1 or never filed'; }
      const filing = per * a.number_of_returns;
      const furnish = a.also_late_to_recipient ? per * a.number_of_returns : 0;
      return reply({ rateBasis: P.label, tier, perReturn: per, numberOfReturns: a.number_of_returns, filingPenalty: filing, recipientCopyPenalty: furnish, totalPenalty: filing + furnish, notes: ['Annual caps apply to non-intentional penalties and are lower for businesses with gross receipts of $5 million or less. Not modelled here.', 'Penalties can be waived for reasonable cause (IRC 6724).', 'Amounts for returns due in 2027 (tax year 2026) are adjusted for inflation and may be slightly higher.'], note: NOTE });
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
httpServer.listen(PORT, () => console.log(`ledgeriq-1099-w2-compliance listening on :${PORT}`));
