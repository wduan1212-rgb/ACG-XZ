import json
import tempfile
import unittest
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from server import main, store


class LlmUsageStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "usage.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_only_verified_usage_is_persisted_and_summarized(self):
        editor = store.add_member("创作者甲", "creator-a", "123456", "editor")
        self.assertFalse(store.record_llm_usage(editor[0], "创作者甲", "通用文案", "m3", {}))
        self.assertTrue(store.record_llm_usage(editor[0], "创作者甲", "通用文案", "m3", {
            "prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165,
        }))
        self.assertTrue(store.record_llm_usage(editor[0], "创作者甲", "成图文案", "vision", {
            "input_tokens": 30, "output_tokens": 20,
        }))

        row = next(item for item in store.llm_usage_summary() if item["memberId"] == editor[0])
        self.assertEqual(2, row["calls"])
        self.assertEqual(150, row["promptTokens"])
        self.assertEqual(65, row["completionTokens"])
        self.assertEqual(215, row["totalTokens"])

        details = store.llm_usage_details()
        by_api = {(item["feature"], item["model"]): item for item in details["apiRows"]}
        self.assertEqual(165, by_api[("通用文案", "m3")]["totalTokens"])
        self.assertEqual(50, by_api[("成图文案", "vision")]["totalTokens"])
        self.assertEqual(2, len(details["events"]))
        self.assertEqual("成图文案", details["events"][0]["feature"])

    def test_image_and_video_are_recorded_as_successful_calls_not_fake_tokens(self):
        editor = store.add_member("创作者乙", "creator-b", "123456", "editor")
        self.assertTrue(store.record_api_usage(editor[0], "创作者乙", "image", "图片生成", "image-model-a", 1, "张"))
        self.assertTrue(store.record_api_usage(editor[0], "创作者乙", "video", "视频生成", "video-model-b", 1, "任务"))
        self.assertFalse(store.record_api_usage(editor[0], "创作者乙", "image", "图片生成", "image-model-a", 0, "张"))

        row = next(item for item in store.model_usage_summary() if item["memberId"] == editor[0])
        self.assertEqual(0, row["totalTokens"])
        self.assertEqual(1, row["imageCalls"])
        self.assertEqual(1, row["imageOutputs"])
        self.assertEqual(1, row["videoCalls"])
        self.assertEqual(1, row["videoOutputs"])

        details = store.model_usage_details(member_id=editor[0])
        by_model = {(item["feature"], item["model"]): item for item in details["assetApiRows"]}
        self.assertEqual(1, by_model[("图片生成", "image-model-a")]["outputUnits"])
        self.assertEqual("张", by_model[("图片生成", "image-model-a")]["unitLabel"])
        self.assertEqual(1, by_model[("视频生成", "video-model-b")]["outputUnits"])
        self.assertEqual(2, len(details["assetEvents"]))

    def test_topic_usage_counts_outputs_by_item_and_replay_is_idempotent(self):
        editor = store.add_member("选题创作者", "topic-creator", "123456", "editor")
        event_id = "topic-stable-request"
        self.assertTrue(store.record_api_usage(
            editor[0], "选题创作者", "topic", "百度搜索 AI 选题",
            "MiniMax-M3", 50, "条", event_id=event_id,
        ))
        self.assertTrue(store.record_api_usage(
            editor[0], "选题创作者", "topic", "百度搜索 AI 选题",
            "MiniMax-M3", 50, "条", event_id=event_id,
        ))

        row = next(
            item for item in store.model_usage_summary()
            if item["memberId"] == editor[0]
        )
        self.assertEqual(1, row["topicCalls"])
        self.assertEqual(50, row["topicOutputs"])
        details = store.model_usage_details(member_id=editor[0])
        topic = next(
            item for item in details["assetApiRows"]
            if item["feature"] == "百度搜索 AI 选题"
        )
        self.assertEqual(1, topic["calls"])
        self.assertEqual(50, topic["outputUnits"])
        self.assertEqual("条", topic["unitLabel"])

    def test_usage_range_filters_legacy_events_without_hiding_members(self):
        editor = store.add_member("范围测试", "usage-range", "123456", "editor")
        store.record_llm_usage(editor[0], "范围测试", "旧调用", "m3", {"total_tokens": 30})
        store.record_api_usage(editor[0], "范围测试", "image", "旧图片", "image", 1, "张")
        old_at = int(time.time() * 1000) - 40 * 24 * 60 * 60 * 1000
        with sqlite3.connect(store.DB_PATH) as conn:
            conn.execute("UPDATE llm_usage_events SET created_at=? WHERE member_id=?", (old_at, editor[0]))
            conn.execute("UPDATE api_usage_events SET created_at=? WHERE member_id=?", (old_at, editor[0]))
            conn.commit()
        since = int(time.time() * 1000) - 7 * 24 * 60 * 60 * 1000
        row = next(item for item in store.model_usage_summary(since) if item["memberId"] == editor[0])
        self.assertEqual(0, row["totalTokens"])
        self.assertEqual(0, row["imageCalls"])
        details = store.model_usage_details(member_id=editor[0], since_ms=since)
        self.assertEqual([], details["events"])
        self.assertEqual([], details["assetEvents"])

    def test_qianfan_preview_enforces_platform_text_limits(self):
        accounts = [
            main.QianfanTopicAccount(id="xhs", name="小红书号", platform="小红书"),
            main.QianfanTopicAccount(id="wx", name="视频号", platform="视频号"),
        ]
        payload = {"items": [
            {"accountId": "xhs", "title": "甲" * 30, "copy": "乙" * 1200, "tags": ["AI", "工具"]},
            {"accountId": "wx", "title": "规则怪谈：校园！第一个晚上", "copy": "正文", "tags": []},
        ]}
        items = {item["accountId"]: item for item in main._qianfan_normalize_topic_items(payload, accounts)}
        self.assertEqual(20, len(items["xhs"]["title"]))
        self.assertEqual(1000, len(items["xhs"]["copy"]))
        self.assertLessEqual(len(items["wx"]["title"]), 16)
        self.assertNotRegex(items["wx"]["title"], r"[：！]")

    def test_qianfan_single_account_repair_recovers_a_missing_account_id(self):
        accounts = [main.QianfanTopicAccount(id="only", name="唯一账号", platform="小红书")]
        payload = {"items": [{"title": "补齐这一行", "copy": "基于搜索资料生成的正文", "tags": ["AI"]}]}
        items = main._qianfan_normalize_topic_items(
            payload,
            accounts,
            single_account_fallback=True,
        )
        self.assertEqual(1, len(items))
        self.assertEqual("only", items[0]["accountId"])

    def test_qianfan_route_repairs_missing_accounts_and_returns_partial_preview(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("for index, account in enumerate(missing_accounts, start=1)", source)
        self.assertIn("single_account_fallback=True", source)
        self.assertIn('"missingAccountIds": still_missing', source)
        self.assertIn('errors_by_account[account_id] = _qianfan_topic_error_message(exc)', source)
        self.assertNotIn("还有 {len(still_missing)} 个账号未生成完整内容", source)
        self.assertIn("不要根据账号定位、人设、语气或历史文风改写", source)
        self.assertIn("干货拆解", source)
        self.assertIn("自然的真人分享", source)
        self.assertIn("你是严格 JSON 格式修复器", source)
        self.assertIn("qianfan.topic-ideas.{phase}.json-repair", source)
        self.assertIn('idempotency_key=f"{request_key}:{phase}:json-repair"', source)
        self.assertNotIn('"style": str(account.style or "")[:600]', source)

    def test_main_service_no_longer_exposes_silent_best_effort_recorders(self):
        self.assertFalse(hasattr(main, "_record_llm_usage"))
        self.assertFalse(hasattr(main, "_record_model_api_usage"))

    def test_reference_planner_never_turns_visual_attachment_into_long_prompt_copy(self):
        self.assertEqual({}, main._image_reference_plan_json("not json"))
        self.assertEqual("附件1放在右侧", main._clean_reference_instruction("  附件1放在右侧  "))
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('/api/llm/image-reference-plan', source)
        self.assertIn("不要详细复述附件里的颜色、物体、人物或文字", source)
        self.assertIn("class _ModelUsageAttempts", source)
        self.assertIn('operation="image.generate"', source)
        self.assertIn('operation="video.submit.seedance"', source)
        self.assertNotIn('_record_model_api_usage(member, "image", "图片生成"', source)
        self.assertNotIn('_record_model_api_usage(_me, "video", "视频生成"', source)


class QianfanTopicPartialResponseTest(unittest.IsolatedAsyncioTestCase):
    async def test_partial_accounts_are_returned_and_only_successes_are_counted(self):
        accounts = [
            main.QianfanTopicAccount(
                id=f"account-{index}",
                name=f"账号{index}",
                platform="小红书",
            )
            for index in range(1, 9)
        ]
        request = main.QianfanTopicReq(query="AI 行业动态", recency="week", accounts=accounts)

        class SearchResponse:
            status_code = 200
            text = ""

            @staticmethod
            def json():
                return {
                    "request_id": "search-partial-1",
                    "references": [{
                        "id": 1,
                        "title": "公开资料",
                        "url": "https://example.com/source",
                        "content": "用于测试的公开事实资料",
                    }],
                }

        class SearchClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, *_args, **_kwargs):
                return SearchResponse()

        def llm_payload(account_ids):
            return {
                "choices": [{"message": {"content": json.dumps({
                    "items": [{
                        "accountId": account_id,
                        "title": f"{account_id}标题",
                        "copy": f"{account_id}正文",
                        "sourceIds": [1],
                    } for account_id in account_ids],
                }, ensure_ascii=False)}}],
            }

        provider_results = [
            llm_payload([f"account-{index}" for index in range(1, 7)]),
            HTTPException(503, "模型繁忙"),
            llm_payload(["account-7"]),
            HTTPException(503, "模型仍繁忙"),
        ]

        async def fake_call_llm(_body, **_kwargs):
            result = provider_results.pop(0)
            if isinstance(result, BaseException):
                raise result
            return result

        async def fake_finish(_ledger, response, **_kwargs):
            return response

        async def fake_billable(_member, *, operation, **_kwargs):
            return await operation(), {"status": "settled", "bypassed": True}

        usage = []
        with (
            patch.object(main, "QIANFAN_SEARCH_API_KEY", "test-search-key"),
            patch.object(main, "LLM_API_KEY", "test-llm-key"),
            patch.object(main.httpx, "AsyncClient", side_effect=lambda **_kwargs: SearchClient()),
            patch.object(main, "_main_provider_attempts", return_value=object()),
            patch.object(main, "_call_llm", side_effect=fake_call_llm),
            patch.object(main, "_finish_llm_attempt", side_effect=fake_finish),
            patch.object(main, "_run_personal_billable", side_effect=fake_billable),
            patch.object(store, "record_api_usage", side_effect=lambda *args, **kwargs: usage.append((args, kwargs)) or True),
        ):
            result = await main.qianfan_topic_ideas(
                request,
                _me={"id": "member-1", "name": "测试成员"},
                idempotency_key="partial-topic-test",
            )

        self.assertEqual(
            [f"account-{index}" for index in range(1, 8)],
            [item["accountId"] for item in result["items"]],
        )
        self.assertFalse(result["complete"])
        self.assertEqual(["account-8"], result["missingAccountIds"])
        self.assertEqual("account-8", result["errors"][0]["accountId"])
        self.assertIn("模型仍繁忙", result["errors"][0]["message"])
        self.assertEqual(1, len(usage))
        self.assertEqual(7, usage[0][0][5])
        self.assertEqual([], provider_results)


if __name__ == "__main__":
    unittest.main()
