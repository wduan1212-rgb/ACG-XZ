import asyncio
import inspect
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from server import main


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text or ""
        self.content = b"{}"
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, *_args, **_kwargs):
        return self.responses.pop(0)


@asynccontextmanager
async def open_queue():
    yield


class MainProviderUsageReceiptTest(unittest.TestCase):
    member = {"id": "member-a", "name": "成员甲", "role": "editor"}

    def _ledger(self, events, *, kind="llm", operation="test.provider"):
        async def begin(_member, **kwargs):
            ordinal = len([event for event in events if event[0] == "begin"]) + 1
            events.append(("begin", kwargs))
            return {"receiptId": f"receipt-{ordinal}", "shouldCallProvider": True}

        async def mark(receipt, error, *, definitive=None):
            events.append(("mark", receipt["receiptId"], definitive, str(error)))

        async def complete(receipt, **kwargs):
            events.append(("complete", receipt["receiptId"], kwargs))
            return True

        ledger = main._ModelUsageAttempts(
            self.member,
            feature="主服务模型调用",
            usage_kind=kind,
            operation=operation,
            idempotency_key="stable-request",
            request_fingerprint="f" * 64,
            provider="provider.test",
            model="model-test",
            surface="main",
            source="main-provider",
        )
        return ledger, begin, mark, complete

    def test_llm_retry_opens_one_receipt_per_network_attempt_and_classifies_5xx_unknown(self):
        events = []
        ledger, begin, mark, complete = self._ledger(events)
        responses = [
            FakeResponse(503, {"error": "temporary"}, "temporary"),
            FakeResponse(200, {
                "id": "req-ok",
                "model": "model-test",
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
                "choices": [{"message": {"content": "ok"}}],
            }),
        ]

        async def run():
            with patch.object(main, "_begin_model_usage_call_async", new=begin), patch.object(
                main, "_mark_model_usage_call_async", new=mark,
            ), patch.object(main, "_complete_model_usage_call_async", new=complete), patch.object(
                main.httpx, "AsyncClient", return_value=FakeClient(responses),
            ), patch.object(main.asyncio, "sleep", new=AsyncMock()):
                response = await main._call_llm(
                    {"model": "model-test", "messages": []},
                    attempt_ledger=ledger,
                )
                return await main._finish_llm_attempt(ledger, response, fallback_model="model-test")

        data = asyncio.run(run())
        self.assertEqual("req-ok", data["id"])
        begins = [event for event in events if event[0] == "begin"]
        self.assertEqual(2, len(begins))
        self.assertNotEqual(begins[0][1]["idempotency_key"], begins[1][1]["idempotency_key"])
        self.assertEqual(False, next(event for event in events if event[0] == "mark")[2])
        self.assertEqual("receipt-2", next(event for event in events if event[0] == "complete")[1])
        self.assertNotIn("messages", str(begins))

    def test_image_and_video_busy_retries_each_get_distinct_receipts(self):
        async def exercise_image():
            events = []
            ledger, begin, mark, _complete = self._ledger(
                events, kind="image", operation="image.generate",
            )
            with patch.object(main, "_begin_model_usage_call_async", new=begin), patch.object(
                main, "_mark_model_usage_call_async", new=mark,
            ), patch.object(main, "_image_submit_queue", new=open_queue), patch.object(
                main.asyncio, "sleep", new=AsyncMock(),
            ):
                response, _data = await main._post_json_with_retry(
                    FakeClient([
                        FakeResponse(503, {"error": "concurrency limit"}),
                        FakeResponse(200, {"data": [{"url": "ok"}]}),
                    ]),
                    "https://provider.test/images",
                    {"prompt": "secret prompt"},
                    {},
                    retries=1,
                    attempt_ledger=ledger,
                )
            return response, events

        async def exercise_video():
            events = []
            ledger, begin, mark, _complete = self._ledger(
                events, kind="video", operation="video.submit",
            )
            with patch.object(main, "_begin_model_usage_call_async", new=begin), patch.object(
                main, "_mark_model_usage_call_async", new=mark,
            ), patch.object(main, "_video_submit_queue", new=open_queue), patch.object(
                main.asyncio, "sleep", new=AsyncMock(),
            ):
                response = await main._queued_video_post(
                    FakeClient([
                        FakeResponse(429, {"error": "rate limit"}),
                        FakeResponse(200, {"id": "task-ok"}),
                    ]),
                    "https://provider.test/videos",
                    retries=1,
                    attempt_ledger=ledger,
                    json={"prompt": "secret prompt"},
                )
            return response, events

        image_response, image_events = asyncio.run(exercise_image())
        video_response, video_events = asyncio.run(exercise_video())
        self.assertEqual(200, image_response.status_code)
        self.assertEqual(200, video_response.status_code)
        self.assertEqual(2, len([event for event in image_events if event[0] == "begin"]))
        self.assertEqual(False, next(event for event in image_events if event[0] == "mark")[2])
        self.assertEqual(2, len([event for event in video_events if event[0] == "begin"]))
        self.assertEqual(True, next(event for event in video_events if event[0] == "mark")[2])
        self.assertNotIn("secret prompt", str(image_events + video_events))

    def test_all_requested_main_provider_callers_are_wired_to_durable_attempts(self):
        expected = {
            "llm_test": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "llm_proxy": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "llm_vision_copy": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "llm_image_copy_reference_brief": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "llm_image_reference_plan": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "chat_completions_proxy": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "image_generate": ("_main_provider_attempts", "attempt_ledger=attempts"),
            "_video_submit_upstream": ("_main_provider_attempts", "attempt_ledger=usage_attempts"),
            "_supplier_assistant_answer": ("_main_provider_attempts", "attempt_ledger=attempts"),
        }
        for function_name, needles in expected.items():
            with self.subTest(function=function_name):
                source = inspect.getsource(getattr(main, function_name))
                for needle in needles:
                    self.assertIn(needle, source)
        source = inspect.getsource(main)
        self.assertNotIn('_record_llm_usage(_me, data, "通用文案"', source)
        self.assertNotIn('_record_model_api_usage(_me, "video"', source)

    def test_image_queue_timeout_happens_before_receipt_and_provider_call(self):
        events = []

        class Ledger:
            async def acquire(self):
                events.append("receipt")
                return {"receiptId": "must-not-open"}

            async def mark_latest(self, *_args, **_kwargs):
                events.append("mark")

        client = FakeClient([FakeResponse(200, {"data": [{"url": "ok"}]})])

        @asynccontextmanager
        async def busy_queue():
            raise main.HTTPException(
                503,
                detail={
                    "code": "image_queue_busy",
                    "providerCalled": False,
                    "retryable": True,
                },
            )
            yield

        async def run():
            with patch.object(main, "_image_submit_queue", new=busy_queue):
                with self.assertRaises(main.HTTPException) as caught:
                    await main._post_json_with_retry(
                        client, "https://provider.test/images", {}, {},
                        retries=0, attempt_ledger=Ledger(),
                    )
                return caught.exception

        error = asyncio.run(run())
        self.assertEqual(503, error.status_code)
        self.assertEqual([], events)
        self.assertEqual(1, len(client.responses))

    def test_image_operation_reconciliation_is_read_only(self):
        receipts = {
            "image.generate:image-op:attempt:1": {
                "status": "succeeded", "providerRef": "provider-1",
                "calls": 1, "outputUnits": 1, "updatedAt": 123,
            },
        }

        def find(_member_id, *, source, stable_credential):
            self.assertEqual("main-provider", source)
            return receipts.get(stable_credential)

        with patch.object(main.store, "find_model_usage_receipt", new=find):
            status = main.image_operation_status("image-op", {"id": "member-a"})
        self.assertEqual("succeeded", status["status"])
        self.assertTrue(status["providerCalled"])
        self.assertEqual("provider-1", status["attempts"][0]["providerRef"])


if __name__ == "__main__":
    unittest.main()
