# LedgerIQ Depreciation Calculator

MACRS schedules, Section 179 expensing and bonus depreciation for business assets, with a side-by-side comparison of every available method so you can see which deduction timing fits.

## Pick the depreciation method with the numbers in front of you
## Tools
- `calculate_macrs`: the full MACRS schedule for an asset.
- `calculate_section_179`: first-year expensing deduction.
- `calculate_bonus_depreciation`: bonus depreciation using the current phase-down schedule.
- `compare_depreciation_methods`: all options side by side.

General information, not tax advice. Limits and phase-down percentages change by year, so confirm with a tax professional.

## Use it

Hosted on [MCPize](https://mcpize.com/mcp/openapi-1779148060328) with a free tier (10 calls a day). Remote MCP endpoint (streamable HTTP, API key from MCPize):

```
https://openapi-1779148060328.mcpize.run/mcp
```

Or run it yourself:

```bash
npm install
node server.js   # listens on :8080, MCP at /mcp
```

MIT licensed.
