# BOM Bulk Importer — Spec

**File:** `tools/bom-importer.html`
**Built:** 2026-04-23

---

## What It Does

Accepts multiple CSV part-list files via drag-and-drop and bulk-imports BOMs into Aligni. The workflow is:

1. **Drop CSVs** — filenames must follow the pattern `YYYYMMDD-[MPN]-01-Part-List.csv`. The assembly MPN is parsed from the filename.
2. **Dry-run** — each file triggers a live Aligni lookup. The preview table shows Found/Not Found, current revision state, and what action will be taken (New BOM / Replace BOM / Create New Revision + Import).
3. **Confirm & Import** — processes files sequentially. For each assembly:
   - If the active revision is DRAFT: wipes existing subparts and re-imports
   - If the active revision is RELEASED: creates a new numbered draft revision, then imports
   - If a DRAFT already exists (e.g. a previous failed import): re-uses that draft rather than stacking another revision
4. **Review & Release** — after import, shows one card per successfully imported assembly with a three-column diff table (Before Import / Now in Aligni / Audit vs CSV). Each card has a checkbox; clicking **Release Selected** releases all checked revisions and sets them as active in one call.
5. **Abort & Revert** — an abort button is available during import. On abort, completed imports are rolled back in reverse order.

Part `100464` (generic pivot part) is always excluded from imports.

---

## CSV Format

Files must be named: `YYYYMMDD-[MPN]-01-Part-List.csv`

Expected columns:
| Column | Usage |
|--------|-------|
| `Manufacturer P/N` | Component MPN — used to look up the component's active revision ID |
| `Quantity` | Subpart quantity |
| `Unit of Measure` | Displayed in audit diff (not sent to Aligni — UOM is set on the part itself) |
| `Build Sequence` | Optional; passed to `subpartCreate` if present |
| `Partnumber` | Used only to filter out part `100464` |

---

## GraphQL Operations

### Queries

**Assembly lookup (dry-run + pre-import)**
```graphql
{
  parts(filters: [{ field: "manufacturerPn", value: { eq: "SA-CUT-DISC5-FT-111TRAU3" } }]) {
    nodes {
      id partNumber manufacturerPn
      revisions {
        nodes {
          id revisionName status active
          subparts {
            nodes {
              id quantity
              childPart { manufacturerPn partNumber unit { name } }
            }
          }
        }
      }
    }
  }
}
```
> Filter value must be inlined as a template literal — see API Quirks below.

**Component revision ID lookup (cached)**
```graphql
{
  parts(filters: [{ field: "manufacturerPn", value: { eq: "O-CUT-DISC5" } }]) {
    nodes {
      id
      revisions { nodes { id revisionName active } }
    }
  }
}
```

**Schema introspection (diagnostic)**
```graphql
{ __type(name: "Mutation") { fields { name } } }
{ __type(name: "PartRevisionReleaseInput") { inputFields { name type { name } } } }
```

### Mutations

**Create new draft revision from a released one**
```graphql
mutation ($sourceId: ID!, $input: PartRevisionInput!) {
  partRevisionCreate(
    sourcePartRevisionId: $sourceId
    partRevisionInput: $input
  ) { partRevision { id revisionName } errors }
}
```
Input: `{ revisionName: "02", revisionReason: "BOM bulk import — 2026-04-23" }`

**Delete a subpart (BOM line item)**
```graphql
mutation ($id: ID!) {
  subpartDelete(subpartId: $id) { errors }
}
```

**Create a subpart (BOM line item)**
```graphql
mutation ($input: SubpartInput!) {
  subpartCreate(subpartInput: $input) { subpart { id } errors }
}
```
Input: `{ partRevisionId, subpartPartRevisionId, quantity, buildSequence? }`
> `partRevisionId` = the assembly's revision ID. `subpartPartRevisionId` = the **component's active revision ID** — not the part ID.

**Release a revision and set it as active**
```graphql
mutation ($id: ID!) {
  partRevisionRelease(
    partRevisionId: $id
    partRevisionReleaseInput: { revisionActive: true }
  ) { partRevision { id revisionName status active } errors }
}
```

**Delete a revision (used during abort/revert of `newrev` entries)**
```graphql
mutation ($id: ID!) {
  partRevisionDelete(partRevisionId: $id) { errors }
}
```

---

## Key Aligni API Discoveries

### OperatorScalar — filter values must be inlined
The `eq` filter field has type `OperatorScalar`, not `String`. Passing the value as a GraphQL variable (`$mpn: String!`) causes a type mismatch error:
> `"Type mismatch on variable $mpn and argument eq (String! / OperatorScalar)"`

Values must be inlined directly into the query string as template literals:
```js
`{ parts(filters: [{ field: "manufacturerPn", value: { eq: "${mpn}" } }]) { ... } }`
```

### `errors` is a String scalar, not an object
All mutation payloads return `errors` as a plain `String`, not an object with a `message` field. Query it as `errors`, not `errors { message }` — the latter causes:
> `"Selections can't be made on scalars"`

### BOM items are called "subparts"
In the Aligni data model, BOM line items are `subparts`, not "part list items". The mutations are `subpartCreate` / `subpartDelete`.

### `subpartCreate` requires revision IDs, not part IDs
Both `partRevisionId` (assembly) and `subpartPartRevisionId` (component) must be the revision's GraphQL `id`, not the part's numeric `partNumber`. Always look up the component's active revision first.

### `revisionActive: true` releases and activates in one call
`partRevisionActivate` does not exist as a mutation. `partRevisionUpdate` does not accept an `active` field. The correct approach is to pass `revisionActive: true` inside `PartRevisionReleaseInput` when calling `partRevisionRelease` — this releases the revision and sets it as active simultaneously.

### Revision naming is zero-padded
Revision names are integers-as-strings. The tool scans all existing revisions (not just the active one) to find the true maximum, then increments and preserves the original pad width: `"01"` → `"02"`, not `"2"`.

### Rate limit
Confirmed **10 requests/minute** (sliding window). The account should be provisioned for 30/min — support ticket open with Aligni. Current `IMPORT_DELAY` is set to `6100ms` to stay under the 10/min limit. Once the account is upgraded, drop it to `2100ms`.

When the limit is hit the tool waits **62 seconds** and retries up to 3 times before failing the file. A sweeping activity bar at the top of the page indicates when a call is in-flight; the progress label changes to show the rate limit wait countdown.

### Component revision cache
Shared operation parts (e.g. `O-CUT-DISC5`) appear in every BOM. The tool caches component revision IDs in `componentRevCache` after the first lookup and reuses them across all files in a batch — avoiding ~35 redundant API calls for a 37-file import.

### Existing draft detection
If an assembly already has a DRAFT revision when the dry-run runs (e.g. from a previous failed or unreleased import), the tool imports into that draft rather than creating another new revision. The dry-run preview reflects this: it shows the draft revision number and "Replace BOM" rather than "Create Rev N + Import".

---

## Abort & Revert Logic

When the user clicks **Abort & Revert** during import, completed entries are rolled back in reverse order:

| Action type | Revert behaviour |
|-------------|-----------------|
| `newrev` | Calls `partRevisionDelete` to remove the newly created revision entirely |
| `import` | Re-fetches current subparts → deletes them → re-adds the original subparts from the pre-import snapshot using cached component revision IDs |

Entries that had not yet started are simply not processed. Released entries are not reverted (release is intentional and one-way).

---

## Watch Points

- **`partRevisionDelete` untested** — mutation name is correct per introspection but has not been exercised in a live abort. Verify the first time an import is aborted after a `newrev` entry completes.
- **Rate limit** — full 37-file batch has not completed end-to-end. Individual files and small batches work. Waiting on Aligni support to activate 30/min. After fix: change `IMPORT_DELAY` from `6100` to `2100` in `bom-importer.html`.
- **`revisionActive: true` on release** — correct per introspection; not yet confirmed in a live end-to-end release test with a newly created revision.
- **CSV column names are case/space sensitive** — the parser expects exact headers: `Manufacturer P/N`, `Quantity`, `Unit of Measure`, `Build Sequence`, `Partnumber`. Any deviation in the export template will silently produce empty values.
