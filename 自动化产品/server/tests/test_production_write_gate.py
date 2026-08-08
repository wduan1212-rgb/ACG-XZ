import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
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

    def test_exact_v140_contract_allows_production_write(self):
        mode, production, read_only, mode_status = self.production_mode()
        with mode, production, read_only, mode_status:
            gate = server_main._production_write_contract_readiness(healthy_checks())
        self.assertTrue(gate["ok"])
        self.assertTrue(gate["writeReady"])
        self.assertEqual([], gate["writeEnableBlockers"])
        self.assertEqual("v140-production-write-gate-2", gate["contract"])

    def test_every_security_layer_is_authoritative(self):
        cases = (
            ("acgMigration", False, "acg-team-migration-137004"),
            ("resourceScopeMigration", False, "resource-scope-migration-140002"),
            ("privateMediaMigration", False, "private-media-migration-140004"),
            ("modelUsageCompletionSpoolCorrupt", 1, "model-usage-spool-integrity"),
            ("modelUsageUnresolved", 1, "model-usage-unresolved"),
            ("modelUsageOutboxPending", 1, "model-usage-outbox-pending"),
            ("modelUsageCompletionSpoolPending", 1, "model-usage-spool-pending"),
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
