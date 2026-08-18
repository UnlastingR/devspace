---
name: massive-market-data
description: Build, inspect, or debug market-data workflows that use Massive.com REST, WebSocket, Python SDK, or MCP. Use this skill whenever a task mentions Massive, Polygon/Massive market data, U.S. stocks/options/forex/futures/crypto data from Massive, real-time scanners, historical market dashboards, or code that calls Massive APIs.
---

# Massive Market Data

Treat Massive's current machine-readable documentation as the source of truth.
Do not invent endpoint paths, parameter names, response fields, SDK methods, or
WebSocket message shapes from model memory.

## Mandatory documentation-first rule

Before writing or changing code that uses Massive, read the relevant current
`llms.txt` documentation:

- REST API: `https://massive.com/docs/rest/llms.txt`
- Real-time WebSocket API: `https://massive.com/docs/websocket/llms.txt`

Use the REST document for HTTP endpoints, historical data, snapshots, reference
data, fundamentals, corporate actions, indicators, and ordinary request/response
workflows. Use the WebSocket document for live trades, quotes, aggregates,
subscriptions, streaming scanners, and other real-time feeds.

If the documentation cannot be reached, say so explicitly and avoid guessing a
Massive endpoint or schema. Prefer inspecting existing project code or the
installed SDK as a narrower fallback until the documentation is available.

## Choose the right Massive interface

- For normal application code and repeatable data pipelines, prefer Massive's
  official SDK or direct REST/WebSocket API as appropriate.
- When the task explicitly asks for Python, use the current Massive Python SDK
  patterns documented by Massive rather than recalling an older Polygon SDK
  interface from memory.
- For agent-driven ad hoc exploration, Massive MCP is appropriate. Discover the
  needed endpoint first, then call it; do not assume one tool exists per API
  endpoint.
- Do not route tick-by-tick streaming data through an LLM when deterministic
  code can filter or aggregate it first. Let code handle the high-rate stream,
  then send compact events or summaries to the model.

## REST workflow

1. Read `https://massive.com/docs/rest/llms.txt`.
2. Identify the exact endpoint needed for the requested market and data type.
3. Confirm required path/query parameters and response fields from current docs.
4. Implement the smallest request that proves the data path.
5. Handle pagination, rate limits, time zones, market sessions, and adjusted vs.
   unadjusted data when they matter to the task.
6. Validate returned fields before building calculations or UI on top of them.

Never infer that a bare numeric symbol identifies the intended instrument. Keep
market, asset class, and ticker/index identity explicit when ambiguity is
possible.

## WebSocket workflow

1. Read `https://massive.com/docs/websocket/llms.txt`.
2. Confirm the current WebSocket URL, authentication flow, subscription syntax,
   channel names, and event schema.
3. Keep connection management, reconnect/backoff, heartbeat handling, parsing,
   and deduplication in deterministic application code.
4. Bound queues and memory. High-rate market feeds must not grow unbounded when
   a downstream consumer is slow.
5. Aggregate/filter locally before invoking an AI model for interpretation.
6. Test reconnect and resubscribe behavior, not only the happy-path connection.

## Analysis correctness

- Label delayed, end-of-day, and real-time data accurately according to the
  user's Massive entitlement and the endpoint actually used.
- Do not present stale snapshots as live quotes.
- Normalize timestamps and state the exchange/session timezone when relevant.
- For return calculations, distinguish price return from total return and note
  whether splits/dividends are adjusted.
- For multi-symbol comparisons, align trading dates before computing returns,
  correlations, regressions, or cumulative performance.
- Preserve raw source fields where practical so downstream calculations can be
  audited.

## Verification

For code changes, verify the real path the user will run:

- run the focused test or a minimal authenticated request when credentials are
  available through the project's normal secret mechanism;
- never print or commit API keys;
- inspect at least one real response/schema before claiming a field exists;
- for WebSocket work, verify at least connect/auth/subscribe/message parsing and,
  when feasible, reconnect behavior;
- distinguish failures caused by account entitlements or market-data plans from
  code defects.

When reporting completion, mention which Massive documentation source was used
(REST or WebSocket), what path was verified, and any entitlement-dependent edge
that remains unverified.
