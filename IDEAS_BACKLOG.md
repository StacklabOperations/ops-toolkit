# Ops Toolkit — Ideas Backlog

## Active
- stackabl-mcp deployed; observing Phase 1 usage patterns before designing Phase 2 writes

## Next up
- stackabl-mcp Phase 2: write tools — design from observed Phase 1 atomic-call patterns,
  not speculatively. What gets repeatedly orchestrated in Phase 1 becomes a Phase 2 tool.

## Ideas
- **Extract stackabl-auth Worker:** when a second MCP consumer (or any second Worker
  needing OAuth) appears, extract the OAuth endpoints into a shared `stackabl-auth` Worker.
  Not now — one Worker to retrofit is cheap; wait for the second consumer to know the shape.
- **Centralized rate limiter (Durable Object):** `stackabl-mcp` and `stackabl-aligni-proxy`
  share the Aligni token and compete for the same 10 req/min budget. If concurrent-use
  collisions become a real problem (felt-dashboard refresh racing an MCP search), fix with
  a Durable Object rate limiter shared by both Workers. Build only when the problem is
  observed — not speculatively.
- Vendor/supplier write capabilities as MCP tools — let emerge from observed Phase 1 usage

## Refactors
- ~~Endpoint-ify the BOM importer's core operation (currently UI-coupled)~~
  **Closed 2026-07-11 — superseded, not refactored.** The browser tool was
  retired and replaced by the `stackabl-write-executor` Worker (durable
  server-side job executor) + MCP write tools + read-only `write-jobs.html`
  dashboard. See tools/aligni-write-executor-spec.md.
- Endpoint-ify the lead time calculator
- Endpoint-ify the safety stock calculator
- Pattern rule: every new tool is built endpoint-first; existing
  tools get refactored when next touched

## Won't do (yet)
- Bulk supplier import — single-entry covers the realistic volume for 
  Stacklab; revisit only if a real bulk need surfaces
