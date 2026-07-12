// STACKABL Write Executor — Phase 2 smart endpoint (first Aligni write capability)
//
// Accepts a structured write job (createPart / ensureDraft / addSubparts /
// releaseRevision), dry-runs it against live Aligni with NO writes, and — only
// on an explicit second call — executes it unattended as a Cloudflare Workflow.
//
// Design rules (see tools/aligni-write-executor-spec.md):
// - ALL Aligni write logic lives here. MCP tools and the dashboard are thin clients.
// - Convention-blind: no MPN patterns, no naming intelligence. The executor runs
//   exactly the job it is given; naming decisions happen upstream in chat.
// - Jobs are immutable once submitted. A changed plan means a new job.
// - No automatic revert in v1: the per-op `writes` log records every mutation
//   (with returned IDs) so a human or follow-up job can undo precisely.

import { WorkflowEntrypoint } from 'cloudflare:workers';

// ── Constants ──────────────────────────────────────────────────────────────────
const ALIGNI_GQL = 'https://stacklab.aligni.com/api/v3/graphql';

// THE rate-limit constant. 10 req/min today — drop to 2100 when the Aligni
// 30/min support ticket resolves. This is the ONLY place the delay lives
// (tools/bom-importer.html and its IMPORT_DELAY are retired).
const RATE_DELAY_MS = 6100;

const RATE_LIMIT_WAIT_MS = 62000; // full 60s sliding window + 2s buffer
const MAX_RATE_RETRIES = 3;       // matches retired bom-importer behaviour

// Aligni rejects queries with complexity > 10,000, computed roughly as the
// product of connection page sizes × leaf fields (measured live 2026-07-11).
// Assembly lookups (nested revisions × subparts) cost ~2,500 each with the
// bounds below; component lookups are trivial. Chunks sized to stay under cap.
const ASSEMBLY_CHUNK = 3;
const COMPONENT_CHUNK = 40;
const JOBS_LIST_LIMIT = 20;       // GET /jobs returns at most this many
const INDEX_CAP = 100;            // jobs:index keeps at most this many entries
const MAX_OPS = 400;              // guardrail; a bigger job should be split
const CACHE_TTL_MS = 5 * 60 * 1000;

const OP_TYPES = ['createPart', 'ensureDraft', 'addSubparts', 'releaseRevision'];

// ── Module-level state (best-effort within a warm isolate) ─────────────────────
let _lastAligniCallAt = 0;
let _unitsCache = null, _unitsCacheAt = 0;
let _partTypesCache = null, _partTypesCacheAt = 0;
let _mfrsCache = null, _mfrsCacheAt = 0;
let _paramFieldsCache = null, _paramFieldsCacheAt = 0;

// ── Generic helpers ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escape values inlined into GraphQL query strings (OperatorScalar filter
// values cannot be GraphQL variables — they must be inlined).
function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

const CORS_GET = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200, cors = false) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(cors ? CORS_GET : {}) },
  });
}

function errResp(code, message, status, cors = false) {
  return jsonResp({ error: { code, message } }, status, cors);
}

function newJobId() {
  const t = Date.now().toString(36);
  const r = crypto.randomUUID().slice(0, 6);
  return `wj_${t}_${r}`;
}

// Next revision name: scan ALL revisions, find true max, preserve zero-padding.
function nextRevName(allRevisions) {
  const nums = allRevisions.map((r) => parseInt(r.revisionName) || 0);
  const maxNum = Math.max(...nums, 0);
  const next = maxNum + 1;
  const sample = allRevisions[0]?.revisionName ?? '1';
  const pad = /^\d+$/.test(sample) ? Math.max(sample.length, String(next).length) : 0;
  return pad > 0 ? String(next).padStart(pad, '0') : String(next);
}

// ── Aligni GraphQL call: throttled, rate-limit-retrying ────────────────────────
// `state.lastCallAt` threads the throttle timestamp across workflow steps
// (module state alone doesn't survive isolate recycling mid-job).
async function aligni(env, state, query, variables = undefined) {
  for (let attempt = 0; attempt <= MAX_RATE_RETRIES; attempt++) {
    const last = Math.max(_lastAligniCallAt, state.lastCallAt || 0);
    const gap = Date.now() - last;
    if (last && gap < RATE_DELAY_MS) await sleep(RATE_DELAY_MS - gap);
    _lastAligniCallAt = Date.now();
    state.lastCallAt = _lastAligniCallAt;
    state.calls = (state.calls || 0) + 1;

    const resp = await fetch(ALIGNI_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${env.ALIGNI_TOKEN}`,
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });

    let data;
    try { data = await resp.json(); }
    catch { throw { code: 'ALIGNI_ERROR', message: `Aligni returned non-JSON (HTTP ${resp.status})` }; }

    const isRateLimit = resp.status === 429 ||
      (data.errors && data.errors.some((e) =>
        /rate|too many/i.test(e.message || '')));

    if (isRateLimit) {
      if (attempt < MAX_RATE_RETRIES) {
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw { code: 'RATE_LIMITED', message: `Aligni rate limit persisted after ${MAX_RATE_RETRIES} retries.` };
    }

    // Field-level GraphQL errors (e.g. partCreate input validation) come back
    // as { data: { partCreate: null }, errors: [...] }. Surface them instead of
    // returning a null payload the caller then crashes on. Throw when errors are
    // present and no operation produced a usable value.
    const allDataNull = data.data && Object.values(data.data).every((v) => v == null);
    if (data.errors?.length && (!data.data || allDataNull)) {
      throw { code: 'ALIGNI_ERROR', message: data.errors[0].message };
    }
    // Aligni auth/permission failures come back as a bare { error: "..." }
    // instead of standard GraphQL errors — surface them instead of returning undefined.
    if (!data.data) {
      throw { code: 'ALIGNI_ERROR', message: String(data.error || 'Aligni returned an empty response.') };
    }
    return data.data;
  }
}

// ── Paginated list fetchers (units / part types / manufacturers) ───────────────
async function fetchAllPages(env, state, queryFn, connKey) {
  const items = [];
  let cursor = null;
  do {
    const data = await aligni(env, state, queryFn(cursor));
    const conn = data[connKey];
    items.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

async function getUnits(env, state) {
  if (_unitsCache && Date.now() - _unitsCacheAt < CACHE_TTL_MS) return _unitsCache;
  _unitsCache = await fetchAllPages(env, state,
    (c) => `{ units(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor } nodes { id name } } }`, 'units');
  _unitsCacheAt = Date.now();
  return _unitsCache;
}

async function getPartTypes(env, state) {
  if (_partTypesCache && Date.now() - _partTypesCacheAt < CACHE_TTL_MS) return _partTypesCache;
  _partTypesCache = await fetchAllPages(env, state,
    (c) => `{ partTypes(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor } nodes { id name } } }`, 'partTypes');
  _partTypesCacheAt = Date.now();
  return _partTypesCache;
}

async function getManufacturers(env, state) {
  if (_mfrsCache && Date.now() - _mfrsCacheAt < CACHE_TTL_MS) return _mfrsCache;
  _mfrsCache = await fetchAllPages(env, state,
    (c) => `{ manufacturers(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor } nodes { id name } } }`, 'manufacturers');
  _mfrsCacheAt = Date.now();
  return _mfrsCache;
}

// Custom parameter FIELD DEFINITIONS. partCreate's customParameters expects each
// entry's `name` to be the field's apiName (e.g. "COL"), NOT the display name
// ("Collection") — Aligni rejects display names with "part parameter ... does not
// exist". We fetch the definitions so a job can pass either the human display
// name or the apiName, and the executor resolves to apiName before writing.
async function getParamFields(env, state) {
  if (_paramFieldsCache && Date.now() - _paramFieldsCacheAt < CACHE_TTL_MS) return _paramFieldsCache;
  _paramFieldsCache = await fetchAllPages(env, state,
    (c) => `{ partParameterFields(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor } nodes { name apiName parameterType } } }`, 'partParameterFields');
  _paramFieldsCacheAt = Date.now();
  return _paramFieldsCache;
}

// Resolve one custom-parameter name to its apiName. Accepts the display name or
// the apiName, case-insensitive. Returns null if neither matches.
function resolveParamApiName(fields, name) {
  const n = String(name ?? '').trim().toLowerCase();
  const f = fields.find((x) =>
    (x.apiName || '').toLowerCase() === n || (x.name || '').toLowerCase() === n);
  return f ? f.apiName : null;
}

function findByName(list, name) {
  const n = String(name ?? '').toLowerCase();
  return list.find((x) => (x.name || '').toLowerCase() === n) || null;
}

// ── Batched part lookups (dry run) ─────────────────────────────────────────────
// GraphQL aliases collapse many MPN lookups into one Aligni call. Connection
// bounds keep each alias under the complexity cap; an eq filter returns at
// most one part, so parts(first: 1) is lossless. Dry-run bounds (20 revisions,
// 30 subparts) only limit plan display — execution re-reads each part fresh
// with the wider single-part shape below.
const ASSEMBLY_SHAPE = `nodes { id partNumber manufacturerPn
  revisions(first: 20) { nodes { id revisionName status active
    subparts(first: 30) { nodes { id quantity childPart { manufacturerPn } } } } } }`;

const COMPONENT_SHAPE = `nodes { id partNumber manufacturerPn
  activeRevision { id revisionName } }`;

async function batchLookup(env, state, mpns, shape, chunkSize) {
  const out = {};
  const unique = [...new Set(mpns)];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const query = '{\n' + chunk.map((mpn, j) =>
      `p${j}: parts(first: 1, filters: [{ field: "manufacturerPn", value: { eq: "${esc(mpn)}" } }]) { ${shape} }`
    ).join('\n') + '\n}';
    const data = await aligni(env, state, query);
    chunk.forEach((mpn, j) => { out[mpn] = data[`p${j}`]?.nodes?.[0] ?? null; });
  }
  return out;
}

// Single-part fresh lookup used during execution (state may have moved on
// since the dry run — drafts get released, revisions added, etc.). Wider
// bounds than the batched shape; a single part stays well under the cap.
const EXEC_ASSEMBLY_SHAPE = `nodes { id partNumber manufacturerPn
  revisions(first: 40) { nodes { id revisionName status active
    subparts(first: 60) { nodes { id quantity childPart { manufacturerPn } } } } } }`;

async function lookupAssembly(env, state, mpn) {
  const data = await aligni(env, state, `{
    parts(first: 1, filters: [{ field: "manufacturerPn", value: { eq: "${esc(mpn)}" } }]) { ${EXEC_ASSEMBLY_SHAPE} }
  }`);
  return data.parts?.nodes?.[0] ?? null;
}

// ── Mutations (variables are fine here — only filter values need inlining) ─────
const M_PART_CREATE = `mutation($input: PartCreateInput!) {
  partCreate(partInput: $input) {
    part { id partNumber manufacturerPn activeRevision { id revisionName status } }
    errors
  } }`;

const M_REV_CREATE = `mutation($sourceId: ID!, $input: PartRevisionCreateInput!, $copy: Boolean) {
  partRevisionCreate(sourcePartRevisionId: $sourceId, partRevisionInput: $input, copySubparts: $copy) {
    partRevision { id revisionName status } errors
  } }`;

const M_SUBPART_CREATE = `mutation($input: SubpartInput!) {
  subpartCreate(subpartInput: $input) { subpart { id } errors } }`;

const M_SUBPART_DELETE = `mutation($id: ID!) {
  subpartDelete(subpartId: $id) { errors } }`;

const M_REV_RELEASE = `mutation($id: ID!) {
  partRevisionRelease(partRevisionId: $id, partRevisionReleaseInput: { revisionActive: true }) {
    partRevision { id revisionName status active } errors
  } }`;

// Aligni docs flag subscription part-limit as a real partCreate failure mode.
// `errors` is [String!] so this can only be detected by message text.
function classifyMutationError(errs) {
  const msg = (errs || []).join('; ');
  if (/subscription|plan limit|part limit|upgrade|maximum number/i.test(msg)) {
    return { code: 'SUBSCRIPTION_LIMIT', message: msg };
  }
  return { code: 'ALIGNI_ERROR', message: msg };
}

// ── Job validation + dry run ───────────────────────────────────────────────────
function structuralErrors(job) {
  const errs = [];
  if (!job || typeof job !== 'object') return ['Job body must be a JSON object.'];
  if (!job.jobName || typeof job.jobName !== 'string' || !job.jobName.trim())
    errs.push('jobName is required (a short human label for this job).');
  if (!Array.isArray(job.operations) || job.operations.length === 0)
    errs.push('operations must be a non-empty array.');
  else if (job.operations.length > MAX_OPS)
    errs.push(`operations is capped at ${MAX_OPS} per job — split this into multiple jobs.`);
  else job.operations.forEach((op, i) => {
    const tag = `operations[${i}]`;
    if (!op || typeof op !== 'object') { errs.push(`${tag}: must be an object.`); return; }
    if (!OP_TYPES.includes(op.op)) { errs.push(`${tag}: op must be one of ${OP_TYPES.join(', ')}.`); return; }
    if (!op.manufacturerPn || typeof op.manufacturerPn !== 'string')
      errs.push(`${tag} (${op.op}): manufacturerPn is required.`);
    if (op.op === 'createPart') {
      // UOM cannot be changed after creation — hard-fail rather than guess.
      if (!op.unit) errs.push(`${tag} (createPart ${op.manufacturerPn}): unit is required and cannot be changed after creation.`);
      if (!op.partType) errs.push(`${tag} (createPart ${op.manufacturerPn}): partType is required.`);
      if (!op.manufacturer) errs.push(`${tag} (createPart ${op.manufacturerPn}): manufacturer is required.`);
      if (op.customParameters != null) {
        if (!Array.isArray(op.customParameters)) errs.push(`${tag}: customParameters must be an array of {name, value}.`);
        else op.customParameters.forEach((cp, k) => {
          if (!cp || !cp.name || cp.value == null) errs.push(`${tag}: customParameters[${k}] needs name and value.`);
        });
      }
    }
    if (op.op === 'addSubparts') {
      if (!Array.isArray(op.lines) || op.lines.length === 0)
        errs.push(`${tag} (addSubparts ${op.manufacturerPn}): lines must be a non-empty array.`);
      else op.lines.forEach((ln, k) => {
        if (!ln || !ln.manufacturerPn) errs.push(`${tag}: lines[${k}] needs manufacturerPn.`);
        const q = Number(ln?.quantity);
        if (!(q > 0)) errs.push(`${tag}: lines[${k}] (${ln?.manufacturerPn ?? '?'}) needs quantity > 0.`);
      });
    }
  });
  return errs;
}

// Dry run: all lookups, zero writes. Returns the stored dry-run context.
async function dryRun(env, job) {
  const state = { lastCallAt: 0, calls: 0 };
  const plan = [];
  const planErrors = [];

  // What gets created in-job, so later ops can reference it before it exists.
  const createdInJob = new Set(
    job.operations.filter((o) => o.op === 'createPart').map((o) => o.manufacturerPn));

  // Reference lists — only when the job mints parts.
  let units = [], partTypes = [], manufacturers = [], paramFields = [];
  const jobHasCustomParams = job.operations.some(
    (o) => o.op === 'createPart' && (o.customParameters || []).length);
  if (createdInJob.size > 0) {
    units = await getUnits(env, state);
    partTypes = await getPartTypes(env, state);
    manufacturers = await getManufacturers(env, state);
    if (jobHasCustomParams) paramFields = await getParamFields(env, state);
  }

  // Batched lookups.
  const targetMpns = job.operations
    .filter((o) => o.op !== 'createPart').map((o) => o.manufacturerPn);
  const createMpns = job.operations
    .filter((o) => o.op === 'createPart').map((o) => o.manufacturerPn);
  const componentMpns = job.operations
    .filter((o) => o.op === 'addSubparts')
    .flatMap((o) => (o.lines || []).map((l) => l.manufacturerPn))
    .filter((m) => m && !createdInJob.has(m));

  const assemblies = await batchLookup(env, state,
    [...targetMpns, ...createMpns].filter(Boolean), ASSEMBLY_SHAPE, ASSEMBLY_CHUNK);
  const components = await batchLookup(env, state, componentMpns, COMPONENT_SHAPE, COMPONENT_CHUNK);

  // Component revision cache for the whole job (shared parts like O-CUT-DISC5
  // are looked up once — same optimisation as the retired bom-importer).
  const componentRevIds = {};
  for (const [mpn, node] of Object.entries(components)) {
    if (node?.activeRevision?.id) componentRevIds[mpn] = node.activeRevision.id;
  }

  // refs snapshot for execution: live parts keyed by MPN.
  const refs = {};
  for (const [mpn, node] of Object.entries(assemblies)) {
    if (!node) continue;
    const revs = node.revisions?.nodes ?? [];
    const draft = revs.find((r) => (r.status || '').toUpperCase() === 'DRAFT') || null;
    const active = revs.find((r) => r.active) || null;
    refs[mpn] = {
      partId: node.id,
      partNumber: node.partNumber,
      draftRevId: draft?.id ?? null,
      draftRevName: draft?.revisionName ?? null,
      activeRevId: active?.id ?? null,
    };
  }

  // Simulated walk, op by op, producing the plain-English plan.
  const sim = {}; // mpn → { exists, willBeCreated, hasDraft, draftLabel, released, opFailed }
  for (const [mpn, node] of Object.entries(assemblies)) {
    if (!node) { sim[mpn] = { exists: false }; continue; }
    const revs = node.revisions?.nodes ?? [];
    const draft = revs.find((r) => (r.status || '').toUpperCase() === 'DRAFT');
    sim[mpn] = {
      exists: true,
      partNumber: node.partNumber,
      hasDraft: !!draft,
      draftLabel: draft ? `draft revision ${draft.revisionName}` : null,
      draftLineCount: draft ? (draft.subparts?.nodes?.length ?? 0) : 0,
      allRevs: revs,
    };
  }

  let estimatedCalls = 2; // slack for list fetches / rounding

  for (let i = 0; i < job.operations.length; i++) {
    const op = job.operations[i];
    const mpn = op.manufacturerPn;
    const entry = { index: i, op: op.op, target: mpn, action: '', error: null };
    const s = sim[mpn] ?? (sim[mpn] = { exists: false });

    if (op.op === 'createPart') {
      estimatedCalls += 2;
      if (s.exists) {
        entry.action = `Part ${mpn} already exists in Aligni (P/N ${s.partNumber}) — creation will be skipped and the existing part reused.`;
      } else {
        const unit = findByName(units, op.unit);
        const ptype = findByName(partTypes, op.partType);
        const mfr = findByName(manufacturers, op.manufacturer);
        // Resolve custom-parameter names to apiNames up front so an unknown
        // parameter fails the dry run rather than mid-execution (Aligni rejects
        // the whole partCreate on an unknown parameter).
        const badParams = [];
        const resolvedParams = (op.customParameters || []).map((cp) => {
          const apiName = resolveParamApiName(paramFields, cp.name);
          if (!apiName) badParams.push(cp.name);
          return { name: apiName, value: String(cp.value) };
        });
        if (!unit) entry.error = `Unknown unit "${op.unit}" — UOM cannot be changed after creation, so this is a hard failure. Valid units include: ${units.slice(0, 12).map((u) => u.name).join(', ')}.`;
        else if (!ptype) entry.error = `Unknown part type "${op.partType}". Valid types include: ${partTypes.slice(0, 12).map((p) => p.name).join(', ')}.`;
        else if (!mfr) entry.error = `Unknown manufacturer "${op.manufacturer}". Check the exact name in Aligni.`;
        else if (badParams.length) entry.error = `Unknown custom parameter${badParams.length > 1 ? 's' : ''}: ${badParams.join(', ')}. Valid parameters: ${paramFields.map((f) => f.name).join(', ')}.`;
        else {
          op._resolved = { unitId: unit.id, partTypeId: ptype.id, manufacturerId: mfr.id };
          op._resolvedParams = resolvedParams;
          const cpCount = resolvedParams.length;
          entry.action = `Create new part ${mpn} (type ${ptype.name}, unit ${unit.name}, manufacturer ${mfr.name})` +
            (cpCount ? ` with ${cpCount} custom parameter${cpCount > 1 ? 's' : ''}` : '') +
            `. Aligni will assign the next part number.`;
          s.exists = true; s.willBeCreated = true; s.hasDraft = true;
          s.draftLabel = 'the new part’s initial revision';
        }
      }
    } else if (!s.exists && !s.willBeCreated) {
      entry.error = `Part ${mpn} was not found in Aligni and is not created earlier in this job.`;
    } else if (op.op === 'ensureDraft') {
      estimatedCalls += 2;
      if (s.hasDraft) {
        entry.action = `${mpn}: ${s.draftLabel} will be reused — no new revision needed.`;
      } else {
        const nextName = s.allRevs ? nextRevName(s.allRevs) : 'next';
        entry.action = `${mpn} has no draft (currently released) — a new draft revision ${nextName} will be created${op.copyExistingBom ? ', copying the existing BOM' : ''}.`;
        s.hasDraft = true; s.draftLabel = `new draft revision ${nextName}`;
      }
    } else if (op.op === 'addSubparts') {
      const lines = op.lines || [];
      estimatedCalls += 1 + lines.length + (op.replaceExisting ? (s.draftLineCount || 0) : 0);
      const missing = [...new Set(lines.map((l) => l.manufacturerPn)
        .filter((m) => !createdInJob.has(m) && !components[m]))];
      if (missing.length) {
        entry.error = `Component part${missing.length > 1 ? 's' : ''} not found in Aligni: ${missing.join(', ')}. Nothing will be written for this operation.`;
      } else {
        let where;
        if (s.hasDraft) where = s.draftLabel;
        else {
          const nextName = s.allRevs ? nextRevName(s.allRevs) : 'next';
          where = `a new draft revision ${nextName} (created automatically — part is currently released)`;
          s.hasDraft = true; s.draftLabel = `new draft revision ${nextName}`;
          estimatedCalls += 1;
        }
        const replacing = op.replaceExisting && s.draftLineCount
          ? ` after removing the ${s.draftLineCount} existing line${s.draftLineCount > 1 ? 's' : ''}`
          : (op.replaceExisting ? ' (nothing existing to remove)' : '');
        const inJobComps = lines.filter((l) => createdInJob.has(l.manufacturerPn)).length;
        entry.action = `${mpn}: add ${lines.length} BOM line${lines.length > 1 ? 's' : ''} onto ${where}${replacing}. All components resolved` +
          (inJobComps ? ` (${inJobComps} created earlier in this job)` : '') + '.';
        s.draftLineCount = op.replaceExisting ? lines.length : (s.draftLineCount || 0) + lines.length;
      }
    } else if (op.op === 'releaseRevision') {
      estimatedCalls += 1;
      if (s.hasDraft) {
        entry.action = `${mpn}: release ${s.draftLabel} and set it as the active revision.`;
        s.hasDraft = false; s.draftLabel = null;
      } else {
        entry.action = `${mpn}: no draft is expected to exist at this point — release will be skipped.`;
      }
    }

    if (entry.error) planErrors.push(`Op ${i + 1} (${op.op} ${mpn}): ${entry.error}`);
    plan.push(entry);
  }

  return {
    plan,
    planErrors,
    valid: planErrors.length === 0,
    refs,
    componentRevIds,
    estimatedCalls,
    estimatedMinutes: Math.max(1, Math.round((estimatedCalls * RATE_DELAY_MS) / 60000)),
    dryRunCalls: state.calls,
  };
}

function planSummaryText(job, dry) {
  const lines = [];
  lines.push(`Dry-run plan for "${job.jobName}" — ${job.operations.length} operation${job.operations.length > 1 ? 's' : ''}, estimated ~${dry.estimatedMinutes} min to execute (rate-limited at ${RATE_DELAY_MS / 1000}s per Aligni call).`);
  dry.plan.forEach((p) => {
    lines.push(`${p.index + 1}. ${p.error ? '✗ PROBLEM — ' + p.error : p.action}`);
  });
  if (dry.valid) {
    lines.push('No writes have been made. Review the plan, then execute the job to run it unattended.');
  } else {
    lines.push(`This job is INVALID (${dry.planErrors.length} problem${dry.planErrors.length > 1 ? 's' : ''}) and cannot be executed. Fix the inputs and submit a new job — jobs are immutable once submitted.`);
  }
  return lines.join('\n');
}

// ── Job store helpers ──────────────────────────────────────────────────────────
async function loadJob(env, id) {
  return env.WRITE_JOBS.get(`job:${id}`, 'json');
}

async function saveJob(env, jobRecord) {
  await env.WRITE_JOBS.put(`job:${jobRecord.id}`, JSON.stringify(jobRecord));
}

async function addToIndex(env, summary) {
  const index = (await env.WRITE_JOBS.get('jobs:index', 'json')) || [];
  index.unshift(summary);
  await env.WRITE_JOBS.put('jobs:index', JSON.stringify(index.slice(0, INDEX_CAP)));
}

function opCounts(results) {
  const c = { success: 0, failed: 0, blocked: 0, skipped: 0, pending: 0 };
  for (const r of results) c[r.status === 'running' ? 'pending' : (c[r.status] != null ? r.status : 'pending')]++;
  return c;
}

function jobSummary(rec) {
  return {
    id: rec.id,
    jobName: rec.jobName,
    status: rec.status,
    valid: rec.valid,
    submittedAt: rec.submittedAt,
    startedAt: rec.startedAt ?? null,
    finishedAt: rec.finishedAt ?? null,
    progress: rec.progress,
    opCounts: opCounts(rec.results || []),
  };
}

// ── Execution (runs inside the Workflow) ───────────────────────────────────────
// Each op returns { result, refsDelta, lastCallAt, flags } and NEVER throws for
// Aligni-reported failures — a failed op is a recorded result, not a crash.
// Throwing is reserved for infra errors, which the Workflow step retries.

async function execCreatePart(env, op, ctx) {
  const state = { lastCallAt: ctx.lastCallAt, calls: 0 };
  const writes = [];
  const mpn = op.manufacturerPn;

  // Idempotency guard: a retried step (or re-submitted job) must not double-create.
  const existing = await lookupAssembly(env, state, mpn);
  if (existing) {
    const revs = existing.revisions?.nodes ?? [];
    const draft = revs.find((r) => (r.status || '').toUpperCase() === 'DRAFT');
    const active = revs.find((r) => r.active);
    return {
      result: {
        status: 'skipped',
        message: `Part already exists (P/N ${existing.partNumber}) — reused existing part.`,
        partNumber: existing.partNumber,
      },
      refsDelta: { [mpn]: {
        partId: existing.id, partNumber: existing.partNumber,
        draftRevId: draft?.id ?? null, activeRevId: active?.id ?? null,
        createdInJob: false,
      } },
      state, writes,
    };
  }

  // Custom parameter placement (verified against live schema 2026-07-11):
  // PartCreateInput accepts customParameters at BOTH the part level and inside
  // activeRevisionAttributes. Aligni's defined parameter fields carry a
  // `revisioned` flag; all 13 Stacklab fields (Collection, Material,
  // Thickness (mm), Colour/Sheen, Grade, ...) are NON-revisioned, so they live
  // on the PART, not the revision. We therefore set them at the part level.
  // If a revisioned parameter is ever added, route it via activeRevisionAttributes.
  // Prefer dry-run-resolved apiNames; fall back to resolving here for safety.
  const custom = (op._resolvedParams || (op.customParameters || []).map((cp) => ({ name: cp.name, value: String(cp.value) })));
  const input = {
    manufacturerPn: mpn,
    manufacturerId: op._resolved.manufacturerId,
    partTypeId: op._resolved.partTypeId,
    unitId: op._resolved.unitId,
    ...(custom.length ? { customParameters: custom } : {}),
    activeRevisionAttributes: {
      revisionName: op.revisionName || '1',
      ...(op.description != null ? { description: op.description } : {}),
      ...(op.comment != null ? { comment: op.comment } : {}),
      ...(op.revisionReason != null ? { revisionReason: op.revisionReason } : {}),
    },
    ...(op.manufacturedHere != null ? { manufacturedHere: !!op.manufacturedHere } : {}),
  };

  const data = await aligni(env, state, M_PART_CREATE, { input });
  const payload = data.partCreate;
  if (payload.errors?.length) {
    const err = classifyMutationError(payload.errors);
    return {
      result: {
        status: 'failed',
        message: err.code === 'SUBSCRIPTION_LIMIT'
          ? 'Aligni subscription part limit reached — no more parts can be created on the current plan.'
          : 'Part creation failed.',
        error: err,
      },
      refsDelta: {}, state, writes,
      flags: err.code === 'SUBSCRIPTION_LIMIT' ? { subscriptionLimitHit: true } : {},
    };
  }

  const part = payload.part;
  const rev = part.activeRevision;
  writes.push(`partCreate ${mpn} → part ${part.id}, assigned P/N ${part.partNumber}, revision ${rev?.revisionName} (${rev?.status})`);
  const revIsDraft = (rev?.status || '').toUpperCase() === 'DRAFT';
  return {
    result: {
      status: 'success',
      message: `Created part — Aligni assigned P/N ${part.partNumber}. Initial revision ${rev?.revisionName} is ${rev?.status?.toLowerCase()}.`,
      partNumber: part.partNumber,
      revisionName: rev?.revisionName ?? null,
    },
    refsDelta: { [mpn]: {
      partId: part.id, partNumber: part.partNumber,
      draftRevId: revIsDraft ? rev.id : null,
      activeRevId: rev?.id ?? null,
      createdInJob: true,
    } },
    state, writes,
  };
}

// Shared by ensureDraft and addSubparts' auto-draft path.
// Returns { draftRevId, draftRevName, created, part } or { error }.
async function resolveDraft(env, state, mpn, { copyExistingBom = false, revisionReason } , writes) {
  const part = await lookupAssembly(env, state, mpn);
  if (!part) return { error: { code: 'NOT_FOUND', message: `Part ${mpn} not found at execution time.` } };

  const revs = part.revisions?.nodes ?? [];
  const draft = revs.find((r) => (r.status || '').toUpperCase() === 'DRAFT');
  if (draft) {
    return { draftRevId: draft.id, draftRevName: draft.revisionName, created: false, part };
  }

  const source = revs.find((r) => r.active) || revs[revs.length - 1];
  if (!source) return { error: { code: 'NO_REVISION', message: `Part ${mpn} has no revisions to draft from.` } };

  const newName = nextRevName(revs);
  const data = await aligni(env, state, M_REV_CREATE, {
    sourceId: source.id,
    input: {
      revisionName: newName,
      revisionReason: revisionReason || `Write-executor job — ${new Date().toISOString().slice(0, 10)}`,
    },
    copy: !!copyExistingBom,
  });
  const payload = data.partRevisionCreate;
  if (payload.errors?.length) return { error: classifyMutationError(payload.errors) };
  writes.push(`partRevisionCreate ${mpn} rev ${newName} → ${payload.partRevision.id}`);
  return { draftRevId: payload.partRevision.id, draftRevName: newName, created: true, part };
}

async function execEnsureDraft(env, op, ctx) {
  const state = { lastCallAt: ctx.lastCallAt, calls: 0 };
  const writes = [];
  const mpn = op.manufacturerPn;
  const r = await resolveDraft(env, state, mpn, op, writes);
  if (r.error) return { result: { status: 'failed', message: 'Could not ensure a draft revision.', error: r.error }, refsDelta: {}, state, writes };
  return {
    result: {
      status: 'success',
      message: r.created
        ? `Created new draft revision ${r.draftRevName}.`
        : `Reused existing draft revision ${r.draftRevName}.`,
      revisionName: r.draftRevName,
    },
    refsDelta: { [mpn]: {
      ...(ctx.refs[mpn] || {}),
      partId: r.part.id, partNumber: r.part.partNumber,
      draftRevId: r.draftRevId, draftRevName: r.draftRevName,
    } },
    state, writes,
  };
}

async function execAddSubparts(env, op, ctx) {
  const state = { lastCallAt: ctx.lastCallAt, calls: 0 };
  const writes = [];
  const mpn = op.manufacturerPn;

  // Fresh lookup every time: doubles as the idempotency verify-read (a retried
  // step must not duplicate lines) and gives us existing-line IDs for replace.
  const r = await resolveDraft(env, state, mpn, op, writes);
  if (r.error) return { result: { status: 'failed', message: 'No draft revision available for BOM edit.', error: r.error }, refsDelta: {}, state, writes };

  const draftRev = (r.part.revisions?.nodes ?? []).find((x) => x.id === r.draftRevId);
  let existingLines = draftRev?.subparts?.nodes ?? [];

  const lineResults = [];
  let failed = 0;

  if (op.replaceExisting && !r.created) {
    for (const sp of existingLines) {
      const data = await aligni(env, state, M_SUBPART_DELETE, { id: sp.id });
      if (data.subpartDelete.errors?.length) {
        failed++;
        lineResults.push({ manufacturerPn: sp.childPart?.manufacturerPn ?? '?', action: 'remove', status: 'failed', error: classifyMutationError(data.subpartDelete.errors) });
      } else {
        writes.push(`subpartDelete ${sp.childPart?.manufacturerPn ?? sp.id} (was qty ${sp.quantity})`);
        lineResults.push({ manufacturerPn: sp.childPart?.manufacturerPn ?? '?', action: 'remove', status: 'success' });
      }
    }
    existingLines = [];
  }

  for (const line of op.lines) {
    const compMpn = line.manufacturerPn;
    const qty = Number(line.quantity);

    // Idempotency: skip a line that is already on the draft with this quantity.
    const dup = existingLines.find((sp) =>
      sp.childPart?.manufacturerPn === compMpn && Math.abs((sp.quantity ?? 0) - qty) < 1e-9);
    if (dup) {
      lineResults.push({ manufacturerPn: compMpn, quantity: qty, action: 'add', status: 'skipped', message: 'already present with this quantity' });
      continue;
    }

    const compRevId = ctx.refs[compMpn]?.activeRevId || ctx.componentRevIds[compMpn];
    if (!compRevId) {
      failed++;
      lineResults.push({ manufacturerPn: compMpn, quantity: qty, action: 'add', status: 'failed', error: { code: 'NOT_FOUND', message: `No active revision ID for component ${compMpn}.` } });
      continue;
    }

    const input = {
      partRevisionId: r.draftRevId,
      subpartPartRevisionId: compRevId,
      quantity: qty,
      ...(line.buildSequence != null ? { buildSequence: parseInt(line.buildSequence) } : {}),
      ...(line.designator != null ? { designator: String(line.designator) } : {}),
      ...(line.comment != null ? { comment: String(line.comment) } : {}),
    };
    const data = await aligni(env, state, M_SUBPART_CREATE, { input });
    if (data.subpartCreate.errors?.length) {
      failed++;
      lineResults.push({ manufacturerPn: compMpn, quantity: qty, action: 'add', status: 'failed', error: classifyMutationError(data.subpartCreate.errors) });
    } else {
      writes.push(`subpartCreate ${compMpn} ×${qty} on ${mpn} rev ${r.draftRevName} → ${data.subpartCreate.subpart?.id}`);
      lineResults.push({ manufacturerPn: compMpn, quantity: qty, action: 'add', status: 'success' });
    }
  }

  const ok = lineResults.filter((l) => l.status === 'success').length;
  const skipped = lineResults.filter((l) => l.status === 'skipped').length;
  return {
    result: {
      status: failed ? 'failed' : 'success',
      message: `${ok} line${ok === 1 ? '' : 's'} written onto draft revision ${r.draftRevName}` +
        (skipped ? `, ${skipped} already present` : '') +
        (failed ? `, ${failed} FAILED` : '') + '.',
      revisionName: r.draftRevName,
      lines: lineResults,
    },
    refsDelta: { [mpn]: {
      ...(ctx.refs[mpn] || {}),
      partId: r.part.id, partNumber: r.part.partNumber,
      draftRevId: r.draftRevId, draftRevName: r.draftRevName,
    } },
    state, writes,
  };
}

async function execReleaseRevision(env, op, ctx) {
  const state = { lastCallAt: ctx.lastCallAt, calls: 0 };
  const writes = [];
  const mpn = op.manufacturerPn;

  let revId = ctx.refs[mpn]?.draftRevId;
  let revName = ctx.refs[mpn]?.draftRevName ?? null;
  if (!revId) {
    const part = await lookupAssembly(env, state, mpn);
    if (!part) return { result: { status: 'failed', message: 'Part not found at execution time.', error: { code: 'NOT_FOUND', message: `Part ${mpn} not found.` } }, refsDelta: {}, state, writes };
    const draft = (part.revisions?.nodes ?? []).find((r) => (r.status || '').toUpperCase() === 'DRAFT');
    if (!draft) return { result: { status: 'skipped', message: 'No draft revision to release — nothing to do.' }, refsDelta: {}, state, writes };
    revId = draft.id; revName = draft.revisionName;
  }

  const data = await aligni(env, state, M_REV_RELEASE, { id: revId });
  const payload = data.partRevisionRelease;
  if (payload.errors?.length) {
    const msg = payload.errors.join('; ');
    if (/already released|not.*draft/i.test(msg)) {
      return { result: { status: 'skipped', message: `Revision ${revName ?? ''} was already released.` }, refsDelta: {}, state, writes };
    }
    return { result: { status: 'failed', message: 'Release failed.', error: classifyMutationError(payload.errors) }, refsDelta: {}, state, writes };
  }
  const rel = payload.partRevision;
  writes.push(`partRevisionRelease ${mpn} rev ${rel.revisionName} → status ${rel.status}, active ${rel.active}`);
  return {
    result: {
      status: 'success',
      message: `Released revision ${rel.revisionName} and set it active.`,
      revisionName: rel.revisionName,
    },
    refsDelta: { [mpn]: { ...(ctx.refs[mpn] || {}), draftRevId: null, activeRevId: revId } },
    state, writes,
  };
}

const EXECUTORS = {
  createPart: execCreatePart,
  ensureDraft: execEnsureDraft,
  addSubparts: execAddSubparts,
  releaseRevision: execReleaseRevision,
};

// ── The Workflow: durable, unattended execution ────────────────────────────────
export class WriteJobWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { jobId } = event.payload;
    const env = this.env;

    const job = await step.do('load-job', async () => {
      const rec = await loadJob(env, jobId);
      if (!rec) throw new Error(`Job ${jobId} not found in KV`);
      rec.status = 'running';
      rec.startedAt = Date.now();
      await saveJob(env, rec);
      return rec;
    });

    // Rebuilt deterministically on replay: completed steps return cached results.
    const refs = { ...(job.refs || {}) };
    const ctxBase = { componentRevIds: job.componentRevIds || {} };
    const failedTargets = new Set();
    let subscriptionLimitHit = false;
    let lastCallAt = 0;
    const results = job.results;

    try {
      for (let i = 0; i < job.operations.length; i++) {
        const op = job.operations[i];
        const mpn = op.manufacturerPn;

        const out = await step.do(`op-${i}-${op.op}`, {
          retries: { limit: 2, delay: '1 minute', backoff: 'constant' },
          timeout: '45 minutes',
        }, async () => {
          // Dependency rule: an op is blocked when an earlier op on the same
          // part failed (e.g. addSubparts onto a part whose createPart failed),
          // or when the subscription limit already killed part creation.
          if (failedTargets.has(mpn) || (op.op === 'createPart' && subscriptionLimitHit)) {
            const why = subscriptionLimitHit && op.op === 'createPart'
              ? 'Aligni subscription part limit was reached earlier in this job.'
              : `An earlier operation on ${mpn} failed.`;
            const blocked = {
              result: { status: 'blocked', message: `Blocked — ${why}` },
              refsDelta: {}, state: { lastCallAt, calls: 0 }, writes: [],
            };
            const rec = await loadJob(env, jobId);
            rec.results[i] = { ...rec.results[i], ...blocked.result, finishedAt: Date.now() };
            rec.progress = { done: i + 1, total: job.operations.length };
            await saveJob(env, rec);
            return blocked;
          }

          const ctx = { ...ctxBase, refs, lastCallAt };
          const started = Date.now();

          // A deterministic Aligni rejection (bad parameter, invalid input) is an
          // OP failure, not an infrastructure failure: record it and let the job
          // continue (dependents get blocked). Only RATE_LIMITED — which aligni()
          // already retried internally — is rethrown so the step retries after a
          // delay when the rate window has cleared.
          let out;
          try {
            out = await EXECUTORS[op.op](env, op, ctx);
          } catch (e) {
            if (e && e.code === 'RATE_LIMITED') throw e;
            out = {
              result: {
                status: 'failed',
                message: 'Operation failed — see error.',
                error: { code: e?.code || 'ERROR', message: e?.message || String(e) },
              },
              refsDelta: {},
              state: { lastCallAt },
              writes: [],
            };
          }
          out.result.startedAt = started;
          out.result.finishedAt = Date.now();
          out.result.aligniCalls = out.state.calls;
          out.result.writes = out.writes;

          const rec = await loadJob(env, jobId);
          rec.results[i] = { ...rec.results[i], ...out.result };
          rec.progress = { done: i + 1, total: job.operations.length };
          await saveJob(env, rec);
          return { result: out.result, refsDelta: out.refsDelta, state: { lastCallAt: out.state.lastCallAt }, flags: out.flags || {} };
        });

        Object.assign(refs, out.refsDelta ? Object.fromEntries(
          Object.entries(out.refsDelta).map(([k, v]) => [k, { ...(refs[k] || {}), ...v }])
        ) : {});
        lastCallAt = Math.max(lastCallAt, out.state?.lastCallAt || 0);
        results[i] = out.result;
        if (out.flags?.subscriptionLimitHit) subscriptionLimitHit = true;
        if (['failed', 'blocked'].includes(out.result.status)) failedTargets.add(mpn);
      }

      await step.do('finalize', async () => {
        const rec = await loadJob(env, jobId);
        rec.status = 'complete';
        rec.finishedAt = Date.now();
        rec.progress = { done: job.operations.length, total: job.operations.length };
        await saveJob(env, rec);
      });
    } catch (e) {
      // A step exhausted its retries (infra-level failure). Record and stop —
      // per-op results up to this point are already persisted.
      const rec = await loadJob(env, jobId);
      rec.status = 'failed';
      rec.finishedAt = Date.now();
      rec.failure = { code: 'EXECUTION_ERROR', message: e.message || String(e) };
      await saveJob(env, rec);
      throw e;
    }
  }
}

// ── HTTP API ───────────────────────────────────────────────────────────────────
async function handleSubmit(request, env) {
  let job;
  try { job = await request.json(); }
  catch { return errResp('BAD_JSON', 'Request body must be valid JSON.', 400); }

  const structural = structuralErrors(job);
  if (structural.length) {
    return jsonResp({ error: { code: 'INVALID_JOB', message: 'Job failed validation.', details: structural } }, 422);
  }

  let dry;
  try { dry = await dryRun(env, job); }
  catch (e) {
    return errResp(e.code || 'DRY_RUN_ERROR', `Dry run could not complete: ${e.message || e}. No job was stored — submit again.`, 502);
  }

  const id = newJobId();
  const record = {
    id,
    jobName: job.jobName.trim(),
    status: dry.valid ? 'validated' : 'invalid',
    valid: dry.valid,
    submittedAt: Date.now(),
    operations: job.operations,
    plan: dry.plan,
    planErrors: dry.planErrors,
    planText: planSummaryText(job, dry),
    estimatedCalls: dry.estimatedCalls,
    estimatedMinutes: dry.estimatedMinutes,
    refs: dry.refs,
    componentRevIds: dry.componentRevIds,
    results: job.operations.map((op) => ({
      op: op.op, target: op.manufacturerPn, status: 'pending', message: null,
    })),
    progress: { done: 0, total: job.operations.length },
  };
  await saveJob(env, record);
  await addToIndex(env, { id, jobName: record.jobName, submittedAt: record.submittedAt });

  return jsonResp({
    jobId: id,
    valid: dry.valid,
    status: record.status,
    planText: record.planText,
    plan: dry.plan,
    estimatedMinutes: dry.estimatedMinutes,
  }, 201);
}

async function handleExecute(env, id) {
  const rec = await loadJob(env, id);
  if (!rec) return errResp('NOT_FOUND', `No job with id ${id}.`, 404);
  if (!rec.valid) return errResp('INVALID_JOB', 'This job failed its dry run and cannot be executed. Submit a corrected job.', 409);
  if (rec.status !== 'validated') {
    return errResp('ALREADY_EXECUTED', `Job is ${rec.status} — a job can only be executed once, from the validated state.`, 409);
  }

  // One job at a time: the whole account shares one Aligni rate budget.
  const index = (await env.WRITE_JOBS.get('jobs:index', 'json')) || [];
  for (const entry of index.slice(0, JOBS_LIST_LIMIT)) {
    if (entry.id === id) continue;
    const other = await loadJob(env, entry.id);
    if (other && ['queued', 'running'].includes(other.status)) {
      return errResp('JOB_ALREADY_RUNNING', `Job ${other.id} ("${other.jobName}") is ${other.status}. Wait for it to finish before executing another.`, 409);
    }
  }

  rec.status = 'queued';
  rec.executeRequestedAt = Date.now();
  await saveJob(env, rec);
  await env.JOB_WORKFLOW.create({ id, params: { jobId: id } });

  return jsonResp({
    jobId: id,
    status: 'queued',
    message: `Execution started — ${rec.progress.total} operations, estimated ~${rec.estimatedMinutes} min. Progress via job status; the session can be closed.`,
  }, 202);
}

// If the workflow died in a way that never reached our catch block, reconcile.
async function reconcileWithWorkflow(env, rec) {
  if (!['queued', 'running'].includes(rec.status)) return rec;
  try {
    const instance = await env.JOB_WORKFLOW.get(rec.id);
    const st = await instance.status();
    if (['errored', 'terminated'].includes(st.status)) {
      rec.status = 'failed';
      rec.finishedAt = rec.finishedAt || Date.now();
      rec.failure = rec.failure || { code: 'WORKFLOW_' + st.status.toUpperCase(), message: String(st.error || 'Workflow did not complete.') };
      await saveJob(env, rec);
    }
  } catch { /* instance not found yet (queued) — leave as is */ }
  return rec;
}

async function handleGetJob(env, id) {
  let rec = await loadJob(env, id);
  if (!rec) return errResp('NOT_FOUND', `No job with id ${id}.`, 404, true);
  rec = await reconcileWithWorkflow(env, rec);
  return jsonResp({
    ...jobSummary(rec),
    planText: rec.planText,
    plan: rec.plan,
    planErrors: rec.planErrors,
    estimatedMinutes: rec.estimatedMinutes,
    failure: rec.failure ?? null,
    results: rec.results,
  }, 200, true);
}

async function handleListJobs(env) {
  const index = (await env.WRITE_JOBS.get('jobs:index', 'json')) || [];
  const jobs = [];
  for (const entry of index.slice(0, JOBS_LIST_LIMIT)) {
    let rec = await loadJob(env, entry.id);
    if (!rec) continue;
    rec = await reconcileWithWorkflow(env, rec);
    jobs.push(jobSummary(rec));
  }
  return jsonResp({ jobs }, 200, true);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_GET, 'Access-Control-Max-Age': '86400' } });
    }

    const jobIdMatch = path.match(/^\/jobs\/([A-Za-z0-9_-]+)(\/execute)?$/);

    // Writes require the shared secret — only the MCP server holds it.
    // The read-only dashboard uses the open GET endpoints.
    if (method === 'POST') {
      if (!env.EXECUTOR_API_KEY) return errResp('CONFIG', 'EXECUTOR_API_KEY secret not set.', 500);
      if (request.headers.get('X-Executor-Key') !== env.EXECUTOR_API_KEY) {
        return errResp('FORBIDDEN', 'Missing or invalid X-Executor-Key.', 403);
      }
      if (path === '/jobs') return handleSubmit(request, env);
      if (jobIdMatch && jobIdMatch[2]) return handleExecute(env, jobIdMatch[1]);
      return errResp('NOT_FOUND', 'Unknown endpoint.', 404);
    }

    if (method === 'GET') {
      if (path === '/jobs') return handleListJobs(env);
      if (jobIdMatch && !jobIdMatch[2]) return handleGetJob(env, jobIdMatch[1]);
      if (path === '/') return jsonResp({ service: 'stackabl-write-executor', endpoints: ['POST /jobs', 'POST /jobs/:id/execute', 'GET /jobs', 'GET /jobs/:id'] }, 200, true);
      return errResp('NOT_FOUND', 'Unknown endpoint.', 404, true);
    }

    return errResp('METHOD_NOT_ALLOWED', `${method} not supported.`, 405);
  },
};
