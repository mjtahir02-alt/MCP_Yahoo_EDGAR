# Market & Filings MCP

MCP connector for Yahoo Finance market data and SEC EDGAR company filings.

The repository includes a compressed source bundle that is unpacked automatically during `npm install`. The deployed MCP endpoint is `/mcp`.

## Required environment variable

```text
SEC_USER_AGENT=YourCompany MarketFilingsMCP/0.1 your-email@example.com
```

## Vercel

Import this repository into Vercel, add the environment variable above, and deploy.
