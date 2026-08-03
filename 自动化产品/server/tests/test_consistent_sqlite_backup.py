import hashlib
import importlib.util
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


APP_DIR = Path(__file__).resolve().parents[2]
SCRIPT = APP_DIR / "server" / "scripts" / "consistent_sqlite_backup.py"


def load_backup_module():
    name = f"consistent_sqlite_backup_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ConsistentSQLiteBackupTests(unittest.TestCase):
    def _database(self, root: Path) -> Path:
        path = root / "source.sqlite"
        with sqlite3.connect(path) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT)")
            conn.executemany(
                "INSERT INTO events(value) VALUES (?)",
                [(f"event-{index}",) for index in range(20)],
            )
        return path

    def test_cli_creates_verified_backup_and_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            destination = root / "backup.sqlite"
            manifest = root / "backup.manifest.json"

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--source",
                    str(source),
                    "--destination",
                    str(destination),
                    "--manifest",
                    str(manifest),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(0, result.returncode, result.stderr)
            payload = json.loads(manifest.read_text("utf-8"))
            stdout = json.loads(result.stdout)
            self.assertEqual("acg-sqlite-backup-v2", payload["format"])
            self.assertTrue(payload["verified"])
            self.assertEqual("ok", payload["backup"]["quickCheck"])
            self.assertEqual(destination.stat().st_size, payload["backup"]["bytes"])
            self.assertEqual(
                hashlib.sha256(destination.read_bytes()).hexdigest(),
                payload["backup"]["sha256"],
            )
            self.assertEqual(
                hashlib.sha256(manifest.read_bytes()).hexdigest(),
                stdout["manifestSha256"],
            )
            self.assertEqual(
                payload["source"]["logicalSha256"],
                payload["backup"]["logicalSha256"],
            )
            with sqlite3.connect(destination) as conn:
                self.assertEqual(20, conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
                self.assertEqual("ok", conn.execute("PRAGMA quick_check").fetchone()[0])
            self.assertFalse(any(".partial-" in path.name for path in root.iterdir()))

    def test_verified_manifest_rejects_tamper_and_wrong_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            destination = root / "backup.sqlite"
            manifest = root / "backup.manifest.json"
            backup = load_backup_module()
            backup.create_backup(source, destination, manifest)
            manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()

            binding = backup.verify_backup_manifest(
                manifest,
                destination,
                expected_manifest_sha256=manifest_sha256,
            )
            self.assertTrue(binding["verified"])
            self.assertEqual("acg-sqlite-backup-v2", binding["format"])

            payload = json.loads(manifest.read_text("utf-8"))
            payload["source"]["schemaVersion"] += 1
            manifest.write_text(json.dumps(payload), "utf-8")
            with self.assertRaisesRegex(ValueError, "confirmation mismatch"):
                backup.verify_backup_manifest(
                    manifest,
                    destination,
                    expected_manifest_sha256=manifest_sha256,
                )

    def test_verified_manifest_rejects_changed_backup_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            destination = root / "backup.sqlite"
            manifest = root / "backup.manifest.json"
            backup = load_backup_module()
            backup.create_backup(source, destination, manifest)
            manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()
            with destination.open("ab") as handle:
                handle.write(b"changed")

            with self.assertRaisesRegex(ValueError, "size does not match"):
                backup.verify_backup_manifest(
                    manifest,
                    destination,
                    expected_manifest_sha256=manifest_sha256,
                )

    def test_cli_refuses_to_replace_existing_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            destination = root / "backup.sqlite"
            destination.write_bytes(b"keep-me")

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--source",
                    str(source),
                    "--destination",
                    str(destination),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(2, result.returncode)
            self.assertEqual(b"keep-me", destination.read_bytes())
            self.assertIn("must not already exist", result.stderr)

    def test_cli_rejects_destination_manifest_alias_without_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            shared_output = root / "backup.sqlite"

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--source",
                    str(source),
                    "--destination",
                    str(shared_output),
                    "--manifest",
                    str(shared_output),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(2, result.returncode)
            self.assertIn("must be different files", result.stderr)
            self.assertFalse(shared_output.exists())
            self.assertFalse(any(".partial-" in path.name for path in root.iterdir()))

    def test_create_backup_conservatively_rejects_case_alias_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            backup = load_backup_module()

            with self.assertRaisesRegex(ValueError, "must be different files"):
                backup.create_backup(
                    source,
                    root / "Backup.sqlite",
                    root / "backup.sqlite",
                )

            self.assertFalse((root / "Backup.sqlite").exists())
            self.assertFalse((root / "backup.sqlite").exists())
            self.assertFalse(any(".partial-" in path.name for path in root.iterdir()))

    def test_create_backup_fsyncs_database_manifest_and_parent_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            destination = root / "backup.sqlite"
            manifest = root / "backup.manifest.json"
            backup = load_backup_module()
            real_fsync = os.fsync
            fsync_types = []

            def tracked_fsync(descriptor):
                mode = os.fstat(descriptor).st_mode
                if stat.S_ISREG(mode):
                    fsync_types.append("file")
                elif stat.S_ISDIR(mode):
                    fsync_types.append("directory")
                return real_fsync(descriptor)

            with patch.object(backup.os, "fsync", side_effect=tracked_fsync):
                backup.create_backup(source, destination, manifest)

            self.assertGreaterEqual(fsync_types.count("file"), 2)
            self.assertGreaterEqual(fsync_types.count("directory"), 2)
            self.assertTrue(destination.is_file())
            self.assertTrue(manifest.is_file())

    def test_create_backup_refuses_a_source_changed_during_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            destination = root / "backup.sqlite"
            manifest = root / "backup.manifest.json"
            backup = load_backup_module()

            with (
                patch.object(
                    backup,
                    "_logical_sha256",
                    side_effect=["a" * 64, "b" * 64],
                ),
                self.assertRaisesRegex(RuntimeError, "changed during backup"),
            ):
                backup.create_backup(source, destination, manifest)

            self.assertFalse(destination.exists())
            self.assertFalse(manifest.exists())
            self.assertFalse(any(".partial-" in path.name for path in root.iterdir()))

    def test_cli_rejects_non_database_without_leaving_partial_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "not-a-database.sqlite"
            source.write_bytes(b"not sqlite")
            destination = root / "backup.sqlite"

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--source",
                    str(source),
                    "--destination",
                    str(destination),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(2, result.returncode)
            self.assertFalse(destination.exists())
            self.assertFalse((root / "backup.sqlite.manifest.json").exists())

    def test_migration_apply_cli_requires_explicit_verified_backup_arguments(self):
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "server.migrations",
                "apply",
                "--confirm-version",
                "1",
                "--confirm-identity",
                "identity",
            ],
            cwd=APP_DIR,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("--backup-manifest", result.stderr)
        self.assertIn("--backup-database", result.stderr)
        self.assertIn("--confirm-backup-manifest-sha256", result.stderr)

        resource_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "server.migrations",
                "resource-apply",
                "--confirm-schema-version",
                "1",
                "--confirm-identity",
                "identity",
            ],
            cwd=APP_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(2, resource_result.returncode)
        self.assertIn("--backup-manifest", resource_result.stderr)
        self.assertIn("--backup-database", resource_result.stderr)
        self.assertIn(
            "--confirm-backup-manifest-sha256", resource_result.stderr,
        )

        media_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "server.migrations",
                "media-apply",
                "--confirm-schema-version",
                "1",
                "--confirm-identity",
                "identity",
            ],
            cwd=APP_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(2, media_result.returncode)
        self.assertIn("--backup-manifest", media_result.stderr)
        self.assertIn("--backup-database", media_result.stderr)
        self.assertIn("--confirm-backup-manifest-sha256", media_result.stderr)

        media_preflight_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "server.migrations",
                "media-preflight",
                "--confirm-schema-version",
                "140003",
                "--confirm-identity",
                "identity",
                "--override-manifest",
                "reviewed-media.json",
                "--confirm-override-manifest-sha256",
                "a" * 64,
            ],
            cwd=APP_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(2, media_preflight_result.returncode)
        self.assertIn(
            "backup manifest, database and confirmed sha256 are required",
            media_preflight_result.stderr,
        )

    def test_verified_manifest_unlocks_exact_database_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self._database(root)
            blobs = root / "blobs"
            blobs.mkdir()
            backup = load_backup_module()
            environment = {
                **os.environ,
                "DATA_DB": str(source),
                "CUSTOM_CANVAS_BLOB_DIR": str(blobs),
                "ACG_RUNTIME_MODE": "production",
                "ACG_READ_ONLY": "0",
                "ACG_RELEASE_ID": "test-backup-binding",
                "ACG_ALLOW_SCHEMA_MIGRATION": "1",
                "AUTH_SECRET": "test-secret",
            }
            version_result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import json; from server import store; "
                    "print(json.dumps([store.SCHEMA_MIGRATION_VERSION, "
                    "store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION, "
                    "store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION, "
                    "store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION]))",
                ],
                cwd=APP_DIR,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, version_result.returncode, version_result.stderr)
            versions = json.loads(version_result.stdout)
            for index, version in enumerate(versions):
                destination = root / f"backup-{index}.sqlite"
                manifest = root / f"backup-{index}.manifest.json"
                backup.create_backup(source, destination, manifest)
                payload = json.loads(manifest.read_text("utf-8"))
                manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()
                result = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "server.migrations",
                        "apply",
                        "--confirm-version",
                        str(version),
                        "--confirm-identity",
                        payload["source"]["identity"],
                        "--backup-manifest",
                        str(manifest),
                        "--backup-database",
                        str(destination),
                        "--confirm-backup-manifest-sha256",
                        manifest_sha256,
                    ],
                    cwd=APP_DIR,
                    env=environment,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(0, result.returncode, result.stderr)
                migration = json.loads(result.stdout)
                self.assertTrue(migration["applied"])
                self.assertEqual([version], migration["appliedVersions"])
            with sqlite3.connect(source) as conn:
                ledger = conn.execute(
                    "SELECT COUNT(*) FROM schema_migrations WHERE status='success'"
                ).fetchone()[0]
            self.assertGreaterEqual(ledger, len(versions))


if __name__ == "__main__":
    unittest.main()
