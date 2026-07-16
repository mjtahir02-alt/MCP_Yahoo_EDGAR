# MCP Yahoo + EDGAR Specification

## Purpose

Provide a remotely deployed MCP server that combines public-market data with official SEC filing data for company research.

## Operating model

- GitHub is the source of truth for code, documentation, and change history.
- Vercel remains the production runtime and deployment platform.
- The production deployment continues to track the `main` branch.
- Changes must be developed on a separate branch and reviewed through a pull request before merge.

## Non-breaking constraints

- Preserve the existing production MCP endpoint and transport behavior.
- Preserve existing tool names, input schemas, and output contracts unless a versioned migration is explicitly approved.
- Do not commit API keys, access tokens, secrets, or private credentials.
- Keep secrets in Vercel environment variables.
- Do not change Vercel project linkage, domains, authentication, or environment variables as part of repository governance work.
- Existing production behavior must remain unchanged until a reviewed pull request is merged into `main`.

## Data-source principles

- Prefer SEC EDGAR for official US filing data.
- Clearly identify source and retrieval date in tool outputs where practical.
- Distinguish reported filing data from market-data estimates or third-party calculations.
- Handle unavailable or rate-limited upstream data with explicit errors rather than invented values.

## Engineering requirements

- Keep the MCP server deployable on Vercel.
- Provide a health or diagnostic path that does not expose secrets.
- Validate required environment variables at runtime with safe error messages.
- Document local setup, required environment-variable names, deployment path, and MCP endpoint.
- Add automated checks only where they do not alter production runtime behavior.

## Current workstream

Establish safe GitHub-based governance and audit the existing repository without changing production behavior. Any proposed code or configuration changes will be documented separately and submitted through a pull request.
