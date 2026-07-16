import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]
VIDEO_DIR = APP_DIR / "apps" / "video-workshop"


class CustomSubappDeploymentTest(unittest.TestCase):
    def test_video_sidecar_has_dedicated_process_environment(self):
        config = (VIDEO_DIR / "app" / "config.py").read_text(encoding="utf-8")
        env_example = (VIDEO_DIR / ".env.example").read_text(encoding="utf-8")

        self.assertIn('os.getenv("VIDEO_WORKSHOP_HOST", "127.0.0.1")', config)
        self.assertIn('os.getenv("VIDEO_WORKSHOP_PORT", "8765")', config)
        self.assertNotIn('host: str = os.getenv("HOST"', config)
        self.assertNotIn('port: int = int(os.getenv("PORT"', config)

        self.assertIn("VIDEO_WORKSHOP_HOST=127.0.0.1", env_example)
        self.assertIn("VIDEO_WORKSHOP_PORT=8765", env_example)
        self.assertIn("HF_HOME=../../runtime/model-cache", env_example)
        self.assertIn("BGM_SOURCE=platform", env_example)
        self.assertIn("DATA_DB=../../server/data.sqlite", env_example)
        self.assertIn("UPLOAD_DIR=../../server/uploads", env_example)
        self.assertIn(
            "VIDEO_WORKSHOP_PROJECTS_DIR=../../runtime/video-workshop/projects",
            env_example,
        )
        for key in ("LLM_API_KEY", "SEEDANCE_API_KEY", "MINIMAX_API_KEY"):
            line = next(item for item in env_example.splitlines() if item.startswith(key + "="))
            self.assertEqual(line, key + "=")

    def test_non_docker_launcher_manages_both_services_and_persistent_data(self):
        start = (APP_DIR / "deploy" / "start_server.sh").read_text(encoding="utf-8")
        stop = (APP_DIR / "deploy" / "stop_server.sh").read_text(encoding="utf-8")
        status = (APP_DIR / "deploy" / "status_server.sh").read_text(encoding="utf-8")

        for token in (
            'VIDEO_WORKSHOP_HOST="${VIDEO_WORKSHOP_HOST:-127.0.0.1}"',
            'VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"',
            'VIDEO_WORKSHOP_DATA_ROOT="${VIDEO_WORKSHOP_DATA_ROOT:-$APP_DIR/runtime/video-workshop}"',
            'HF_HOME="${HF_HOME:-$APP_DIR/runtime/model-cache}"',
            'BGM_SOURCE="${BGM_SOURCE:-platform}"',
            'export DATA_DB="$DATA_DB_PATH"',
            'export UPLOAD_DIR="$UPLOAD_DIR_PATH"',
            'migrate_legacy_tree "$VIDEO_APP_DIR/data/projects" "$VIDEO_WORKSHOP_PROJECTS_DIR"',
            '"$VIDEO_VENV/bin/python" -m pip install',
            'exec nohup "$VIDEO_VENV/bin/python" run.py',
            'vendor/infinite-canvas/index.html',
            '"$video_backup_dir/uploads.manifest"',
            '"$video_backup_dir/outputs.manifest"',
            'VIDEO_WORKSHOP_HOST must stay on a loopback address',
        ):
            self.assertIn(token, start)

        self.assertIn('logs/video-workshop.pid', stop)
        self.assertIn('VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"', stop)
        self.assertIn('logs/video-workshop.pid', status)
        self.assertIn('VIDEO_WORKSHOP_HEALTH_URL', status)
        self.assertIn('video-workshop.log', status)

    def test_finder_launchers_start_and_clean_loopback_sidecar(self):
        helper = (APP_DIR / "deploy" / "local_video_workshop.sh").read_text(
            encoding="utf-8"
        )
        gitignore = (APP_DIR / ".gitignore").read_text(encoding="utf-8")
        for token in (
            'export VIDEO_WORKSHOP_HOST="127.0.0.1"',
            'export VIDEO_WORKSHOP_PORT="8765"',
            'export VIDEO_WORKSHOP_URL="http://127.0.0.1:8765"',
            'VIDEO_WORKSHOP_PROJECTS_DIR="$APP_DIR/runtime/video-workshop/projects"',
            'VIDEO_WORKSHOP_OUTPUT_DIR="$APP_DIR/runtime/video-workshop/outputs"',
            'VIDEO_WORKSHOP_UPLOAD_DIR="$APP_DIR/runtime/video-workshop/uploads"',
            'export BGM_SOURCE="${BGM_SOURCE:-platform}"',
            'export DATA_DB="${DATA_DB:-$APP_DIR/server/data.sqlite}"',
            'export UPLOAD_DIR="${UPLOAD_DIR:-$APP_DIR/server/uploads}"',
            'BGM_LIBRARY_DIR="${BGM_LIBRARY_DIR:-$APP_DIR/runtime/bgm-library}"',
            'HF_HOME="$APP_DIR/runtime/model-cache"',
            'VIDEO_WORKSHOP_VENV="$VIDEO_WORKSHOP_APP_DIR/.venv"',
            'exec "$VIDEO_WORKSHOP_PYTHON" run.py',
            'http://127.0.0.1:8765/api/health',
            "stop_local_video_workshop()",
        ):
            self.assertIn(token, helper)
        self.assertNotIn('VIDEO_WORKSHOP_HOST="0.0.0.0"', helper)
        self.assertIn("runtime/", gitignore)

        for filename, browser_url in (
            ("start.command", "http://localhost:${PORT}/#/overview"),
            ("start-shared.command", "http://localhost:${PORT}"),
        ):
            launcher = (APP_DIR / filename).read_text(encoding="utf-8")
            self.assertIn(
                '. "$APP_DIR/deploy/local_video_workshop.sh"',
                launcher,
            )
            self.assertIn("prepare_local_video_workshop", launcher)
            self.assertIn("start_local_video_workshop", launcher)
            self.assertIn("trap stop_local_video_workshop EXIT", launcher)
            self.assertIn("stop_local_video_workshop", launcher)
            self.assertIn(browser_url, launcher)
            self.assertIn(
                'python3 -m uvicorn server.main:app --host 0.0.0.0 --port "${PORT}"',
                launcher,
            )

        guide = (APP_DIR / "运行与架构说明.md").read_text(encoding="utf-8")
        self.assertIn("127.0.0.1:8765", guide)
        self.assertIn("退出 `8787` 主服务或按 `Ctrl+C`", guide)
        self.assertIn("保存在 `runtime/`", guide)

    def test_docker_image_bundles_runtime_without_secrets_or_user_data(self):
        dockerfile = (APP_DIR / "server" / "Dockerfile").read_text(encoding="utf-8")
        dockerignore = (APP_DIR / ".dockerignore").read_text(encoding="utf-8")
        entrypoint = (APP_DIR / "deploy" / "docker_entrypoint.sh").read_text(
            encoding="utf-8"
        )

        for token in (
            "ffmpeg fonts-noto-cjk libgomp1",
            "python -m venv /opt/video-workshop-venv",
            "COPY vendor/infinite-canvas/ ./vendor/infinite-canvas/",
            "COPY apps/video-workshop/ ./apps/video-workshop/",
            'VIDEO_WORKSHOP_HOST="127.0.0.1"',
            'VIDEO_WORKSHOP_PORT="8765"',
            'VIDEO_WORKSHOP_PROJECTS_DIR="/data/video-workshop/projects"',
            'BGM_SOURCE="platform"',
            'HF_HOME="/data/model-cache"',
            'CMD ["./deploy/docker_entrypoint.sh"]',
        ):
            self.assertIn(token, dockerfile)
        self.assertNotIn("COPY .env", dockerfile)
        self.assertNotIn("favicon.svg", dockerfile)
        self.assertNotIn("EXPOSE 8765", dockerfile)

        for token in (
            "apps/video-workshop/.env",
            "apps/video-workshop/.venv/",
            "apps/video-workshop/data/projects/*",
            "apps/video-workshop/outputs/*",
            "apps/video-workshop/uploads/*",
            "runtime/",
            "backups/",
        ):
            self.assertIn(token, dockerignore)

        self.assertIn('exec "$VIDEO_PYTHON" run.py', entrypoint)
        self.assertIn("python -m uvicorn server.main:app", entrypoint)
        self.assertIn("VIDEO_WORKSHOP_HOST must stay on a loopback address", entrypoint)

    def test_deployment_guide_preserves_server_data_and_lists_both_subapps(self):
        guide = (APP_DIR / "deploy" / "README.md").read_text(encoding="utf-8")
        for token in (
            "apps/video-workshop/",
            "vendor/infinite-canvas/",
            "apps/infinite-canvas-source/",
            "--exclude 'runtime/'",
            "--exclude 'server/data.sqlite*'",
            "--exclude 'apps/video-workshop/data/projects/'",
            "不要使用 `--delete-excluded`",
            "不要映射 `8765`",
            "AGPL-3.0",
        ):
            self.assertIn(token, guide)

    def test_empty_bgm_library_is_a_safe_optional_path(self):
        pipeline = (VIDEO_DIR / "app" / "pipeline.py").read_text(encoding="utf-8")
        media = (VIDEO_DIR / "app" / "media.py").read_text(encoding="utf-8")

        self.assertIn(
            "bgm_path=selected_bgm.path if selected_bgm else None",
            pipeline,
        )
        self.assertIn(
            "resolved_bgm = bgm_path.resolve() if bgm_path and bgm_path.is_file() else None",
            media,
        )
        self.assertIn('filters.append("[voicebase]anull[voice]")', media)


if __name__ == "__main__":
    unittest.main()
