import asyncio
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from server import main

APP_DIR = Path(__file__).resolve().parents[2]


class _Response:
    def __init__(self, status_code, text="", headers=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self.content = text.encode("utf-8")


class _Client:
    responses = []
    calls = 0

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        type(self).calls += 1
        return type(self).responses.pop(0)


class LlmResilienceTest(unittest.TestCase):
    def test_server_retries_only_transient_provider_failures(self):
        _Client.responses = [_Response(503, "busy"), _Response(200, "ok")]
        _Client.calls = 0
        with patch.object(main.httpx, "AsyncClient", _Client), patch.object(main.asyncio, "sleep", return_value=None):
            result = asyncio.run(main._call_llm({"messages": []}))
        self.assertEqual(200, result.status_code)
        self.assertEqual(2, _Client.calls)

        _Client.responses = [_Response(429, "insufficient quota"), _Response(200, "should-not-run")]
        _Client.calls = 0
        with patch.object(main.httpx, "AsyncClient", _Client), patch.object(main.asyncio, "sleep", return_value=None):
            result = asyncio.run(main._call_llm({"messages": []}))
        self.assertEqual(429, result.status_code)
        self.assertEqual(1, _Client.calls)

        _Client.responses = [_Response(401, "invalid token"), _Response(200, "should-not-run")]
        _Client.calls = 0
        with patch.object(main.httpx, "AsyncClient", _Client), patch.object(main.asyncio, "sleep", return_value=None):
            result = asyncio.run(main._call_llm({"messages": []}))
        self.assertEqual(401, result.status_code)
        self.assertEqual(1, _Client.calls)

    def test_browser_client_retries_bad_json_and_network_but_not_managed_http_errors(self):
        code = r'''
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', protocol:'http:', hostname:'127.0.0.1', port:'8787' };
globalThis.window = { location: globalThis.location, addEventListener(){}, dispatchEvent(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
const { LLM_CONFIG, llm } = await import('./js/api/llm.js?v=20260718-v94-1-resilience');
LLM_CONFIG.apiKey = 'test-only';
LLM_CONFIG.endpoint = 'https://provider.invalid/v1/chat/completions';
LLM_CONFIG.serverManaged = false;
const response = (status, payload, text='') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get(){ return null; } },
  text: async () => text,
  json: async () => payload
});

let calls = 0;
const malformed = { choices:[{ message:{ content:'{"title":"broken"' } }] };
const valid = { choices:[{ message:{ content:'{"title":"broken"}' } }] };
globalThis.fetch = async () => response(200, calls++ === 0 ? malformed : valid);
const repaired = await llm([{role:'user',content:'x'}], {json:true});
const malformedCalls = calls;

calls = 0;
LLM_CONFIG.serverManaged = true;
LLM_CONFIG.endpoint = '/api/chat/completions';
globalThis.fetch = async () => { calls++; return response(503, {}, 'busy'); };
let managedError = '';
try { await llm([{role:'user',content:'x'}]); } catch (error) { managedError = error.message; }
const managedCalls = calls;

calls = 0;
LLM_CONFIG.serverManaged = false;
LLM_CONFIG.endpoint = 'https://provider.invalid/v1/chat/completions';
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) throw new TypeError('temporary network failure');
  return response(200, { choices:[{message:{content:'在线'}}] });
};
const networkRecovered = await llm([{role:'user',content:'x'}]);
const networkCalls = calls;

calls = 0;
globalThis.fetch = async () => { calls++; return response(401, {}, 'invalid token'); };
let authError = '';
try { await llm([{role:'user',content:'x'}]); } catch (error) { authError = error.message; }

console.log(JSON.stringify({
  repaired: JSON.parse(repaired), malformedCalls,
  managedError, managedCalls,
  networkRecovered, networkCalls,
  authError, authCalls: calls
}));
'''
        result = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual("broken", payload["repaired"]["title"])
        self.assertEqual(2, payload["malformedCalls"])
        self.assertIn("HTTP 503", payload["managedError"])
        self.assertEqual(1, payload["managedCalls"])
        self.assertEqual("在线", payload["networkRecovered"])
        self.assertEqual(2, payload["networkCalls"])
        self.assertIn("HTTP 401", payload["authError"])
        self.assertEqual(1, payload["authCalls"])


if __name__ == "__main__":
    unittest.main()
