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
            self.assertEqual("acg-sqlite-backup-v1", payload["format"])
            self.assertEqual("ok", payload["quickCheck"])
            self.assertEqual(destination.stat().st_size, payload["bytes"])
            self.assertEqual(
                hashlib.sha256(destination.read_bytes()).hexdigest(),
                payload["sha256"],
            )
            with sqlite3.connect(destination) as conn:
                self.assertEqual(20, conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
                self.assertEqual("ok", conn.execute("PRAGMA quick_check").fetchone()[0])
            self.assertFalse(any(".partial-" in path.name for path in root.iterdir()))

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


if __name__ == "__main__":
    unittest.main()
