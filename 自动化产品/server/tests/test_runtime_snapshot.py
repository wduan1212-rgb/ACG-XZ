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
        policies = {
            item["name"]: item.get("dereferenceInternalSymlinks", False)
            for item in production["components"]
        }
        self.assertEqual(
            {"model-cache", "nginx-site"},
            {name for name, enabled in policies.items() if enabled},
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

    def test_nonproduction_plan_cannot_enable_symlink_dereference(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent, plan = self._fixture(root)
            payload = json.loads(plan.read_text("utf-8"))
            payload["components"][2]["dereferenceInternalSymlinks"] = True
            plan.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(
                module.SnapshotError, "dereference_not_allowed:runtime-env"
            ):
                module.create_snapshot(plan, persistent, root / "snapshot")

    def test_approved_symlinks_are_hashed_and_restored_as_regular_files(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            persistent = root / "persistent"
            persistent.mkdir()
            database = persistent / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE records(id INTEGER PRIMARY KEY)")
            model_cache = persistent / "model-cache"
            blob = model_cache / "blobs" / "sha256-model"
            blob.parent.mkdir(parents=True)
            blob.write_bytes(b"trusted-model-bytes")
            snapshot_dir = model_cache / "snapshots" / "revision-one"
            snapshot_dir.mkdir(parents=True)
            os.symlink("../../blobs/sha256-model", snapshot_dir / "model.bin")
            nginx = root / "etc" / "nginx"
            nginx_enabled = nginx / "sites-enabled"
            nginx_available = nginx / "sites-available"
            nginx_enabled.mkdir(parents=True)
            nginx_available.mkdir()
            nginx_target = nginx_available / "site.conf"
            nginx_target.write_text("server { listen 80; }\n", encoding="utf-8")
            nginx_source = nginx_enabled / "site.conf"
            os.symlink("../sites-available/site.conf", nginx_source)
            plan = root / "plan.json"
            plan.write_text(
                json.dumps({
                    "format": module.PLAN_FORMAT,
                    "profile": module.PRODUCTION_COMPLETE_PROFILE,
                    "releaseId": "symlink-test",
                    "components": [
                        {
                            "name": "database",
                            "type": "sqlite",
                            "path": str(database),
                        },
                        {
                            "name": "model-cache",
                            "type": "directory",
                            "path": str(model_cache),
                            "dereferenceInternalSymlinks": True,
                        },
                        {
                            "name": "nginx-site",
                            "type": "file",
                            "path": str(nginx_source),
                            "allowOutsidePersistentRoot": True,
                            "dereferenceInternalSymlinks": True,
                        },
                    ],
                }),
                encoding="utf-8",
            )
            contract = {
                "database": (
                    "sqlite", True, str(database), False, False,
                ),
                "model-cache": (
                    "directory", True, str(model_cache), False, True,
                ),
                "nginx-site": (
                    "file", True, str(nginx_source), True, True,
                ),
            }
            with patch.object(
                module, "PRODUCTION_COMPLETE_COMPONENTS", contract
            ), patch.dict(
                module.PRODUCTION_COMPONENT_SYMLINK_ROOTS,
                {"nginx-site": nginx},
                clear=True,
            ):
                snapshot = root / "snapshot"
                manifest = module.create_snapshot(plan, persistent, snapshot)
                digest = (snapshot / "snapshot.manifest.sha256").read_text(
                    "ascii"
                ).strip()
                self.assertTrue(module.verify_snapshot(
                    snapshot, expected_manifest_sha256=digest,
                )["ok"])
                model_component = next(
                    item for item in manifest["components"]
                    if item["name"] == "model-cache"
                )
                linked_entry = next(
                    item for item in model_component["files"]
                    if item["path"] == "snapshots/revision-one/model.bin"
                )
                self.assertTrue(linked_entry["dereferencedSymlink"])
                self.assertEqual("blobs/sha256-model", linked_entry["targetPath"])
                self.assertEqual(
                    hashlib.sha256(b"trusted-model-bytes").hexdigest(),
                    linked_entry["sha256"],
                )
                nginx_component = next(
                    item for item in manifest["components"]
                    if item["name"] == "nginx-site"
                )
                self.assertTrue(nginx_component["sourceWasSymlink"])
                self.assertEqual(
                    hashlib.sha256(b"server { listen 80; }\n").hexdigest(),
                    nginx_component["artifactSha256"],
                )
                restored = root / "restored"
                module.restore_drill(
                    snapshot,
                    restored,
                    expected_manifest_sha256=digest,
                )
                restored_model = (
                    restored / "model-cache" / "snapshots" / "revision-one"
                    / "model.bin"
                )
                self.assertFalse(restored_model.is_symlink())
                self.assertEqual(b"trusted-model-bytes", restored_model.read_bytes())
                restored_nginx = restored / "nginx-site"
                self.assertFalse(restored_nginx.is_symlink())
                self.assertEqual(
                    b"server { listen 80; }\n", restored_nginx.read_bytes()
                )

    def test_model_cache_symlink_policy_rejects_unsafe_targets(self):
        module = load_module()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "cache"
            root.mkdir()
            (root / "blob.bin").write_bytes(b"inside")
            os.symlink("blob.bin", root / "model.bin")
            with self.assertRaisesRegex(
                module.SnapshotError, "file_symlink_rejected"
            ):
                module._directory_inventory(root)

        def assert_rejected(setup, pattern):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "cache"
                root.mkdir()
                setup(root)
                with self.assertRaisesRegex(module.SnapshotError, pattern):
                    module._directory_inventory(
                        root, dereference_internal_symlinks=True,
                    )

        def outside(root):
            target = root.parent / "outside.bin"
            target.write_bytes(b"outside")
            os.symlink("../outside.bin", root / "model.bin")

        def absolute(root):
            target = root / "blob.bin"
            target.write_bytes(b"inside")
            os.symlink(str(target), root / "model.bin")

        def nested_absolute(root):
            target = root / "blob.bin"
            target.write_bytes(b"inside")
            os.symlink(str(target), root / "second-link.bin")
            os.symlink("second-link.bin", root / "model.bin")

        def dangling(root):
            os.symlink("missing.bin", root / "model.bin")

        def loop(root):
            os.symlink("second.bin", root / "first.bin")
            os.symlink("first.bin", root / "second.bin")

        def directory(root):
            target = root / "target-dir"
            target.mkdir()
            os.symlink("target-dir", root / "linked-dir")

        def special(root):
            target = root / "pipe"
            os.mkfifo(target)
            os.symlink("pipe", root / "model.bin")

        assert_rejected(outside, "target_outside_component")
        assert_rejected(absolute, "absolute_symlink_rejected")
        assert_rejected(nested_absolute, "absolute_symlink_rejected")
        assert_rejected(dangling, "dangling_symlink_rejected")
        assert_rejected(loop, "symlink_loop_rejected")
        assert_rejected(directory, "directory_symlink_rejected")
        assert_rejected(special, "special_file_rejected")

    def test_nginx_component_symlink_is_scoped_to_explicit_root(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nginx = root / "etc" / "nginx"
            enabled = nginx / "sites-enabled"
            available = nginx / "sites-available"
            enabled.mkdir(parents=True)
            available.mkdir()
            source = enabled / "site.conf"
            target = available / "site.conf"
            target.write_text("server {}\n", encoding="utf-8")
            os.symlink("../sites-available/site.conf", source)
            item = {
                "name": "nginx-site",
                "path": source,
                "dereferenceInternalSymlinks": True,
            }
            with patch.dict(
                module.PRODUCTION_COMPONENT_SYMLINK_ROOTS,
                {"nginx-site": nginx},
                clear=True,
            ):
                resolved, _info, metadata = module._file_component_source(item)
                self.assertEqual(target.resolve(), resolved)
                self.assertTrue(metadata["sourceWasSymlink"])
                source.unlink()
                os.symlink(str(target.resolve()), source)
                absolute_resolved, _info, _metadata = (
                    module._file_component_source(item)
                )
                self.assertEqual(target.resolve(), absolute_resolved)
                external = root / "outside.conf"
                external.write_text("outside\n", encoding="utf-8")
                source.unlink()
                os.symlink(str(external), source)
                with self.assertRaisesRegex(
                    module.SnapshotError, "target_outside_component"
                ):
                    module._file_component_source(item)

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
            for name, (kind, required, relative, outside, dereference) in (
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
                    "dereferenceInternalSymlinks": dereference,
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

            wrong_dereference = [dict(item) for item in components]
            next(
                item for item in wrong_dereference
                if item["name"] == "model-cache"
            )["dereferenceInternalSymlinks"] = False
            with self.assertRaisesRegex(
                module.SnapshotError, "dereference_invalid:model-cache"
            ):
                module._validate_production_component_contract(
                    wrong_dereference, persistent, snapshot=False
                )
            wrong_scope = [dict(item) for item in components]
            next(
                item for item in wrong_scope if item["name"] == "uploads"
            )["dereferenceInternalSymlinks"] = True
            with self.assertRaisesRegex(
                module.SnapshotError, "dereference_invalid:uploads"
            ):
                module._validate_production_component_contract(
                    wrong_scope, persistent, snapshot=False
                )
            next(
                item for item in wrong_dereference
                if item["name"] == "model-cache"
            )["dereferenceInternalSymlinks"] = "true"
            with self.assertRaisesRegex(
                module.SnapshotError, "dereference_invalid:model-cache"
            ):
                module._validate_production_component_contract(
                    wrong_dereference, persistent, snapshot=False
                )

            absent = [dict(item) for item in components]
            next(item for item in absent if item["name"] == "uploads")[
                "state"
            ] = "absent"
            with self.assertRaisesRegex(module.SnapshotError, "component_absent:uploads"):
                module._validate_production_component_contract(
                    absent, persistent, snapshot=True
                )

    def test_production_runtime_environment_path_is_config_scoped(self):
        module = load_module()
        module._validate_production_runtime_env_path(
            Path("/data/dumate-studio/config/runtime-v140-0d690d6.env")
        )
        module._validate_production_runtime_env_path(
            Path("/data/dumate-studio/config/runtime-v140.env")
        )
        for path in (
            Path("/tmp/runtime-v140.env"),
            Path("/data/dumate-studio/config/runtime-v139.env"),
            Path("/data/dumate-studio/config/nested/runtime-v140.env"),
        ):
            with self.subTest(path=path), self.assertRaisesRegex(
                module.SnapshotError, "path_invalid:runtime-env-v140"
            ):
                module._validate_production_runtime_env_path(path)

    def test_production_profile_binds_both_systemd_units_to_snapshotted_env(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "config"
            config.mkdir()
            runtime_env = config / "runtime-v140-release.env"
            runtime_env.write_text("ACG_ENV=production\n", encoding="utf-8")
            main_unit = root / "main.service"
            video_unit = root / "video.service"
            for unit in (main_unit, video_unit):
                unit.write_text(
                    "[Service]\nEnvironmentFile=-"
                    f"{runtime_env}\n",
                    encoding="utf-8",
                )
            components = [
                {
                    "name": "runtime-env-v140",
                    "path": runtime_env,
                    "contentPath": runtime_env,
                },
                {
                    "name": "systemd-main",
                    "contentPath": main_unit,
                },
                {
                    "name": "systemd-video",
                    "contentPath": video_unit,
                },
            ]
            with patch.object(module, "PRODUCTION_RUNTIME_ENV_ROOT", config):
                module._validate_production_systemd_environment_binding(components)
                video_unit.write_text(
                    "[Service]\nEnvironmentFile=/wrong/runtime.env\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    module.SnapshotError,
                    "systemd_environment_mismatch:systemd-video",
                ):
                    module._validate_production_systemd_environment_binding(
                        components
                    )

    def test_production_profile_rejects_absent_snapshotted_runtime_env(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "config"
            config.mkdir()
            runtime_env = config / "runtime-v140-release.env"
            main_unit = root / "main.service"
            main_unit.write_text(
                f"[Service]\nEnvironmentFile={runtime_env}\n",
                encoding="utf-8",
            )
            components = [
                {
                    "name": "runtime-env-v140",
                    "path": runtime_env,
                    "contentPath": runtime_env,
                },
                {
                    "name": "systemd-main",
                    "contentPath": main_unit,
                },
                {
                    "name": "systemd-video",
                    "contentPath": main_unit,
                },
            ]
            with patch.object(module, "PRODUCTION_RUNTIME_ENV_ROOT", config):
                with self.assertRaisesRegex(
                    module.SnapshotError, "runtime_environment_missing"
                ):
                    module._validate_production_systemd_environment_binding(
                        components
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
