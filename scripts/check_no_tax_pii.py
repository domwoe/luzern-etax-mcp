#!/usr/bin/env python3
"""Scan repository text files for obvious tax PII and secret markers."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".md", ".py", ".json", ".xml", ".properties", ".txt", ".gitignore"}
SKIP_DIRS = {".git", "__pycache__", "node_modules"}

CHECKS = [
    ("email address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("Swiss AHV number", re.compile(r"\b756\.\d{4}\.\d{4}\.\d{2}\b")),
    ("access-code-like value", re.compile(r"\b\d{4}[A-Z]\d{8}[A-Z0-9]{4}\b")),
    ("bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b", re.IGNORECASE)),
    ("JWT-like token", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("placeholder declaration ID", re.compile(r"\b[A-Z0-9]{26}\b")),
]

ALLOWLIST_PATTERNS = [
    re.compile(r"<email>"),
    re.compile(r"<ahvNumber>"),
    re.compile(r"<trainingAccessCode>"),
    re.compile(r"<accessCodeSha256Prefix>"),
    re.compile(r"<docId>"),
    re.compile(r"code_challenge=<S256-challenge>"),
]


def iter_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.is_file() and (path.suffix in TEXT_SUFFIXES or path.name == ".gitignore"):
            files.append(path)
    return sorted(files)


def is_allowed(line: str) -> bool:
    return any(pattern.search(line) for pattern in ALLOWLIST_PATTERNS)


def main() -> int:
    findings: list[tuple[Path, int, str]] = []

    for archive in (ROOT / "test-import").glob("*.lunp2024"):
        findings.append((archive.relative_to(ROOT), 0, "generated .lunp2024 archive"))

    for path in iter_files():
        rel = path.relative_to(ROOT)
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        for line_number, line in enumerate(lines, start=1):
            if is_allowed(line):
                continue
            for label, pattern in CHECKS:
                if pattern.search(line):
                    findings.append((rel, line_number, label))

    if findings:
        print("Potential sensitive tax data found:")
        for path, line_number, label in findings:
            location = f"{path}:{line_number}" if line_number else str(path)
            print(f"- {location}: {label}")
        return 1

    print("No obvious tax PII or generated .lunp2024 archives found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
