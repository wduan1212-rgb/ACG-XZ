import importlib.util
import json
import os
import stat
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


APP_DIR = Path(__file__).resolve().parents[2]
SCRIPT = APP_DIR / "deploy" / "verify_offline_dependencies.py"


def load_module():
    name = f"verify_offline_dependencies_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class OfflineDependencyTests(unittest.TestCase):
    def test_release_locks_are_exact_and_bind_target_runtime_versions(self):
        module = load_module()
        main_pins = module.parse_lock(APP_DIR / "server" / "requirements.lock.txt")
        video_pins = module.parse_lock(
            APP_DIR / "apps" / "video-workshop" / "requirements.lock.txt"
        )
        self.assertEqual("11.3.0", main_pins["pillow"])
        self.assertEqual("0.68.1", main_pins["fastapi"])
        self.assertEqual(18, len(main_pins))
        self.assertEqual("0.139.0", video_pins["fastapi"])
        self.assertEqual("1.27.0", video_pins["onnxruntime"])
        self.assertEqual(36, len(video_pins))

        # The inherited local main .venv predates the Pillow requirement.  The
        # production gate must expose that drift instead of silently accepting
        # an environment that skips image normalization.
        with self.assertRaises(module.DependencyContractError):
            module.verify_installed(
                APP_DIR / ".venv" / "bin" / "python",
                APP_DIR / "server" / "requirements.lock.txt",
            )

    def test_lock_rejects_ranges_markers_and_duplicates(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for text in ("fastapi>=1\n", "fastapi==1; python_version>'3'\n", "A_B==1\na-b==1\n"):
                lock = root / uuid.uuid4().hex
                lock.write_text(text, encoding="utf-8")
                with self.assertRaises(module.DependencyContractError):
                    module.parse_lock(lock)

    def test_wheelhouse_verify_rejects_tamper_extra_and_runtime_drift(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / "requirements.lock.txt"
            lock.write_text("demo==1.0\n", encoding="utf-8")
            wheelhouse = root / "wheelhouse"
            wheelhouse.mkdir()
            wheel = wheelhouse / "demo-1.0-py3-none-any.whl"
            wheel.write_bytes(b"wheel")
            runtime = {
                "implementation": "CPython",
                "python": "3.12.1",
                "machine": "x86_64",
                "sysconfigPlatform": "linux-x86_64",
            }
            manifest = {
                "format": module.FORMAT,
                "lockSha256": module._sha256(lock),
                "runtime": runtime,
                "files": [{"name": wheel.name, "bytes": 5, "sha256": module._sha256(wheel)}],
            }
            (wheelhouse / "wheelhouse.manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
            manifest_digest = module._sha256(
                wheelhouse / "wheelhouse.manifest.json"
            )
            with patch.object(module, "_runtime_identity", return_value=runtime):
                verified = module.verify_wheelhouse(
                    wheelhouse,
                    lock,
                    Path("python"),
                    expected_manifest_sha256=manifest_digest,
                )
                self.assertTrue(verified["ok"])
                self.assertEqual(manifest_digest, verified["manifestSha256"])
                with self.assertRaisesRegex(
                    module.DependencyContractError, "confirmation_mismatch"
                ):
                    module.verify_wheelhouse(
                        wheelhouse,
                        lock,
                        Path("python"),
                        expected_manifest_sha256="0" * 64,
                    )
                wheel.write_bytes(b"other")
                with self.assertRaisesRegex(module.DependencyContractError, "hash_mismatch"):
                    module.verify_wheelhouse(wheelhouse, lock, Path("python"))
                wheel.write_bytes(b"wheel")
                (wheelhouse / "extra.whl").write_bytes(b"x")
                with self.assertRaisesRegex(module.DependencyContractError, "unexpected_files"):
                    module.verify_wheelhouse(wheelhouse, lock, Path("python"))
            with patch.object(module, "_runtime_identity", return_value={**runtime, "python": "3.11.9"}):
                with self.assertRaisesRegex(module.DependencyContractError, "runtime_mismatch"):
                    module.verify_wheelhouse(wheelhouse, lock, Path("python"))

    def test_build_refuses_existing_output_before_running_pip(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / "requirements.lock.txt"
            lock.write_text("demo==1.0\n", encoding="utf-8")
            output = root / "wheelhouse"
            output.mkdir()
            with self.assertRaisesRegex(module.DependencyContractError, "already_exists"):
                module.build_wheelhouse(Path(os.sys.executable), lock, output)


if __name__ == "__main__":
    unittest.main()
