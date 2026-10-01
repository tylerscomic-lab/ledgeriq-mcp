# LedgerIQ 1099 & W-2 Compliance Checker

Is a 1099 required, which form, when is it due, and what does a late filing cost? Deterministic IRS 1099/W-2 rules for bookkeepers, accountants and small business owners: form selection, deadlines, backup withholding and late-filing penalties.

## 1099 and W-2 questions, answered by rule
Built for bookkeepers, accountants and anyone paying contractors.

## Tools
- `check_1099_required`: is a 1099 required for this payment, and which form?
- `get_1099_deadlines`: filing and recipient-copy deadlines for a form type.
- `check_backup_withholding`: does backup withholding apply, and how much?
- `calculate_late_filing_penalties`: penalty exposure for late or incorrect filings.

General information based on published IRS rules, not tax advice. Confirm current-year thresholds with the IRS or a tax professional.

## Use it

Hosted on [MCPize](https://mcpize.com/mcp/openapi-1779157377315) with a free tier (10 calls a day). Remote MCP endpoint (streamable HTTP, API key from MCPize):

```
https://openapi-1779157377315.mcpize.run/mcp
```

Or run it yourself:

```bash
npm install
node server.js   # listens on :8080, MCP at /mcp
```

MIT licensed.
