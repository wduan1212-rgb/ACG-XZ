import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote


APP_DIR = Path(__file__).resolve().parents[2]
START_SERVER = APP_DIR / "deploy" / "start_server.sh"
DOCKER_ENTRYPOINT = APP_DIR / "deploy" / "docker_entrypoint.sh"
DOCKERFILE = APP_DIR / "server" / "Dockerfile"
DOCKERIGNORE = APP_DIR / ".dockerignore"
RELEASE_ID = json.loads(
    (APP_DIR / "deploy" / "release-runtime.manifest.json").read_text("utf-8")
)["releaseId"]


class DeployRuntimeSafetyTests(unittest.TestCase):
    @staticmethod
    def _embedded_python(script: Path, function_name: str) -> str:
        source = script.read_text("utf-8")
        function_source = source.split(f"{function_name}() {{", 1)[1]
        heredoc_source = function_source.split("<<'PY'\n", 1)[1]
        return heredoc_source.split("\nPY\n", 1)[0]

    def _preflight_env(self, script: Path, root: Path) -> dict[str, str]:
        env = self._base_production_env(root)
        env.update({
            "FALLBACK_ENV": env["ACG_ENV_FILE"],
            "BACKUP_ROOT": str(root / "backups"),
            "LOG_DIR": str(root / "logs"),
        })
        if script == START_SERVER:
            env.update({
                "APP_DIR": str(APP_DIR),
                "ACG_RELEASE_ROOT": str(APP_DIR),
            })
        else:
            env["ACG_RELEASE_ROOT"] = "/app"
        return env

    def _run_embedded_preflight(
        self,
        script: Path,
        env: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-c",
                self._embedded_python(script, "production_preflight"),
            ],
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def _run_embedded_health_gate(
        self,
        script: Path,
        function_name: str,
        payload: dict,
        *,
        use_ready_token: bool,
        require_service_ready: bool,
    ) -> subprocess.CompletedProcess[str]:
        code = self._embedded_python(script, function_name)
        self.assertEqual(1, code.count("for _ in range(40):"))
        code = code.replace("for _ in range(40):", "for _ in range(1):")
        url = "data:application/json," + quote(
            json.dumps(payload, separators=(",", ":"))
        )
        return subprocess.run(
            [
                sys.executable,
                "-c",
                code,
                url,
                "runtime gate",
                "1" if use_ready_token else "0",
                "1" if require_service_ready else "0",
            ],
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "ACG_RELEASE_ID": "release-current",
                "ACG_READY_TOKEN": "ready-token",
                "ACG_READ_ONLY": "1",
            },
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def _write_shutdown_harness(self, root: Path) -> Path:
        source = START_SERVER.read_text("utf-8")
        start = source.index("readonly STOP_WAIT_ATTEMPTS=")
        end = source.index("wait_for_health() {", start)
        functions = source[start:end]
        functions = functions.replace(
            "readonly STOP_WAIT_ATTEMPTS=20",
            "readonly STOP_WAIT_ATTEMPTS=3",
        ).replace(
            "readonly STOP_WAIT_INTERVAL_SECONDS=0.25",
            "readonly STOP_WAIT_INTERVAL_SECONDS=0.05",
        )
        harness = root / "shutdown-harness.sh"
        harness.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"{functions}\n"
            "shutdown_failed=0\n"
            "if [ \"${TEST_STOP_PID:-0}\" = \"1\" ]; then\n"
            "  if ! stop_pid_file \"$TEST_PID_FILE\"; then shutdown_failed=1; fi\n"
            "fi\n"
            "if [ \"${TEST_STOP_PORT:-0}\" = \"1\" ]; then\n"
            "  if ! stop_port \"$TEST_PORT\"; then shutdown_failed=1; fi\n"
            "fi\n"
            "if [ \"$shutdown_failed\" -ne 0 ]; then\n"
            "  echo \"Runtime shutdown could not be proven; refusing backup and startup.\" >&2\n"
            "  exit 70\n"
            "fi\n"
            "printf backup > \"$TEST_BACKUP_MARKER\"\n",
            encoding="utf-8",
        )
        harness.chmod(0o755)
        return harness

    def _start_term_ignoring_process(self) -> subprocess.Popen[str]:
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import signal,time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "print('ready', flush=True)\n"
                "while True: time.sleep(1)\n",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertIsNotNone(process.stdout)
        self.assertEqual("ready", process.stdout.readline().strip())
        return process

    @staticmethod
    def _terminate_test_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()

    def _write_fake_lsof(self, root: Path, source: str) -> Path:
        bin_dir = root / "bin"
        bin_dir.mkdir()
        executable = bin_dir / "lsof"
        executable.write_text(source, encoding="utf-8")
        executable.chmod(0o755)
        return bin_dir

    def _base_production_env(self, root: Path) -> dict[str, str]:
        env_file = root / "runtime.env"
        env_file.write_text("# mounted production configuration\n", encoding="utf-8")
        database = root / "data.sqlite"
        with sqlite3.connect(database) as conn:
            conn.execute("CREATE TABLE keep_me (id INTEGER PRIMARY KEY)")
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "ACG_RUNTIME_MODE": "production",
            "ACG_DB_BOOTSTRAP_MODE": "validate",
            "ACG_READ_ONLY": "1",
            "ACG_REQUIRE_INTERNAL_TEAM": "1",
            "ACG_PERSISTENT_ROOT": str(root),
            "ACG_ENV_FILE": str(env_file),
            "ACG_RELEASE_ID": RELEASE_ID,
            "ACG_READY_TOKEN": "test-ready-token",
            "DATA_DB": str(database),
            "LEGACY_DATA_FILE": str(root / "data.json"),
            "UPLOAD_DIR": str(root / "uploads"),
            "COMPOSED_DIR": str(root / "composed"),
            "CUSTOM_CANVAS_BLOB_DIR": str(root / "canvas_blobs"),
            "VIDEO_WORKSHOP_PROJECTS_DIR": str(root / "video-workshop" / "projects"),
            "VIDEO_WORKSHOP_OUTPUT_DIR": str(root / "video-workshop" / "outputs"),
            "VIDEO_WORKSHOP_UPLOAD_DIR": str(root / "video-workshop" / "uploads"),
            "VIDEO_WORKSHOP_PORT": "8765",
            "VIDEO_WORKSHOP_URL": "http://127.0.0.1:8765",
            "VIDEO_WORKSHOP_HEALTH_URL": "http://127.0.0.1:8765",
            "HF_HOME": str(root / "model-cache"),
            "BGM_SOURCE": "platform",
        }

    def test_non_docker_production_preflight_does_not_create_missing_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self._preflight_env(START_SERVER, root)
            result = self._run_embedded_preflight(START_SERVER, env)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("Production runtime preflight failed", result.stderr)
            self.assertFalse((root / "backups").exists())
            self.assertFalse((root / "logs").exists())
            self.assertFalse((root / "video-workshop").exists())

    def test_docker_production_preflight_does_not_create_missing_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self._base_production_env(root)
            env["ACG_RELEASE_ROOT"] = "/app"

            result = subprocess.run(
                ["bash", str(DOCKER_ENTRYPOINT)],
                cwd=APP_DIR,
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(0, result.returncode)
            self.assertIn("Release contract verifier is missing", result.stderr)
            self.assertFalse((root / "uploads").exists())
            self.assertFalse((root / "video-workshop").exists())

    def test_production_read_write_mode_is_rejected_before_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self._preflight_env(START_SERVER, root)
            env["ACG_READ_ONLY"] = "0"
            result = self._run_embedded_preflight(START_SERVER, env)

            self.assertNotEqual(0, result.returncode)
            self.assertIn(
                "ACG_READ_ONLY must be enabled for this production release",
                result.stderr,
            )
            self.assertFalse((root / "backups").exists())
            self.assertFalse((root / "logs").exists())

    def test_deploy_entrypoints_reject_local_and_test_without_side_effects(self):
        for script in (START_SERVER, DOCKER_ENTRYPOINT):
            for mode in ("local", "test"):
                with self.subTest(script=script.name, mode=mode):
                    with tempfile.TemporaryDirectory() as tmp:
                        root = Path(tmp)
                        result = subprocess.run(
                            ["bash", str(script)],
                            cwd=APP_DIR,
                            env={
                                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                "PYTHON_BIN": sys.executable,
                                "ACG_RUNTIME_MODE": mode,
                                "BACKUP_ROOT": str(root / "backups"),
                                "LOG_DIR": str(root / "logs"),
                                "VIDEO_WORKSHOP_PROJECTS_DIR": str(root / "projects"),
                            },
                            check=False,
                            capture_output=True,
                            text=True,
                            timeout=10,
                        )

                        self.assertNotEqual(0, result.returncode)
                        self.assertIn(
                            "requires ACG_RUNTIME_MODE=production", result.stderr
                        )
                        self.assertNotIn("Release contract verifier", result.stderr)
                        self.assertFalse((root / "backups").exists())
                        self.assertFalse((root / "logs").exists())
                        self.assertFalse((root / "projects").exists())

    def test_env_file_cannot_switch_deploy_entrypoints_to_local_or_test(self):
        for script in (START_SERVER, DOCKER_ENTRYPOINT):
            for mode in ("local", "test"):
                with self.subTest(script=script.name, mode=mode):
                    with tempfile.TemporaryDirectory() as tmp:
                        root = Path(tmp)
                        env_file = root / "runtime.env"
                        env_file.write_text(
                            f"ACG_RUNTIME_MODE={mode}\n"
                            f"BACKUP_ROOT={root / 'backups'}\n"
                            f"LOG_DIR={root / 'logs'}\n",
                            encoding="utf-8",
                        )
                        result = subprocess.run(
                            ["bash", str(script)],
                            cwd=APP_DIR,
                            env={
                                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                "PYTHON_BIN": sys.executable,
                                "ACG_ENV_FILE": str(env_file),
                            },
                            check=False,
                            capture_output=True,
                            text=True,
                            timeout=10,
                        )

                        self.assertNotEqual(0, result.returncode)
                        self.assertIn(
                            "requires ACG_RUNTIME_MODE=production", result.stderr
                        )
                        self.assertFalse((root / "backups").exists())
                        self.assertFalse((root / "logs").exists())

    def test_production_preflight_requires_internal_team_mode(self):
        for script in (START_SERVER, DOCKER_ENTRYPOINT):
            with self.subTest(script=script.name):
                with tempfile.TemporaryDirectory() as tmp:
                    env = self._preflight_env(script, Path(tmp))
                    env["ACG_REQUIRE_INTERNAL_TEAM"] = "0"
                    result = self._run_embedded_preflight(script, env)

                    self.assertNotEqual(0, result.returncode)
                    self.assertIn(
                        "ACG_REQUIRE_INTERNAL_TEAM must be enabled in production",
                        result.stderr,
                    )

    def test_production_preflight_rejects_unsafe_sidecar_urls(self):
        invalid_urls = {
            "https": "https://127.0.0.1:8765",
            "hostname": "http://localhost:8765",
            "credentials": "http://user@127.0.0.1:8765",
            "path": "http://127.0.0.1:8765/health",
            "query": "http://127.0.0.1:8765?probe=1",
            "fragment": "http://127.0.0.1:8765#probe",
            "port": "http://127.0.0.1:8766",
        }
        for script in (START_SERVER, DOCKER_ENTRYPOINT):
            for name in ("VIDEO_WORKSHOP_URL", "VIDEO_WORKSHOP_HEALTH_URL"):
                for case, invalid_url in invalid_urls.items():
                    with self.subTest(
                        script=script.name,
                        variable=name,
                        case=case,
                    ):
                        with tempfile.TemporaryDirectory() as tmp:
                            env = self._preflight_env(script, Path(tmp))
                            env[name] = invalid_url
                            result = self._run_embedded_preflight(script, env)

                            self.assertNotEqual(0, result.returncode)
                            self.assertIn(
                                f"{name} must use http with a literal loopback IP",
                                result.stderr,
                            )

    def test_health_gates_require_exact_release_and_sidecar_contract(self):
        valid_sidecar = {
            "ok": True,
            "ready": True,
            "contractVersion": "video-workshop-v137-read-only-1",
            "buildId": "release-current",
            "readOnly": True,
            "writePolicy": "deny-mutations",
        }
        invalid_sidecars = {
            "forged-nonempty-contract": {
                **valid_sidecar,
                "contractVersion": "video-workshop-old-but-nonempty",
            },
            "stale-build": {**valid_sidecar, "buildId": "release-previous"},
        }
        valid_main = {
            "ok": True,
            "ready": True,
            "checks": {"release": {"id": "release-current"}},
        }
        stale_main = {
            **valid_main,
            "checks": {"release": {"id": "release-previous"}},
        }
        for script, function_name in (
            (START_SERVER, "wait_for_health"),
            (DOCKER_ENTRYPOINT, "wait_for_json_gate"),
        ):
            with self.subTest(script=script.name, case="valid-sidecar"):
                result = self._run_embedded_health_gate(
                    script,
                    function_name,
                    valid_sidecar,
                    use_ready_token=False,
                    require_service_ready=True,
                )
                self.assertEqual(0, result.returncode, result.stderr)
            for case, payload in invalid_sidecars.items():
                with self.subTest(script=script.name, case=case):
                    result = self._run_embedded_health_gate(
                        script,
                        function_name,
                        payload,
                        use_ready_token=False,
                        require_service_ready=True,
                    )
                    self.assertNotEqual(0, result.returncode)
            with self.subTest(script=script.name, case="valid-main"):
                result = self._run_embedded_health_gate(
                    script,
                    function_name,
                    valid_main,
                    use_ready_token=True,
                    require_service_ready=False,
                )
                self.assertEqual(0, result.returncode, result.stderr)
            with self.subTest(script=script.name, case="stale-main"):
                result = self._run_embedded_health_gate(
                    script,
                    function_name,
                    stale_main,
                    use_ready_token=True,
                    require_service_ready=False,
                )
                self.assertNotEqual(0, result.returncode)

    def test_stubborn_pid_aborts_before_backup_and_preserves_pidfile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            process = self._start_term_ignoring_process()
            try:
                pid_file = root / "service.pid"
                pid_file.write_text(f"{process.pid}\n", encoding="utf-8")
                backup_marker = root / "backup-ran"
                result = subprocess.run(
                    ["/bin/bash", str(self._write_shutdown_harness(root))],
                    env={
                        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                        "TEST_STOP_PID": "1",
                        "TEST_PID_FILE": str(pid_file),
                        "TEST_BACKUP_MARKER": str(backup_marker),
                    },
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )

                self.assertEqual(70, result.returncode)
                self.assertIn("still alive; preserving pidfile", result.stderr)
                self.assertEqual(str(process.pid), pid_file.read_text("utf-8").strip())
                self.assertIsNone(process.poll())
                self.assertFalse(backup_marker.exists())
            finally:
                self._terminate_test_process(process)

    def test_stubborn_lsof_listener_aborts_before_backup_without_sigkill(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            process = self._start_term_ignoring_process()
            try:
                fake_bin = self._write_fake_lsof(
                    root,
                    "#!/bin/sh\n"
                    "if kill -0 \"$FAKE_LISTENER_PID\" 2>/dev/null; then\n"
                    "  printf '%s\\n' \"$FAKE_LISTENER_PID\"\n"
                    "  exit 0\n"
                    "fi\n"
                    "exit 1\n",
                )
                backup_marker = root / "backup-ran"
                result = subprocess.run(
                    ["/bin/bash", str(self._write_shutdown_harness(root))],
                    env={
                        "PATH": f"{fake_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                        "FAKE_LISTENER_PID": str(process.pid),
                        "TEST_STOP_PORT": "1",
                        "TEST_PORT": "59997",
                        "TEST_BACKUP_MARKER": str(backup_marker),
                    },
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )

                self.assertEqual(70, result.returncode)
                self.assertIn("still has listener(s)", result.stderr)
                self.assertIsNone(process.poll())
                self.assertFalse(backup_marker.exists())
                shutdown_source = START_SERVER.read_text("utf-8").split(
                    "readonly STOP_WAIT_ATTEMPTS=", 1
                )[1].split("wait_for_health() {", 1)[0]
                self.assertNotIn("SIGKILL", shutdown_source)
                self.assertNotIn("kill -9", shutdown_source)
            finally:
                self._terminate_test_process(process)

    def test_lsof_probe_error_cannot_be_treated_as_an_empty_port(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_bin = self._write_fake_lsof(
                root,
                "#!/bin/sh\n"
                "echo 'synthetic lsof failure' >&2\n"
                "exit 2\n",
            )
            backup_marker = root / "backup-ran"
            result = subprocess.run(
                ["/bin/bash", str(self._write_shutdown_harness(root))],
                env={
                    "PATH": f"{fake_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                    "TEST_STOP_PORT": "1",
                    "TEST_PORT": "59996",
                    "TEST_BACKUP_MARKER": str(backup_marker),
                },
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )

            self.assertEqual(70, result.returncode)
            self.assertIn("lsof could not prove", result.stderr)
            self.assertIn("synthetic lsof failure", result.stderr)
            self.assertFalse(backup_marker.exists())

    def test_shutdown_proof_gate_precedes_runtime_backup(self):
        source = START_SERVER.read_text("utf-8")
        gate = source.index("shutdown_failed=0")
        abort = source.index(
            "Runtime shutdown could not be proven; refusing backup and startup.", gate
        )
        backup = source.index("\nbackup_runtime_data\n", abort)

        self.assertLess(gate, abort)
        self.assertLess(abort, backup)
        shutdown_block = source[gate:backup]
        self.assertIn('stop_pid_file "$MAIN_PID_FILE"', shutdown_block)
        self.assertIn('stop_pid_file "$VIDEO_PID_FILE"', shutdown_block)
        self.assertIn('stop_port "$PORT"', shutdown_block)
        self.assertIn('stop_port "$VIDEO_WORKSHOP_PORT"', shutdown_block)
        self.assertIn("shutdown_failed=1", shutdown_block)

    def test_external_env_paths_feed_preflight_and_backup_after_contract_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = root / "release"
            persistent = root / "shared"
            (release / "deploy").mkdir(parents=True)
            (release / "server" / "scripts").mkdir(parents=True)
            (release / "vendor" / "infinite-canvas").mkdir(parents=True)
            (release / "apps" / "video-workshop" / ".venv" / "bin").mkdir(
                parents=True
            )
            (release / ".venv" / "bin").mkdir(parents=True)
            shutil.copy2(START_SERVER, release / "deploy" / "start_server.sh")
            (release / "vendor" / "infinite-canvas" / "index.html").write_text(
                "ok", encoding="utf-8"
            )
            (release / "server" / "requirements.txt").write_text("", encoding="utf-8")
            video_root = release / "apps" / "video-workshop"
            (video_root / "requirements.txt").write_text("", encoding="utf-8")
            (video_root / "run.py").write_text("raise SystemExit(99)\n", encoding="utf-8")
            for executable in (
                release / ".venv" / "bin" / "python",
                video_root / ".venv" / "bin" / "python",
            ):
                executable.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
                executable.chmod(0o755)

            verify_marker = persistent / "verified"
            backup_marker = persistent / "backup-invocation"
            verifier = release / "deploy" / "verify_release_contracts.sh"
            verifier.write_text(
                '#!/bin/sh\nprintf "verified" > "$VERIFY_MARKER"\n',
                encoding="utf-8",
            )
            verifier.chmod(0o755)
            backup_helper = release / "server" / "scripts" / "consistent_sqlite_backup.py"
            backup_helper.write_text(
                """import argparse, os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--destination", required=True)
parser.add_argument("--manifest", required=True)
args = parser.parse_args()
verified = Path(os.environ["VERIFY_MARKER"]).read_text("utf-8")
Path(os.environ["BACKUP_TEST_MARKER"]).write_text(
    f"{args.source}\\n{args.destination}\\n{verified}", encoding="utf-8"
)
raise SystemExit(42)
""",
                encoding="utf-8",
            )

            required_dirs = {
                "BACKUP_ROOT": persistent / "backups",
                "LOG_DIR": persistent / "logs",
                "UPLOAD_DIR": persistent / "uploads",
                "COMPOSED_DIR": persistent / "composed",
                "CUSTOM_CANVAS_BLOB_DIR": persistent / "canvas_blobs",
                "VIDEO_WORKSHOP_PROJECTS_DIR": persistent / "video" / "projects",
                "VIDEO_WORKSHOP_OUTPUT_DIR": persistent / "video" / "outputs",
                "VIDEO_WORKSHOP_UPLOAD_DIR": persistent / "video" / "uploads",
                "HF_HOME": persistent / "model-cache",
            }
            for path in required_dirs.values():
                path.mkdir(parents=True, exist_ok=True)
            database = persistent / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE keep_me (id INTEGER PRIMARY KEY)")
            env_file = persistent / "runtime.env"
            values = {
                "ACG_RUNTIME_MODE": "production",
                "ACG_DB_BOOTSTRAP_MODE": "validate",
                "ACG_READ_ONLY": "1",
                "ACG_REQUIRE_INTERNAL_TEAM": "1",
                "ACG_RELEASE_ROOT": str(release),
                "ACG_PERSISTENT_ROOT": str(persistent),
                "ACG_RELEASE_ID": "env-release",
                "ACG_READY_TOKEN": "env-ready-token",
                "DATA_DB": str(database),
                "LEGACY_DATA_FILE": str(persistent / "data.json"),
                "BGM_SOURCE": "platform",
                "VERIFY_MARKER": str(verify_marker),
                "BACKUP_TEST_MARKER": str(backup_marker),
                "PORT": "59998",
                "VIDEO_WORKSHOP_PORT": "59999",
                **{name: str(path) for name, path in required_dirs.items()},
            }
            env_file.write_text(
                "\n".join(f"{name}={value}" for name, value in values.items()) + "\n",
                encoding="utf-8",
            )

            result = subprocess.run(
                ["bash", str(release / "deploy" / "start_server.sh")],
                cwd=release,
                env={
                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                    "PYTHON_BIN": sys.executable,
                    "ACG_ENV_FILE": str(env_file),
                },
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )

            self.assertNotEqual(0, result.returncode)
            self.assertEqual("verified", verify_marker.read_text("utf-8"))
            source, destination, verified = backup_marker.read_text("utf-8").splitlines()
            self.assertEqual(str(database), source)
            self.assertEqual("verified", verified)
            self.assertIn(required_dirs["BACKUP_ROOT"], Path(destination).parents)

    def test_startup_contract_uses_readiness_and_verified_backup(self):
        start_source = START_SERVER.read_text("utf-8")
        entrypoint_source = DOCKER_ENTRYPOINT.read_text("utf-8")
        dockerfile_source = DOCKERFILE.read_text("utf-8")
        dockerignore_source = DOCKERIGNORE.read_text("utf-8")

        self.assertIn("consistent_sqlite_backup.py", start_source)
        self.assertNotIn('cp -p "$DATA_DB_PATH"*', start_source)
        self.assertIn("/api/ready", start_source)
        self.assertIn("/api/ready", entrypoint_source)
        self.assertIn("/api/ready", dockerfile_source)
        self.assertIn('data.get("ready") is True', start_source)
        self.assertIn('data.get("ready") is True', entrypoint_source)
        self.assertIn("verify_release_contracts\nproduction_preflight", start_source)
        self.assertIn("verify_release_contracts\nproduction_preflight", entrypoint_source)
        for source in (start_source, entrypoint_source):
            self.assertIn(
                'if [ "$ACG_RUNTIME_MODE" != "production" ]; then', source
            )
            self.assertIn(
                "Deployment entrypoint requires ACG_RUNTIME_MODE=production.", source
            )
            self.assertNotIn("local|test)", source)
            self.assertIn("ACG_REQUIRE_INTERNAL_TEAM must be enabled", source)
            self.assertIn("validate_sidecar_url(\"VIDEO_WORKSHOP_URL\"", source)
            self.assertIn(
                "validate_sidecar_url(\"VIDEO_WORKSHOP_HEALTH_URL\"", source
            )
            self.assertIn(
                'data.get("contractVersion") == "video-workshop-v137-read-only-1"',
                source,
            )
            self.assertIn('data.get("buildId") == release_id', source)
            self.assertIn('release.get("id") == release_id', source)
        self.assertIn("COPY tools/verify_release_contracts.py", dockerfile_source)
        self.assertIn("COPY vendor/infinite-canvas.manifest.json", dockerfile_source)
        self.assertNotIn(
            "COPY apps/video-workshop/ ./apps/video-workshop/", dockerfile_source
        )
        self.assertNotIn("COPY server/scripts/ ./server/scripts/", dockerfile_source)
        self.assertIn("COPY server/scripts/*.py ./server/scripts/", dockerfile_source)
        self.assertIn(
            "COPY apps/video-workshop/run.py apps/video-workshop/requirements.txt ./apps/video-workshop/",
            dockerfile_source,
        )
        for copy_contract in (
            "COPY apps/video-workshop/app/ ./apps/video-workshop/app/",
            "COPY apps/video-workshop/web/ ./apps/video-workshop/web/",
            "COPY apps/video-workshop/skills/video-production/ ./apps/video-workshop/skills/video-production/",
            "COPY apps/video-workshop/vendor/OpenMontage/ ./apps/video-workshop/vendor/OpenMontage/",
        ):
            self.assertIn(copy_contract, dockerfile_source)
        self.assertIn("from server import config as c", dockerfile_source)
        self.assertIn('ACG_READ_ONLY="1"', dockerfile_source)
        self.assertIn('ACG_REQUIRE_INTERNAL_TEAM="1"', dockerfile_source)
        self.assertIn('VIDEO_WORKSHOP_HEALTH_URL="http://127.0.0.1:8765"', dockerfile_source)
        self.assertIn('FALLBACK_ENV="${FALLBACK_ENV:-${ACG_ENV_FILE:-}}"', start_source)
        self.assertIn('FALLBACK_ENV="${FALLBACK_ENV:-${ACG_ENV_FILE:-}}"', entrypoint_source)
        self.assertNotIn("mkdir -p", dockerfile_source)
        self.assertIn("server/**/__pycache__/", dockerignore_source)
        self.assertIn("apps/video-workshop/**/__pycache__/", dockerignore_source)


if __name__ == "__main__":
    unittest.main()
