import json
import subprocess
import textwrap
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class PublicApiOriginFrontendTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR.parent,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_public_image_request_never_falls_back_to_browser_loopback(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.window = { location: {
              origin: "https://team.example", protocol: "https:", hostname: "team.example", port: ""
            }};
            const calls = [];
            globalThis.fetch = async (url) => {
              calls.push(String(url));
              return { ok: false, status: 404, async text() { return JSON.stringify({ detail: "not found" }); } };
            };
            const { getProvider } = await import("./自动化产品/js/api/providers.js");
            let message = "";
            try { await getProvider("openai-image").submit({ prompt: "test" }); }
            catch (error) { message = error.message; }
            console.log(JSON.stringify({ calls, message }));
            """
        )
        self.assertEqual(result["calls"], ["/api/image/generate"])
        self.assertNotIn("127.0.0.1", result["message"])

    def test_public_llm_probe_never_uses_browser_loopback(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.window = { location: {
              origin: "https://team.example", protocol: "https:", hostname: "team.example", port: ""
            }};
            const calls = [];
            globalThis.fetch = async (url) => {
              calls.push(String(url));
              return { ok: false, status: 404, async json() { return {}; } };
            };
            const { enableServerProxyIfConfigured } = await import("./自动化产品/js/api/llm.js?v=public-origin-test");
            const enabled = await enableServerProxyIfConfigured();
            console.log(JSON.stringify({ calls, enabled }));
            """
        )
        self.assertEqual(result["calls"], ["/api/health"])
        self.assertFalse(result["enabled"])


if __name__ == "__main__":
    unittest.main()
