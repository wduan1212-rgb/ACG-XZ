import asyncio
import importlib
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


def member_row(member_id, role):
    return (
        member_id,
        role,
        f"{role}-user",
        "unused-hash",
        role,
        None,
        1,
    )


class _FakeStreamResponse:
    def __init__(self, chunks, content_type="video/mp4", status_code=200):
        self._chunks = list(chunks)
        self.status_code = status_code
        self.headers = {"content-type": content_type}

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _FakeAsyncClient:
    def __init__(self, response, **_kwargs):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def stream(self, *_args, **_kwargs):
        return self._response


class CreatorProxySecurityTest(unittest.TestCase):
    def test_creator_dependency_rejects_anonymous_and_suppliers(self):
        with self.assertRaises(HTTPException) as anonymous:
            main.require_creator("")
        self.assertEqual(anonymous.exception.status_code, 401)

        for role in ("supplier_parent", "supplier_child"):
            with self.subTest(role=role), patch.object(
                main.store,
                "parse_token",
                return_value=f"{role}-id",
            ), patch.object(
                main.store,
                "get_member",
                return_value=member_row(f"{role}-id", role),
            ):
                with self.assertRaises(HTTPException) as denied:
                    main.require_creator("Bearer supplier-token")
                self.assertEqual(denied.exception.status_code, 403)

    def test_creator_dependency_allows_admin_and_editor(self):
        for role in ("admin", "editor"):
            with self.subTest(role=role), patch.object(
                main.store,
                "parse_token",
                return_value=f"{role}-id",
            ), patch.object(
                main.store,
                "get_member",
                return_value=member_row(f"{role}-id", role),
            ):
                member = main.require_creator("Bearer creator-token")
                self.assertEqual(member["id"], f"{role}-id")
                self.assertEqual(member["role"], role)

    def test_all_costly_routes_require_creator_permission(self):
        paths = {
            "/api/llm/config",
            "/api/llm/test",
            "/api/llm",
            "/api/llm/vision-copy",
            "/api/chat/completions",
            "/api/image/config",
            "/api/image/generate",
            "/api/analytics/justoneapi/config",
            "/api/analytics/justoneapi/fetch",
            "/api/video/config",
            "/api/video/submit",
            "/api/video/poll/{task_id}",
            "/api/video/cancel/{task_id}",
            "/api/proxy/file",
            "/api/video/audio-timing",
            "/api/video/compose",
            "/api/accounts",
            "/api/accounts/{acc_id}",
            "/api/assets",
            "/api/assets/{asset_id}/download",
        }
        routes = [
            route
            for route in main.app.routes
            if getattr(route, "path", "") in paths
        ]
        self.assertEqual(
            {getattr(route, "path", "") for route in routes},
            paths,
        )
        for route in routes:
            path = getattr(route, "path", "")
            calls = {
                dependency.call
                for dependency in route.dependant.dependencies
            }
            self.assertIn(main.require_creator, calls, path)

    def test_server_managed_image_mode_ignores_client_key_and_endpoint(self):
        req = main.ImageGenerateReq(
            prompt="测试",
            endpoint="https://attacker.example/collect",
            apiKey="attacker-client-key",
        )
        with patch.object(main, "IMAGE_API_KEY", "server-secret"), patch.object(
            main,
            "IMAGE_ENDPOINT",
            "https://trusted.example/v1/images/generations",
        ):
            api_key, endpoint, edit_endpoint = main._image_request_config(req)
        self.assertEqual(api_key, "server-secret")
        self.assertEqual(main._endpoint_hostname(endpoint), "trusted.example")
        self.assertEqual(main._endpoint_hostname(edit_endpoint), "trusted.example")
        self.assertNotIn("attacker.example", endpoint)
        self.assertNotIn("attacker.example", edit_endpoint)

    def test_client_image_endpoint_requires_exact_allowlisted_host(self):
        evil = main.ImageGenerateReq(
            prompt="测试",
            endpoint="https://trusted.example.attacker.test/v1",
            apiKey="client-secret",
        )
        trusted = main.ImageGenerateReq(
            prompt="测试",
            endpoint="https://trusted.example/v1",
            apiKey="client-secret",
        )
        wrong_origin = main.ImageGenerateReq(
            prompt="测试",
            endpoint="http://trusted.example:8080/v1",
            apiKey="client-secret",
        )
        patches = (
            patch.object(main, "IMAGE_API_KEY", ""),
            patch.object(main, "IMAGE_ENDPOINT", ""),
            patch.object(main, "IMAGE_BASE_URL", "https://tokenhub.tencentmaas.com/v1"),
            patch.object(main, "IMAGE_CLIENT_ENDPOINT_ALLOWLIST", "trusted.example"),
        )
        with patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(HTTPException) as denied:
                main._image_request_config(evil)
            self.assertEqual(denied.exception.status_code, 403)
            with self.assertRaises(HTTPException) as wrong_origin_denied:
                main._image_request_config(wrong_origin)
            self.assertEqual(wrong_origin_denied.exception.status_code, 403)
            api_key, endpoint, _ = main._image_request_config(trusted)
        self.assertEqual(api_key, "client-secret")
        self.assertEqual(main._endpoint_hostname(endpoint), "trusted.example")

    def test_proxy_rejects_loopback_private_and_link_local_targets(self):
        for url in (
            "http://127.0.0.1/internal",
            "http://10.0.0.8/internal",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/internal",
        ):
            with self.subTest(url=url), self.assertRaises(HTTPException) as denied:
                main._validate_proxy_target(url)
            self.assertEqual(denied.exception.status_code, 403)

    def test_proxy_rejects_hostname_resolving_to_private_ip(self):
        private_answer = [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("192.168.1.20", 443),
            )
        ]
        with patch.object(main.socket, "getaddrinfo", return_value=private_answer):
            with self.assertRaises(HTTPException) as denied:
                main._validate_proxy_target("https://media.example/video.mp4")
        self.assertEqual(denied.exception.status_code, 403)

    def test_proxy_allows_public_dns_and_rechecks_redirect_destinations(self):
        public_answer = [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("93.184.216.34", 443),
            )
        ]
        with patch.object(main.socket, "getaddrinfo", return_value=public_answer):
            self.assertEqual(
                main._validate_proxy_target("https://media.example/video.mp4"),
                "https://media.example/video.mp4",
            )
        with self.assertRaises(HTTPException) as denied:
            main._proxy_redirect_target(
                "https://media.example/video.mp4",
                "http://169.254.169.254/latest/meta-data/",
            )
        self.assertEqual(denied.exception.status_code, 403)

    def test_proxy_enforces_media_type_and_stream_size_limit(self):
        with self.assertRaises(HTTPException) as denied:
            main._proxy_media_type("text/html", "https://media.example/file")
        self.assertEqual(denied.exception.status_code, 415)
        self.assertEqual(
            main._proxy_media_type(
                "application/octet-stream",
                "https://media.example/video.mp4",
            ),
            "application/octet-stream",
        )

        response = _FakeStreamResponse([b"12", b"34"])
        fake_client = lambda **kwargs: _FakeAsyncClient(response, **kwargs)
        with patch.object(
            main,
            "_validate_proxy_target",
            return_value="https://media.example/video.mp4",
        ), patch.object(
            main.httpx,
            "AsyncClient",
            side_effect=fake_client,
        ), patch.object(
            main,
            "PROXY_FILE_MAX_BYTES",
            3,
        ):
            with self.assertRaises(HTTPException) as oversized:
                asyncio.run(
                    main._download_public_media(
                        "https://media.example/video.mp4"
                    )
                )
        self.assertEqual(oversized.exception.status_code, 413)

    def test_frontend_sends_member_bearer_to_protected_routes(self):
        providers = (APP_DIR / "js" / "api" / "providers.js").read_text("utf-8")
        llm = (APP_DIR / "js" / "api" / "llm.js").read_text("utf-8")
        analytics = (APP_DIR / "js" / "domain" / "analytics.js").read_text("utf-8")
        delivery = (APP_DIR / "js" / "domain" / "delivery.js").read_text("utf-8")
        chain_cut = (APP_DIR / "js" / "views" / "chainCut.js").read_text("utf-8")
        workshop = (APP_DIR / "js" / "views" / "chainWorkshop.js").read_text("utf-8")

        self.assertIn(
            'headers: creatorAuthHeaders({ "Content-Type": "application/json" })',
            providers,
        )
        self.assertIn("headers: creatorAuthHeaders()", providers)
        self.assertIn("serverManaged ? remote.getToken()", llm)
        self.assertIn("Authorization: `Bearer ${remote.getToken()}`", llm)
        self.assertIn("headers: creatorAuthHeaders()", analytics)
        self.assertIn("Authorization: `Bearer ${remote.getToken()}`", delivery)
        self.assertIn("Authorization: `Bearer ${remote.getToken()}`", chain_cut)
        self.assertIn("Authorization: `Bearer ${token}`", workshop)


if __name__ == "__main__":
    unittest.main()
