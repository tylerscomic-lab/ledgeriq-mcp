import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── Financial ratio analysis ─────────────────────────────────────────────
// Standard textbook definitions. Every ratio reports its formula and which
// inputs it used, returns null (not NaN or Infinity) when a denominator is
// zero or an input is missing, and gets a plain-language reading. Benchmarks
// are rules of thumb, not industry-specific standards.

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const ratio = (num, den) => (num === undefined || den === undefined || den === 0 ? null : num / den);

const Fin = {
  // balance sheet
  cash: z.number().optional().describe('Cash and cash equivalents'),
  marketable_securities: z.number().optional().describe('Short-term investments'),
  accounts_receivable: z.number().optional(),
  inventory: z.number().optional(),
  current_assets: z.number().optional().describe('Total current assets'),
  total_assets: z.number().optional(),
  current_liabilities: z.number().optional().describe('Total current liabilities'),
  total_liabilities: z.number().optional(),
  total_debt: z.number().optional().describe('Interest-bearing debt. Defaults to total liabilities when omitted.'),
  shareholders_equity: z.number().optional(),
  // income statement
  revenue: z.number().optional(),
  cost_of_goods_sold: z.number().optional(),
  operating_income: z.number().optional().describe('EBIT / operating profit'),
  net_income: z.number().optional(),
  interest_expense: z.number().optional(),
};

function liquidity(f) {
  const quickAssets = f.current_assets !== undefined && f.inventory !== undefined ? f.current_assets - f.inventory : (f.cash ?? 0) + (f.marketable_securities ?? 0) + (f.accounts_receivable ?? 0);
  const cash = (f.cash ?? 0) + (f.marketable_securities ?? 0);
  const cur = ratio(f.current_assets, f.current_liabilities);
  const quick = ratio(quickAssets, f.current_liabilities);
  const cashR = f.cash === undefined ? null : ratio(cash, f.current_liabilities);
  return {
    currentRatio: { value: cur === null ? null : r2(cur), formula: 'current assets / current liabilities', reading: cur === null ? 'Needs current_assets and current_liabilities' : cur < 1 ? 'Below 1.0: short-term obligations exceed short-term assets' : cur < 1.5 ? 'Adequate but thin' : cur > 3 ? 'Strong, possibly more idle assets than needed' : 'Healthy' },
    quickRatio: { value: quick === null ? null : r2(quick), formula: '(current assets - inventory) / current liabilities', reading: quick === null ? 'Needs current assets (and inventory) or cash and receivables' : quick < 1 ? 'Below 1.0: cannot cover current liabilities without selling inventory' : 'Covers current liabilities without selling inventory' },
    cashRatio: { value: cashR === null ? null : r2(cashR), formula: '(cash + marketable securities) / current liabilities', reading: cashR === null ? 'Needs cash and current_liabilities' : cashR < 0.2 ? 'Low cash cushion' : 'Reasonable cash cushion' },
    workingCapital: f.current_assets !== undefined && f.current_liabilities !== undefined ? r2(f.current_assets - f.current_liabilities) : null,
  };
}
function profitability(f) {
  const gp = f.revenue !== undefined && f.cost_of_goods_sold !== undefined ? f.revenue - f.cost_of_goods_sold : undefined;
  const pct = (n, d) => { const v = ratio(n, d); return v === null ? null : r2(v * 100); };
  return {
    grossMarginPct: { value: pct(gp, f.revenue), formula: '(revenue - COGS) / revenue' },
    operatingMarginPct: { value: pct(f.operating_income, f.revenue), formula: 'operating income / revenue' },
    netMarginPct: { value: pct(f.net_income, f.revenue), formula: 'net income / revenue' },
    returnOnAssetsPct: { value: pct(f.net_income, f.total_assets), formula: 'net income / total assets', note: 'Uses ending assets; average assets give a more accurate figure if you have both years.' },
    returnOnEquityPct: { value: pct(f.net_income, f.shareholders_equity), formula: 'net income / shareholders equity', note: f.shareholders_equity !== undefined && f.shareholders_equity <= 0 ? 'Equity is zero or negative, so ROE is not meaningful.' : undefined },
  };
}
function leverage(f) {
  const debt = f.total_debt ?? f.total_liabilities;
  const ebitdaProxy = f.operating_income;
  const de = ratio(debt, f.shareholders_equity);
  const da = ratio(f.total_liabilities ?? debt, f.total_assets);
  const ic = ratio(ebitdaProxy, f.interest_expense);
  return {
    debtToEquity: { value: de === null ? null : r2(de), formula: (f.total_debt === undefined ? 'total liabilities' : 'total debt') + ' / shareholders equity', reading: de === null ? 'Needs debt and equity' : f.shareholders_equity <= 0 ? 'Negative or zero equity: liabilities exceed assets' : de > 2 ? 'Highly leveraged' : de > 1 ? 'Moderately leveraged' : 'Conservative' },
    debtToAssets: { value: da === null ? null : r2(da), formula: 'total liabilities / total assets', reading: da === null ? 'Needs liabilities and assets' : da > 0.7 ? 'Most assets are financed by creditors' : 'Majority financed by owners' },
    interestCoverage: { value: ic === null ? null : r2(ic), formula: 'operating income / interest expense', reading: ic === null ? 'Needs operating income and a non-zero interest expense' : ic < 1.5 ? 'Thin: earnings barely cover interest' : ic < 3 ? 'Adequate' : 'Comfortable' },
  };
}
const strip = (o) => JSON.parse(JSON.stringify(o));
const reply = (o) => ({ content: [{ type: 'text', text: JSON.stringify(strip(o), null, 2) }] });
const NOTE = 'Textbook formulas; interpretation thresholds are general rules of thumb and vary by industry. Ratios that cannot be computed from the inputs are returned as null with the reason.';

function buildServer() {
  const server = new McpServer({ name: 'ledgeriq-ratios', version: '2.0.0' });

  server.tool('calculate_liquidity_ratios',
    'Current ratio, quick ratio, cash ratio and working capital from balance sheet figures, each with its formula and a plain-language reading.',
    { cash: Fin.cash, marketable_securities: Fin.marketable_securities, accounts_receivable: Fin.accounts_receivable, inventory: Fin.inventory, current_assets: Fin.current_assets, current_liabilities: Fin.current_liabilities },
    async (f) => reply({ ...liquidity(f), note: NOTE }));

  server.tool('calculate_profitability_ratios',
    'Gross margin, operating margin, net margin, return on assets and return on equity from income statement and balance sheet figures.',
    { revenue: Fin.revenue, cost_of_goods_sold: Fin.cost_of_goods_sold, operating_income: Fin.operating_income, net_income: Fin.net_income, total_assets: Fin.total_assets, shareholders_equity: Fin.shareholders_equity },
    async (f) => reply({ ...profitability(f), note: NOTE }));

  server.tool('calculate_leverage_ratios',
    'Debt-to-equity, debt-to-assets and interest coverage. Handles zero or negative equity and zero interest expense without returning nonsense.',
    { total_debt: Fin.total_debt, total_liabilities: Fin.total_liabilities, total_assets: Fin.total_assets, shareholders_equity: Fin.shareholders_equity, operating_income: Fin.operating_income, interest_expense: Fin.interest_expense },
    async (f) => reply({ ...leverage(f), note: NOTE }));

  server.tool('analyze_full_financials',
    'Every ratio at once from a full set of figures, plus a short list of the strongest and weakest signals so you know where to look first. Accepts any subset of inputs; ratios that cannot be computed are null.',
    Fin,
    async (f) => {
      const L = liquidity(f), P = profitability(f), V = leverage(f);
      const flags = [];
      if (L.currentRatio.value !== null && L.currentRatio.value < 1) flags.push({ level: 'concern', item: 'Current ratio below 1.0', detail: L.currentRatio.reading });
      if (L.quickRatio.value !== null && L.quickRatio.value < 1) flags.push({ level: 'watch', item: 'Quick ratio below 1.0', detail: L.quickRatio.reading });
      if (P.netMarginPct.value !== null && P.netMarginPct.value < 0) flags.push({ level: 'concern', item: 'Net loss', detail: `Net margin ${P.netMarginPct.value}%` });
      if (V.interestCoverage.value !== null && V.interestCoverage.value < 1.5) flags.push({ level: 'concern', item: 'Thin interest coverage', detail: V.interestCoverage.reading });
      if (V.debtToEquity.value !== null && V.debtToEquity.value > 2) flags.push({ level: 'watch', item: 'High leverage', detail: V.debtToEquity.reading });
      if (f.shareholders_equity !== undefined && f.shareholders_equity < 0) flags.push({ level: 'concern', item: 'Negative equity', detail: 'Liabilities exceed assets.' });
      if (P.grossMarginPct.value !== null && P.grossMarginPct.value > 50) flags.push({ level: 'strength', item: 'High gross margin', detail: `${P.grossMarginPct.value}%` });
      if (L.currentRatio.value !== null && L.currentRatio.value >= 1.5 && L.quickRatio.value !== null && L.quickRatio.value >= 1) flags.push({ level: 'strength', item: 'Solid liquidity', detail: 'Current and quick ratios above common thresholds.' });
      const computed = [L.currentRatio, L.quickRatio, L.cashRatio, P.grossMarginPct, P.operatingMarginPct, P.netMarginPct, P.returnOnAssetsPct, P.returnOnEquityPct, V.debtToEquity, V.debtToAssets, V.interestCoverage].filter((x) => x.value !== null).length;
      return reply({ liquidity: L, profitability: P, leverage: V, signals: flags, ratiosComputed: `${computed} of 11`, note: NOTE });
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
httpServer.listen(PORT, () => console.log(`ledgeriq-ratios listening on :${PORT}`));
