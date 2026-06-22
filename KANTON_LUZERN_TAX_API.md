# Kanton Luzern Online Tax — Reverse-Engineered API

> Working notes for building an **MCP server** that helps agents create a Luzern (CH) tax
> declaration. Compiled from prior reverse-engineering sessions (JS bundle analysis +
> `.lunp2024` file dissection) plus the test fixtures in `test-import/`.
>
> **Status:** substantially verified. §2 (web platform) is now largely confirmed from live
> session capture + JS bundle analysis (2026-06-22). §2.10 documents **confirmed full JSON
> response shapes** captured via live XHR against training env (2026-06-22). Items still
> marked ⚠️ remain unverified. Config files extracted to `config/` from the installed 2024
> desktop app.

---

## 1. Landscape: two platforms

Kanton Luzern changed delivery between tax periods. An MCP server should target the **web
platform** for 2025+ and treat the desktop/file format as an **import/export interchange**.

| | **Legacy (Steuerperiode 2024)** | **Current (Steuerperiode 2025+)** |
|---|---|---|
| Product | Desktop app (Information Factory) | **eSteuern.LU** web SPA |
| Vendor | Information Factory | **Ringler Informatik AG** ("eTax", used in 13+ cantons) |
| Entry point | local installer | `https://esteuern.lu.ch` |
| Launched | — | 2026-01-26 (for period 2025) |
| Data unit | `.lunp2024` ZIP file | server-side `datamodel` (declaration) |
| Interchange | `.lunp2024` file | can **import** `.lunp2024` from prior year |
| Training env | — | `https://schulen-lu.etax.ch/` (see §2.2) |

A 2025 desktop app still exists as a fallback (now from Ringler, not iFactory), but the web
platform is primary going forward.

---

## 2. eSteuern.LU web platform

### 2.1 Architecture

- **Frontend:** React single-page app, JS bundle at `/assets/index-*.js`.
- **Auth:** Keycloak (OpenID Connect) — bearer token on every backend call.
- **Backend:** REST under `/services/` prefix; all ops serialized per-document via op-queue.
- **Version observed:** `1.0.37` (training, 2026-06-22). Production was `1.0.33` earlier.
- **Group IDs** (selects form set / tax period):
  - `ch.np.lu.2025` — natürliche Personen (individuals), period 2025 ← **default**
  - `ch.jp.lu.2025` — juristische Personen (legal entities), period 2025
  - `ch.np.lu.2026`, `ch.jp.lu.2026` — period 2026
- **Additional paths:** `/delegation/` (sharing), `/documentHelp/` (help search).
- **Op queue:** requests per document are queued `concurrency=1` (no parallel ops on same doc).
  A `requestNumber` counter is maintained per doc, incremented before every call.

### 2.2 Authentication — CONFIRMED

Two separate credential sets are required:

| Credential | What it unlocks |
|---|---|
| Keycloak email + password | A Keycloak session / bearer token (needed for every API call) |
| PersID + Zugangscode eFiling | Creates/bootstraps a declaration (passed in `datamodel/create`) |

**These are completely independent.** The PersID and access code from the tax letter are NOT
Keycloak credentials. They are declaration parameters passed after a successful Keycloak login.

#### Keycloak (auth layer)

| | Production | Training |
|---|---|---|
| Keycloak base | `https://esteuern.lu.ch` | `https://schulen-lu.etax.ch` |
| Realm path | `/realms/eTax-LU` | `/realms/eTaxEDU-LU` |
| Client | `etax` | `eTaxEDU-LU` |
| Token endpoint | `…/protocol/openid-connect/token` | same pattern |
| Auth endpoint | `…/protocol/openid-connect/auth` | same pattern |
| OIDC discovery | `…/.well-known/openid-configuration` | confirmed live |

> **Note:** Keycloak is at the domain root (no `/auth/` prefix). Prior docs said
> `https://esteuern.lu.ch/auth` — that was wrong. Correct base is just the domain.

**Grant flow (confirmed from live capture):**

Authorization Code + PKCE (S256), `response_mode=fragment`:

```
GET /realms/eTaxEDU-LU/protocol/openid-connect/auth
  ?client_id=eTaxEDU-LU
  &redirect_uri=https://schulen-lu.etax.ch/
  &response_type=code
  &response_mode=fragment
  &scope=openid
  &code_challenge=<S256-challenge>
  &code_challenge_method=S256
  &state=<random>
  &nonce=<random>
```

Keycloak redirects back to the SPA with `#code=<code>&state=<state>` in the fragment. The SPA
then exchanges the code at the token endpoint using the PKCE verifier.

**Password grant alternative** (supported, useful for MCP server headless operation):

```
POST /realms/eTaxEDU-LU/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
&client_id=eTaxEDU-LU
&username=<email>
&password=<password>
```

Returns `{access_token, refresh_token, expires_in, …}`. The access token is a JWT bearer
sent as `Authorization: Bearer <token>` on all `/services/` calls.

**Training environment Keycloak accounts:** The training env (`schulen-lu.etax.ch`) requires
a registered Keycloak account (email + password). PersID/access-code values are
**declaration parameters** only — not Keycloak credentials. ⚠️ Training Keycloak account
creation path not yet confirmed (check for self-registration at
`/realms/eTaxEDU-LU/protocol/openid-connect/registrations`).

#### Declaration credentials (passed to `datamodel/create`)

Use only configured, operator-provided values. Do not commit real or training declaration
credentials to this repository.

| Profile | PersID (`PID`) | Zugangscode (`CODE`) |
|---|---|---|
| Single | `<trainingPersId>` | `<trainingAccessCode>` |
| Married | `<trainingPersId>` | `<trainingAccessCode>` |

### 2.3 Unauthenticated config endpoints — CONFIRMED

```
GET /config/config.json
→ {"appUrl":"/","defaultGroupId":"ch.np.lu.2025","delegation":true,
   "jpAppUrl":"/etax2/doc/","statusMessages":true,
   "supportedGroupIds":["ch.np.lu.2026","ch.jp.lu.2026","ch.np.lu.2025","ch.jp.lu.2025"]}

GET /config/keycloak.json
→ {"auth-server-url":"https://schulen-lu.etax.ch","realm":"eTaxEDU-LU","resource":"eTaxEDU-LU"}

GET /appinfo/versions.json
→ {"app":"1.0.37","backend":"1.0.37","print-server":"1.0.37","client":"1.0.37",
   "thumbnail-server":"1.6.1-edge","sr-server":"1.5.0-edge","pdfscanner-server":"1.3.5"}
```

### 2.4 Core declaration API (`/services/datamodel/*`) — CONFIRMED

All endpoints `POST` with JSON body. `requestNumber` increments per call per document.
All calls require `Authorization: Bearer <token>`.

#### Declaration lifecycle

| Method | Path | Request body |
|---|---|---|
| POST | `/datamodel/create` | `{modelId, parameters: {CODE?, PID?, FORMULARID?, NODUPCHECK?, NOPREVYEARIMPORT?, PREVYEAR_ID?, EASY?}}` |
| POST | `/datamodel/search` | `{groupId}` |
| POST | `/datamodel/load` | `{requestNumber, id, templateIds?, …}` |
| POST | `/datamodel/save` | `{id}` |
| POST | `/datamodel/close` | `{id}` |
| POST | `/datamodel/delete` | `{id}` |

#### Field reads and writes — CONFIRMED from live session

The **actual runtime endpoints** (observed in browser) differ from what JS bundle class names imply:

| Method | Path | Request body |
|---|---|---|
| POST | `/datamodel/entityScope` | `{id, templateIds, rootScopeId, language}` — **READ** all fields in a scope |
| POST | `/datamodel/update` | `{id, templateIds, rootScopeId, language, changes[]}` — **WRITE** one or more fields |

`update` **auto-commits** — no transaction wrapper needed. The response field `"inTransaction": false` confirms this.

`changes[]` entry format (type 1 = SET_VALUE, type 2 = INSERT list entry):
```json
{"domainPath": "/revenue/dependent/amount", "scopeId": "/revenue:0/dependent:0/", "value": 120000, "type": 1}
{"domainPath": "/revenue/dependent", "scopeId": "/revenue:0/", "currentScopeCount": 0, "type": 2,
 "request": {"onSuccess": {"action": "navigate-to-inserted", "templateId": "nplu-dependent-2025"}}}
```

The following v2 endpoints exist in the JS bundle but are **not used by the browser** in normal operation. They may be legacy or server-side only:

| Method | Path | Notes |
|---|---|---|
| POST | `/datamodel/startTransaction` | `{requestNumber, id}` — browser calls this but update auto-commits anyway |
| POST | `/datamodel/commit` | `{requestNumber, id}` |
| POST | `/datamodel/rollback` | `{requestNumber, id}` |
| POST | `/datamodel/v2/updateValue` | `{requestNumber, id, templateIds, templateValuePath, changes, skipDataResponse}` — older API |
| POST | `/datamodel/v2/domainDataForView` | `{requestNumber, id, templateIds, templateValuePath?}` — older API |
| POST | `/datamodel/v2/viewsByValuePath` | `{requestNumber, id, valuePath, mode}` |

#### Print (async, 3-step)

| Method | Path | Notes |
|---|---|---|
| POST | `/datamodel/print` | `{id, includeAttachments: true, language: "de", modelId: ""}` → returns `jobId` |
| GET | `/datamodel/printStatus/{jobId}` | Poll until complete |
| GET | `/datamodel/printResult/{jobId}` | Download PDF blob |

#### Submission (eFiling)

| Method | Path | Notes |
|---|---|---|
| POST | `/datamodel/submission` | `{id, includeAttachments: true, partialAttachmentSubmission, language: "de", modelId: ""}` |
| POST | `/datamodel/submissions` | `{id}` — list submissions for declaration |
| GET | `/datamodel/submittedDeclaration/{id}` | Download submitted declaration blob |
| GET | `/datamodel/submittedAttachments/{id}` | Download submitted attachments blob |
| GET | `/datamodel/submissionReceipt/{id}` | Download submission receipt blob |
| GET | `/datamodel/submissionArtifact/typeSubmissionTaxCalculationOutput/{id}` | Download tax calculation output |

**Confirmed write flow (from live browser capture):**

```
create      (modelId, PID, CODE)                    → docId
load        (docId)                                 → requestNumber seed
entityScope (docId, templateIds, rootScopeId)       → all fields + anchors in scope (READ)
update      (docId, templateIds, rootScopeId, changes[]) → auto-commit; returns changed fields
  └── insert a list entry first (type=2), then set values on the inserted scope (type=1)
save        (docId)                                 → {"OK": true}
print       (docId)                                 → jobId → poll printStatus → download printResult
submission  (docId)                                 → eFiling
```

> **No transaction wrapper needed for `update`** — calls are auto-committed.
> `calculated=true` entities are **server-derived** — never write them; read them back from the
> `entityScope` response after writing to get recomputed totals (e.g. `taxcalc2/residential/taxTotal`).
> See §3.3 for the legacy XML equivalents.

### 2.5 Import / export — CONFIRMED

| Method | Path | Notes |
|---|---|---|
| POST | `/lu-channel/import` | LU-specific import (e.g. `.lunp2024`) — **preferred** |
| GET | `/lu-channel/export` | LU-specific export — **preferred** |
| POST | `/import/package` | Generic import fallback |
| GET | `/export/package/{id}` | Generic export fallback |

The LU-specific paths are set by the app as overrides: `importDeclarationPath="/lu-channel/import"`,
`exportDeclarationPath="/lu-channel/export"`. These replace the generic `/import/package` and
`/export/package` defaults from the base service class.

Import multipart body: `data=<file>`, `meta=JSON({PID, CODE, ...createDocumentParams})`.

### 2.6 Attachments, document scanning, SnapShare — CONFIRMED

| Method | Path | Request / notes |
|---|---|---|
| POST | `/attachment/v2/{id}` | Upload attachment to declaration `id` |
| GET | `/attachment/v2/content/{attachId}?ref={n}` | Download attachment content (blob) |
| GET | `/attachment/thumbnail/{id}/{attachId}` | Thumbnail for attachment |
| POST | `/pdfscanner/upload` | Upload PDF for OCR (multipart) → returns `jobId` |
| GET | `/pdfscanner/status/{jobId}?seq={requestNumber}` | Poll scanner job status |
| POST | `/pdfscanner/importJob` | `{dmId, jobId, importerId, anchorPath}` → import scanned values |
| POST | `/snap/v2/create` | Create SnapShare QR code (mobile document hand-off) |

The `pdfscanner` + `importJob` pair is useful for the agent: upload a Lohnausweis / bank
statement → poll status → get structured values → write via `updateValue`.
⚠️ Capture the `importJob` response schema and the set of valid `importerId`s.

### 2.7 Templates & help

| Method | Path | Notes |
|---|---|---|
| GET | `/v2/templates/menu/{menuId}` | Load form templates by menu ID |
| POST | `/documentHelp/searchQuery` | `{queryStr, menuId}` — search help docs |
| GET | `/documentHelp/menu/{menuId}` | Load help doc for menu |

### 2.8 Session

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/keepalive` | Keep session alive. SPA calls every 30 s. |
| POST | `/auth/logout` | Log out |

### 2.9 Delegation (sharing)

All under `/delegation/` base (not `/services/`):

| Method | Path | Notes |
|---|---|---|
| GET | `/user` | Get delegation user profile |
| POST | `/delegation/invitation/new` | Send sharing invitation |
| POST | `/delegation/invitation/info` | `{lang, requestId}` |
| POST | `/delegation/invitation/send-sms` | `{lang, requestId}` |
| POST | `/delegation/invitation/accept` | `{lang, requestId, "sms-code"}` |
| POST | `/delegation/invitation/decline` | `{lang, requestId}` |
| POST | `/delegation/invitation/search` | `{lang, subjectId, subjectType: "declaration"}` |
| POST | `/shares/my/search` | `{lang, subjectId}` |
| POST | `/shares/my/all` | `{lang}` |
| POST | `/shares/my/delete` | `{subjectId, subjectType, trusteeId}` |
| POST | `/shares/given/search` | `{lang, subjectId}` |
| POST | `/shares/given/all` | `{lang}` |
| POST | `/shares/given/delete` | `{ownerId, subjectId, subjectType}` |

### 2.10 Confirmed JSON response shapes (live capture 2026-06-22)

All captured against training env `https://schulen-lu.etax.ch` and redacted to preserve
response shape without storing taxpayer data.

#### `POST /services/datamodel/search`

```json
{
  "limit": -1, "taxYear": 2025, "OK": true,
  "values": [{
    "id": "<docId>",
    "model": "com.riag.ch.np.lu.2025.1",
    "createdBy": "<email>",
    "createdAt": "2026-06-22T09:16:07.840Z",
    "lastModified": "2026-06-22T09:16:07.840Z",
    "submissions": 0,
    "metaData": {
      "lastName": "<name>", "firstName": "<name>", "fullName": "<name>",
      "taxMunicipality": "<municipality>", "birthDate": "<birthDate>",
      "ahvNumber": "<ahvNumber>", "taxId": "<trainingPersId>", "taxYear": 2025.0,
      "addressLines": ["<address>"],
      "accessCodeSha256": "<accessCodeSha256Prefix>..."
    },
    "permissions": {
      "canRead": true, "canWrite": true, "canDelete": true,
      "canSubmit": true, "canGrant": true, "owner": true
    }
  }]
}
```

#### `POST /services/datamodel/create` (with `NOPREVYEARIMPORT`)

```json
{"id": "<docId>", "modelId": "com.riag.ch.np.lu.2025.1", "incomplete": false, "OK": true}
```

Without `NOPREVYEARIMPORT`: `"incomplete": true` with `additionalData` (MODEL_ID, STEUERPERIODE, SWISS_DOMICILE, …).

#### `POST /services/datamodel/load`

```json
{"id": "<docId>", "modelId": "com.riag.ch.np.lu.2025.1", "OK": true, "requestNumber": 2}
```

`requestNumber` starts at 2 for a fresh declaration (seed for `startTransaction`/`commit`/`rollback` calls).

#### `POST /services/datamodel/save`

```json
{"OK": true}
```

#### `POST /services/datamodel/entityScope` — READ endpoint

**Request:**
```json
{
  "id": "<docId>",
  "templateIds": ["nplu-dependent-2025", "nplu-common-2025"],
  "rootScopeId": "/revenue:0/dependent:0/",
  "language": "de"
}
```

No `requestNumber` required.

**Response** (top-level keys: `dto`, `id`, `modelId`, `consistency`, `OK`):

```json
{
  "dto": {
    "rootScopeId": "/revenue:0/dependent:0/",
    "inTransaction": false,
    "entities": [
      {"value": "main", "calculated": false, "overriden": false, "noRounding": false,
       "enumeration": ["main","sideline","simplified"],
       "domainPath": "/revenue/dependent/type",
       "scopeId": "/revenue:0/dependent:0/", "active": true, "enabled": true, "type": "string"},
      {"calculated": false, "overriden": false, "noRounding": false,
       "domainPath": "/revenue/dependent/salesman",
       "scopeId": "/revenue:0/dependent:0/", "active": true, "enabled": true, "type": "boolean"},
      {"value": "<employer>", "calculated": false, "overriden": false, "noRounding": false,
       "domainPath": "/revenue/dependent/description",
       "scopeId": "/revenue:0/dependent:0/", "active": true, "enabled": true, "type": "string"},
      {"value": 120000, "calculated": false, "overriden": false, "noRounding": false,
       "domainPath": "/revenue/dependent/amount",
       "scopeId": "/revenue:0/dependent:0/", "active": true, "enabled": true, "type": "decimal"},
      {"value": 21478.90, "calculated": true, "overriden": false, "noRounding": false,
       "domainPath": "/taxcalc2/residential/taxTotal",
       "scopeId": "/taxcalc2:0/residential:0/", "active": true, "enabled": false, "type": "decimal", "id": "taxTotal"},
      {"value": "<name>", "calculated": true, "overriden": false, "noRounding": false,
       "domainPath": "/personalData/p1/fullName",
       "scopeId": "/personalData:0/p1:0/", "active": true, "enabled": true, "type": "string", "id": "p1-fullName"},
      {"scopeIds": [], "scopes": [],
       "domainPath": "/revenue/dependent/anchorLink",
       "scopeId": "/revenue:0/dependent:0/", "active": true, "enabled": true, "type": "list"}
      // … 21 entities total for nplu-dependent-2025 scope
    ],
    "enumValues": [],
    "attachments": [],
    "anchors": [
      {"id": "anchorLohnausweis", "modalityType": "MANDATORY",
       "anchorPath": "/revenue/dependent/anchorLink", "enabled": false,
       "description": "Lohnausweis Haupterwerb <name> - <employer>", "sort": "10", "fields": []},
      {"id": "anchorJobexpensesP1", "modalityType": "OPTIONAL",
       "anchorPath": "/jobexpenses/personal/anchorLinkP1", "enabled": false,
       "description": "Berufsauslagen <name>", "sort": "1045", "fields": []},
      {"id": "anchorAccomodationOfPayment", "modalityType": "OPTIONAL",
       "anchorPath": "/miscellaneous/accomodationOfPaymentAnchorLink", "enabled": false,
       "description": "Zahlungserleichterung/Steuererlass", "sort": "2020", "fields": []},
      {"id": "anchorNonCategorized", "modalityType": "OPTIONAL",
       "anchorPath": "/miscellaneous/othersAnchorLink", "enabled": false,
       "description": "Sonstiges / ohne Kategorie", "sort": "999999", "fields": []}
    ]
  },
  "id": "<docId>",
  "modelId": "com.riag.ch.np.lu.2025.1",
  "consistency": [
    {"scopeId": "/personalData:0/taxablePerson:0/",
     "path": "/personalData/taxablePerson/religionReq",
     "messageText": "Konfession des/der Steuerpflichtigen fehlt.",
     "severity": 0, "valid": false, "sortingKey": "__case__0",
     "affectedDataIds": [{"itemId": "religion", "scopeId": "/personalData:0/taxablePerson:0/"}]},
    {"scopeId": "/personalData:0/taxablePerson:0/",
     "path": "/personalData/taxablePerson/pensionskasseReq",
     "messageText": "Zahlungen an die 2. Säule des/der Steuerpflichtigen fehlt.",
     "severity": 0, "valid": false, "sortingKey": "__case__1",
     "affectedDataIds": [{"itemId": "secondPillarPayed", "scopeId": "/personalData:0/taxablePerson:0/"}]}
    // … 4 consistency entries total
  ],
  "OK": true
}
```

Entity field notes:
- `type`: `"string"` | `"boolean"` | `"decimal"` | `"list"` | `"date"` | `"integer"`
- `enumeration`: present on enum fields; lists allowed values
- `calculated: true` = server-derived, do not write
- `active: false` = field is inactive/not applicable in current context (e.g., single-person field on a solo declaration)
- `list` type entities have `scopeIds` + `scopes` arrays instead of a `value`
- Anchors with `modalityType: "MANDATORY"` require an attachment before submission
- `consistency` entries with `severity: 0` = blocking error; `severity: 1` = warning

#### `POST /services/datamodel/update` — WRITE endpoint

**Request (SET_VALUE, type=1):**
```json
{
  "id": "<docId>",
  "templateIds": ["nplu-dependent-2025", "nplu-common-2025"],
  "rootScopeId": "/revenue:0/dependent:0/",
  "language": "de",
  "changes": [{
    "domainPath": "/revenue/dependent/amount",
    "scopeId": "/revenue:0/dependent:0/",
    "value": 120000,
    "type": 1
  }]
}
```

String value: `"value": "<employer>"` (string). Numeric value: `"value": 120000` (number, not string).
No `requestNumber` required.

**Request (INSERT list entry, type=2):**
```json
{
  "id": "<docId>",
  "templateIds": ["nplu-work-2025", "nplu-common-2025"],
  "rootScopeId": "/",
  "language": "de",
  "changes": [{
    "domainPath": "/revenue/dependent",
    "scopeId": "/revenue:0/",
    "currentScopeCount": 0,
    "type": 2,
    "request": {"onSuccess": {"action": "navigate-to-inserted", "templateId": "nplu-dependent-2025"}}
  }]
}
```

INSERT response includes `"changeResults": [{"scopeId": "/revenue:0/dependent:0/"}]` — the new scope ID.

**Response** (top-level keys: `changeResults`, `dto`, `modelId`, `events`, `consistency`, `OK`):

```json
{
  "changeResults": [{}],
  "dto": {
    "rootScopeId": "/revenue:0/dependent:0/",
    "inTransaction": false,
    "entities": [
      {"value": 120000, "calculated": false, "overriden": false, "noRounding": false,
       "domainPath": "/revenue/dependent/amount",
       "scopeId": "/revenue:0/dependent:0/", "active": true, "enabled": true, "type": "decimal"}
      // Only changed + recomputed dependent entities — NOT the full scope
    ],
    "enumValues": [],
    "attachments": [],
    "anchors": [/* same structure as entityScope */]
  },
  "modelId": "com.riag.ch.np.lu.2025.1",
  "events": [],
  "consistency": [/* same structure as entityScope */],
  "OK": true
}
```

Key differences from `entityScope`:
- `dto.entities` contains **only the changed field + its recomputed dependents** (not the full scope).
  After setting `amount=120000`, both `amount` and the recomputed `taxcalc2/residential/taxTotal` appear.
- `events` is an array (empty `[]` for simple value writes; may be non-empty for structural changes).

#### `GET /services/datamodel/domainModel/com.riag.ch.np.lu.2025.1`

```json
{
  "domainModelId": "com.riag.ch.np.lu.2025.1",
  "anchorModelV1": false, "anchorModelV2": true,
  "defaultLanguage": "de", "supportedLanguages": ["de", "en", "fr"]
}
```

#### Menu `templateIds` observed in browser navigation

Always include `nplu-common-2025` alongside the section-specific template in `entityScope` and `update` calls.

| templateId | Section |
|---|---|
| `nplu-main-2025` | Main overview |
| `nplu-summary-new-2025` | Preview & submit |
| `nplu-person-household-2025` | Persons & household |
| `nplu-work-2025` | Work (Arbeit) — parent; use for INSERT |
| `nplu-insurance-2025` | Insurance & pension |
| `nplu-finance2-2025` | Finances |
| `nplu-asset-2025` | Property & assets |
| `nplu-other-2025` | Other (Sonstiges) |
| `nplu-dependent-2025` | Employed income sub-form |
| `nplu1-menu-2025` | Side menu |
| `nplu-common-2025` | **Always included as a base templateId** |

#### `rootScopeId` and `scopeId` conventions

- Root declaration scope: `"/"`
- List entry scope: `"/{list}:{index}/"` e.g. `"/revenue:0/"`, `"/revenue:0/dependent:0/"`
- `rootScopeId` in requests = the context scope; `scopeId` in each entity = the entity's own scope
- After INSERT (type=2) the new entry's scopeId is returned in `changeResults`

#### URL fragment structure (for navigation reference)

```
https://schulen-lu.etax.ch/etax/#doc/{docId}/{templateId}/{encodedScopeId}/{step}
```

Example: `#doc/<docId>/nplu-dependent-2025/%2Frevenue%3A0%2Fdependent%3A0%2F/0`

---

## 3. `.lunp2024` file format (interchange / legacy)

A real submitted declaration was dissected; test fixtures live in `test-import/`. The three
key config files have been extracted to `config/` from the installed 2024 desktop app JARs
(see §3.5).

### 3.1 Container

`.lunp2024` is a plain **ZIP archive**:

```
artifacts/taxcase.LUnP2024            # XML data model (~836 KB, 9,860 fields)
artifacts/taxcase.LUnP2024.sign       # signature over the XML (88 bytes, base64)
taxcase.LUnP2024.meta                 # JSON metadata (see §3.2)
taxcase.LUnP2024.meta.sign            # signature over the meta
annexes/<name>.pdf                    # uploaded supporting documents
annexes/<name>.pdf.sign               # signature per annex (88 bytes)
```

Every signed payload has a sibling `.sign` (88-byte base64 — looks like a 64-byte raw
signature). ⚠️ The signing key/algorithm is unknown; whether the app **validates** signatures
on import is open. Test fixtures in `test-import/` (no_sign / dummy_sign / orig_sign) were
built to answer this — run `create_test_files.py` output through the app to confirm.

### 3.2 `taxcase.LUnP2024.meta` (JSON)

```jsonc
{
  "metaVersion": "LUnP2024",
  "applicationYear": 2024,
  "productYear": 2024,
  "metadataName": "taxcase.LUnP2024.meta",
  "annexesContainerName": "annexes",
  "artifactsContainerName": "artifacts",
  "lastChangeUser": "<user>",
  "creationDate": 1754400510.589,        // epoch seconds (float)
  "lastChangeDate": 1775123933.048,
  "productIdentifier": "<productIdentifier>",
  "productOwner": "<name>",
  "productStatus": "IN_PROGRESS",         // e.g. IN_PROGRESS, SUBMITTED_ONLINE
  "submissionDate": null,
  "productSubtype": null,
  "remarks": null,
  "artifacts": [
    { "artifactType": "PRODUCT_BIN", "name": "taxcase.LUnP2024",
      "size": 836166, "mimeType": "application/octet-stream", "creationDate": … }
  ],
  "annexes": [
    { "name": "<annexName>.pdf", "type": "WAGESTATEMENT", "source": "OBEAM",
      "size": 566976, "mimeType": "application/pdf", "creationDate": …,
      "lastChangeDate": …, "annexOwner": null, "description": null, "signature": null }
    // …
  ]
}
```

**Annex `type` enum** (observed): `WAGESTATEMENT`, `WAGESTATEMENT_EXTRAS`, `COLUMN_3A`
(Säule 3a), `INSURANCE_PREMIUMS`, `SECURITES` *(sic — misspelled in the format)*, `OTHER`.

**Annex `source` enum** (observed): `UPLOAD` (user-uploaded), `OBEAM` (generated by the app,
e.g. the rendered Wertschriftenverzeichnis / Lohnausweis forms).

### 3.3 Data model XML (`artifacts/taxcase.LUnP2024`)

```xml
<?xml version='1.0' encoding='UTF-8'?>
<data majorVersion="LUnP2024" minorVersion="3">
<group>
  <context>{}</context>
  <integer id="STES1_353AnzKindEigen_BASE" calculated="true"><value>1100</value></integer>
  <boolean id="STES3_EinkomVeraendErwartet"><value>false</value></boolean>
  <float   id="CALC_Steuereinheit" enabled="false"><value>3.25</value></float>
  <string  id="WVS4_Bank"><value>Hypothekarbank Lenzburg AG</value></string>
  <date    id="FK_KrankKind3Datum0"></date>
  <text    id="…">…</text>
  <list    id="listOfSecurities" uidMaxSeq="52">
     <entry>{listOfSecurities=0}</entry>
     <entry>{listOfSecurities=1}</entry>
  </list>
  <dictionary id="dialogStatusMap" valueType="BOOLEAN">
     <entry key="listOfSecurities.visited">true</entry>
  </dictionary>
</group>
</data>
```

A single flat `<group>` of **9,860 typed fields**. An empty element = unset value.

**Field element types & counts:**

| Element | Count | Notes |
|---|---:|---|
| `string` | 3,065 | free text; also enum-ish codes (`STES1_StKonf` = `other`) |
| `boolean` | 2,403 | `true` / `false` |
| `integer` | 1,993 | CHF amounts, counts |
| `float` | 1,784 | rates, factors |
| `date` | 481 | |
| `list` | 79 | repeating tables; entries reference rows by index |
| `text` | 53 | multi-line text |
| `dictionary` | 2 | key→value maps (wizard/UI state) |

**Attribute flags** (UI/computation metadata carried with each field):

| Flag | Count | Meaning |
|---|---:|---|
| `calculated="true"` | 3,254 | **server-/engine-derived — do not write**; read for totals |
| `enabled="false"` | 1,591 | not editable in current context |
| `visible="false"` | 1,113 | hidden in current context |

**ID naming convention** — `PREFIX_CamelCaseName`. Major prefixes (CALC_/MAX_/MIN_ and the
`TAXABLE_/FEDERAL_/CANTONAL_` families are computed results):

| Prefix | ~count | Area |
|---|---:|---|
| `AB_` | 1,325 | **Securities row columns** (Wertschriften/Anlage rows — see §3.4) |
| `WVS2_`,`WVS1_`,`WVS3_`,`WVS4_`,`WV2_`,`WV3_`,`WVLG_` | ~510 | Wertschriftenverzeichnis (securities directory) |
| `STES1_`–`STES4_` | ~220 | Steuererklärung main pages (income, deductions, totals) |
| `FK_` | 78 | Krankheits-/Behinderungskosten (medical/disability costs) |
| `BAEF_`,`HVEF_`,`HVST_`,`BAST_` | ~180 | Berufsauslagen / Liegenschafts-/Unterhaltskosten (job & property expenses) |
| `UB_` | 40 | Unterstützungs-/Kinderbeiträge (support/child contributions) |
| `KU1_`,`KU2_` | ~40 | Kurkosten / similar |
| `DA_`,`DA1_` | ~45 | Form DA (Verrechnungssteuer / DA-1, foreign withholding) |
| `VB_` | 26 | Versicherungsbeiträge (insurance premiums) |
| `CALC_` | 22 | computed intermediate values |
| `personData_…` | — | identity, e.g. `personData_accessCode` |

> Examples of computed totals worth reading back: `STES3_NettoEinkommenBund` (net income,
> federal), `MAX_DEDUCTION_COLUMN_3A` (35280), `BAST_PauschalMax` (4000),
> `STES1_VBAbzugAMitBund` (3600).

### 3.4 Repeating tables (securities example)

The securities directory is the richest table and the most relevant for crypto/foreign assets.

- `<list id="listOfSecurities" uidMaxSeq="52">` holds N `<entry>{listOfSecurities=i}</entry>`
  rows. Other security lists: `securityList_FormAB`, `securityList_FormDA`,
  `securityList_RevenueDetail`, `securityList_AdditionDivestitureDetail`.
- Each **row's columns** use the `AB_*` fields, including:

| Field | Meaning |
|---|---|
| `AB_Description` | security name / description |
| `AB_Isin`, `AB_ValorNumber`, `AB_AccountNumber` | identifiers |
| `AB_OriginalCurrency` | currency |
| `AB_FaceValueQuantity` | quantity / nominal |
| `AB_TaxValueBase`, `AB_TaxValueEndOfYear` | wealth value (Vermögen) at 31.12 |
| `AB_GrossRevenue`, `AB_GrossRevenueRubricA`, `AB_GrossRevenueRubricB` | income (Rubrik A = mit VST, B = ohne) |
| `AB_InterestRate`, `AB_Redemption`, `AB_Issue` | bond fields |
| `AB_AdditionDivestitureDate/Quantity/Reason` | purchases/sales during year |
| `AB_Code`, `AB_Kind`, `AB_Rubric`, `AB_RowType`, `AB_Owner`, `AB_isDBEntry` | classification/ownership |

> **Crypto mapping (user-specific, see project memory):** ICP neurons / SNS tokens are entered
> as securities rows — wealth at spot 31.12 in `AB_TaxValue*`, dissolving-maturity income in
> `AB_GrossRevenue*` (Rubrik B / ohne Verrechnungssteuer), with Koinly/NNS PDFs as `SECURITES`
> annexes. There is no native crypto/neuron concept in the model.

### 3.5 Config files — EXTRACTED ✓

All three files are now in `config/` (extracted from the installed 2024 desktop app at
the installed 2024 desktop app JARs):

| File | Size | Content |
|---|---|---|
| [`config/model.xml`](config/model.xml) | 503 KB / 11,188 lines | Complete field definitions (types, defaults, calc rules) |
| [`config/entity-labels.properties`](config/entity-labels.properties) | 80 KB | German labels per field ID |
| [`config/scantax.xml`](config/scantax.xml) | 64 KB | Field-ID → printed-form position mapping |

These give a near-complete schema + i18n dictionary for the 2025 web model (field IDs are
shared between the 2024 file format and the 2025 web platform).

---

## 4. Mapping to an MCP server

### 4.1 Recommended architecture: web platform + offline catalogue

**Decision (recommended):** Drive the web platform live. The web API is primary; `.lunp` file
generation is only needed if you want to import into the desktop fallback. The agent loop is:
auth → create/load declaration → updateValue fields → commit → save → print/submit.

For offline use (no auth session): parse and modify `.lunp2024` files locally and import via
`/lu-channel/import`. This requires resolving the `.sign` validation question (§5).

### 4.2 Auth strategy for MCP server

The Keycloak **password grant** is supported and is the cleanest headless option:

```python
token = requests.post(
    "https://esteuern.lu.ch/realms/eTax-LU/protocol/openid-connect/token",
    data={"grant_type": "password", "client_id": "etax",
          "username": keycloak_email, "password": keycloak_password}
).json()["access_token"]
```

Then pass PersID + access code to `datamodel/create` as declaration parameters — not as auth.

### 4.3 Proposed tools

**Session / lifecycle**
- `list_declarations(groupId)` → `/datamodel/search`
- `create_declaration(groupId, prevYearId?)` → `/datamodel/create` with configured declaration credentials
- `load_declaration(id)` → `/datamodel/load`

**Read / write fields** (the core loop)
- `get_scope(id, templateIds, rootScopeId)` → `entityScope`; returns all entities + anchors + consistency
- `set_field(id, templateIds, rootScopeId, domainPath, scopeId, value)` → `update` (type=1); auto-commits; refuses `calculated` entities; returns recomputed dependents
- `insert_list_entry(id, templateIds, parentScopeId, domainPath, currentScopeCount)` → `update` (type=2); returns new scopeId
- `search_fields(query)` → resolve human intent → domainPath (backed by §2.10 entity listing + §3.5 label dictionary)

**Documents**
- `upload_attachment(id, file, annex_type)` → `/attachment/v2/{id}`
- `scan_document(id, file)` → `pdfscanner/upload` + poll `pdfscanner/status` + `pdfscanner/importJob`

**Securities table** (high value for this user)
- `add_security(id, {description, isin, taxValueEndOfYear, grossRevenue, …})` → append row
- `list_securities(id)` / `update_security(id, rowIndex, …)` / `delete_security(id, rowIndex)`

**Output**
- `print_declaration(id)` → `/datamodel/print` → poll `printStatus` → download `printResult`
- `submit_declaration(id)` → `/datamodel/submission`
- `export_lunp(id)` / `import_lunp(id, file, pers_id, code)` → `/lu-channel/*`

**Design notes**
- Keep a **local field catalogue** (from §3.5 `model.xml` + `entity-labels.properties`) so the
  agent maps "net wealth" → `AB_TaxValueEndOfYear` without round-tripping the server.
- Treat `calculated`/`enabled=false`/`visible=false` flags as guardrails: never write calculated
  fields; surface visibility so the agent knows which inputs are in scope.
- `requestNumber` is only needed for the legacy `startTransaction`/`commit`/`rollback` endpoints — not for `update` or `entityScope`. Seed it from the `load` response if calling those legacy ops.
- Schedule keepalive every 30 s (`POST /services/auth/keepalive`) during active sessions.
- Privacy: field IDs + amounts may go to cloud LLMs but **PII must be pseudonymized**. The MCP
  layer is the right place to enforce that boundary.

---

## 5. What's verified vs. what's assumed

| Verified ✓ | Still open ⚠️ |
|---|---|
| `.lunp2024` ZIP layout, meta JSON, annex enums | Whether import validates `.sign` signatures (test fixtures unrun) |
| XML field model: 9,860 fields, types, flags, prefixes | Valid `importerId` values for `pdfscanner/importJob` |
| `AB_*` securities columns, `listOfSecurities` structure | Training Keycloak account self-registration path (confirmed works — path TBD) |
| Auth: Authorization Code + PKCE (S256), `response_mode=fragment` | `viewsByValuePath` `mode` parameter values |
| Auth: password grant also supported (headless option) | `submittedDeclaration` / `submissionReceipt` response formats |
| PersID + code = declaration params, NOT Keycloak credentials | `pdfscanner/status` + `pdfscanner/importJob` response shapes |
| Keycloak base at domain root (no `/auth/` prefix) | `print` → `printStatus` → `printResult` full async flow |
| Token endpoint: `/realms/{realm}/protocol/openid-connect/token` | |
| All `/services/datamodel/*` endpoint paths + request bodies | |
| **Real write endpoint: `POST /datamodel/update` (NOT `v2/updateValue`)** | |
| **Real read endpoint: `POST /datamodel/entityScope` (NOT `domainDataForView`)** | |
| **`update` auto-commits — no startTransaction/commit needed** | |
| **`update` + `entityScope` do not require `requestNumber`** | |
| **Full `entityScope` response shape** (entities, anchors, consistency) — see §2.10 | |
| **Full `update` response shape** (changeResults, entities, events, consistency) — see §2.10 | |
| **`save` response shape**: `{"OK": true}` | |
| **`consistency` array structure** (validation errors per field) | |
| **Anchor structure** (id, modalityType, anchorPath, enabled, description, sort, fields) | |
| **Computed fields returned immediately** in `update` response (e.g. taxTotal=21478.90 CHF) | |
| Print is async (print → printStatus poll → printResult download) | |
| Export: `GET /services/lu-channel/export`, Import: `POST /services/lu-channel/import` | |
| Generic fallback: `/export/package/{id}`, `/import/package` | |
| Config files extracted to `config/` (model.xml, entity-labels, scantax.xml) | |
| App version 1.0.37, versions endpoint confirmed | |
| `config.json` + `keycloak.json` response shapes confirmed | |
| Delegation API under `/delegation/` (separate from `/services/`) | |
| Keepalive fires every 30 s | |
| All menu templateIds for 2025 form sections | |

---

## 6. Next steps

To build a callable MCP server, in priority order:

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

2. **Confirm `.sign` validation** — run `test-import/create_test_files.py` output through the
   desktop app (import the no_sign and dummy_sign variants). If signatures are ignored on import,
   you can freely generate `.lunp` files without a signing key.

3. **Capture print flow** — trigger a print from the training env and capture `print` → `printStatus`
   → `printResult` response shapes.

4. **Resolve `importerId` values** — needed to use the PDF scanner feature. Capture from a live
   session when first using Lohnausweis OCR.
