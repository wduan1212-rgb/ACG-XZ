import importlib
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


class TtsCreatorPermissionTest(unittest.TestCase):
    def test_dependency_rejects_anonymous_and_supplier_roles(self):
        with self.assertRaises(HTTPException) as anonymous:
            main.require_tts_creator("")
        self.assertEqual(anonymous.exception.status_code, 401)

        for role in ("supplier_parent", "supplier_child"):
            with self.subTest(role=role), patch.object(
                main.store, "parse_token", return_value=f"{role}-id"
            ), patch.object(
                main.store,
                "get_member",
                return_value=member_row(f"{role}-id", role),
            ):
                with self.assertRaises(HTTPException) as denied:
                    main.require_tts_creator("Bearer supplier-token")
                self.assertEqual(denied.exception.status_code, 403)

    def test_dependency_allows_admin_and_editor(self):
        for role in ("admin", "editor"):
            with self.subTest(role=role), patch.object(
                main.store, "parse_token", return_value=f"{role}-id"
            ), patch.object(
                main.store,
                "get_member",
                return_value=member_row(f"{role}-id", role),
            ):
                member = main.require_tts_creator("Bearer creator-token")
                self.assertEqual(member["id"], f"{role}-id")
                self.assertEqual(member["role"], role)

    def test_all_tts_routes_depend_on_creator_permission(self):
        paths = {
            "/api/tts/config",
            "/api/tts/test",
            "/api/tts/voice/lookup",
            "/api/tts/voice/design",
            "/api/tts/generate",
        }
        routes = {
            getattr(route, "path", ""): route
            for route in main.app.routes
            if getattr(route, "path", "") in paths
        }
        self.assertEqual(set(routes), paths)
        for path, route in routes.items():
            calls = {
                dependency.call
                for dependency in route.dependant.dependencies
            }
            self.assertIn(main.require_tts_creator, calls, path)

    def test_frontend_sends_bearer_and_editor_voice_tab_is_unlocked(self):
        providers = (APP_DIR / "js" / "api" / "providers.js").read_text(
            encoding="utf-8"
        )
        main_js = (APP_DIR / "js" / "main.js").read_text(encoding="utf-8")
        shell = (APP_DIR / "js" / "views" / "customCreation.js").read_text(
            encoding="utf-8"
        )
        router = (APP_DIR / "js" / "core" / "router.js").read_text(
            encoding="utf-8"
        )
        self.assertIn('import * as remote from "../core/remote.js"', providers)
        self.assertIn("Authorization: `Bearer ${token}`", providers)
        self.assertIn('headers: creatorAuthHeaders()', providers)
        self.assertIn(
            'headers: creatorAuthHeaders({ "Content-Type": "application/json" })',
            providers,
        )
        self.assertIn('state.role === "admin" || state.role === "editor"', providers)
        self.assertIn("if (entered) {", main_js)
        self.assertNotIn("adminOnly", shell)
        self.assertNotIn("data-custom-locked", shell)
        self.assertNotIn("语音生成仅管理员可用", shell)
        self.assertNotIn('page === "voice" && state.role !== "admin"', router)


if __name__ == "__main__":
    unittest.main()
