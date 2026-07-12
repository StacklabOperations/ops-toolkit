# BOM Bulk Importer — RETIRED

**Retired:** 2026-07-11. `tools/bom-importer.html` has been deleted.

This browser tool was superseded by the **Aligni write executor** — a
server-side job runner that imports BOMs (and creates parts) unattended,
without a browser tab that has to stay open.

- Full spec: [aligni-write-executor-spec.md](aligni-write-executor-spec.md)
- Jobs are submitted from chat/Cowork via the Stacklab Operations MCP tools
  (`submit_write_job` → review dry-run plan → `execute_write_job`)
- Job status and history: [write-jobs.html](write-jobs.html) (read-only dashboard)

All Aligni knowledge documented here (subpart mutations, revision workflow,
rate limits, OperatorScalar quirks) was folded into DEV_ENVIRONMENT.md and
the write-executor spec. The old tool's `IMPORT_DELAY` constant is gone;
the single rate-delay constant now lives in
`workers/stackabl-write-executor/index.js` as `RATE_DELAY_MS`.
