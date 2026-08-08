import importlib.util
import json
import os
import stat
import subprocess
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
        test_pins = module.parse_lock(
            APP_DIR / "server" / "requirements-test.lock.txt"
        )
        video_pins = module.parse_lock(
            APP_DIR / "apps" / "video-workshop" / "requirements.lock.txt"
        )
        self.assertEqual("11.3.0", main_pins["pillow"])
        self.assertEqual("0.68.1", main_pins["fastapi"])
        self.assertEqual("1.10.26", main_pins["pydantic"])
        self.assertEqual(18, len(main_pins))
        extension = module.verify_lock_extension(
            APP_DIR / "server" / "requirements.lock.txt",
            APP_DIR / "server" / "requirements-test.lock.txt",
            allowed_extras={"requests", "urllib3"},
        )
        self.assertEqual(20, extension["extendedPackageCount"])
        self.assertEqual(["requests", "urllib3"], extension["extras"])
        self.assertEqual("2.28.2", test_pins["requests"])
        self.assertEqual("1.26.20", test_pins["urllib3"])
        self.assertEqual("0.139.0", video_pins["fastapi"])
        self.assertEqual("1.27.0", video_pins["onnxruntime"])
        self.assertEqual("83.0.0", video_pins["setuptools"])
        self.assertEqual(37, len(video_pins))
        self.assertNotIn("setuptools", module.IGNORED_INSTALLED)

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

    def test_test_lock_extension_rejects_runtime_drift_and_undeclared_extras(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / "runtime.lock"
            extended = root / "test.lock"
            base.write_text("fastapi==1\npydantic==1\n", encoding="utf-8")
            extended.write_text(
                "fastapi==2\npydantic==1\nrequests==1\npytest==1\n",
                encoding="utf-8",
            )
            with self.assertRaises(module.DependencyContractError) as denied:
                module.verify_lock_extension(
                    base,
                    extended,
                    allowed_extras={"requests", "urllib3"},
                )
            payload = json.loads(str(denied.exception))
            self.assertEqual("2", payload["drift"][0]["actual"])
            self.assertEqual(["pytest"], payload["unexpectedExtras"])
            self.assertEqual(["urllib3"], payload["requiredExtrasMissing"])

    def test_locked_test_runner_is_offline_and_refuses_local_secret_files(self):
        script = (
            APP_DIR / "tools" / "run_locked_server_tests.sh"
        ).read_text("utf-8")
        self.assertIn("--no-index", script)
        self.assertIn("requirements-test.lock.txt", script)
        self.assertIn("Secret-free test refused", script)
        self.assertIn("env -i", script)
        self.assertIn("lsof", script)
        self.assertIn("run_server_unittest_suite.py", script)
        suite_runner = (
            APP_DIR / "tools" / "run_server_unittest_suite.py"
        ).read_text("utf-8")
        self.assertIn("unexpected skipped tests", suite_runner)
        self.assertIn("test_real_v120_snapshot_copy", suite_runner)

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

    def test_installed_contract_rejects_unlocked_setuptools_and_runs_pip_check(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "requirements.lock.txt"
            lock.write_text("demo==1.0\n", encoding="utf-8")
            runtime = {
                "implementation": "CPython",
                "python": "3.12.3",
                "machine": "x86_64",
                "sysconfigPlatform": "linux-x86_64",
            }
            with patch.object(
                module,
                "installed_versions",
                return_value=({"demo": "1.0", "setuptools": "83.0.0"}, runtime),
            ):
                with self.assertRaisesRegex(
                    module.DependencyContractError, r'"unexpected": \["setuptools"\]'
                ):
                    module.verify_installed(Path(os.sys.executable), lock)

            failed = subprocess.CompletedProcess(
                [os.sys.executable, "-m", "pip", "check"],
                1,
                stdout="demo 1.0 requires missing-package",
                stderr="",
            )
            with (
                patch.object(
                    module,
                    "installed_versions",
                    return_value=({"demo": "1.0"}, runtime),
                ),
                patch.object(module.subprocess, "run", return_value=failed),
            ):
                with self.assertRaisesRegex(
                    module.DependencyContractError, "pip_check_failed"
                ):
                    module.verify_installed(Path(os.sys.executable), lock)

    def test_install_check_uses_no_deps_offline_venv_before_pip_check(self):
        module = load_module()
        runtime = {
            "implementation": "CPython",
            "python": "3.12.3",
            "machine": "x86_64",
            "sysconfigPlatform": "linux-x86_64",
        }
        completed = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / "requirements.lock.txt"
            lock.write_text("demo==1.0\n", encoding="utf-8")
            wheelhouse = root / "wheelhouse"
            wheelhouse.mkdir()
            with (
                patch.object(
                    module,
                    "verify_wheelhouse",
                    return_value={
                        "root": str(wheelhouse),
                        "manifestSha256": "a" * 64,
                        "lockSha256": "b" * 64,
                        "fileCount": 1,
                    },
                ),
                patch.object(
                    module,
                    "verify_installed",
                    return_value={
                        "packageCount": 1,
                        "pipCheck": "ok",
                        "runtime": runtime,
                    },
                ) as installed,
                patch.object(module.subprocess, "run", return_value=completed) as run,
            ):
                result = module.verify_offline_install(
                    Path(os.sys.executable),
                    lock,
                    wheelhouse,
                    expected_manifest_sha256="a" * 64,
                )
            install_command = run.call_args_list[1].args[0]
            self.assertIn("--no-index", install_command)
            self.assertIn("--no-deps", install_command)
            self.assertIn("--requirement", install_command)
            installed.assert_called_once()
            self.assertEqual("ok", result["pipCheck"])


if __name__ == "__main__":
    unittest.main()
