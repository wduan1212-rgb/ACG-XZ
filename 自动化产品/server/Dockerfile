FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 前端静态资源（v5：ES Modules + 分仓 CSS）——只拷必要文件，
# 不带 _backup_*/方案文档/cli/proxy.py 等，避免随静态托管泄露源码与备份
COPY index.html favicon.svg logo.png ./
COPY js/ ./js/
COPY styles/ ./styles/

# 后端
COPY server/ ./server/

# 运行时注入：LLM_API_KEY（语言模型，经 /api/chat/completions 代理）
#            JUSTONEAPI_KEY（小红书真实数据采集，留空则走稳定模拟数据）
ENV LLM_API_KEY="" \
    JUSTONEAPI_KEY=""
EXPOSE 8787
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8787"]
