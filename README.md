# Luzern Tax MCP Notes

This repository contains reverse-engineered notes, extracted configuration, and implementation plans for a local MCP server that works with Luzern tax declarations.

## Privacy

Do not commit real tax declarations, annex PDFs, credentials, access codes, bearer tokens, declaration IDs, AHV numbers, or taxpayer PII. Generated `.lunp2024` archives are ignored and should be treated as local sensitive artifacts unless they were created from fully synthetic inputs.

## Setup

```sh
npm install
npm run typecheck
npm test
```

`npm run lint` currently runs the same strict TypeScript check as `typecheck`; no formatter is configured for this spike.

## Offline Catalogue

The `search_fields` and `get_field` MCP tools work locally from:

- `config/model.xml`
- `config/entity-labels.properties`
- `config/scantax.xml`

They do not require credentials or network access. Duplicate label keys are reported as catalogue diagnostics instead of being silently hidden.

## Running The MCP Server

```sh
npm start
```

By default the server listens on `http://127.0.0.1:3000/mcp` using the current MCP streamable HTTP transport. Override with `HOST` and `PORT`.

Network tools require an explicit `environment` argument: `training` or `production`. The first version is optimized for one configured taxpayer and an optional configured declaration.

Environment variables for network use:

- `ETAX_LOGIN_EMAIL`
- `ETAX_LOGIN_PASSWORD`
- `ETAX_DECLARATION_PERS_ID`
- `ETAX_DECLARATION_ACCESS_CODE`
- `ETAX_DECLARATION_ID` optional; lets editing tools omit `id`
- `ETAX_LANGUAGE` optional; defaults to `de`

`create_declaration` uses configured declaration credentials. Do not pass PersID or access codes as tool arguments.

## Implemented Tools

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

`set_field` and `insert_list_entry` check the runtime scope before calling `datamodel/update`. `print_declaration` returns job metadata by default; downloaded PDFs can contain taxpayer data and are refused inside the repository.

## Not Implemented

Submission, export, attachment upload, browser OAuth, durable token storage, multi-taxpayer operation, and full `.lunp2024` import/export support are intentionally outside this spike.
