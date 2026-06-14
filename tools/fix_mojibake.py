#!/usr/bin/env python3
"""Repair UTF-8 text that was double-encoded as CP1252 (the `â”Œ` mojibake).

Cause: a tool read a correct UTF-8 file as Windows-1252, producing mojibake,
then wrote it back as UTF-8 (e.g. PowerShell `Set-Content`/`Out-File` without
`-Encoding utf8` during a copy). The reverse is: read as UTF-8 -> encode as
CP1252 (recovers the original UTF-8 bytes) -> decode as UTF-8.

Caveat: 5 byte values are undefined in CP1252 (0x81 0x8D 0x8F 0x90 0x9D). If the
original UTF-8 contained them (e.g. `┐` U+2510 = E2 94 90), that byte was lost in
the bad copy and cannot be recovered here — those spots surface as U+FFFD and are
reported so they can be patched from the clean source.

Usage:
  python fix_mojibake.py --check  FILE [FILE ...]   # report only, no writes
  python fix_mojibake.py --write  FILE [FILE ...]   # repair in place (utf-8, no BOM)
"""
from __future__ import annotations

import argparse
import sys

# Telltale sequences of UTF-8-misread-as-CP1252 (box drawing, punctuation, emoji).
MOJIBAKE_MARKERS = ["â", "Ã", "â€", "â”", "â–", "ðŸ", "Â ", "â‚"]
REPLACEMENT = "�"


def count_markers(s: str) -> int:
    return sum(s.count(m) for m in MOJIBAKE_MARKERS)


def _to_original_bytes(text: str) -> bytes | None:
    """Invert ".NET/PowerShell read UTF-8 as Windows-1252".

    Windows-1252 maps every byte 0x00-0xFF to a Unicode char; the 5 bytes
    undefined in the standard (0x81 0x8D 0x8F 0x90 0x9D) pass through as the
    same-valued C1 control (U+0081 ...). Inverting char->byte that way recovers
    the original UTF-8 bytes INCLUDING corners like `┐` (whose 0x90 byte became
    U+0090). Returns None if a char clearly isn't from this corruption (ord>0xFF
    and not CP1252-encodable) -> signals partial/other corruption, abort.
    """
    out = bytearray()
    for ch in text:
        o = ord(ch)
        if o < 0x80:
            out.append(o)
            continue
        try:
            out += ch.encode("cp1252")
        except UnicodeEncodeError:
            if o <= 0xFF:
                out.append(o)  # the 5 undefined bytes passed through as U+00xx
            else:
                return None  # genuine UTF-8 / not this corruption -> don't touch
    return bytes(out)


def repair(text: str) -> tuple[str, bool]:
    """Return (repaired_text, ok). ok=False -> leave the file alone."""
    raw = _to_original_bytes(text)
    if raw is None:
        return text, False
    fixed = raw.decode("utf-8", errors="replace")
    return fixed, True


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--write", action="store_true")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    any_fail = False
    for path in args.files:
        with open(path, encoding="utf-8") as f:
            orig = f.read()
        before = count_markers(orig)
        fixed, ok = repair(orig)
        after = count_markers(fixed)
        resid = fixed.count(REPLACEMENT) - orig.count(REPLACEMENT)

        status = "OK" if ok else "ABORT(not uniformly double-encoded)"
        print(f"{path}")
        print(f"  markers: {before} -> {after}   unrecoverable(U+FFFD added): {resid}   [{status}]")
        if before == 0:
            print("  (already clean — skipping)")
            continue
        if not ok:
            any_fail = True
            continue
        if args.write:
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(fixed)
            print("  -> written (utf-8, LF)")

    if any_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
