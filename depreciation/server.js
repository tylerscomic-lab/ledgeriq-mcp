import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── Federal tax depreciation (MACRS, Section 179, bonus) ─────────────────
// IRS Pub. 946 GDS tables (200%/150% declining balance switching to straight
// line, percentages as published), Section 179 limits for 2026 (Rev. Proc.
// 2025-32) and bonus depreciation as amended by the One Big Beautiful Bill
// Act (100% for property acquired after Jan 19, 2025). General information
// for planning, not tax advice.

const r2 = (n) => Math.round(n * 100) / 100;

// Half-year convention, percent per year (Pub. 946 Table A-1)
const HY = {
  3: [33.33, 44.45, 14.81, 7.41],
  5: [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  10: [10.0, 18.0, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  15: [5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
  20: [3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231],
};
// Mid-quarter convention, 5- and 7-year property (Pub. 946 Tables A-2 to A-5)
const MQ = {
  5: { 1: [35.0, 26.0, 15.6, 11.01, 11.01, 1.38], 2: [25.0, 30.0, 18.0, 11.37, 11.37, 4.26], 3: [15.0, 34.0, 20.4, 12.24, 11.3, 7.06], 4: [5.0, 38.0, 22.8, 13.68, 10.94, 9.58] },
  7: { 1: [25.0, 21.43, 15.31, 10.93, 8.75, 8.74, 8.75, 1.09], 2: [17.85, 23.47, 16.76, 11.97, 8.87, 8.87, 8.87, 3.34], 3: [10.71, 25.51, 18.22, 13.02, 9.3, 8.85, 8.86, 5.53], 4: [3.57, 27.55, 19.68, 14.06, 10.04, 8.73, 8.73, 7.64] },
};
const CLASS_EXAMPLES = {
  3: 'Certain tools, some race horses',
  5: 'Computers, office equipment, cars, light trucks, appliances, qualified technology',
  7: 'Office furniture and fixtures, most machinery and equipment, agricultural equipment',
  10: 'Vessels, barges, single-purpose agricultural structures',
  15: 'Land improvements (fences, roads, landscaping), qualified improvement property',
  20: 'Farm buildings, some municipal sewers',
};
const LIMITS_2026 = { section179: 2560000, phaseOutStart: 4090000, phaseOutEnd: 6650000 };

function macrsSchedule(cost, life, convention, quarter, startYear) {
  let table;
  if (convention === 'mid-quarter') {
    if (!MQ[life]) return { error: 'Mid-quarter tables are built in for 5-year and 7-year property. For other classes use the half-year convention or consult Pub. 946.' };
    table = MQ[life][quarter];
  } else table = HY[life];
  if (!table) return { error: `Unsupported recovery period ${life}. Use 3, 5, 7, 10, 15 or 20 (GDS, personal property).` };
  let acc = 0;
  const rows = table.map((pct, i) => {
    const dep = r2(cost * pct / 100);
    acc += dep;
    return { year: startYear ? startYear + i : i + 1, percent: pct, depreciation: dep, accumulated: r2(acc), remainingBasis: r2(cost - acc) };
  });
  // fold rounding residue into the last year so the schedule sums exactly to cost
  const last = rows[rows.length - 1];
  const drift = r2(cost - rows.reduce((s, r) => s + r.depreciation, 0));
  if (drift) { last.depreciation = r2(last.depreciation + drift); last.accumulated = r2(cost); last.remainingBasis = 0; }
  return { rows };
}

function section179(cost, totalPlacedInService, taxableBusinessIncome) {
  const spent = totalPlacedInService ?? cost;
  const limit = Math.max(0, LIMITS_2026.section179 - Math.max(0, spent - LIMITS_2026.phaseOutStart));
  const byLimit = Math.min(cost, limit);
  const byIncome = taxableBusinessIncome === undefined ? byLimit : Math.min(byLimit, Math.max(0, taxableBusinessIncome));
  return {
    deduction: r2(byIncome), carryforward: r2(byLimit - byIncome),
    dollarLimit: LIMITS_2026.section179, phaseOutStartsAt: LIMITS_2026.phaseOutStart, reducedLimit: r2(limit),
    notes: [
      'Section 179 cannot exceed taxable income from your active trades or businesses; the excess carries forward.',
      'The phase-out reduces the limit dollar for dollar once total qualifying property placed in service in the year passes the threshold.',
      'Heavy SUVs (over 6,000 lbs GVWR) have a separate, lower cap. Not modelled here.',
      'Recapture applies if business use drops to 50% or below.',
    ],
  };
}

function bonusRate(acquiredDate, placedYear) {
  const d = acquiredDate ? new Date(acquiredDate + 'T00:00:00') : null;
  if (!d || isNaN(d)) return { rate: 100, basis: 'No acquisition date given; assumed acquired after Jan 19, 2025 (100% permanent bonus under OBBBA).' };
  if (d > new Date('2025-01-19T23:59:59')) return { rate: 100, basis: 'Acquired after Jan 19, 2025: 100% bonus (OBBBA, permanent).' };
  const y = placedYear ?? 2026;
  const rate = y <= 2022 ? 100 : y === 2023 ? 80 : y === 2024 ? 60 : y === 2025 ? 40 : y === 2026 ? 20 : y === 2027 ? 0 : 0;
  return { rate, basis: `Acquired on or before Jan 19, 2025 and placed in service in ${y}: TCJA phase-down rate ${rate}%.` };
}

const reply = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const NOTE = 'General information for tax planning based on IRS Pub. 946 and 2026 limits (Rev. Proc. 2025-32, OBBBA). Not tax advice. Confirm elections (179, bonus opt-out) and state conformity with a tax professional; many states do not follow federal bonus or 179 rules.';

function buildServer() {
  const server = new McpServer({ name: 'ledgeriq-depreciation', version: '2.0.0' });

  server.tool('calculate_macrs',
    'Full MACRS (GDS) depreciation schedule for business property using the IRS Pub. 946 percentage tables: recovery periods 3, 5, 7, 10, 15 and 20 years, half-year or mid-quarter convention (5- and 7-year property). Returns each year\'s percent, deduction, accumulated depreciation and remaining basis, summing exactly to the cost.',
    { cost: z.number().positive().describe('Depreciable basis in dollars'), recovery_period: z.enum(['3', '5', '7', '10', '15', '20']).describe('MACRS recovery period in years'), convention: z.enum(['half-year', 'mid-quarter']).default('half-year'), quarter_placed_in_service: z.number().int().min(1).max(4).default(1).describe('Quarter placed in service, used for mid-quarter'), first_tax_year: z.number().int().optional().describe('Calendar year placed in service, to label rows') },
    async ({ cost, recovery_period, convention, quarter_placed_in_service, first_tax_year }) => {
      const life = Number(recovery_period);
      const s = macrsSchedule(cost, life, convention, quarter_placed_in_service, first_tax_year);
      if (s.error) return reply({ error: s.error });
      return reply({ cost, recoveryPeriod: life, convention, example: CLASS_EXAMPLES[life], schedule: s.rows, totalDepreciation: r2(s.rows.reduce((a, r) => a + r.depreciation, 0)), notes: ['Mid-quarter applies automatically when more than 40% of the year\'s depreciable basis (excluding 179 and real property) is placed in service in the last quarter. This tool applies whichever you choose.', 'Passenger automobiles are subject to annual luxury-auto caps not modelled here.'], note: NOTE });
    });

  server.tool('calculate_section_179',
    'First-year Section 179 expensing deduction for 2026: $2,560,000 dollar limit, dollar-for-dollar phase-out above $4,090,000 of qualifying property placed in service, and the taxable-business-income limit with carryforward.',
    { cost: z.number().positive().describe('Cost of the qualifying property'), total_qualifying_property_placed_in_service: z.number().min(0).optional().describe('All Section 179 property placed in service this year (for the phase-out). Defaults to this asset only.'), taxable_business_income: z.number().optional().describe('Taxable income from active trades or businesses before this deduction') },
    async ({ cost, total_qualifying_property_placed_in_service, taxable_business_income }) => reply({ taxYear: 2026, cost, ...section179(cost, total_qualifying_property_placed_in_service, taxable_business_income), note: NOTE }));

  server.tool('calculate_bonus_depreciation',
    'Bonus depreciation for an asset. 100% for qualified property acquired after January 19, 2025 (permanent under the One Big Beautiful Bill Act). Property acquired on or before that date follows the TCJA phase-down (40% placed in service in 2025, 20% in 2026). Returns the bonus amount and the remaining basis that continues under MACRS.',
    { cost: z.number().positive(), acquisition_date: z.string().optional().describe('YYYY-MM-DD the property was acquired (binding contract date)'), placed_in_service_year: z.number().int().min(2018).max(2035).default(2026), recovery_period: z.enum(['3', '5', '7', '10', '15', '20']).default('5').describe('For the remaining-basis MACRS schedule') },
    async ({ cost, acquisition_date, placed_in_service_year, recovery_period }) => {
      const b = bonusRate(acquisition_date, placed_in_service_year);
      const bonus = r2(cost * b.rate / 100);
      const remaining = r2(cost - bonus);
      const rest = remaining > 0 ? macrsSchedule(remaining, Number(recovery_period), 'half-year', 1, placed_in_service_year) : { rows: [] };
      return reply({ cost, bonusRatePercent: b.rate, rateBasis: b.basis, bonusDepreciation: bonus, remainingBasisDepreciatedUnderMacrs: remaining, remainingSchedule: rest.rows, notes: ['Bonus applies to new and used qualified property (MACRS recovery period of 20 years or less, computer software, qualified improvement property).', 'It is the default: you must elect out per property class if you do not want it.', 'No dollar cap and no taxable-income limit, so it can create a net operating loss.'], note: NOTE });
    });

  server.tool('compare_depreciation_methods',
    'Compares every available way to deduct a business asset side by side: straight-line over the recovery period, regular MACRS (half-year), Section 179, and 100% bonus. Shows year-one deduction and the year-by-year pattern so you can see timing differences.',
    { cost: z.number().positive(), recovery_period: z.enum(['3', '5', '7', '10', '15', '20']).default('5'), taxable_business_income: z.number().optional().describe('Limits Section 179'), acquisition_date: z.string().optional().describe('YYYY-MM-DD, for bonus eligibility') },
    async ({ cost, recovery_period, taxable_business_income, acquisition_date }) => {
      const life = Number(recovery_period);
      const macrs = macrsSchedule(cost, life, 'half-year', 1).rows.map((r) => r.depreciation);
      const slYear = r2(cost / life / 2);
      const sl = [slYear, ...Array(life - 1).fill(r2(cost / life)), slYear];
      const drift = r2(cost - sl.reduce((a, b) => a + b, 0)); sl[sl.length - 1] = r2(sl[sl.length - 1] + drift);
      const s179 = section179(cost, undefined, taxable_business_income);
      const bonus = bonusRate(acquisition_date, 2026);
      const bonusAmt = r2(cost * bonus.rate / 100);
      const options = [
        { method: 'Section 179', yearOne: s179.deduction, note: s179.carryforward ? `${s179.carryforward} carries forward (income limit)` : 'Subject to the income limit and phase-out' },
        { method: `Bonus (${bonus.rate}%)`, yearOne: bonusAmt, note: bonus.basis },
        { method: 'MACRS half-year', yearOne: macrs[0], yearByYear: macrs },
        { method: 'Straight-line (half-year)', yearOne: sl[0], yearByYear: sl },
      ];
      options.sort((a, b) => b.yearOne - a.yearOne);
      return reply({ cost, recoveryPeriod: life, ranked: options, fastestYearOne: options[0].method, notes: ['Total depreciation over the life is the same for every method. The difference is timing: faster methods cut tax now and leave less later.', 'If you expect higher income or higher tax rates in later years, spreading deductions (MACRS or straight-line) can be worth more than taking everything in year one.', 'Many states decouple from 179 limits and bonus, so state taxable income may differ.'], note: NOTE });
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
httpServer.listen(PORT, () => console.log(`ledgeriq-depreciation listening on :${PORT}`));
