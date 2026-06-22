"""
Create synthetic .lunp2024 variants from an explicitly supplied source archive.

The helper is intentionally conservative: it does not know a default source path,
does not know a default output path, and does not copy annexes unless the caller
opts in and acknowledges that annexes may contain sensitive tax documents.
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Mapping


CANARY_OLD = '<boolean id="STES3_EinkomVeraendErwartet">\n<value>true</value>\n</boolean>'
CANARY_NEW = '<boolean id="STES3_EinkomVeraendErwartet">\n<value>false</value>\n</boolean>'
DUMMY_SIGN = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create .lunp2024 import-test variants from an explicit source archive."
    )
    parser.add_argument("--source", required=True, type=Path, help="Source .lunp2024 archive")
    parser.add_argument("--outdir", required=True, type=Path, help="Directory for generated archives")
    parser.add_argument(
        "--include-annexes",
        action="store_true",
        help="Copy annexes from the source archive. Annexes may contain sensitive tax documents.",
    )
    parser.add_argument(
        "--i-understand-annexes-may-contain-pii",
        action="store_true",
        help="Required together with --include-annexes.",
    )
    return parser.parse_args()


def read_source(source: Path) -> dict[str, bytes]:
    contents: dict[str, bytes] = {}
    with zipfile.ZipFile(source, "r") as zf:
        for name in zf.namelist():
            contents[name] = zf.read(name)
    return contents


def modify_xml(xml_bytes: bytes) -> bytes:
    xml_str = xml_bytes.decode("utf-8")
    if CANARY_OLD in xml_str:
        return xml_str.replace(CANARY_OLD, CANARY_NEW).encode("utf-8")

    pattern = r'<boolean id="STES3_EinkomVeraendErwartet">\s*<value>true</value>\s*</boolean>'
    xml_str_new, count = re.subn(pattern, CANARY_NEW, xml_str)
    if count == 0:
        raise ValueError("Could not find canary field STES3_EinkomVeraendErwartet")
    return xml_str_new.encode("utf-8")


def update_meta(meta_bytes: bytes) -> bytes:
    meta = json.loads(meta_bytes.decode("utf-8"))
    meta["productStatus"] = "IN_PROGRESS"
    meta["submissionDate"] = None
    meta["lastChangeDate"] = datetime.now().timestamp()
    meta["artifacts"] = [a for a in meta.get("artifacts", []) if a.get("artifactType") == "PRODUCT_BIN"]
    if "annexes" in meta:
        meta["annexes"] = []
    return json.dumps(meta, indent=2, ensure_ascii=False).encode("utf-8")


def create_variant(
    name: str,
    contents: Mapping[str, bytes],
    outdir: Path,
    include_signs: str,
    include_annexes: bool,
) -> Path:
    outpath = outdir / f"test_{name}.lunp2024"

    xml_data = modify_xml(contents["artifacts/taxcase.LUnP2024"])
    meta_data = update_meta(contents["taxcase.LUnP2024.meta"])

    with zipfile.ZipFile(outpath, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("artifacts/taxcase.LUnP2024", xml_data)
        zf.writestr("taxcase.LUnP2024.meta", meta_data)

        if include_signs == "dummy":
            zf.writestr("artifacts/taxcase.LUnP2024.sign", DUMMY_SIGN)
            zf.writestr("taxcase.LUnP2024.meta.sign", DUMMY_SIGN)
        elif include_signs == "original":
            for sign_name in ("artifacts/taxcase.LUnP2024.sign", "taxcase.LUnP2024.meta.sign"):
                if sign_name in contents:
                    zf.writestr(sign_name, contents[sign_name])

        if include_annexes:
            for entry_name, data in contents.items():
                if not entry_name.startswith("annexes/"):
                    continue
                if entry_name.endswith(".sign") and include_signs != "original":
                    continue
                zf.writestr(entry_name, data)

    return outpath


def main() -> int:
    args = parse_args()
    if args.include_annexes and not args.i_understand_annexes_may_contain_pii:
        raise SystemExit(
            "--include-annexes may copy sensitive tax documents; also pass "
            "--i-understand-annexes-may-contain-pii to continue"
        )
    if not args.source.exists():
        raise SystemExit(f"Source file not found: {args.source}")

    args.outdir.mkdir(parents=True, exist_ok=True)
    contents = read_source(args.source)

    variants = [
        create_variant("no_sign", contents, args.outdir, "none", args.include_annexes),
        create_variant("dummy_sign", contents, args.outdir, "dummy", args.include_annexes),
        create_variant("orig_sign", contents, args.outdir, "original", args.include_annexes),
    ]

    for path in variants:
        print(f"Created: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
