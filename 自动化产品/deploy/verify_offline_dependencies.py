#!/usr/bin/env python3
"""Build and verify an immutable, target-ABI Python wheelhouse contract.

The application release contains exact lock files but never contains the
platform-specific wheels.  A connected build host creates one wheelhouse for
the exact production Python ABI, the wheelhouse is copied to the maintenance
environment, and every byte is verified before an offline install.

This module also verifies that the two already-installed virtual environments
match their complete lock files.  It intentionally rejects missing packages,
version drift, unpinned requirements, unexpected wheelhouse files and a
manifest produced for another Python implementation/version/platform.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


FORMAT = "acg-offline-wheelhouse-v1"
PIN_RE = re.compile(r"^([A-Za-z0-9_.-]+)==([^\s;]+)$")
IGNORED_INSTALLED = {"pip", "wheel"}


class DependencyContractError(RuntimeError):
    pass


def _canonical_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", str(value or "")).lower()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_lock(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise DependencyContractError(f"lock_missing:{path}")
    pins: dict[str, str] = {}
    for number, raw in enumerate(path.read_text("utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN_RE.fullmatch(line)
        if not match:
            raise DependencyContractError(f"lock_not_exact:{path}:{number}")
        name = _canonical_name(match.group(1))
        if name in pins:
            raise DependencyContractError(f"lock_duplicate:{path}:{number}:{name}")
        pins[name] = match.group(2)
    if not pins:
        raise DependencyContractError(f"lock_empty:{path}")
    return pins


def verify_lock_extension(
    base_lock: Path,
    extended_lock: Path,
    *,
    allowed_extras: set[str],
) -> dict:
    """Prove that a test lock is an exact, named extension of runtime.

    Keeping a complete test lock makes one-file offline installation and
    ``installed`` verification possible.  This check prevents the duplicated
    runtime portion from silently drifting away from production.
    """

    base = parse_lock(base_lock)
    extended = parse_lock(extended_lock)
    allowed = {_canonical_name(name) for name in allowed_extras}
    missing = sorted(name for name in base if name not in extended)
    drift = sorted(
        (
            {
                "name": name,
                "expected": version,
                "actual": extended.get(name, ""),
            }
            for name, version in base.items()
            if name in extended and extended[name] != version
        ),
        key=lambda item: item["name"],
    )
    extras = set(extended) - set(base)
    unexpected = sorted(extras - allowed)
    required_missing = sorted(allowed - extras)
    if missing or drift or unexpected or required_missing:
        raise DependencyContractError(
            json.dumps(
                {
                    "missing": missing,
                    "drift": drift,
                    "unexpectedExtras": unexpected,
                    "requiredExtrasMissing": required_missing,
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
    return {
        "ok": True,
        "baseLock": str(base_lock.resolve()),
        "baseLockSha256": _sha256(base_lock),
        "extendedLock": str(extended_lock.resolve()),
        "extendedLockSha256": _sha256(extended_lock),
        "basePackageCount": len(base),
        "extendedPackageCount": len(extended),
        "extras": sorted(extras),
    }


def installed_versions(python: Path) -> tuple[dict[str, str], dict]:
    if not python.is_file() or not os.access(python, os.X_OK):
        raise DependencyContractError(f"python_not_executable:{python}")
    probe = (
        "import importlib.metadata,json,platform,sys,sysconfig;"
        "print(json.dumps({'implementation':platform.python_implementation(),"
        "'python':platform.python_version(),'machine':platform.machine(),"
        "'sysconfigPlatform':sysconfig.get_platform(),"
        "'packages':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}},"
        "sort_keys=True))"
    )
    result = subprocess.run(
        [str(python), "-c", probe], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise DependencyContractError(
            f"python_probe_failed:{python}:{result.stderr.strip()[:240]}"
        )
    payload = json.loads(result.stdout)
    versions = {
        _canonical_name(name): str(version)
        for name, version in payload.pop("packages", {}).items()
    }
    return versions, payload


def verify_installed(python: Path, lock: Path) -> dict:
    pins = parse_lock(lock)
    actual, runtime = installed_versions(python)
    missing = sorted(name for name in pins if name not in actual)
    drift = sorted(
        (
            {"name": name, "expected": version, "actual": actual.get(name, "")}
            for name, version in pins.items()
            if name in actual and actual[name] != version
        ),
        key=lambda item: item["name"],
    )
    unexpected = sorted(
        name for name in actual if name not in pins and name not in IGNORED_INSTALLED
    )
    if missing or drift or unexpected:
        raise DependencyContractError(
            json.dumps(
                {"missing": missing, "drift": drift, "unexpected": unexpected},
                ensure_ascii=False,
                sort_keys=True,
            )
        )
    check = subprocess.run(
        [str(python), "-m", "pip", "check"],
        capture_output=True,
        text=True,
        check=False,
    )
    if check.returncode:
        detail = (check.stdout + "\n" + check.stderr).strip()[-500:]
        raise DependencyContractError(f"pip_check_failed:{detail}")
    return {
        "ok": True,
        "lock": str(lock.resolve()),
        "lockSha256": _sha256(lock),
        "packageCount": len(pins),
        "pipCheck": "ok",
        "runtime": runtime,
    }


def _runtime_identity(python: Path) -> dict:
    _versions, payload = installed_versions(python)
    return payload


def _wheel_files(root: Path) -> list[Path]:
    return sorted(
        path for path in root.iterdir()
        if path.is_file() and path.suffix.lower() in {".whl", ".gz", ".zip"}
    )


def build_wheelhouse(python: Path, lock: Path, output: Path) -> dict:
    parse_lock(lock)
    if output.exists():
        raise DependencyContractError(f"output_already_exists:{output}")
    if not output.parent.is_dir():
        raise DependencyContractError(f"output_parent_missing:{output.parent}")
    with tempfile.TemporaryDirectory(prefix=".wheelhouse-", dir=output.parent) as tmp:
        stage = Path(tmp)
        result = subprocess.run(
            [
                str(python), "-m", "pip", "download", "--only-binary=:all:",
                "--dest", str(stage), "--requirement", str(lock),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise DependencyContractError(
                f"pip_download_failed:{result.stderr.strip()[-500:]}"
            )
        files = _wheel_files(stage)
        if not files:
            raise DependencyContractError("wheelhouse_empty")
        runtime = _runtime_identity(python)
        manifest = {
            "format": FORMAT,
            "createdAt": int(time.time() * 1000),
            "lockName": lock.name,
            "lockSha256": _sha256(lock),
            "runtime": runtime,
            "files": [
                {"name": path.name, "bytes": path.stat().st_size, "sha256": _sha256(path)}
                for path in files
            ],
        }
        manifest_path = stage / "wheelhouse.manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(stage, output)
    manifest_digest = _sha256(output / "wheelhouse.manifest.json")
    return verify_wheelhouse(
        output,
        lock,
        python,
        expected_manifest_sha256=manifest_digest,
    )


def verify_wheelhouse(
    root: Path,
    lock: Path,
    python: Path,
    *,
    expected_manifest_sha256: str = "",
) -> dict:
    parse_lock(lock)
    manifest_path = root / "wheelhouse.manifest.json"
    if not root.is_dir() or not manifest_path.is_file():
        raise DependencyContractError(f"wheelhouse_manifest_missing:{root}")
    manifest_digest = _sha256(manifest_path)
    confirmed_digest = str(expected_manifest_sha256 or "").strip().lower()
    if confirmed_digest:
        if not re.fullmatch(r"[0-9a-f]{64}", confirmed_digest):
            raise DependencyContractError("wheelhouse_manifest_confirmation_invalid")
        if confirmed_digest != manifest_digest:
            raise DependencyContractError("wheelhouse_manifest_confirmation_mismatch")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if manifest.get("format") != FORMAT:
        raise DependencyContractError("wheelhouse_format_mismatch")
    if manifest.get("lockSha256") != _sha256(lock):
        raise DependencyContractError("wheelhouse_lock_mismatch")
    runtime = _runtime_identity(python)
    if manifest.get("runtime") != runtime:
        raise DependencyContractError("wheelhouse_runtime_mismatch")
    declared = manifest.get("files")
    if not isinstance(declared, list) or not declared:
        raise DependencyContractError("wheelhouse_files_missing")
    expected_names: set[str] = set()
    for item in declared:
        name = str((item or {}).get("name") or "")
        if not name or name != Path(name).name or name in expected_names:
            raise DependencyContractError("wheelhouse_file_name_invalid")
        expected_names.add(name)
        path = root / name
        if not path.is_file():
            raise DependencyContractError(f"wheelhouse_file_missing:{name}")
        if path.stat().st_size != int(item.get("bytes") or -1):
            raise DependencyContractError(f"wheelhouse_file_size_mismatch:{name}")
        if _sha256(path) != item.get("sha256"):
            raise DependencyContractError(f"wheelhouse_file_hash_mismatch:{name}")
    actual_names = {path.name for path in root.iterdir() if path.is_file()}
    if actual_names != expected_names | {manifest_path.name}:
        raise DependencyContractError("wheelhouse_unexpected_files")
    return {
        "ok": True,
        "root": str(root.resolve()),
        "manifestSha256": manifest_digest,
        "lockSha256": manifest["lockSha256"],
        "fileCount": len(expected_names),
        "runtime": runtime,
    }


def verify_offline_install(
    python: Path,
    lock: Path,
    root: Path,
    *,
    expected_manifest_sha256: str,
) -> dict:
    """Prove a wheelhouse closes under an isolated ``--no-deps`` install."""

    wheelhouse = verify_wheelhouse(
        root,
        lock,
        python,
        expected_manifest_sha256=expected_manifest_sha256,
    )
    with tempfile.TemporaryDirectory(prefix="acg-offline-install-") as tmp:
        venv = Path(tmp) / "venv"
        created = subprocess.run(
            [str(python), "-m", "venv", str(venv)],
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode:
            raise DependencyContractError(
                f"venv_create_failed:{created.stderr.strip()[-500:]}"
            )
        test_python = venv / "bin" / "python"
        installed = subprocess.run(
            [
                str(test_python), "-m", "pip", "install", "--isolated",
                "--disable-pip-version-check", "--no-index", "--no-deps",
                "--find-links", str(root), "--requirement", str(lock),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if installed.returncode:
            detail = (installed.stdout + "\n" + installed.stderr).strip()[-500:]
            raise DependencyContractError(f"offline_install_failed:{detail}")
        environment = verify_installed(test_python, lock)
    return {
        "ok": True,
        "root": wheelhouse["root"],
        "manifestSha256": wheelhouse["manifestSha256"],
        "lockSha256": wheelhouse["lockSha256"],
        "fileCount": wheelhouse["fileCount"],
        "packageCount": environment["packageCount"],
        "pipCheck": environment["pipCheck"],
        "runtime": environment["runtime"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    installed = sub.add_parser("installed")
    installed.add_argument("--python", required=True, type=Path)
    installed.add_argument("--lock", required=True, type=Path)
    build = sub.add_parser("build")
    build.add_argument("--python", required=True, type=Path)
    build.add_argument("--lock", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    verify = sub.add_parser("verify-wheelhouse")
    verify.add_argument("--python", required=True, type=Path)
    verify.add_argument("--lock", required=True, type=Path)
    verify.add_argument("--root", required=True, type=Path)
    verify.add_argument(
        "--confirm-manifest-sha256",
        required=True,
        help="independently recorded SHA-256 of wheelhouse.manifest.json",
    )
    install_check = sub.add_parser("install-check")
    install_check.add_argument("--python", required=True, type=Path)
    install_check.add_argument("--lock", required=True, type=Path)
    install_check.add_argument("--root", required=True, type=Path)
    install_check.add_argument(
        "--confirm-manifest-sha256",
        required=True,
        help="independently recorded SHA-256 of wheelhouse.manifest.json",
    )
    extends = sub.add_parser("extends")
    extends.add_argument("--base-lock", required=True, type=Path)
    extends.add_argument("--extended-lock", required=True, type=Path)
    extends.add_argument("--allow-extra", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        if args.command == "installed":
            payload = verify_installed(args.python, args.lock)
        elif args.command == "build":
            payload = build_wheelhouse(args.python, args.lock, args.output)
        elif args.command == "extends":
            payload = verify_lock_extension(
                args.base_lock,
                args.extended_lock,
                allowed_extras=set(args.allow_extra),
            )
        elif args.command == "install-check":
            payload = verify_offline_install(
                args.python,
                args.lock,
                args.root,
                expected_manifest_sha256=args.confirm_manifest_sha256,
            )
        else:
            payload = verify_wheelhouse(
                args.root,
                args.lock,
                args.python,
                expected_manifest_sha256=args.confirm_manifest_sha256,
            )
    except (DependencyContractError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Dependency contract failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
