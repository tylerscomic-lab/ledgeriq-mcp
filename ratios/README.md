# LedgerIQ Financial Ratio Analyzer

Calculate liquidity, profitability and leverage ratios from raw financial figures: current and quick ratio, gross/operating/net margin, ROA, ROE, debt-to-equity and interest coverage. One call for the full set.

## Financial ratios without the spreadsheet
Pass in the figures, get the ratios.

## Tools
- `analyze_full_financials`: every ratio from a complete set of figures.
- `calculate_liquidity_ratios`: current, quick and cash ratio.
- `calculate_profitability_ratios`: gross, operating and net margin, ROA, ROE.
- `calculate_leverage_ratios`: debt-to-equity, debt-to-assets, interest coverage.

## Use it

Hosted on [MCPize](https://mcpize.com/mcp/openapi-1779155762580) with a free tier (10 calls a day). Remote MCP endpoint (streamable HTTP, API key from MCPize):

```
https://openapi-1779155762580.mcpize.run/mcp
```

Or run it yourself:

```bash
npm install
node server.js   # listens on :8080, MCP at /mcp
```

MIT licensed.
