# Plan 002: Build an executable Luzern tax MCP spike

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: This directory was not a Git repository when the plan was written, so there is no commit SHA to diff against. Run `find . -maxdepth 3 -type f | sort` and confirm `KANTON_LUZERN_TAX_API.md`, `config/model.xml`, `config/entity-labels.properties`, and `config/scantax.xml` still exist. If Plan 001 is not DONE in `plans/README.md`, stop.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-sanitize-tax-artifacts.md`
- **Category**: direction
- **Planned at**: `no-git-baseline`, 2026-06-22

## Why this matters

The reverse-engineered notes already identify the core web API loop for creating, loading, reading, updating, saving, and printing a Luzern tax declaration. A narrow MCP spike should convert that knowledge into an executable local server with safe tooling boundaries, typed request/response handling, and offline catalogue lookup from the extracted config files. The goal is not a production tax filer; it is a runnable proof that the documented API flow and field catalogue can support agent-driven declaration editing.

## Current state

- `KANTON_LUZERN_TAX_API.md` is the source of API behavior and endpoint notes.
- `config/model.xml` is the extracted tax model. It contains field IDs, expressions, calculated flags, visibility/enabled metadata, and list/table structures.
- `config/entity-labels.properties` maps field IDs to German UI labels. It currently contains a small number of duplicate keys, so catalogue generation must report duplicates instead of silently hiding them.
- `config/scantax.xml` maps model fields to ScanTax output positions.
- There is no application manifest, package manager config, source tree, test runner, or MCP implementation yet.

Relevant current excerpts:

```markdown
# KANTON_LUZERN_TAX_API.md:824-833
1. **Start building — the API is fully understood.** Enough is now confirmed to implement the
   complete MCP server:
   - Auth via password grant (`/realms/{realm}/protocol/openid-connect/token`)
   - `list_declarations` → `search`, `create_declaration` → `create`, `load_declaration` → `load`
   - `get_scope(id, templateIds, rootScopeId)` → `entityScope` (reads entities + consistency)
   - `set_field(id, templateIds, rootScopeId, domainPath, scopeId, value)` → `update` (type=1)
   - `insert_list_entry(id, templateIds, parentScopeId, domainPath, currentScopeCount)` → `update` (type=2)
   - `save_declaration(id)` → `save`
   - `print_declaration(id)` → `print` → poll `printStatus` → download `printResult` (async 3-step)
   - Local field catalogue from `config/model.xml` + `config/entity-labels.properties`
```

```markdown
# KANTON_LUZERN_TAX_API.md:776-780
- Treat `calculated`/`enabled=false`/`visible=false` flags as guardrails: never write calculated
  fields; surface visibility so the agent knows which inputs are in scope.
- `requestNumber` is only needed for the legacy `startTransaction`/`commit`/`rollback` endpoints — not for `update` or `entityScope`.
```

```text
# Duplicate labels observed during audit; values intentionally omitted here.
config/entity-labels.properties has duplicate keys for:
- STES1_persID_Copy
- KU1_13AbzugSelbstbehalt
- WVS3_VerrechnungSteuer
- LIEG00_TotalKosten
```

## Resolved domain decisions

These decisions were agreed during domain-model review and are recorded in `CONTEXT.md`:

- The bounded context is **Tax Declaration Editing**, not tax preparation, advice, or optimization.
- **Submission** and **Export** are out of scope. **Save** and **Print** are in scope.
- The first version is optimized for one configured taxpayer. **Login Credentials** and **Declaration Credentials** are process configuration, not ordinary MCP tool arguments.
- `create_declaration` uses configured Declaration Credentials; it must not accept PersID or access-code arguments.
- `list_declarations` may discover visible Tax Declarations, but editing tools require an explicit declaration ID unless a configured declaration ID exists.
- Network tools automatically open a Tax Declaration when needed; `load_declaration` remains available for diagnostics and manual flow testing.
- The offline Field Catalogue is a discovery/preflight index. Runtime `entityScope` is authoritative for whether a Field or List Entry is currently active, enabled, and writable.
- `set_field` and `insert_list_entry` must check Runtime Scope before calling `update`.
- List insertion must derive `currentScopeCount` from the Runtime Scope when possible instead of trusting caller input.
- `update` responses are partial update results, not complete Runtime Scopes.
- The first version defaults Interface Language to German (`de`) unless configured otherwise.
- The spike exposes vendor template IDs directly as a Template Set instead of hiding them behind aliases.
- Print artifacts can contain taxpayer data and must not be written into the repository by default.

## Commands you will need

No project commands existed during planning. Establish these commands as part of the spike:

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 and creates `package-lock.json` |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Tests | `npm test` | exit 0, all tests pass |
| Lint | `npm run lint` | exit 0 |
| PII guard | `python3 scripts/check_no_tax_pii.py` | exit 0; required from Plan 001 |
| XML sanity | `xmllint --noout config/scantax.xml config/model.xml` | exit 0, no output |

If the maintainer prefers a different runtime than Node/TypeScript, stop and ask before changing the stack. The documented target is an MCP server, and TypeScript has the most direct fit with the official MCP SDK and JSON schema validation libraries.

## Suggested executor toolkit

Use the repo's Context7 rule before relying on MCP SDK or library APIs:

- `npx ctx7@latest library "Model Context Protocol TypeScript SDK" "<full question>"`
- `npx ctx7@latest docs <selected-library-id> "<full question>"`

Also use Context7 for Zod or any other library API you add. Do not exceed the repo's three-command limit per question.

## Scope

**In scope**:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src/catalogue.ts`
- `src/etaxClient.ts`
- `src/server.ts`
- `src/types.ts`
- `src/catalogue.test.ts`
- `src/etaxClient.test.ts`
- `src/server.test.ts`
- `README.md`
- `plans/README.md` status row

**Out of scope**:

- Submitting real declarations
- Handling real credentials in tests
- Storing passwords, access codes, bearer tokens, refresh tokens, declaration IDs, or taxpayer PII
- Reading `.lunp2024` archives or annex PDFs
- Writing to calculated fields
- Building a full production UX, deployment package, or OAuth browser flow

## Git workflow

No Git repository was present during planning. If the repo has been initialized by execution time, use branch `advisor/002-executable-mcp-spike`. Make commits per logical unit: project scaffold, catalogue, client, MCP tools, docs. Do not push unless instructed.

## Steps

### Step 1: Confirm the privacy prerequisite

Open `plans/README.md` and confirm Plan 001 is marked DONE. Run the privacy guard from Plan 001.

**Verify**: `python3 scripts/check_no_tax_pii.py` -> exits 0.

### Step 2: Scaffold a minimal TypeScript project

Create `package.json`, `package-lock.json`, and `tsconfig.json`. Use ESM TypeScript. Add scripts:

- `typecheck`: `tsc --noEmit`
- `test`: Node's built-in test runner against compiled or TypeScript-executed tests, depending on the chosen setup
- `lint`: a no-format check such as `eslint .` if you add ESLint, or a deliberately documented placeholder only if no lint package is installed yet
- `start`: run the MCP server

Install only what the spike needs. Expected dependencies are the MCP TypeScript SDK, a schema validator such as Zod, and XML/properties parsing libraries if the standard library is not enough. Keep dependency count small.

**Verify**: `npm run typecheck` -> exits 0.

### Step 3: Build the offline field catalogue

Create `src/catalogue.ts` to parse:

- `config/model.xml`
- `config/entity-labels.properties`
- optionally `config/scantax.xml` for output position metadata

Expose functions similar to:

- `loadCatalogue(paths): Catalogue`
- `findFields(query, options): FieldSummary[]`
- `getField(fieldId): FieldSummary | undefined`

Each `FieldSummary` should include field ID, type, label if available, calculated/enabled/visible flags, enum ID if present, and source files. Duplicate label keys must be reported in a `diagnostics` array instead of silently ignored.

Tests in `src/catalogue.test.ts` must cover:

- catalogue loads successfully
- known fields from the notes are present
- calculated fields are flagged
- duplicate labels are reported
- text search finds fields by label and ID

**Verify**: `npm test -- src/catalogue.test.ts` -> all catalogue tests pass.

### Step 4: Implement a safe eTax HTTP client

Create `src/etaxClient.ts` with a small class or functions for the documented endpoints:

- `authenticate`
- `listDeclarations`
- `createDeclaration`
- `loadDeclaration`
- `getScope`
- `setField`
- `insertListEntry`
- `saveDeclaration`
- `printDeclaration`

Use dependency injection for `fetch` so tests can run without network. Do not persist tokens. Do not log request bodies that may contain credentials or tax data. Refuse `setField` when the catalogue marks a field as calculated.

Authenticate internally from process configuration; do not expose Login Credentials through MCP tools.

Important call-flow rules from the notes:

- Use `/services/datamodel/entityScope` for reads.
- Use `/services/datamodel/update` for writes.
- Check runtime writability with `entityScope` before `setField` and `insertListEntry`.
- Derive list `currentScopeCount` from runtime `scopeIds` when possible.
- Auto-open the Tax Declaration when needed; do not force callers through `loadDeclaration` for every read/write.
- Do not wrap `update` with `startTransaction` / `commit`.
- Do not require `requestNumber` for `entityScope` or `update`.

Tests in `src/etaxClient.test.ts` must use a fake fetch and assert URLs, request bodies, auth header placement, no transaction wrapper calls, print polling behavior, and calculated-field refusal.

**Verify**: `npm test -- src/etaxClient.test.ts` -> all client tests pass.

### Step 5: Expose the MCP tools

Create `src/server.ts` and register narrowly scoped tools:

- `search_fields`
- `get_field`
- `list_declarations`
- `create_declaration`
- `load_declaration`
- `get_scope`
- `set_field`
- `insert_list_entry`
- `save_declaration`
- `print_declaration`

Tool design requirements:

- Tool descriptions must warn that credentials and taxpayer PII should not be sent unless the operator intentionally runs against eTax.
- `search_fields` and `get_field` must work offline.
- Network tools must require explicit environment selection, such as `training` or `production`.
- Do not expose an `authenticate` tool.
- `create_declaration` must use configured Declaration Credentials, not PersID/access-code tool arguments.
- `set_field` and `insert_list_entry` must reject non-writable runtime Fields before making an update call.
- `print_declaration` may return a path or bytes only if implemented safely outside the repository; otherwise return job status metadata and document the limitation.

Tests in `src/server.test.ts` should call tool handlers directly or through the SDK test harness if available. Do not contact real services.

**Verify**: `npm test -- src/server.test.ts` -> all MCP server tests pass.

### Step 6: Document how to run the spike safely

Update `README.md` with:

- setup commands
- local-only catalogue commands
- how to run the MCP server
- required environment variables for network use
- single-taxpayer configuration model and optional configured declaration ID
- privacy warnings
- what is not implemented

Do not include real credentials, declaration IDs, taxpayer names, AHV numbers, access codes, or bearer tokens.

**Verify**: `python3 scripts/check_no_tax_pii.py` -> exits 0.

### Step 7: Run the full verification gate

Run all project checks.

**Verify**:

- `xmllint --noout config/scantax.xml config/model.xml` -> exit 0
- `npm run typecheck` -> exit 0
- `npm run lint` -> exit 0
- `npm test` -> exit 0
- `python3 scripts/check_no_tax_pii.py` -> exit 0

## Test plan

- `src/catalogue.test.ts`: offline parsing, duplicate diagnostics, search behavior, calculated/enabled/visible flags.
- `src/etaxClient.test.ts`: fake-fetch coverage for every endpoint wrapper and safety guard.
- `src/server.test.ts`: MCP tool schema/handler coverage without network.
- No tests may use real credentials or real taxpayer data.

## Done criteria

- [ ] Plan 001 is DONE before this plan begins.
- [ ] `npm install` has produced a locked dependency set.
- [ ] `search_fields` and `get_field` work offline from config files.
- [ ] HTTP client uses `entityScope` and `update`, not `v2/updateValue` for core writes.
- [ ] `set_field` and `insert_list_entry` check Runtime Scope before update calls.
- [ ] `create_declaration` uses configured Declaration Credentials rather than sensitive tool arguments.
- [ ] Tests cover catalogue, client, and MCP tool handlers without real network.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `xmllint --noout config/scantax.xml config/model.xml`, and `python3 scripts/check_no_tax_pii.py` all exit 0.
- [ ] `README.md` explains safe usage and limitations.
- [ ] `plans/README.md` status row for Plan 002 is updated.

## STOP conditions

Stop and report back if:

- Plan 001 is not DONE.
- Context7 docs show the MCP SDK API shape is materially different from the intended server design.
- The maintainer does not want Node/TypeScript.
- Any test or implementation requires real credentials, real declaration IDs, real taxpayer data, or live network calls.
- The catalogue parser cannot reliably identify calculated fields from `config/model.xml`.
- Implementing auth safely appears to require storing passwords or refresh tokens.

## Maintenance notes

Reviewers should focus on privacy boundaries, network isolation in tests, and whether tool schemas make unsafe operations explicit. This is a spike: defer production OAuth flow, durable token storage, live submission, and full `.lunp2024` import/export support until the offline catalogue and basic API loop are proven.
