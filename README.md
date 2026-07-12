# Stacklab Operations Toolkit

Internal operations tools for Stacklab's production, inventory, and
integration workflows. Browser tools are static pages on GitHub Pages;
Aligni access runs through Cloudflare Workers that keep the API token
server-side.

**Live site:** [your GitHub Pages URL]

> **Canonical reference:** [`DEV_ENVIRONMENT.md`](DEV_ENVIRONMENT.md) is the
> single source of truth for the full stack, the current tool inventory, the
> Aligni data model and API quirks, and the build/deploy workflow. This README
> is just an orientation map — when in doubt, DEV_ENVIRONMENT.md wins.

---

## What's here

Three peer interfaces sit on top of a shared capability layer (see the
architecture note in [`CLAUDE.md`](CLAUDE.md)):

- **Browser tools** (`tools/*.html`) — human-facing static pages.
- **MCP server** (`workers/stackabl-mcp/`) — agent-facing Aligni tools for
  Claude.ai (read tools + write-job tools).
- **Write executor** (`workers/stackabl-write-executor/`) — durable
  server-side Aligni write jobs (create parts, BOMs, releases).

For the live list of every tool and what it does, see the **Tools** tables in
[`DEV_ENVIRONMENT.md`](DEV_ENVIRONMENT.md). Per-tool specs live alongside each
tool as `tools/[name]-spec.md`.

---

## Project structure

```
ops-toolkit/
├── index.html                        # Landing page / tool directory
├── CLAUDE.md                         # Claude Code instructions (auto-loaded)
├── DEV_ENVIRONMENT.md                # Canonical dev/stack reference
├── STACKABL_APPS_STYLE_GUIDE.md      # UI design system
├── IDEAS_BACKLOG.md                  # Backlog, refactors, discovered follow-ups
├── README.md                         # This orientation map
├── worker/
│   └── worker.js                     # stackabl-aligni-proxy (dumb GraphQL proxy)
├── workers/
│   ├── stackabl-mcp/                 # MCP server Worker (read + write-job tools)
│   └── stackabl-write-executor/      # Durable write-job executor Worker
├── tools/
│   ├── felt-inventory.html           # + felt inventory dashboard
│   ├── lead-time-calculator.html
│   ├── safety-stock-calculator.html
│   ├── write-jobs.html               # read-only write-job status/history
│   ├── aligni-write-executor-spec.md
│   ├── aligni-introspect-spec.md
│   ├── mcp-server-spec.md
│   └── bom-importer-spec.md          # tombstone → superseded by write executor
└── assets/
```

---

## Architecture

Browser tools are static HTML on GitHub Pages. Reads for the browser tools go
through the dumb proxy Worker; multi-step Aligni writes go through the
write-executor smart endpoint. The Aligni API token never touches any
frontend — it lives as an encrypted secret in the Workers.

```
Browser tool ─┐
              ├─→ stackabl-aligni-proxy ──→ Aligni GraphQL API
Claude.ai ────┤        (dumb proxy)
  (MCP)       └─→ stackabl-mcp ──(service binding)──→ stackabl-write-executor ──→ Aligni
                  (read tools + write-job tools)         (durable write jobs)
```

Details, URLs, and the endpoint-first design rules are in
[`DEV_ENVIRONMENT.md`](DEV_ENVIRONMENT.md) and [`CLAUDE.md`](CLAUDE.md).

---

## Adding a new tool

1. Read [`DEV_ENVIRONMENT.md`](DEV_ENVIRONMENT.md) for full context.
2. Read [`STACKABL_APPS_STYLE_GUIDE.md`](STACKABL_APPS_STYLE_GUIDE.md) before writing any UI.
3. Follow the endpoint-first pattern (logic in a Worker capability, thin UI).
4. Add a link card to `index.html` and a spec at `tools/[name]-spec.md`.

---

## Deploying

- **Browser tools:** push to `main` → GitHub Pages deploys automatically. No build step.
- **Workers:** `cd workers/<name> && wrangler deploy` (see DEV_ENVIRONMENT.md).

---

## Development workflow

Developed with Claude Code using persistent context in `CLAUDE.md` and
`DEV_ENVIRONMENT.md`. End each session with **DEVSUM** (defined in `CLAUDE.md`)
for a structured handoff. See `DEV_ENVIRONMENT.md` for the full workflow.
