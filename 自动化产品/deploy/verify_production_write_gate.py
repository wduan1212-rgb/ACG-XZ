#!/usr/bin/env python3
"""Read-only pre-service validation for the v140 production write contract."""

from __future__ import annotations

import asyncio
import argparse
import json
import sys
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from server import config as runtime_config


runtime_config.load_environment()

from server import main  # noqa: E402  (storage identity follows environment load)


async def _run(*, skip_sidecar: bool) -> int:
    if not runtime_config.is_production():
        print("production write gate requires ACG_RUNTIME_MODE=production", file=sys.stderr)
        return 2
    if runtime_config.is_read_only():
        payload = main._production_write_contract_readiness()
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        return 0

    try:
        checks = await main._deployment_readiness_checks(
            include_sidecar=not skip_sidecar,
        )
        payload = main._production_write_contract_readiness(checks)
    except Exception as exc:
        print(
            "production write gate audit failed: " + exc.__class__.__name__,
            file=sys.stderr,
        )
        return 1
    blockers_list = list(payload.get("writeEnableBlockers") or [])
    if skip_sidecar and blockers_list == ["video-sidecar"]:
        payload = {
            **payload,
            "ok": True,
            "writeReady": False,
            "phase": "static-preflight",
            "writeEnableBlockers": blockers_list,
        }
    if not payload.get("ok"):
        blockers = ",".join(blockers_list or ["unknown"])
        print("production write gate blocked: " + blockers, file=sys.stderr)
        return 1
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0


def main_cli() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-sidecar",
        action="store_true",
        help="defer only the loopback sidecar check for the pre-stop audit",
    )
    args = parser.parse_args()
    return asyncio.run(_run(skip_sidecar=args.skip_sidecar))


if __name__ == "__main__":
    raise SystemExit(main_cli())
