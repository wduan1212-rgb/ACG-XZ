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
COPY server/requirements.txt /tmp/main-requirements.txt
COPY apps/video-workshop/requirements.txt /tmp/video-workshop-requirements.txt
RUN pip install --no-cache-dir -r /tmp/main-requirements.txt \
    && python -m venv /opt/video-workshop-venv \
    && /opt/video-workshop-venv/bin/pip install --no-cache-dir \
       -r /tmp/video-workshop-requirements.txt

# Frontend shell and deployable child applications. The Docker context excludes
# all real env files, virtualenvs and runtime/user data.
COPY index.html logo.png ./
COPY js/ ./js/
COPY styles/ ./styles/
COPY assets/ ./assets/
COPY vendor/infinite-canvas/ ./vendor/infinite-canvas/
COPY apps/video-workshop/ ./apps/video-workshop/
COPY deploy/docker_entrypoint.sh ./deploy/docker_entrypoint.sh

# Main backend.
COPY server/main.py server/store.py ./server/
COPY server/requirements.txt ./server/requirements.txt
COPY server/minimax_system_voices.json ./server/minimax_system_voices.json
COPY server/scripts/ ./server/scripts/

RUN chmod +x ./deploy/docker_entrypoint.sh \
    && mkdir -p \
       /data/uploads \
       /data/composed \
       /data/video-workshop/projects \
       /data/video-workshop/outputs \
       /data/video-workshop/uploads \
       /data/bgm-library \
       /data/model-cache

# Secrets are injected at runtime. Only persistent paths and non-secret process
# defaults belong in the image.
ENV LLM_API_KEY="" \
    DATA_DB="/data/data.sqlite" \
    LEGACY_DATA_FILE="/data/data.json" \
    UPLOAD_DIR="/data/uploads" \
    COMPOSED_DIR="/data/composed" \
    HOST="0.0.0.0" \
    PORT="8787" \
    VIDEO_WORKSHOP_HOST="127.0.0.1" \
    VIDEO_WORKSHOP_PORT="8765" \
    VIDEO_WORKSHOP_URL="http://127.0.0.1:8765" \
    VIDEO_WORKSHOP_PROJECTS_DIR="/data/video-workshop/projects" \
    VIDEO_WORKSHOP_OUTPUT_DIR="/data/video-workshop/outputs" \
    VIDEO_WORKSHOP_UPLOAD_DIR="/data/video-workshop/uploads" \
    BGM_SOURCE="platform" \
    BGM_LIBRARY_DIR="/data/bgm-library" \
    HF_HOME="/data/model-cache"

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD python -c "import json,os,urllib.request; main='http://127.0.0.1:'+os.getenv('PORT','8787')+'/api/health'; video=os.getenv('VIDEO_WORKSHOP_URL','http://127.0.0.1:8765')+'/api/health'; assert json.load(urllib.request.urlopen(main, timeout=4)).get('ok'); assert json.load(urllib.request.urlopen(video, timeout=4)).get('ok')"
CMD ["./deploy/docker_entrypoint.sh"]
