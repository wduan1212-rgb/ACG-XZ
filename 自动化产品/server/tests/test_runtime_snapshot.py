import importlib.util
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


APP_DIR = Path(__file__).resolve().parents[2]
SCRIPT = APP_DIR / "server" / "scripts" / "runtime_snapshot.py"


def load_module():
    name = f"runtime_snapshot_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class RuntimeSnapshotTests(unittest.TestCase):
    def test_release_plan_names_every_protected_runtime_component(self):
        required = {
                "database",
                "legacy-data",
                "uploads",
                "composed",
                "canvas-blobs",
                "model-usage-spool",
                "video-projects",
                "video-uploads",
                "video-outputs",
                "bgm-library",
                "runtime-env",
                "systemd-unit",
                "nginx-site",
        }
        plan = json.loads(
            (APP_DIR / "deploy" / "runtime-snapshot.plan.example.json").read_text(
                "utf-8"
            )
        )
        self.assertTrue(required.issubset({item["name"] for item in plan["components"]}))

        production = json.loads(
            (
                APP_DIR
                / "deploy"
                / "runtime-snapshot.production-v120.plan.example.json"
            ).read_text("utf-8")
        )
        self.assertEqual("acg-production-complete-v1", production["profile"])
        production_names = {item["name"] for item in production["components"]}
        self.assertTrue(
            {
                "database",
                "uploads",
                "composed",
                "canvas-blobs",
                "model-usage-spool",
                "video-projects",
                "video-uploads",
                "video-outputs",
                "model-cache",
                "runtime-env-public",
                "runtime-env-private",
                "runtime-env-v140",
                "systemd-main",
                "systemd-video",
                "nginx-site",
            }.issubset(production_names)
        )
        database = next(
            item for item in production["components"] if item["name"] == "database"
        )
        self.assertEqual(
            "/data/dumate-studio/current/server/data.sqlite", database["path"]
        )

    def _fixture(self, root: Path):
        persistent = root / "persistent"
        persistent.mkdir()
        database = persistent / "data.sqlite"
        with sqlite3.connect(database) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT)")
            conn.executemany("INSERT INTO records(value) VALUES(?)", [("a",), ("b",)])
        uploads = persistent / "uploads"
        uploads.mkdir()
        (uploads / "one.png").write_bytes(b"image-one")
        nested = uploads / "nested"
        nested.mkdir()
        (nested / "two.mp4").write_bytes(b"video-two")
        env = persistent / "runtime.env"
        env.write_text("SECRET=fixture\n", encoding="utf-8")
        plan = root / "plan.json"
        plan.write_text(
            json.dumps(
                {
                    "format": "acg-runtime-snapshot-plan-v1",
                    "releaseId": "test-release",
                    "components": [
                        {"name": "database", "type": "sqlite", "path": str(database)},
                        {"name": "uploads", "type": "directory", "path": str(uploads)},
                        {"name": "runtime-env", "type": "file", "path": str(env)},
                        {
                            "name": "optional-auth",
                            "type": "file",
                            "path": str(persistent / "missing-auth"),
                            "required": False,
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        return persistent, plan

    def test_complete_snapshot_verifies_and_restores_to_isolation(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            snapshot = root / "snapshot"
            manifest = module.create_snapshot(plan, persistent, snapshot)
            self.assertEqual("test-release", manifest["releaseId"])
            self.assertEqual(4, len(manifest["components"]))
            database_component = next(
                item for item in manifest["components"] if item["name"] == "database"
            )
            self.assertEqual("ok", database_component["quickCheck"])
            manifest_sha256 = (snapshot / "snapshot.manifest.sha256").read_text(
                "ascii"
            ).strip()
            self.assertTrue(module.verify_snapshot(
                snapshot,
                expected_manifest_sha256=manifest_sha256,
            )["ok"])

            restored = root / "restored"
            report = module.restore_drill(
                snapshot,
                restored,
                expected_manifest_sha256=manifest_sha256,
            )
            self.assertTrue(report["ok"])
            self.assertEqual(b"image-one", (restored / "uploads" / "one.png").read_bytes())
            self.assertEqual(b"video-two", (restored / "uploads" / "nested" / "two.mp4").read_bytes())
            with sqlite3.connect(restored / "database") as conn:
                self.assertEqual(2, conn.execute("SELECT COUNT(*) FROM records").fetchone()[0])
            self.assertTrue((restored / "restore.report.json").is_file())

    def test_snapshot_tamper_is_rejected_and_does_not_replace_restore_target(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            snapshot = root / "snapshot"
            module.create_snapshot(plan, persistent, snapshot)
            archive = snapshot / "components" / "uploads.tar"
            archive.write_bytes(archive.read_bytes() + b"tamper")
            with self.assertRaisesRegex(module.SnapshotError, "artifact_(size|hash)_mismatch"):
                module.verify_snapshot(snapshot)
            target = root / "restore"
            target.mkdir()
            marker = target / "keep"
            marker.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(module.SnapshotError, "artifact_(size|hash)_mismatch"):
                module.restore_drill(
                    snapshot,
                    target,
                    expected_manifest_sha256=(
                        snapshot / "snapshot.manifest.sha256"
                    ).read_text("ascii").strip(),
                )
            self.assertEqual("keep", marker.read_text("utf-8"))

    def test_restore_requires_independently_confirmed_manifest_digest(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            snapshot = root / "snapshot"
            module.create_snapshot(plan, persistent, snapshot)
            with self.assertRaisesRegex(
                module.SnapshotError, "confirmation_required"
            ):
                module.restore_drill(
                    snapshot,
                    root / "restore-missing-confirmation",
                    expected_manifest_sha256="",
                )
            with self.assertRaisesRegex(
                module.SnapshotError, "confirmation_mismatch"
            ):
                module.restore_drill(
                    snapshot,
                    root / "restore-wrong-confirmation",
                    expected_manifest_sha256="0" * 64,
                )

    def test_plan_rejects_symlink_and_outside_directory(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            outside = root / "outside"
            outside.mkdir()
            payload = json.loads(plan.read_text("utf-8"))
            payload["components"][1]["path"] = str(outside)
            plan.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(module.SnapshotError, "outside_persistent_root"):
                module.create_snapshot(plan, persistent, root / "snapshot")

            payload["components"][1]["path"] = str(persistent / "uploads-link")
            os.symlink(persistent / "uploads", persistent / "uploads-link")
            plan.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(module.SnapshotError, "symlink"):
                module.create_snapshot(plan, persistent, root / "snapshot")

    def test_snapshot_and_restore_refuse_existing_outputs(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            output = root / "existing"
            output.mkdir()
            with self.assertRaisesRegex(module.SnapshotError, "already_exists"):
                module.create_snapshot(plan, persistent, output)

    def test_production_profile_rejects_an_incomplete_component_set(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            payload = json.loads(plan.read_text("utf-8"))
            payload["profile"] = module.PRODUCTION_COMPLETE_PROFILE
            plan.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(
                module.SnapshotError, "production_profile_component_set_invalid"
            ):
                module.create_snapshot(plan, persistent, root / "snapshot")

    def test_production_profile_rejects_wrong_type_requirement_path_and_absence(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            persistent = Path(tmp) / "persistent"
            persistent.mkdir()
            components = []
            for name, (kind, required, relative, outside) in (
                module.PRODUCTION_COMPLETE_COMPONENTS.items()
            ):
                path = (
                    persistent / relative
                    if relative is not None
                    else Path(tmp) / f"outside-{name}"
                )
                components.append({
                    "name": name,
                    "type": kind,
                    "path": path,
                    "source": str(path),
                    "required": required,
                    "allowOutsidePersistentRoot": outside,
                })

            wrong_type = [dict(item) for item in components]
            next(item for item in wrong_type if item["name"] == "uploads")[
                "type"
            ] = "file"
            with self.assertRaisesRegex(module.SnapshotError, "type_invalid:uploads"):
                module._validate_production_component_contract(
                    wrong_type, persistent, snapshot=False
                )

            wrong_required = [dict(item) for item in components]
            next(item for item in wrong_required if item["name"] == "uploads")[
                "required"
            ] = False
            with self.assertRaisesRegex(
                module.SnapshotError, "required_invalid:uploads"
            ):
                module._validate_production_component_contract(
                    wrong_required, persistent, snapshot=False
                )

            wrong_path = [dict(item) for item in components]
            next(item for item in wrong_path if item["name"] == "uploads")[
                "path"
            ] = persistent / "wrong-uploads"
            with self.assertRaisesRegex(module.SnapshotError, "path_invalid:uploads"):
                module._validate_production_component_contract(
                    wrong_path, persistent, snapshot=False
                )

            absent = [dict(item) for item in components]
            next(item for item in absent if item["name"] == "uploads")[
                "state"
            ] = "absent"
            with self.assertRaisesRegex(module.SnapshotError, "component_absent:uploads"):
                module._validate_production_component_contract(
                    absent, persistent, snapshot=True
                )

    def test_media_inventory_digest_changes_on_same_size_same_mtime_content_drift(self):
        module = load_module()
        components = [
            {
                "name": name,
                "type": "directory",
                "files": [{
                    "path": "same.bin",
                    "bytes": 4,
                    "mtimeNs": 100,
                    "sha256": "0" * 64,
                    "mode": 0o600,
                }],
            }
            for name in sorted(module.PRODUCTION_MEDIA_COMPONENTS)
        ]
        first = module._media_inventory_digest_from_components(components)
        changed = [
            {**item, "files": [dict(item["files"][0])]} for item in components
        ]
        changed[0]["files"][0]["sha256"] = "1" * 64
        second = module._media_inventory_digest_from_components(changed)
        self.assertNotEqual(first, second)

    def test_snapshot_verify_rejects_duplicate_component_names(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            snapshot = root / "snapshot"
            module.create_snapshot(plan, persistent, snapshot)
            manifest_path = snapshot / "snapshot.manifest.json"
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["components"].append(dict(manifest["components"][0]))
            encoded = (
                json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)
                + "\n"
            ).encode("utf-8")
            manifest_path.write_bytes(encoded)
            (snapshot / "snapshot.manifest.sha256").write_text(
                hashlib.sha256(encoded).hexdigest() + "\n",
                encoding="ascii",
            )
            with self.assertRaisesRegex(
                module.SnapshotError, "component_name_duplicate"
            ):
                module.verify_snapshot(snapshot)

    def test_directory_snapshot_rejects_file_added_during_archive(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            original_verify = module._verify_archive
            added = False

            def verify_then_add(archive, entries):
                nonlocal added
                original_verify(archive, entries)
                if not added and archive.name == "uploads.tar":
                    added = True
                    (persistent / "uploads" / "late.bin").write_bytes(b"late")

            with patch.object(module, "_verify_archive", side_effect=verify_then_add):
                with self.assertRaisesRegex(
                    module.SnapshotError, "source_changed_during_snapshot"
                ):
                    module.create_snapshot(plan, persistent, root / "snapshot")

    def test_file_snapshot_rejects_same_size_same_mtime_content_drift(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            original_copy = module.shutil.copyfile

            def copy_then_mutate(source, destination, *args, **kwargs):
                result = original_copy(source, destination, *args, **kwargs)
                source_path = Path(source)
                if source_path.name == "runtime.env":
                    info = source_path.stat()
                    source_path.write_bytes(b"X" * info.st_size)
                    os.utime(
                        source_path,
                        ns=(info.st_atime_ns, info.st_mtime_ns),
                    )
                return result

            with patch.object(
                module.shutil, "copyfile", side_effect=copy_then_mutate,
            ):
                with self.assertRaisesRegex(
                    module.SnapshotError, "source_changed_during_snapshot"
                ):
                    module.create_snapshot(plan, persistent, root / "snapshot")


if __name__ == "__main__":
    unittest.main()
