# Luzern eTax MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI agents explore and fill out **Kanton Luzern** tax declarations on the [eSteuern.LU](https://esteuern.lu.ch) platform (Ringler eTax).

> ⚠️ **Unofficial experiment.** This is a personal, experimental project. It is not an official product and is not affiliated with, endorsed by, or supported by Kanton Luzern, Ringler Informatik AG, or eSteuern.LU. Use it at your own risk.

It exposes two things over the Model Context Protocol:

- **An offline field catalogue** — search and inspect every field in the Luzern declaration (German labels, IDs, printed-form positions) with no credentials and no network access.
- **Live declaration tools** — log in, create or open a declaration, read and write fields, save, and generate a review PDF against the training or production environment.

## Quick start

```sh
npm install
npm test        # run the test suite
npm start       # start the MCP server
```

The server listens on `http://127.0.0.1:3000/mcp` using the MCP streamable HTTP transport. Override the bind address with the `HOST` and `PORT` environment variables.

## Connect an agent

Point any MCP client at the running server. For example, in an MCP client config:

```json
{
  "mcpServers": {
    "luzern-etax": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

The offline catalogue tools work immediately. The live tools need credentials (see [Configuration](#configuration)) and an explicit `environment` argument — `training` or `production` — on every call.

## Tools

### Offline catalogue — no credentials, no network

| Tool | Purpose |
| --- | --- |
| `search_fields` | Search the field catalogue by keyword |
| `get_field` | Look up a single field by its ID |

These read from `config/model.xml`, `config/entity-labels.properties`, and `config/scantax.xml`. Duplicate label keys are surfaced as catalogue diagnostics rather than silently dropped.

### Live declaration — eSteuern.LU

| Tool | Purpose |
| --- | --- |
| `list_declarations` | List declarations visible to the configured login |
| `create_declaration` | Create a declaration using the configured declaration credentials |
| `load_declaration` | Open a declaration (normally automatic; useful for diagnostics) |
| `get_scope` | Read a runtime scope of field values |
| `set_field` | Update one field after catalogue and scope checks |
| `insert_list_entry` | Insert a list entry after checking the parent scope |
| `save_declaration` | Save the current draft (this is **not** submission) |
| `print_declaration` | Generate a review-PDF job |

`set_field` and `insert_list_entry` validate the runtime scope before writing. `print_declaration` returns job metadata by default; PDFs can contain taxpayer data and are not written into the repository.

## Configuration

The live tools authenticate with two independent credential sets, supplied as environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `ETAX_LOGIN_EMAIL` | yes | Keycloak login email |
| `ETAX_LOGIN_PASSWORD` | yes | Keycloak login password |
| `ETAX_DECLARATION_PERS_ID` | yes | PersID from the tax letter (for `create_declaration`) |
| `ETAX_DECLARATION_ACCESS_CODE` | yes | Zugangscode eFiling from the tax letter |
| `ETAX_DECLARATION_ID` | no | Pin a declaration so editing tools can omit `id` |
| `ETAX_LANGUAGE` | no | Declaration language; defaults to `de` |

Credentials are read from the environment only — never pass logins, PersIDs, or access codes as tool arguments.

### Environments

| `environment` | Base URL |
| --- | --- |
| `training` | `https://schulen-lu.etax.ch` |
| `production` | `https://esteuern.lu.ch` |

This version is optimized for a single configured taxpayer and an optional configured declaration.

## Privacy

This repository must stay free of real tax data. Do not commit declarations, annex PDFs, credentials, access codes, bearer tokens, declaration IDs, AHV numbers, or any taxpayer PII. Generated `.lunp2024` archives are git-ignored and should be treated as sensitive local artifacts unless built entirely from synthetic input.

## Scope

Submission, export, attachment upload, browser OAuth, durable token storage, multi-taxpayer operation, and full `.lunp2024` import/export are intentionally out of scope.

## License

[MIT](LICENSE) © Dominic Wörner
