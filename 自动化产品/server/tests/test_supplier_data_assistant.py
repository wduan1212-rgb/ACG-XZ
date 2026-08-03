import asyncio
import importlib
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class FakeLlmResponse:
    status_code = 200

    def json(self):
        return {
            "model": "MiniMax-M3",
            "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            "choices": [{"message": {"content": "最近两天交付节奏较稳定，昨天回传链接占比更高。"}}],
        }


class FakeGreetingResponse:
    status_code = 200

    def json(self):
        return {
            "model": "MiniMax-M3",
            "usage": {"prompt_tokens": 8, "completion_tokens": 6, "total_tokens": 14},
            "choices": [{"message": {"content": "你好！我是数据助手，可以帮你查询交付、回传链接、下载记录、账号排行和播放量。"}}],
        }


class SupplierDataAssistantTest(unittest.TestCase):
    def setUp(self):
        self.member = {"id": "supplier-parent", "role": "supplier_parent", "parentId": None, "name": "供应商"}
        self.now = datetime(2026, 7, 24, 10, 0, tzinfo=timezone.utc)
        self.scoped_state = {
            "accounts": [
                {"id": "account-a", "name": "账号 A", "platform": "小红书"},
                {"id": "account-b", "name": "账号 B", "platform": "视频号"},
            ],
            "assets": [
                {"id": "delivery-yesterday-a", "delivered": True, "accountId": "account-a", "title": "昨天图文 A", "deliveredAt": "2026-07-23T10:00:00+08:00", "publishedUrl": "https://example.test/a", "views": 31, "globalSeq": 12, "supplierDownloadedBy": "supplier-child-a", "supplierDownloadedAt": "2026-07-23T12:00:00+08:00"},
                {"id": "delivery-yesterday-b", "delivered": True, "accountId": "account-b", "title": "昨天视频 B", "deliveredAt": "2026-07-23T11:00:00+08:00", "views": 8, "globalSeq": 13},
                {"id": "delivery-today", "delivered": True, "accountId": "account-a", "title": "今天图文", "deliveredAt": "2026-07-24T09:00:00+08:00", "publishedUrl": "https://example.test/today", "views": 17, "globalSeq": 14},
                {"id": "private-draft", "delivered": False, "accountId": "account-a", "title": "不应进入问答", "createdAt": "2026-07-24T09:00:00+08:00"},
            ],
        }

    def _snapshot(self, children=None):
        with patch.object(main.store, "list_supplier_children", return_value=list(children or [])):
            return main._supplier_assistant_snapshot(self.member, self.scoped_state, self.now)

    def test_yesterday_delivery_is_an_authoritative_date_fact_not_generic_total(self):
        snapshot = self._snapshot()
        answer = main._supplier_assistant_fact_answer("昨天交付多少条", snapshot)
        self.assertEqual("昨天交付 2 条，其中已回传链接 1 条。", answer)
        self.assertNotIn("当前共有", answer)
        self.assertNotIn("不应进入问答", str(snapshot))

    def test_returned_links_and_views_respect_the_requested_date(self):
        snapshot = self._snapshot()
        links = main._supplier_assistant_fact_answer("昨天回传链接", snapshot)
        self.assertIn("昨天已回传链接 1 条", links)
        self.assertIn("https://example.test/a", links)
        self.assertNotIn("https://example.test/today", links)
        self.assertEqual("昨天交付内容累计播放量为 39。", main._supplier_assistant_fact_answer("昨天播放量", snapshot))

    def test_download_question_returns_only_authorized_actor_and_delivery_rows(self):
        snapshot = self._snapshot(children=[{"id": "supplier-child-a", "name": "子账号甲"}])
        answer = main._supplier_assistant_fact_answer("昨天谁下载过", snapshot)
        self.assertIn("昨天共有 1 条下载记录", answer)
        self.assertIn("#012", answer)
        self.assertIn("昨天图文 A", answer)
        self.assertIn("子账号甲", answer)
        self.assertNotIn("账号 B", answer)

    def test_snapshot_uses_the_same_server_authorized_scope_as_supplier_state(self):
        child = {"id": "supplier-child", "role": "supplier_child", "parentId": "supplier-parent", "name": "子账号"}
        visible = {
            "accounts": [{"id": "account-b", "name": "账号 B", "platform": "视频号"}],
            "assets": [self.scoped_state["assets"][1]],
        }
        with patch.object(main.store, "state_for", return_value=visible) as state_for:
            snapshot = main._supplier_assistant_snapshot(child, now=self.now)
        state_for.assert_called_once_with("supplier-child", "supplier_child", "supplier-parent", ["accounts", "assets"])
        self.assertEqual(["账号 B"], [item["account"] for item in snapshot["deliveries"]])
        self.assertNotIn("账号 A", str(snapshot))

    def test_open_question_calls_deployed_llm_with_authorized_snapshot_only(self):
        snapshot = self._snapshot()
        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(
            main, "_call_llm", new=AsyncMock(return_value=FakeLlmResponse())
        ) as call_llm:
            result = asyncio.run(main._supplier_assistant_answer("总结最近两天的交付节奏", snapshot, self.member))
        self.assertEqual("llm", result["source"])
        self.assertEqual("MiniMax-M3", result["model"])
        self.assertIn("昨天回传链接占比更高", result["answer"])
        body = call_llm.await_args.args[0]
        self.assertEqual("MiniMax-M3", body["model"])
        self.assertIn("2026-07-23", body["messages"][1]["content"])
        self.assertNotIn("不应进入问答", body["messages"][1]["content"])
        self.assertIsInstance(call_llm.await_args.kwargs["attempt_ledger"], main._ModelUsageAttempts)

    def test_date_fact_and_link_question_both_use_m3_but_raw_links_stay_server_side(self):
        snapshot = self._snapshot()
        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(
            main, "_call_llm", new=AsyncMock(return_value=FakeLlmResponse())
        ) as call_llm:
            result = asyncio.run(main._supplier_assistant_answer("昨天交付多少条", snapshot, self.member))
        self.assertEqual("llm", result["source"])
        self.assertTrue(result["answer"].startswith("昨天交付 2 条，其中已回传链接 1 条。"))
        body = call_llm.await_args.args[0]
        self.assertIn("authoritativeAnswer", body["messages"][1]["content"])
        self.assertIn("昨天交付 2 条，其中已回传链接 1 条。", body["messages"][1]["content"])
        self.assertNotIn("https://example.test/a", body["messages"][1]["content"])
        self.assertIsInstance(call_llm.await_args.kwargs["attempt_ledger"], main._ModelUsageAttempts)

        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(
            main, "_call_llm", new=AsyncMock(return_value=FakeLlmResponse())
        ) as call_llm:
            links = asyncio.run(main._supplier_assistant_answer("昨天回传链接", snapshot, self.member))
        self.assertEqual("llm", links["source"])
        self.assertIn("https://example.test/a", links["answer"])
        body = call_llm.await_args.args[0]
        self.assertIn("完整链接清单将由系统附在回答下方", body["messages"][1]["content"])
        self.assertNotIn("https://example.test/a", body["messages"][1]["content"])

    def test_greeting_is_a_model_turn_instead_of_a_local_statistics_fallback(self):
        snapshot = self._snapshot()
        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(
            main, "_call_llm", new=AsyncMock(return_value=FakeGreetingResponse())
        ) as call_llm:
            result = asyncio.run(main._supplier_assistant_answer("你好", snapshot, self.member))
        self.assertEqual("llm", result["source"])
        self.assertEqual("你好！我是数据助手，可以帮你查询交付、回传链接、下载记录、账号排行和播放量。", result["answer"])
        self.assertNotIn("当前共有", result["answer"])
        self.assertIn("遇到问候或闲聊时", call_llm.await_args.args[0]["messages"][0]["content"])

    def test_unavailable_model_is_reported_instead_of_returning_a_local_rule_answer(self):
        snapshot = self._snapshot()
        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(
            main, "_call_llm", new=AsyncMock(side_effect=RuntimeError("provider unavailable"))
        ):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main._supplier_assistant_answer("你好", snapshot, self.member))
        self.assertEqual(503, error.exception.status_code)
        self.assertIn("语言模型暂时不可用", str(error.exception.detail))

    def test_route_is_member_authenticated_and_supplier_only(self):
        route = next(route for route in main.app.routes if getattr(route, "path", "") == "/api/supplier/assistant")
        dependencies = {dependency.call for dependency in route.dependant.dependencies}
        self.assertIn(main.require_member, dependencies)

    def test_frontend_only_accepts_server_m3_answers_and_never_uses_browser_rule_fallback(self):
        remote = (APP_DIR / "js/core/remote.js").read_text(encoding="utf-8")
        view = (APP_DIR / "js/views/supplierViews.js").read_text(encoding="utf-8")
        self.assertIn('ask: (question) => req("/api/supplier/assistant"', remote)
        self.assertIn("await remote.supplier.ask(q)", view)
        self.assertIn('response?.source !== "llm"', view)
        self.assertIn("语言模型暂时不可用，本次未使用本地规则回答", view)
        self.assertNotIn("function supplierDataAnswer", view)
        self.assertIn("supplierAssistantPending", view)
        self.assertIn("正在读取数据…", view)
        self.assertIn("数据助手", view)


if __name__ == "__main__":
    unittest.main()
