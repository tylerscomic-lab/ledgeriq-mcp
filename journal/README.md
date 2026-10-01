# LedgerIQ Journal Entry Assistant

Turn a transaction description into proper debit/credit journal entries. Also month-end adjusting entries, year-end closing entries and account classification (type, normal balance, statement placement).

## Double-entry bookkeeping, handled
For bookkeepers, accounting students and anyone who does not want to look up the normal balance of an account again.

## Tools
- `get_journal_entry`: transaction description to balanced debits and credits.
- `get_adjusting_entries`: month-end or year-end adjustments.
- `get_account_classification`: account type, normal balance, statement placement.
- `get_closing_entries`: year-end closing entries for temporary accounts.

## Use it

Hosted on [MCPize](https://mcpize.com/mcp/openapi-1779155638284) with a free tier (10 calls a day). Remote MCP endpoint (streamable HTTP, API key from MCPize):

```
https://openapi-1779155638284.mcpize.run/mcp
```

Or run it yourself:

```bash
npm install
node server.js   # listens on :8080, MCP at /mcp
```

MIT licensed.
