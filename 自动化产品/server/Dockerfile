FROM python:3.12-slim

WORKDIR /app

# Video composition and OpenMontage validation require the system FFmpeg
# binaries. libgomp1 is needed by the CTranslate2 runtime used by faster-whisper.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Keep the legacy main service and the Pydantic 2 video sidecar in separate
# Python environments so their FastAPI dependency ranges cannot overwrite one
# another.
COPY server/requirements.lock.txt /tmp/main-requirements.lock.txt
COPY apps/video-workshop/requirements.lock.txt /tmp/video-workshop-requirements.lock.txt
RUN pip install --no-cache-dir -r /tmp/main-requirements.lock.txt \
    && python -m venv /opt/video-workshop-venv \
    && /opt/video-workshop-venv/bin/pip install --no-cache-dir \
       -r /tmp/video-workshop-requirements.lock.txt

# Frontend shell and deployable child applications. The Docker context excludes
# all real env files, virtualenvs and runtime/user data.
COPY index.html logo.png ./
COPY js/ ./js/
COPY styles/ ./styles/
COPY assets/ ./assets/
COPY vendor/infinite-canvas/ ./vendor/infinite-canvas/
COPY vendor/infinite-canvas.manifest.json ./vendor/infinite-canvas.manifest.json
COPY apps/video-workshop/run.py apps/video-workshop/requirements.txt ./apps/video-workshop/
COPY apps/video-workshop/requirements.lock.txt ./apps/video-workshop/requirements.lock.txt
COPY apps/video-workshop/app/ ./apps/video-workshop/app/
COPY apps/video-workshop/web/ ./apps/video-workshop/web/
COPY apps/video-workshop/skills/video-production/ ./apps/video-workshop/skills/video-production/
COPY apps/video-workshop/vendor/OpenMontage/ ./apps/video-workshop/vendor/OpenMontage/
COPY deploy/*.sh ./deploy/
COPY deploy/verify_offline_dependencies.py ./deploy/verify_offline_dependencies.py
COPY deploy/verify_production_write_gate.py ./deploy/verify_production_write_gate.py
COPY deploy/release-runtime.manifest.json ./deploy/release-runtime.manifest.json
COPY tools/verify_release_contracts.py ./tools/verify_release_contracts.py

# Main backend and explicit schema migration runner.
COPY server/main.py server/store.py server/config.py server/model_usage_recovery.py ./server/
COPY server/migrations/ ./server/migrations/
COPY server/requirements.txt ./server/requirements.txt
COPY server/requirements.lock.txt ./server/requirements.lock.txt
COPY server/minimax_system_voices.json ./server/minimax_system_voices.json
COPY server/scripts/*.py ./server/scripts/

RUN chmod +x ./deploy/docker_entrypoint.sh ./deploy/verify_release_contracts.sh

# Secrets are injected at runtime. Only persistent paths and non-secret process
# defaults belong in the image.
ENV ACG_RUNTIME_MODE="production" \
    ACG_DB_BOOTSTRAP_MODE="validate" \
    ACG_READ_ONLY="1" \
    ACG_REQUIRE_INTERNAL_TEAM="1" \
    ACG_REQUIRE_RESOURCE_SCOPES="1" \
    ACG_REQUIRE_PRIVATE_MEDIA="1" \
    ACG_RELEASE_ROOT="/app" \
    ACG_PERSISTENT_ROOT="/data" \
    ACG_ENV_FILE="/data/config/runtime.env" \
    DATA_DB="/data/data.sqlite" \
    MODEL_USAGE_COMPLETION_SPOOL_DIR="/data/model_usage_spool" \
    LEGACY_DATA_FILE="/data/data.json" \
    UPLOAD_DIR="/data/uploads" \
    COMPOSED_DIR="/data/composed" \
    CUSTOM_CANVAS_BLOB_DIR="/data/canvas_blobs" \
    HOST="0.0.0.0" \
    PORT="8787" \
    VIDEO_WORKSHOP_HOST="127.0.0.1" \
    VIDEO_WORKSHOP_PORT="8765" \
    VIDEO_WORKSHOP_URL="http://127.0.0.1:8765" \
    VIDEO_WORKSHOP_HEALTH_URL="http://127.0.0.1:8765" \
    VIDEO_WORKSHOP_PROJECTS_DIR="/data/video-workshop/projects" \
    VIDEO_WORKSHOP_OUTPUT_DIR="/data/video-workshop/outputs" \
    VIDEO_WORKSHOP_UPLOAD_DIR="/data/video-workshop/uploads" \
    BGM_SOURCE="platform" \
    BGM_LIBRARY_DIR="/data/bgm-library" \
    HF_HOME="/data/model-cache"

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD python3 -c "import json,os,urllib.request; from server import config as c; rid=os.getenv('ACG_RELEASE_ID',''); main='http://127.0.0.1:'+os.getenv('PORT','8787')+'/api/ready'; req=urllib.request.Request(main,headers={'X-Readiness-Token':c.readiness_token()}); m=json.load(urllib.request.urlopen(req,timeout=4)); release=((m.get('checks') or {}).get('release') or {}); assert m.get('ok') and m.get('ready') is True and rid and release.get('id') == rid; video=os.getenv('VIDEO_WORKSHOP_HEALTH_URL','http://127.0.0.1:8765')+'/api/health'; v=json.load(urllib.request.urlopen(video,timeout=4)); ro=c.is_read_only(); assert v.get('ok') and v.get('ready') is True and v.get('contractVersion') == 'video-workshop-v137-read-only-1' and v.get('buildId') == rid and ((ro and v.get('readOnly') is True and v.get('writePolicy') == 'deny-mutations') or (not ro and v.get('readOnly') is False and v.get('writePolicy') == 'normal'))"
CMD ["./deploy/docker_entrypoint.sh"]
