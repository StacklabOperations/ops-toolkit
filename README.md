# Stacklab Operations Toolkit

Internal operations tools for Stacklab's production, inventory, and 
integration workflows. Built on GitHub Pages, powered by the Stackabl 
Aligni API proxy.

**Live site:** [your GitHub Pages URL]

---

## Tools

| Tool | File | What it does |
|------|------|-------------|
| Felt Inventory Dashboard | `tools/felt-dashboard.html` | Live felt inventory with available sqft and linear inch calculations by colour |
| BOM Importer | `tools/bom-importer.html` | Bulk import BOM CSVs to Aligni via drag and drop |

---

## Project Structure

```
ops-toolkit/
├── index.html                        # Landing page / tool directory
├── CLAUDE.md                         # Claude Code instructions (auto-loaded)
├── DEV_ENVIRONMENT.md                # Full dev environment reference
├── STACKABL_APPS_STYLE_GUIDE.md      # UI design system
├── README.md                         # This file
├── worker/
│   └── worker.js                     # Cloudflare Worker source (deployed separately)
├── tools/
│   ├── felt-dashboard.html
│   ├── felt-dashboard-spec.md
│   ├── bom-importer.html
│   └── bom-importer-spec.md
└── assets/
```

---

## Architecture

All tools are static HTML files hosted on GitHub Pages. API calls go 
through a Cloudflare Worker that injects the Aligni API token server-side.

```
Browser (GitHub Pages tool)
        ↓
Cloudflare Worker (stackabl-aligni-proxy.operations-dae.workers.dev)
        ↓
Aligni GraphQL API (stacklab.aligni.com/api/v3/graphql)
```

The API token never touches the frontend. It lives as an encrypted 
secret in the Cloudflare Worker environment.

---

## Adding a New Tool

1. Read `DEV_ENVIRONMENT.md` for full context
2. Read `STACKABL_APPS_STYLE_GUIDE.md` before writing any UI
3. Create `tools/[tool-name].html` — single self-contained HTML file
4. Add a link card to `index.html`
5. Save a spec at `tools/[tool-name]-spec.md`

All API calls POST to:
`https://stackabl-aligni-proxy.operations-dae.workers.dev`

---

## Deploying

Push to `main` branch → GitHub Pages deploys automatically. No build 
step required.

---

## Development Workflow

This toolkit is developed using Claude Code with persistent context 
managed through `CLAUDE.md` and `DEV_ENVIRONMENT.md`.

See `DEV_ENVIRONMENT.md` for the full development workflow including 
the DEVSUM handoff process.
