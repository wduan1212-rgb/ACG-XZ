#!/usr/bin/env python3
"""
Dumate 本地 LLM 代理 —— 仅当浏览器直连 DeepSeek 出现 CORS 报错时才需要。

用法：
    python3 proxy.py
然后在浏览器控制台执行（或在「设置」里把 Provider 填成这个地址）：
    DumateConfig.endpoint = "http://localhost:8787/chat"

它会把请求转发到 DeepSeek 并补上跨域响应头，避免浏览器 CORS 拦截。
默认从环境变量 LLM_API_KEY 读取 key，也可由请求头 Authorization 覆盖。
"""
import json, os, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UPSTREAM = "https://api.deepseek.com/chat/completions"
DEFAULT_KEY = os.getenv("LLM_API_KEY", "")
PORT = 8787


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        auth = self.headers.get("Authorization") or (("Bearer " + DEFAULT_KEY) if DEFAULT_KEY else "")
        if not auth:
            data = json.dumps({"error": "LLM_API_KEY is not configured"}).encode()
            self.send_response(500); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(data)
            return
        req = urllib.request.Request(UPSTREAM, data=body,
            headers={"Content-Type": "application/json", "Authorization": auth})
        try:
            r = urllib.request.urlopen(req, timeout=120)
            data, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
        except Exception as e:
            data, code = json.dumps({"error": str(e)}).encode(), 502
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"Dumate LLM 代理已启动： http://localhost:{PORT}/chat  (Ctrl+C 退出)")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
