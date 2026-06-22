# Luzern Tax MCP

This context covers the local MCP server and supporting notes for creating, inspecting, and editing Luzern tax declarations through the eSteuern.LU web platform.

## Language

**Tax Declaration**:
A taxpayer's period-specific Luzern tax filing being edited or submitted through eSteuern.LU.
_Avoid_: Datamodel, document, Steuererklärung

**Taxpayer**:
The person or legal entity whose Tax Declaration is being edited.
_Avoid_: User, account

**Tax Declaration Editing**:
The bounded context for reading catalogue fields and applying explicit changes to a Tax Declaration.
_Avoid_: Tax preparation, tax advice, tax optimization

**Submission**:
The irreversible eFiling act that sends a Tax Declaration to the tax authority.
_Avoid_: Save, print, export

**Save**:
Persisting the current Tax Declaration draft in eSteuern.LU.
_Avoid_: Submit, file

**Print**:
Generating a review PDF artifact for a Tax Declaration.
_Avoid_: Submit, export

**Export**:
Downloading an interchange package for a Tax Declaration.
_Avoid_: Print, submit

**Training Environment**:
The non-production eSteuern.LU environment at `schulen-lu.etax.ch`.
_Avoid_: School, test

**Production Environment**:
The live eSteuern.LU environment at `esteuern.lu.ch`.
_Avoid_: Prod, live unless contrasting with Training Environment

**Login Credential**:
The Keycloak email and password used to obtain an eSteuern.LU bearer token.
_Avoid_: Declaration credential, PersID, access code

**Declaration Credential**:
The PersID and access code used to create or bootstrap a Tax Declaration.
_Avoid_: Login credential, Keycloak credential

**Configured Tax Declaration**:
The optional Tax Declaration ID selected through server process configuration.
_Avoid_: Active declaration, current declaration

**Open Tax Declaration**:
Preparing a Tax Declaration for subsequent API operations in eSteuern.LU.
_Avoid_: Load data, request number seed

**Tax Period**:
The calendar year for which a Tax Declaration is prepared.
_Avoid_: App version, model version

**Tax Model**:
The vendor model identifier that selects the canton, taxpayer type, and Tax Period schema.
_Avoid_: Tax Declaration, form

**Interface Language**:
The language code used for eSteuern.LU labels, messages, and help text.
_Avoid_: Tax Period, locale

**Template Set**:
The vendor template IDs required to read or update a Runtime Scope.
_Avoid_: Tax Model, Field Catalogue

**Field**:
A typed value or list entry in a Tax Declaration identified by a vendor `domainPath` and `scopeId`.
_Avoid_: Entity, input

**Runtime Scope**:
The current eSteuern.LU view of Fields, anchors, and consistency messages for a specific Tax Declaration scope.
_Avoid_: Catalogue, model

**Field Catalogue**:
An offline discovery index of model Fields, labels, metadata hints, diagnostics, and source provenance.
_Avoid_: Runtime state, validator

**Scope**:
A concrete instance path within a Tax Declaration, usually representing a form section or list row.
_Avoid_: Template, field path

**List Entry**:
A repeated child Scope under a list Field.
_Avoid_: Row, child scope, scope instance

**Consistency Message**:
Server-produced feedback about completeness or correctness of a Tax Declaration.
_Avoid_: Local validation error, diagnostic

**Attachment Anchor**:
A server-provided attachment requirement or suggestion tied to a path in a Tax Declaration.
_Avoid_: File upload, consistency message

**Auto-Commit Update**:
A Field or List Entry update that is persisted by eSteuern.LU without an explicit transaction wrapper.
_Avoid_: Transaction, staged change

## Relationships

- A **Tax Declaration** is represented by the vendor API as a `datamodel`.
- A **Tax Declaration** belongs to one **Taxpayer** for one **Tax Period**.
- **Tax Declaration Editing** may expose eSteuern.LU consistency messages, but it does not decide filing strategy.
- **Submission** is outside the MCP spike even though the vendor API exposes a submission endpoint.
- **Save** and **Print** are inside the MCP spike; **Export** and **Submission** are outside it.
- A **Print** artifact can contain taxpayer data and must not be written into the repository by default.
- Every network MCP tool requires an explicit **Training Environment** or **Production Environment** selection.
- **Login Credentials** and **Declaration Credentials** are independent and must not be stored by the MCP spike.
- The MCP spike does not expose an authentication tool; **Login Credentials** are process configuration.
- The first MCP version is configured for one taxpayer; **Declaration Credentials** are process configuration rather than normal tool arguments.
- The MCP `create_declaration` tool uses configured **Declaration Credentials** and does not accept PersID or access code arguments.
- `list_declarations` may discover visible **Tax Declarations**, but editing tools require an explicit or configured Tax Declaration ID.
- Editing tools may omit a Tax Declaration ID only when a **Configured Tax Declaration** exists.
- The vendor `datamodel/load` call means **Open Tax Declaration** and does not make `requestNumber` part of normal Field writes.
- MCP tools automatically **Open Tax Declaration** when needed; `load_declaration` remains available for diagnostics and manual flow testing.
- The first MCP version defaults to natural-person Luzern 2025 only when no **Tax Model** is configured.
- **Tax Period** and **Tax Model** are configuration/discovery concerns, not replacements for **Tax Declaration**.
- The first MCP version defaults **Interface Language** to German (`de`) unless configured otherwise.
- A **Field** is represented by the vendor API as an `entity`.
- The **Field Catalogue** can preflight a **Field**, but **Runtime Scope** is authoritative for whether that Field is active, enabled, and writable in a Tax Declaration.
- The MCP `set_field` tool checks **Runtime Scope** itself before writing; it does not rely on the caller having fetched scope earlier.
- A **Runtime Scope** is read for one root **Scope** and includes Fields addressed by their own **Scope** IDs.
- Inserting a **List Entry** creates a new child **Scope** whose Fields can then be written.
- The MCP `insert_list_entry` tool checks the parent **Runtime Scope** and derives the current list count before inserting.
- The MCP spike exposes vendor identifiers such as `templateIds`, `rootScopeId`, `domainPath`, and `scopeId` directly.
- `templateIds` are exposed as a **Template Set** in the spike rather than hidden behind aliases.
- A **Runtime Scope** can include **Consistency Messages** for the Tax Declaration.
- Updating a **Field** returns a partial update result with changed or recomputed Fields and **Consistency Messages**, not a complete **Runtime Scope**.
- A **Runtime Scope** can include **Attachment Anchors**, but the first MCP version does not upload attachments.
- Field and List Entry writes use **Auto-Commit Updates** through `datamodel/update`; the MCP spike does not call transaction endpoints for normal writes.

## Example dialogue

> **Dev:** "When the agent updates a **Tax Declaration**, should it call the vendor `datamodel/update` endpoint directly?"
> **Domain expert:** "Yes, but only after checking the catalogue and the current **Runtime Scope**."

## Flagged ambiguities

- "datamodel" and "document" appear in vendor API paths and payloads, but the domain term is **Tax Declaration**.
- "user" or "account" must not be used for the **Taxpayer** unless referring specifically to Keycloak login ownership.
- "tax preparation" is too broad for this MCP server; the bounded context is **Tax Declaration Editing**.
- "submission" must not be used for saving or printing; it means eFiling to the tax authority.
- "entity" appears in vendor responses, but the domain-facing term is **Field**.
- **Field Catalogue** must not imply runtime writability; **Runtime Scope** decides current applicability.
- Multi-taxpayer operation is outside the first MCP version.
- "model" must not be used to mean a **Tax Declaration**; it means the vendor **Tax Model** schema.
- "attachment" must not imply upload support in the first MCP version; **Attachment Anchors** are visible as server feedback only.
