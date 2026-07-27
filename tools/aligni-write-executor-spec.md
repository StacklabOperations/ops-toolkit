# Aligni Write Executor — Spec

**Worker:** `workers/stackabl-write-executor/`
**URL:** `https://stackabl-write-executor.operations-dae.workers.dev`
**Built:** 2026-07-11 (Phase 2 — first write capability)
**Durable primitive:** Cloudflare Workflows (binding `JOB_WORKFLOW`, workflow `stackabl-write-job`)
**Storage:** Cloudflare KV namespace `WRITE_JOBS` (`job:<id>` records + `jobs:index`)

---

## What it is

A server-side job executor for Aligni writes. A chat/Cowork session builds a
**job** (a list of write operations), submits it, gets back a **dry-run plan**
(all lookups, zero writes), and — only on an explicit second call — the job
executes **unattended** on Cloudflare's infrastructure, respecting the Aligni
rate limit. Closing the browser or chat session does not stop execution.

It replaces two workflows:
- `tools/bom-importer.html` (retired) — browser-tab BOM imports that died if the tab closed
- Aligni's UI bulk part import — 100-row cap, manual part-number retrieval

**Submission path:** ONLY via the Stacklab Operations MCP tools
(`submit_write_job`, `execute_write_job`, `get_write_job_status`).
The dashboard `tools/write-jobs.html` is read-only status/history.

**Migration guardrail:** the executor is convention-blind. It contains no MPN
patterns and no naming intelligence — it executes exactly the job it is given.
All naming decisions live upstream in the chat session that builds the job.

---

## ⚠ No automatic revert (v1 limitation)

The retired browser importer had an abort-and-revert button. That does not
translate to unattended execution: **there is no automatic rollback**. Instead,
every operation's result includes a `writes` array logging each mutation made
(with the Aligni IDs it returned), so a human or a follow-up job can see exactly
what was written and undo it precisely. Review the dry-run plan carefully —
it is the gate.

---

## Rate limiting

`RATE_DELAY_MS = 6100` in `workers/stackabl-write-executor/index.js` — the
ONLY place this constant exists (the old `IMPORT_DELAY` died with
bom-importer.html). Drop it to `2100` when the Aligni 30/min support ticket
resolves. On a rate-limit response the executor waits 62s and retries up to
3 times (matching the old importer's behaviour). One job executes at a time —
a second execute request is refused with `JOB_ALREADY_RUNNING` while one is
queued/running, because every Worker shares the same Aligni rate budget.

---

## The job contract

```json
{
  "jobName": "GP-A-OPEN family BOMs",
  "operations": [ <op>, <op>, ... ]   // max 400 per job, executed in order
}
```

Parts are referenced by `manufacturerPn` everywhere — never by Partnumber.
Later operations may reference parts created by an earlier `createPart` in the
same job; the executor resolves references against both live Aligni and
earlier-in-job creations.

### `createPart`
```json
{
  "op": "createPart",
  "manufacturerPn": "SA-NEW-PART-MPN",        // required
  "partType": "Sheet-Cut Profile",             // required — exact Aligni name
  "unit": "each",                              // required — exact Aligni name; UOM is
                                               // PERMANENT, unknown unit hard-fails the job
  "manufacturer": "Stacklab",                  // required — exact Aligni name
  "description": "revision description",       // optional (lives on the revision)
  "comment": "revision comment",               // optional (lives on the revision)
  "revisionName": "1",                         // optional, default "1"
  "customParameters": [                         // optional — set at creation
    { "name": "Thickness (mm)", "value": "3" },
    { "name": "Colour/Sheen", "value": "Charcoal" }
  ],
  "manufacturedHere": true                     // optional
}
```
- If the MPN already exists, the op is **skipped** and the existing part reused
  (idempotent — re-running a job never double-creates).
- Aligni assigns the part number; it is returned in the op result.
- A subscription part-limit error is detected explicitly
  (`SUBSCRIPTION_LIMIT`) and blocks all later `createPart` ops in the job.

### `ensureDraft`
```json
{
  "op": "ensureDraft",
  "manufacturerPn": "SA-EXISTING-PART",
  "revisionReason": "why",          // optional
  "copyExistingBom": false          // optional — copySubparts on the new revision
}
```
- Reuses an existing draft revision if one exists; otherwise creates the next
  numbered draft from the active revision (scans ALL revisions for the true
  max, preserves zero-padding: "01" → "02").

### `addSubparts`
```json
{
  "op": "addSubparts",
  "manufacturerPn": "SA-ASSEMBLY",
  "replaceExisting": false,          // true = delete existing BOM lines first
  "lines": [
    { "manufacturerPn": "O-CUT-DISC5", "quantity": 1,
      "buildSequence": 10, "designator": null, "comment": null }
  ]
}
```
- Targets the part's draft revision. If no draft exists, one is created
  automatically (so `createPart` → `addSubparts` chains work without an
  explicit `ensureDraft`).
- Component lines resolve to the component's **active revision id**
  (`subpartPartRevisionId`) — cached per job, so shared parts like O-CUT-DISC5
  are looked up once.
- Idempotent: lines already on the draft with the same quantity are skipped,
  not duplicated.
- Line failures are recorded per line; any line failure marks the op failed
  (which blocks a later `releaseRevision` on the same part).

### `releaseRevision`
```json
{ "op": "releaseRevision", "manufacturerPn": "SA-ASSEMBLY" }
```
- `partRevisionRelease` with `revisionActive: true` — releases and activates in
  one call (`partRevisionActivate` does not exist).
- Skipped (not failed) if the revision is already released or no draft exists.

### `updatePart`
```json
{
  "op": "updatePart",
  "manufacturerPn": "JP-LEG-14L-BR01",          // required — identifies the part
  "description": "Jupiter Leg, 14.25in Height", // optional (revision-level)
  "comment": "Bronze - Mirror",                  // optional (revision-level)
  "customParameters": [                          // optional (part-level; name = display OR apiName)
    { "name": "Finish Type", "value": "Bronze - Satin" }
  ],
  "newManufacturerPn": "JP-LEG-14L-BR02"         // optional — RENAME the part
}
```
**Partial update — the defining rule.** ONLY the fields present in the op are
written. Absent fields are never touched and never blanked. This op exists
specifically to escape the legacy bulk-update CSV tool, which blanked Comment on
every row it touched. Provide at least one of `description` / `comment` /
`customParameters` / `newManufacturerPn` (an op with none is rejected in
validation).

- **`description` / `comment`** (revision-level) are edited **in place on the
  active revision** via `partRevisionUpdate`. Verified live 2026-07-20: this
  succeeds on a **Released** revision and does **NOT** create a new revision — no
  revision bump. (No `ensureDraft`/`releaseRevision` composition is performed.)
- **`customParameters`** (part-level) are written via `partUpdate` (`PartInput`).
  Same apiName rules as `createPart`: the job may pass the display name
  ("Finish Type") or the apiName ("FIN1"); the executor resolves to apiName, and
  an unknown parameter fails the dry run. Per-part-type validity still applies —
  a globally-defined parameter can be rejected for a given part type, which
  surfaces as a clean failed op at execution.
- **`newManufacturerPn`** renames the part via `partUpdate.manufacturerPn`
  (confirmed supported by the schema and live). The dry-run plan renders it
  unmistakably: `RENAME: OLD → NEW`. A rename should generally be the last op on
  a part in a job — later ops that still reference the old MPN will not resolve.
- **Idempotency:** the op verify-reads current values first. If every requested
  value already matches (and no rename is pending), the op is **skipped**, not
  rewritten. Custom-parameter writes send only the values that actually change.
- Part-level writes (custom parameters + rename) go in ONE `partUpdate` call;
  revision text (description + comment) in ONE `partRevisionUpdate` call — so an
  `updatePart` op makes at most two mutations plus the verify-read.
- Failure semantics match the other ops: a failed `updatePart` records its error,
  the per-op `writes` log shows what was written before the failure, dependents
  on the same part are blocked, and only rate-limit errors retry.

---

## Endpoints

Base: `https://stackabl-write-executor.operations-dae.workers.dev`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/jobs` | `X-Executor-Key` | Validate + dry run (no writes), store job, return jobId + plan |
| POST | `/jobs/:id/execute` | `X-Executor-Key` | Begin durable execution (only valid on a validated, unexecuted job) |
| GET | `/jobs/:id` | none (CORS open) | Status, progress (op X of Y), per-op results incl. assigned part numbers |
| GET | `/jobs` | none (CORS open) | Recent jobs list (20 most recent) |

POST endpoints require the `EXECUTOR_API_KEY` shared secret (held only by the
`stackabl-mcp` Worker) — this is what makes chat/Cowork the only submission
path. GET endpoints are public read-only for the dashboard.

### POST /jobs — response
```json
{
  "jobId": "wj_mrgnj77f_802a3b",
  "valid": true,
  "status": "validated",
  "planText": "Dry-run plan for \"...\" — N operations, estimated ~M min...\n1. ...\n2. ...",
  "plan": [ { "index": 0, "op": "createPart", "target": "...", "action": "...", "error": null } ],
  "estimatedMinutes": 4
}
```
`planText` is plain English, one numbered line per operation, stating what will
be created vs reused, what exists and will be skipped, and anything that failed
lookup. Any lookup failure ⇒ `valid: false` ⇒ the job can never be executed
(fix and submit a new job — jobs are immutable once submitted).

### Job statuses
`validated` (dry-run passed, not yet executed) · `invalid` (dry-run found
problems; permanently unexecutable) · `queued` · `running` · `complete` ·
`failed` (infrastructure-level failure; per-op results up to the failure are
preserved).

Note: a job whose ops individually failed still ends `complete` — per-op
results and `opCounts` tell the real story. Ops that depend on a failed op
(same target part) are marked `blocked` and skipped.

### Error semantics
All errors are structured objects: `{ "error": { "code", "message", "details"? } }`.
Codes: `INVALID_JOB`, `BAD_JSON`, `DRY_RUN_ERROR`, `NOT_FOUND`,
`ALREADY_EXECUTED`, `JOB_ALREADY_RUNNING`, `FORBIDDEN`, `RATE_LIMITED`,
`ALIGNI_ERROR`, `SUBSCRIPTION_LIMIT`, `EXECUTION_ERROR`.
Per-op results carry `status` (`success` / `failed` / `blocked` / `skipped`),
`message` (plain English), optional `error {code, message}`, per-line results
for `addSubparts`, and a `writes` log of every mutation made.

---

## Execution model (Cloudflare Workflows)

- One workflow instance per job (instance id = job id, so a job can never run
  twice).
- Each operation is a checkpointed workflow step: if Cloudflare recycles the
  isolate mid-job, execution resumes from the last completed operation — ops
  are additionally idempotent (verify-read at op start) so a retried step
  can't double-write.
- Sequential — never parallel — with `RATE_DELAY_MS` enforced between every
  Aligni call. The rate-gap timestamp is threaded through step results so it
  survives hibernation.
- Progress is written to KV after every op; `GET /jobs/:id` reconciles with
  the workflow instance status to catch infrastructure-level deaths.

## Dry-run mechanics

Lookups are batched with GraphQL aliases (3 assembly lookups or 40 component
lookups per Aligni call), so even a 37-assembly job dry-runs in ~15 rate-limited
calls (~90s) rather than 5+ minutes of one-at-a-time lookups. Reference lists
(units, part types, manufacturers) are fetched only when the job contains
`createPart` ops and cached 5 minutes in the isolate.

**Aligni complexity cap (discovered 2026-07-11):** queries above complexity
10,000 are rejected. Cost ≈ product of nested connection page sizes × leaf
fields, and UNBOUNDED connections cost less than large explicit `first:` values
(defaults are small). All executor queries use explicit bounds: batched
dry-run lookups `parts(first:1) → revisions(first:20) → subparts(first:30)`
(~2.5k per alias), execution single-part lookups
`revisions(first:40) → subparts(first:60)` (~10k budget for one alias).

---

## Aligni knowledge encoded (verified against live schema 2026-07-11)

- `partCreate(partInput: PartCreateInput!)` — required: `manufacturerId`,
  `partTypeId`, `unitId`, `activeRevisionAttributes` (a `PartRevisionCreateInput`
  with required `revisionName`). Returns `part { id partNumber ... }` + `errors`.
- **Custom parameters CAN be set at creation** — both `PartCreateInput` and
  `PartRevisionCreateInput` accept `customParameters: [{name!, value!}]`. The
  executor sets them on `activeRevisionAttributes` (params live on the revision).
  No create-then-update fallback needed.
- `description` / `comment` / `revisionReason` are revision fields
  (`PartRevisionCreateInput`), not Part fields.
- Mutation `errors` is `[String!]!` — subscription-limit failures are detected
  by message pattern, not structurally.
- **Update mutations (added 2026-07-20 for `updatePart`):**
  `partUpdate(partId: ID!, partInput: PartInput!)` → `{ part, errors }` and
  `partRevisionUpdate(partRevisionId: ID!, partRevisionInput: PartRevisionUpdateInput!)`
  → `{ partRevision, errors }`. There is no `PartUpdateInput` type — `partUpdate`
  takes `PartInput`, which carries `manufacturerPn` (rename), `customParameters`,
  `manufacturerId`, `partTypeId`, `manufacturedHere`, etc. `PartRevisionUpdateInput`
  carries `description`, `comment`, `customParameters`, `revisionName`,
  `revisionReason`, `rohs`. Both `errors` fields are `[String!]!`; field-level
  failures also surface as `{ data: null, errors: [...] }` and are handled by the
  shared `aligni()` helper.
- **`partRevisionUpdate` edits a Released revision in place** (live-tested
  2026-07-20) — it does NOT force a draft or create a new revision. So editing a
  released part's description/comment is a light-touch metadata edit, not a
  revision bump.
- All other quirks (OperatorScalar inlining, subparts naming, revision
  release/activate, no contains filter, camelCase) as documented in
  DEV_ENVIRONMENT.md.

### Custom parameters — hard-won details (live-tested 2026-07-11)

1. **Write by apiName, not display name.** `customParameters` entries in
   `partCreate` must use the parameter field's `apiName` (e.g. `COL`, `TH`,
   `MAT`, `FIN2`), NOT the display name ("Collection", "Thickness (mm)").
   Passing a display name fails the whole `partCreate`:
   *"The part parameter with the API name of Collection does not exist."*
   The executor accepts either form in the job and resolves to apiName using
   the `partParameterFields` query (fetched during dry run, cached 5 min).
   The 13 defined fields and their apiNames: Collection=COL, Alternative
   MPN=ALTMPN, Drawing No=DWGNO, Drawing Rev=DWGREV, Drawn By=BY,
   Thickness (mm)=TH, Material=MAT, Grade=GR, Equivalent Grade=EQGR,
   Finish Type=FIN1, Surface Treatment=SRF, Colour/Sheen=FIN2, Wattage=W.

2. **Parameters are constrained BY PART TYPE.** A globally-defined field can
   still be invalid for a given part type — e.g. `FIN1` (Finish Type) is
   rejected on "Sheet-Cut Profile": *"The part parameter with the API name of
   FIN1 does not exist."* The dry run validates names against the GLOBAL field
   list only; per-type validity surfaces as a clean failed-op at execution
   (the op is marked failed, dependents blocked, the job continues). Confirmed
   valid on Sheet-Cut Profile: Collection, Thickness (mm), Material,
   Colour/Sheen.

3. **These parameters live on the PART, not the revision** (none are
   `revisioned`). The executor sets them at `PartCreateInput.customParameters`
   (part level). Reading them back requires `Part.customParameters`, NOT
   `Part.activeRevision.customParameters`. ✅ Fixed 2026-07-20: the `get_part` and
   `search_parts` MCP tools now read `Part.customParameters` (they previously read
   the revision and always returned empty). `updatePart` writes them via
   `partUpdate` (`PartInput.customParameters`), also part-level.

4. **A newly created part's initial revision is DRAFT, not active.** So a
   just-created part cannot be used as a BOM *component* in the same job
   (subpartCreate needs the component's ACTIVE revision id). It CAN be used as
   the *assembly* receiving a BOM (addSubparts targets its draft). To chain
   created-part-as-component, release it first (a `releaseRevision` op earlier
   in the job).

### Part types — "category only" types cannot hold parts

Some part types are category groupings, not buildable types. Creating a part
of type "Assembly" fails: *"Validation failed: A category only part type
cannot have parts."* Use a concrete buildable type (e.g. "Sheet-Cut Profile",
"Finished Good", "Subassembly") for parts that will carry a BOM. The dry run
does not currently detect category-only types — this surfaces as a clean
failed-op at execution.
