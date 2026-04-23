# Stacklab Ops Toolkit — Developer Environment

This document is the first thing any Claude Code session should read 
before building anything in this repo. It covers the full stack, 
deployment process, and standard build pattern.

> **End every Claude Code session with DEVSUM** to generate a structured 
> handoff report. Bring that report back to the MRP project chat to 
> update the context docs. DEVSUM prompt is defined in CLAUDE.md.
---

## Repo
- **GitHub:** https://github.com/StacklabOperations/ops-toolkit
- **Hosted at:** GitHub Pages (check repo Settings → Pages for live URL)
- **Structure:**
  - `index.html` — main landing page / tool directory
  - `tools/` — one HTML file per tool + one spec MD per tool
  - `assets/` — shared images/icons
  - `worker/worker.js` — Cloudflare Worker source (version controlled here)
  - `STACKABL_APPS_STYLE_GUIDE.md` — UI design system, read before any UI work
  - `DEV_ENVIRONMENT.md` — this file

---

## API Layer — Cloudflare Worker

All Aligni API calls go through this Worker. Never call Aligni directly 
from the frontend. Never put the API token in any frontend file.

- **Worker URL:** https://stackabl-aligni-proxy.operations-dae.workers.dev
- **Cloudflare dashboard:** dash.cloudflare.com → Workers & Pages → stackabl-aligni-proxy
- **Secret stored in Cloudflare:** ALIGNI_TOKEN (encrypted, never in code)

The Worker is a dumb GraphQL proxy — it accepts any POST, injects the 
token, forwards to Aligni, returns the response. No routing logic.

To call it from a tool:
  fetch('https://stackabl-aligni-proxy.operations-dae.workers.dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `...`, variables: {} })
  })

Worker source code lives at worker/worker.js in this repo.

---

## Aligni — PLM System

- **Site:** https://stacklab.aligni.com
- **GraphQL endpoint:** https://stacklab.aligni.com/api/v3/graphql
- **GraphiQL explorer:** https://stacklab.aligni.com/api/v3/graphiql
- **API version:** v3 (GraphQL — current and supported)
- **Auth:** Token injected by Worker — not needed in frontend

### Critical data model facts
- Parts have a numeric Partnumber (e.g. 100463) and a human-readable 
  Manufacturer P/N / MPN (e.g. SA-CUT-DISC5-FT-529CHAM3)
- Always look up parts by MPN (manufacturerPn field) not Partnumber
- Part 100464 is a generic pivot part — always exclude from queries
- Felt parts: part type "Felt", UOM sqft, native unit (already converted 
  from Bolt Yards by Aligni, 1 Bolt Yard = 17.49 sqft)
- Cut disc parts: part type "Sheet-Cut Profile", UOM each
- Operations: part type "Operations General", UOM each
- BOMs are called "Part Lists" in Aligni
- Part must be in DRAFT revision state to edit its BOM
- Revision names are integers as strings: "1", "2", "3"
- Rate limit: 10 requests/minute — always add 200ms delay between calls
- Always introspect live schema before writing mutations — never guess 
  field names

### Custom parameters on Felt parts
- Thickness (mm): "3" or "4.8" (4.8mm marketed as 5mm)
- Colour/Sheen: display name (e.g. "Charcoal", "Ivory")

### Disc geometry (for inventory calculations)
- 5in disc: 0.252 sqft per disc
- 8in disc: 0.570 sqft per disc
- Linear inches formula: (sqft / disc_sqft) × thickness_mm / 25.4

### Inventory quantity tiers
- On Hand, Reserved, Allocated, Available
- Always use Available for calculations (not On Hand)

---

## How to Build a New Tool

1. Read this file
2. Read STACKABL_APPS_STYLE_GUIDE.md — follow it exactly for all UI
3. Read an existing tool in tools/ for structure reference
4. Build the tool as a single self-contained HTML file in tools/
5. All CSS and JS lives inside the HTML file — no external files
6. Add a link to the new tool in index.html (follow existing pattern)
7. Save a spec file alongside it: tools/[tool-name]-spec.md
8. The spec should document: what it does, how it works, what GraphQL 
   operations it uses, any gotchas or Aligni quirks discovered

---

## How to Deploy

Changes pushed to the main branch on GitHub automatically deploy via 
GitHub Pages. No build step required — it's static HTML.

To push changes:
  git add .
  git commit -m "describe what you built"
  git push origin main

Or use the GitHub web interface: navigate to the file, click Edit (pencil), 
make changes, click Commit changes.

---

## Tools Built So Far

| Tool | File | What it does |
|------|------|-------------|
| Felt Inventory Dashboard | tools/felt-dashboard.html | Live felt inventory with linear inch calculations |
| BOM Importer | tools/bom-importer.html | Bulk import BOM CSVs to Aligni via drag and drop |

---

## Future Integrations Planned

- HubSpot → Aligni: Closed Won deal triggers build creation in Aligni
- Inventory webhooks: Aligni stock change → HubSpot task for sales team
- COGS analysis: purchase history × build consumption records
- Demand estimator / revenue modelling dashboard
