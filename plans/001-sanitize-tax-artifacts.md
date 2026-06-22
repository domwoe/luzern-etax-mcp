# Plan 001: Sanitize tax artifacts before implementation

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: This directory was not a Git repository when the plan was written, so there is no commit SHA to diff against. Run `ls -la && find . -maxdepth 3 -type f | sort` and compare the in-scope files below against the "Current state" section. If any listed file is missing or structurally different, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: `no-git-baseline`, 2026-06-22

## Why this matters

This repo contains reverse-engineered tax API notes and generated `.lunp2024` fixtures derived from a real tax declaration. The fixture generator copies the source declaration XML, metadata, and annex PDFs into repo-local archives. Before an MCP server spike exists, the repo needs a privacy boundary: documentation examples must be synthetic or redacted, generated archives must not contain real tax data, and the helper must make unsafe fixture generation hard to do accidentally.

## Current state

- `KANTON_LUZERN_TAX_API.md` contains the reverse-engineered API notes and live captured response examples.
- `test-import/create_test_files.py` generates three `.lunp2024` variants from a machine-local source declaration.
- `test-import/test_no_sign.lunp2024`, `test-import/test_dummy_sign.lunp2024`, and `test-import/test_orig_sign.lunp2024` are ZIP archives currently present in the repo.
- `config/model.xml`, `config/scantax.xml`, and `config/entity-labels.properties` are extracted configuration inputs and are not the privacy problem by themselves.

Relevant current excerpts:

```python
# test-import/create_test_files.py:23-24
SOURCE = Path.home() / "Documents" / "Steuerfälle" / "Steuererklärung_2024.lunp2024"
OUTDIR = Path.home() / "Dev" / "projects" / "tax" / "test-import"
```

```python
# test-import/create_test_files.py:105-110
# Include annexes (without sign files for simplicity, except in orig variant)
for entry_name in contents:
    if entry_name.startswith("annexes/") and not entry_name.endswith(".sign"):
        zf.writestr(entry_name, contents[entry_name])
    elif include_signs == 'original' and entry_name.startswith("annexes/") and entry_name.endswith(".sign"):
        zf.writestr(entry_name, contents[entry_name])
```

```markdown
# KANTON_LUZERN_TAX_API.md:289-292
### 2.10 Confirmed JSON response shapes (live capture 2026-06-22)

All captured against training env ..., declaration ...
```

Do not copy personal values from the current files into issues, commits, plans, comments, or test names.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Inventory | `find . -maxdepth 3 -type f | sort` | Lists only expected repo files plus any newly added safe files |
| XML sanity | `xmllint --noout config/scantax.xml config/model.xml` | exit 0, no output |
| Fixture listing | `python3 -m zipfile --list test-import/test_no_sign.lunp2024` | Use only before deleting/replacing fixtures; do not print extracted contents |
| Secret/PII marker scan | `python3 scripts/check_no_tax_pii.py` | exit 0 after you create the script in this plan |

## Scope

**In scope**:

- `KANTON_LUZERN_TAX_API.md`
- `test-import/create_test_files.py`
- `test-import/*.lunp2024`
- `.gitignore` if this repo is initialized as Git
- `scripts/check_no_tax_pii.py` if adding a local verification script
- `README.md` if needed to document the privacy rule
- `plans/README.md` status row

**Out of scope**:

- Implementing an MCP server
- Changing extracted vendor config files under `config/`
- Extracting or inspecting PDF annex contents
- Publishing, committing, pushing, or uploading any current fixture archive

## Git workflow

No Git repository was present during planning. If the repo has been initialized by execution time, use branch `advisor/001-sanitize-tax-artifacts`. Make one commit for the sanitization changes only. Do not push unless instructed.

## Steps

### Step 1: Add ignore rules and a privacy note

If the repo is now under Git, create or update `.gitignore` so generated tax archives and local tool state are ignored:

```gitignore
.DS_Store
.claude/settings.local.json
test-import/*.lunp2024
```

Add a short `README.md` privacy section if no README exists. State that real tax declarations, annex PDFs, credentials, access codes, bearer tokens, declaration IDs, AHV numbers, and taxpayer PII must not be committed. Keep it concise.

**Verify**: `find . -maxdepth 2 -type f | sort` -> includes `.gitignore` and/or `README.md` only if you created them.

### Step 2: Replace committed fixture archives with non-sensitive placeholders

Remove the three current `.lunp2024` archives from the repo working tree, or replace them with tiny placeholder text files only if the operator explicitly wants placeholders. The preferred state is no `.lunp2024` archives in the repo; the generator can recreate safe fixtures later.

Do not extract the archives. Do not copy annex names or personal values into logs or docs.

**Verify**: `find test-import -maxdepth 1 -type f | sort` -> lists `test-import/create_test_files.py` and no `.lunp2024` files.

### Step 3: Make the fixture generator safe by default

Update `test-import/create_test_files.py` so it no longer has a hardcoded real source path or repo output path. Require explicit CLI arguments:

- `--source PATH`
- `--outdir PATH`
- `--include-annexes`, default false

When `--include-annexes` is false, do not copy any `annexes/` entries. When true, print a clear warning that annexes may contain sensitive tax documents and require a second explicit flag such as `--i-understand-annexes-may-contain-pii`.

Also change `modify_xml` so failure to find the canary field raises an exception and exits non-zero rather than returning unmodified XML.

**Verify**: `python3 test-import/create_test_files.py --help` -> exits 0 and shows `--source`, `--outdir`, `--include-annexes`, and the extra confirmation flag.

### Step 4: Redact live captured values in the API notes

Edit `KANTON_LUZERN_TAX_API.md` so live examples keep response shape but replace sensitive values with neutral placeholders. Redact without preserving the original values:

- declaration/document IDs -> `<docId>`
- email addresses -> `<email>`
- taxpayer names -> `<name>`
- addresses -> `<address>`
- birth dates -> `<birthDate>`
- AHV numbers -> `<ahvNumber>`
- access-code hashes -> `<accessCodeSha256Prefix>`
- concrete test declaration credentials -> move behind a warning or replace with `<trainingPersId>` and `<trainingAccessCode>` unless the maintainer confirms they are public non-secret fixtures

Keep endpoint paths, field names, booleans, and structural JSON intact.

**Verify**: `python3 scripts/check_no_tax_pii.py` -> exits 0. If the script does not exist yet, use a temporary scan that reports only file path, line number, and data type for Swiss AHV-like numbers, email addresses, access-code-like values, declaration/document IDs, and known captured-value labels. Do not print matched values.

### Step 5: Add a local PII guard script

Create `scripts/check_no_tax_pii.py`. It should scan Markdown, Python, JSON, XML, and properties files for obvious accidental leaks:

- Swiss AHV-like numbers
- email addresses outside an allowlist of placeholder strings
- access-code-like values
- bearer token strings
- current fixture archive files under `test-import/`

The script must report only file path, line number, and data type. It must not print matched values.

**Verify**: `python3 scripts/check_no_tax_pii.py` -> exits 0 and prints a short success message.

## Test plan

- Run `xmllint --noout config/scantax.xml config/model.xml` to confirm extracted XML files were not damaged.
- Run `python3 test-import/create_test_files.py --help` to confirm the helper is runnable without a real tax source.
- Run `python3 scripts/check_no_tax_pii.py` to confirm the repo has no obvious PII markers or generated `.lunp2024` archives.

## Done criteria

- [ ] No `.lunp2024` archives remain in `test-import/`.
- [ ] `test-import/create_test_files.py` requires explicit `--source` and `--outdir`.
- [ ] Annex copying is off by default and requires an explicit acknowledgement.
- [ ] Missing canary replacement exits non-zero.
- [ ] `KANTON_LUZERN_TAX_API.md` contains no real taxpayer identifiers from captured sessions.
- [ ] `python3 scripts/check_no_tax_pii.py` exits 0.
- [ ] `xmllint --noout config/scantax.xml config/model.xml` exits 0.
- [ ] `plans/README.md` status row for Plan 001 is updated.

## STOP conditions

Stop and report back if:

- The maintainer says the existing `.lunp2024` archives must be preserved in the repo.
- Sanitization requires knowing whether a value is public training data or private, and that cannot be determined from the docs.
- Running the PII scan still reports personal values after two cleanup attempts.
- You need to inspect or extract PDF annex contents to proceed.

## Maintenance notes

Reviewers should scrutinize this change for accidental value leakage in docs, commit diffs, and command output. This plan deliberately does not implement MCP behavior; it creates the privacy and verification baseline that Plan 002 depends on.
