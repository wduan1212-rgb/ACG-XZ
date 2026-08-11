import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from unittest.mock import AsyncMock, patch


APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from server import main as server_main


def healthy_checks():
    return {
        "release": {"ok": True, "id": "v140-test"},
        "database": {
            "ok": True,
            "exists": True,
            "quickCheck": "ok",
            "missingTables": [],
            "missingColumns": {},
            "migrationDirty": 0,
            "modelUsageMigrationVersion": 139001,
            "resourceScopeSchemaVersion": 140001,
            "privateMediaSchemaVersion": 140003,
            "videoComposeSchemaVersion": 140005,
            "memberControlSchemaVersion": 140006,
            "modelUsageSettlementSchemaVersion": 140007,
            "productionRecoverySchemaVersion": 140008,
            "modelUsageSettlementV2SchemaVersion": 140009,
            "mediaIsolationSchemaVersion": 140010,
            "acgMigration": True,
            "acgMigrationVersion": 137004,
            "resourceScopeMigration": True,
            "resourceScopeMigrationVersion": 140002,
            "privateMediaMigration": True,
            "privateMediaMigrationVersion": 140004,
            "modelUsageCompletionSpoolCorrupt": 0,
            "modelUsageCompletionSpoolConflicts": 0,
            "modelUsageUnresolved": 0,
            "modelUsageOutboxPending": 0,
            "modelUsageCompletionSpoolPending": 0,
        },
        "mediaRegistry": {"ok": True},
        "paths": {"ok": True},
        "sidecar": {"ok": True},
        "usageSidecar": {"ok": True},
        "canvas": {"ok": True},
    }


class ProductionWriteGateTests(unittest.TestCase):
    def tearDown(self):
        server_main._clear_production_write_gate()

    def production_mode(self, *, read_only=False):
        return (
            patch.object(server_main.runtime_config, "runtime_mode", return_value="production"),
            patch.object(server_main.runtime_config, "is_production", return_value=True),
            patch.object(server_main.runtime_config, "is_read_only", return_value=read_only),
            patch.object(
                server_main.runtime_config,
                "read_only_mode_status",
                return_value={"ok": True, "readOnly": read_only},
            ),
        )

    @staticmethod
    def _free_local_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    @staticmethod
    def _uvicorn_probe_script():
        return r'''
import json
import os

import fastapi
import starlette
import uvicorn

from server import main

mode = os.environ["ACG_STARTUP_PROBE_MODE"]
report_path = os.environ["ACG_STARTUP_PROBE_REPORT"]
calls = {"prime": 0, "spoolStart": 0, "spoolStop": 0}

main.runtime_config.runtime_mode = lambda: "production"
main.runtime_config.is_production = lambda: True
main.runtime_config.is_read_only = lambda: mode == "ro"
main.runtime_config.read_only_mode_status = lambda: {
    "ok": True,
    "readOnly": mode == "ro",
}

async def prime():
    calls["prime"] += 1
    print("PROBE_PRIME", mode, flush=True)
    main._clear_production_write_gate()
    if mode == "fail":
        raise RuntimeError("forced startup write-gate failure")
    if mode == "rw":
        main._PRODUCTION_WRITE_GATE_SNAPSHOT = {
            "ok": True,
            "writeReady": True,
            "contract": main.PRODUCTION_WRITE_CONTRACT,
            "mode": "read-write",
            "productionReadOnlyRequired": False,
            "startupVerified": True,
            "writeEnableBlockers": [],
        }

async def start_spool():
    calls["spoolStart"] += 1
    snapshot = main._production_write_contract_readiness()
    print("PROBE_SPOOL_START", calls["spoolStart"], flush=True)
    print("PROBE_STARTUP_SNAPSHOT", json.dumps(snapshot, sort_keys=True), flush=True)

async def stop_spool():
    calls["spoolStop"] += 1
    print("PROBE_SPOOL_STOP", calls["spoolStop"], flush=True)
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump({
            **calls,
            "fastapi": fastapi.__version__,
            "starlette": starlette.__version__,
            "uvicorn": uvicorn.__version__,
        }, handle, sort_keys=True)

main._prime_production_write_gate = prime
main._start_model_usage_completion_spool_reconciler = start_spool
main._stop_model_usage_completion_spool_reconciler = stop_spool

uvicorn.run(
    main.app,
    host="127.0.0.1",
    port=int(os.environ["ACG_STARTUP_PROBE_PORT"]),
    log_level="info",
    lifespan="on",
)
'''

    def _start_uvicorn_probe(self, root, mode):
        port = self._free_local_port()
        report = Path(root) / f"{mode}-report.json"
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PYTHONPATH": str(APP_DIR),
            "PYTHONDONTWRITEBYTECODE": "1",
            "ACG_RUNTIME_MODE": "test",
            "ACG_DB_BOOTSTRAP_MODE": "auto",
            "ACG_READ_ONLY": "1",
            "ACG_RELEASE_ID": "v140-startup-probe",
            "ACG_STARTUP_PROBE_MODE": mode,
            "ACG_STARTUP_PROBE_PORT": str(port),
            "ACG_STARTUP_PROBE_REPORT": str(report),
        }
        process = subprocess.Popen(
            [sys.executable, "-u", "-c", self._uvicorn_probe_script()],
            cwd=APP_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        return process, port, report

    def _wait_for_http_status(self, process, url, expected=200, timeout=15):
        deadline = time.monotonic() + timeout
        last_status = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            try:
                with urlopen(url, timeout=0.5) as response:
                    last_status = int(response.status)
            except HTTPError as exc:
                last_status = int(exc.code)
            except (URLError, TimeoutError):
                time.sleep(0.05)
                continue
            if last_status == expected:
                return
            time.sleep(0.05)
        output = ""
        if process.poll() is not None:
            output = process.communicate(timeout=2)[0]
        self.fail(
            f"uvicorn probe did not return {expected}; "
            f"last={last_status} returncode={process.poll()} output={output}"
        )

    @staticmethod
    def _stop_uvicorn_probe(process):
        if process.poll() is None:
            process.terminate()
        try:
            return process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.communicate(timeout=5)

    def test_exact_v140_contract_allows_production_write(self):
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status:
            gate = server_main._production_write_contract_readiness(healthy_checks())
        self.assertTrue(gate["ok"])
        self.assertTrue(gate["writeReady"])
        self.assertEqual([], gate["writeEnableBlockers"])
        self.assertEqual("v1423-production-write-gate-5", gate["contract"])

    def test_every_security_layer_is_authoritative(self):
        cases = (
            ("acgMigration", False, "acg-team-migration-137004"),
            ("resourceScopeMigration", False, "resource-scope-migration-140002"),
            ("privateMediaMigration", False, "private-media-migration-140004"),
        )
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status:
            for field, value, blocker in cases:
                with self.subTest(field=field):
                    checks = healthy_checks()
                    checks["database"][field] = value
                    gate = server_main._production_write_contract_readiness(checks)
                    self.assertFalse(gate["ok"])
                    self.assertIn(blocker, gate["writeEnableBlockers"])

            for check_name, blocker in (
                ("mediaRegistry", "private-media-registry-coverage"),
                ("paths", "runtime-paths"),
                ("sidecar", "video-sidecar"),
                ("canvas", "infinite-canvas-manifest"),
                ("release", "release-identity"),
            ):
                with self.subTest(check=check_name):
                    checks = healthy_checks()
                    checks[check_name]["ok"] = False
                    gate = server_main._production_write_contract_readiness(checks)
                    self.assertFalse(gate["ok"])
                    self.assertIn(blocker, gate["writeEnableBlockers"])

    def test_usage_audits_are_visible_warnings_but_never_block_rw(self):
        checks = healthy_checks()
        checks["database"].update({
            "modelUsageCompletionSpoolCorrupt": 1,
            "modelUsageCompletionSpoolConflicts": 1,
            "modelUsageUnresolved": 8,
            "modelUsageOutboxPending": 3,
            "modelUsageCompletionSpoolPending": 2,
        })
        checks["usageSidecar"] = {"ok": False, "unresolved": 4}
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status:
            gate = server_main._production_write_contract_readiness(checks)
        self.assertTrue(gate["ok"])
        self.assertTrue(gate["writeReady"])
        self.assertEqual([], gate["writeEnableBlockers"])
        self.assertEqual(
            {
                "model-usage-spool-integrity",
                "model-usage-unresolved",
                "model-usage-outbox-pending",
                "model-usage-spool-pending",
                "video-workshop-usage-receipts",
            },
            set(gate["writeGateWarnings"]),
        )

    def test_missing_media_exception_is_release_and_identity_bound(self):
        digest = "a" * 64
        checks = healthy_checks()
        checks["mediaRegistry"] = {
            "ok": False,
            "issues": [
                "missingReferencedFiles",
                "registryMissingFiles",
                "unisolatedMissingReferencedFiles",
            ],
            "missingReferencedFilesSha256": digest,
            "counts": {
                "unisolatedMissingReferencedFiles": 1,
                "registryMissingFiles": 1,
                "effectivePendingRows": 0,
            },
        }
        exception = {
            "ACG_WRITE_GATE_MEDIA_EXCEPTION_RELEASE_ID": "v140-test",
            "ACG_WRITE_GATE_MEDIA_EXCEPTION_SHA256": digest,
            "ACG_WRITE_GATE_MEDIA_EXCEPTION_UNISOLATED": "1",
        }
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status, patch.dict(
            os.environ, exception, clear=False,
        ):
            gate = server_main._production_write_contract_readiness(checks)
        self.assertTrue(gate["ok"])
        self.assertIn(
            "private-media-registry-exact-exception",
            gate["writeGateWarnings"],
        )

        for mutation in (
            {"missingReferencedFilesSha256": "b" * 64},
            {"counts": {"unisolatedMissingReferencedFiles": 2, "registryMissingFiles": 2, "effectivePendingRows": 0}},
            {"issues": ["registryConflicts"]},
        ):
            with self.subTest(mutation=mutation):
                drifted = {**checks, "mediaRegistry": {**checks["mediaRegistry"], **mutation}}
                mode, production, read_only, mode_status = self.production_mode()
                with mode, production, read_only, mode_status, patch.dict(
                    os.environ, exception, clear=False,
                ):
                    rejected = server_main._production_write_contract_readiness(drifted)
                self.assertFalse(rejected["ok"])
                self.assertIn(
                    "private-media-registry-coverage",
                    rejected["writeEnableBlockers"],
                )

    def test_sidecar_mode_must_match_main_mode_in_both_directions(self):
        payload = {
            "ok": True,
            "ready": True,
            "status": "ready",
            "missingRequired": [],
            "contractVersion": server_main.EXPECTED_VIDEO_WORKSHOP_CONTRACT_VERSION,
            "buildId": "v140-test",
            "readOnly": True,
            "writePolicy": "deny-mutations",
        }
        with (
            patch.object(server_main.runtime_config, "release_id", return_value="v140-test"),
            patch.object(server_main.runtime_config, "is_read_only", return_value=False),
        ):
            self.assertFalse(
                server_main._video_sidecar_health_summary(200, payload)["ok"]
            )
            self.assertTrue(
                server_main._video_sidecar_health_summary(200, {
                    **payload,
                    "readOnly": False,
                    "writePolicy": "normal",
                })["ok"]
            )
        with (
            patch.object(server_main.runtime_config, "release_id", return_value="v140-test"),
            patch.object(server_main.runtime_config, "is_read_only", return_value=True),
        ):
            self.assertFalse(
                server_main._video_sidecar_health_summary(200, {
                    **payload,
                    "readOnly": False,
                    "writePolicy": "normal",
                })["ok"]
            )
            self.assertTrue(
                server_main._video_sidecar_health_summary(200, payload)["ok"]
            )

    def test_production_paths_include_spool_model_cache_and_bgm_library(self):
        captured = {}

        def inspect_specs(specs):
            captured.update(specs)
            return {"ok": False, "checks": {}}

        with (
            patch.object(server_main.runtime_config, "is_production", return_value=True),
            patch.object(
                server_main.runtime_config,
                "storage_path_status",
                side_effect=inspect_specs,
            ),
        ):
            server_main._runtime_path_readiness()
        self.assertIn("modelUsageSpool", captured)
        self.assertIn("modelCache", captured)
        self.assertIn("bgmLibrary", captured)

    def test_importing_main_before_startup_does_not_create_runtime_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            targets = {
                "DATA_DB": root / "data.sqlite",
                "MODEL_USAGE_COMPLETION_SPOOL_DIR": root / "model-usage-spool",
                "CUSTOM_CANVAS_BLOB_DIR": root / "canvas-blobs",
                "UPLOAD_DIR": root / "uploads",
                "COMPOSED_DIR": root / "composed",
                "VIDEO_WORKSHOP_PROJECTS_DIR": root / "video" / "projects",
                "VIDEO_WORKSHOP_OUTPUT_DIR": root / "video" / "outputs",
                "VIDEO_WORKSHOP_UPLOAD_DIR": root / "video" / "uploads",
                "HF_HOME": root / "model-cache",
                "BGM_LIBRARY_DIR": root / "bgm-library",
            }
            env = os.environ.copy()
            env.update({
                "PYTHONDONTWRITEBYTECODE": "1",
                "ACG_RUNTIME_MODE": "production",
                "ACG_DB_BOOTSTRAP_MODE": "validate",
                "ACG_READ_ONLY": "1",
                "ACG_RELEASE_ID": "v140-import-test",
                "ACG_RELEASE_ROOT": str(APP_DIR),
                "ACG_PERSISTENT_ROOT": str(root),
                "ACG_ENV_FILE": str(root / "runtime.env"),
                "AUTH_SECRET": "test-secret",
                **{name: str(path) for name, path in targets.items()},
            })
            result = subprocess.run(
                [sys.executable, "-c", "import server.main"],
                cwd=APP_DIR,
                env=env,
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            for path in targets.values():
                self.assertFalse(path.exists(), path)
            self.assertFalse((root / "runtime.env").exists())

    def test_locked_legacy_uvicorn_runs_rw_startup_gate_before_serving(self):
        with tempfile.TemporaryDirectory() as tmp:
            process, port, report = self._start_uvicorn_probe(tmp, "rw")
            try:
                self._wait_for_http_status(process, f"http://127.0.0.1:{port}/")
                self._wait_for_http_status(
                    process,
                    f"http://127.0.0.1:{port}/openapi.json",
                )
            finally:
                output, _ = self._stop_uvicorn_probe(process)

            self.assertEqual(0, process.returncode, output)
            self.assertIn("Application startup complete", output)
            self.assertIn("PROBE_PRIME rw", output)
            self.assertIn("PROBE_SPOOL_START 1", output)
            self.assertIn('"startupVerified": true', output)
            self.assertIn("PROBE_SPOOL_STOP 1", output)
            lifecycle = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(
                {
                    "fastapi": "0.68.1",
                    "prime": 1,
                    "spoolStart": 1,
                    "spoolStop": 1,
                    "starlette": "0.14.2",
                    "uvicorn": "0.15.0",
                },
                lifecycle,
            )

    def test_locked_legacy_uvicorn_refuses_socket_when_rw_gate_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            process, _, report = self._start_uvicorn_probe(tmp, "fail")
            output, _ = process.communicate(timeout=15)

            self.assertIn("forced startup write-gate failure", output)
            self.assertIn("Application startup failed. Exiting.", output)
            self.assertNotIn("Application startup complete", output)
            self.assertNotIn("PROBE_SPOOL_START", output)
            self.assertFalse(report.exists())

    def test_locked_legacy_uvicorn_keeps_read_only_reads_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            process, port, report = self._start_uvicorn_probe(tmp, "ro")
            try:
                self._wait_for_http_status(process, f"http://127.0.0.1:{port}/")
                self._wait_for_http_status(
                    process,
                    f"http://127.0.0.1:{port}/openapi.json",
                )
            finally:
                output, _ = self._stop_uvicorn_probe(process)

            self.assertEqual(0, process.returncode, output)
            self.assertIn("Application startup complete", output)
            self.assertIn("PROBE_PRIME ro", output)
            self.assertIn('"mode": "read-only"', output)
            lifecycle = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(1, lifecycle["prime"])
            self.assertEqual(1, lifecycle["spoolStart"])
            self.assertEqual(1, lifecycle["spoolStop"])

    def test_unverified_process_is_closed_and_read_only_is_always_allowed(self):
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status:
            gate = server_main._production_write_contract_readiness()
        self.assertFalse(gate["ok"])
        self.assertEqual(["startup-contract-unverified"], gate["writeEnableBlockers"])

        mode, production, read_only, mode_status = self.production_mode(read_only=True)
        with mode, production, read_only, mode_status:
            protected = server_main._production_write_contract_readiness()
        self.assertTrue(protected["ok"])
        self.assertFalse(protected["writeReady"])
        self.assertEqual("read-only", protected["mode"])

    def test_ambiguous_write_mode_cannot_bypass_the_launcher(self):
        with (
            patch.object(server_main.runtime_config, "runtime_mode", return_value="production"),
            patch.object(server_main.runtime_config, "is_production", return_value=True),
            patch.object(
                server_main.runtime_config,
                "read_only_mode_status",
                return_value={"ok": False, "readOnly": True},
            ),
        ):
            gate = server_main._production_write_contract_readiness(healthy_checks())
        self.assertFalse(gate["ok"])
        self.assertEqual("invalid", gate["mode"])
        self.assertEqual(
            ["read-only-mode-configuration"],
            gate["writeEnableBlockers"],
        )

    def test_startup_audit_fails_closed_and_caches_only_a_complete_gate(self):
        incomplete = healthy_checks()
        incomplete["mediaRegistry"]["ok"] = False
        mode, production, read_only, mode_status = self.production_mode()
        with (
            mode,
            production,
            read_only,
            mode_status,
            patch.object(
                server_main,
                "_deployment_readiness_checks",
                new=AsyncMock(return_value=incomplete),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "private-media-registry-coverage"):
                asyncio.run(server_main._prime_production_write_gate())
            self.assertFalse(
                server_main._production_write_contract_readiness()["ok"]
            )

        server_main._clear_production_write_gate()
        mode, production, read_only, mode_status = self.production_mode()
        with (
            mode,
            production,
            read_only,
            mode_status,
            patch.object(
                server_main,
                "_deployment_readiness_checks",
                new=AsyncMock(return_value=healthy_checks()),
            ),
        ):
            asyncio.run(server_main._prime_production_write_gate())
            cached = server_main._production_write_contract_readiness()
        self.assertTrue(cached["ok"])
        self.assertTrue(cached["startupVerified"])

    def test_ready_is_observational_and_cannot_revoke_live_write_gate(self):
        failing = healthy_checks()
        failing["database"] = {
            **failing["database"],
            "ok": False,
            "modelUsageUnresolved": 3,
        }
        failing["mediaRegistry"] = {
            "ok": False,
            "issues": ["missingReferencedFiles"],
        }
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status:
            with patch.object(
                server_main,
                "_deployment_readiness_checks",
                new=AsyncMock(return_value=healthy_checks()),
            ):
                asyncio.run(server_main._prime_production_write_gate())
            armed = server_main._production_write_contract_readiness()
            self.assertTrue(armed["ok"])
            with (
                patch.object(
                    server_main,
                    "_deployment_readiness_checks",
                    new=AsyncMock(return_value=failing),
                ),
                patch.object(
                    server_main.runtime_config,
                    "readiness_token",
                    return_value="ready-token",
                ),
            ):
                response = asyncio.run(server_main.readiness("ready-token", ""))

            self.assertEqual(503, response.status_code)
            observed = json.loads(response.body)
            self.assertFalse(observed["ready"])
            self.assertFalse(observed["writeReady"])
            self.assertFalse(observed["checks"]["tenantSecurity"]["ok"])
            self.assertEqual(armed, server_main._production_write_contract_readiness())

    def test_ready_is_observational_and_cannot_arm_an_unverified_process(self):
        mode, production, read_only, mode_status = self.production_mode()
        with (
            mode,
            production,
            read_only,
            mode_status,
            patch.object(
                server_main,
                "_deployment_readiness_checks",
                new=AsyncMock(return_value=healthy_checks()),
            ),
            patch.object(
                server_main.runtime_config,
                "readiness_token",
                return_value="ready-token",
            ),
        ):
            self.assertIsNone(server_main._PRODUCTION_WRITE_GATE_SNAPSHOT)
            response = asyncio.run(server_main.readiness("ready-token", ""))
            self.assertEqual(200, response.status_code)
            observed = json.loads(response.body)
            self.assertTrue(observed["ready"])
            self.assertTrue(observed["writeReady"])
            self.assertIsNone(server_main._PRODUCTION_WRITE_GATE_SNAPSHOT)
            cached = server_main._production_write_contract_readiness()

        self.assertFalse(cached["ok"])
        self.assertFalse(cached["startupVerified"])
        self.assertEqual(
            ["startup-contract-unverified"],
            cached["writeEnableBlockers"],
        )

    def test_read_only_ready_reports_migration_blockers_without_blocking_boot(self):
        checks = healthy_checks()
        checks["database"]["ok"] = False
        checks["database"]["acgMigration"] = False
        checks["mediaRegistry"] = {"ok": False, "issues": ["migration-pending"]}
        mode, production, read_only, mode_status = self.production_mode(read_only=True)
        with (
            mode,
            production,
            read_only,
            mode_status,
            patch.object(
                server_main.runtime_config,
                "readiness_token",
                return_value="ready-token",
            ),
            patch.object(
                server_main,
                "_deployment_readiness_checks",
                new=AsyncMock(return_value=checks),
            ),
        ):
            response = asyncio.run(server_main.readiness("ready-token", ""))
        self.assertEqual(200, response.status_code)
        payload = json.loads(response.body)
        self.assertTrue(payload["ready"])
        self.assertFalse(payload["writeReady"])
        self.assertFalse(payload["checks"]["database"]["ok"])
        self.assertFalse(payload["checks"]["mediaRegistry"]["ok"])


if __name__ == "__main__":
    unittest.main()
