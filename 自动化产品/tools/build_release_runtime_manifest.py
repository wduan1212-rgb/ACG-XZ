#!/usr/bin/env python3
"""Build the deterministic v137 runtime release manifest for audited code."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from verify_release_contracts import (
    RUNTIME_MANIFEST_PATH,
    build_runtime_manifest_data,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--release-id", required=True)
    args = parser.parse_args()
    app_root = args.app_root.resolve()
    destination = app_root / RUNTIME_MANIFEST_PATH
    payload = build_runtime_manifest_data(app_root, args.release_id)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=destination.name + ".", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    print(f"wrote {destination} ({payload['fileCount']} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
