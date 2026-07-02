FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 前端静态资源（v5：ES Modules + 分仓 CSS）——只拷必要文件，
# 不带 _backup_*/方案文档/cli/proxy.py 等，避免随静态托管泄露源码与备份
COPY index.html favicon.svg logo.png ./
COPY js/ ./js/
COPY styles/ ./styles/
COPY assets/ ./assets/

# 后端
COPY server/main.py server/store.py ./server/
COPY server/requirements.txt ./server/requirements.txt
COPY server/minimax_system_voices.json ./server/minimax_system_voices.json
COPY server/scripts/ ./server/scripts/
RUN mkdir -p /data/uploads /data/composed

# 运行时注入：LLM_API_KEY（语言模型，经 /api/chat/completions 代理）
#            JUSTONEAPI_KEY（小红书真实数据采集，留空则数据采集接口明确失败）
ENV LLM_API_KEY="" \
    JUSTONEAPI_KEY="" \
    DATA_DB="/data/data.sqlite" \
    LEGACY_DATA_FILE="/data/data.json" \
    UPLOAD_DIR="/data/uploads" \
    COMPOSED_DIR="/data/composed"
VOLUME ["/data"]
EXPOSE 8787
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8787"]
