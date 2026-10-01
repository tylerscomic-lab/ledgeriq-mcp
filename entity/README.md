# LedgerIQ Entity Structure Analyzer

LLC vs S-Corp vs C-Corp for a given income and state: side-by-side comparison, estimated self-employment tax savings from an S-Corp election, annual compliance costs and conversion steps.

## Should this business be an S-Corp?
## Tools
- `compare_entity_structures`: all entity types side by side for an income and state.
- `calculate_scorp_savings`: estimated annual self-employment tax savings.
- `get_entity_compliance_costs`: annual costs and requirements by entity and state.
- `get_conversion_steps`: steps and timeline to convert between entity types.

Estimates for planning, not tax advice.

## Use it

Hosted on [MCPize](https://mcpize.com/mcp/openapi-1779147989491) with a free tier (10 calls a day). Remote MCP endpoint (streamable HTTP, API key from MCPize):

```
https://openapi-1779147989491.mcpize.run/mcp
```

Or run it yourself:

```bash
npm install
node server.js   # listens on :8080, MCP at /mcp
```

MIT licensed.
