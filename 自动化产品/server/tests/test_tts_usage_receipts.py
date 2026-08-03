import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from server import main, store


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        return self._payload


def successful_tts(trace_id="trace-1"):
    return FakeResponse(
        payload={
            "base_resp": {"status_code": 0},
            "data": {"audio": "74657374"},
            "extra_info": {"audio_length": 1200, "audio_format": "mp3"},
            "trace_id": trace_id,
        }
    )


class TtsUsageReceiptTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "tts-usage.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        member_row = store.add_member("TTS 创作者", "tts-usage-editor", "123456", "editor")
        self.member = store.member_public(member_row)
        self.req = main.TtsReq(
            text="这是一段可对账的语音",
            voiceId="custom-voice",
            idempotencyKey="tts-receipt-1",
        )
        self.fingerprint = main._quota_request_fingerprint(self.req)

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def run_generate(self, request=None, key="tts-receipt-1"):
        request = request or self.req
        return asyncio.run(
            main._tts_generate_impl(
                request,
                member=self.member,
                idempotency_key=key,
                request_fingerprint=main._quota_request_fingerprint(request),
            )
        )

    def test_success_writes_pending_before_provider_and_replay_never_calls_again(self):
        observed_statuses = []

        async def provider(_payload):
            pending = store.unresolved_model_usage_receipts()
            observed_statuses.append([item["status"] for item in pending])
            return successful_tts()

        with patch.object(main, "MINIMAX_API_KEY", "test-key"), patch.object(
            main, "_minimax_tts_request", new=AsyncMock(side_effect=provider)
        ) as mocked:
            result = self.run_generate()
            with self.assertRaises(HTTPException) as replay:
                self.run_generate()

        self.assertEqual(409, replay.exception.status_code)
        self.assertEqual(1, mocked.await_count)
        self.assertEqual([["pending"]], observed_statuses)
        self.assertTrue(result["audioDataUrl"].startswith("data:audio/mp3;base64,"))
        summary = next(
            row for row in store.model_usage_summary()
            if row["memberId"] == self.member["id"]
        )
        self.assertEqual(1, summary["voiceCalls"])
        self.assertEqual(len(self.req.text), summary["voiceOutputs"])

    def test_invalid_custom_voice_and_fallback_are_two_exact_attempts(self):
        invalid = FakeResponse(
            status_code=400,
            payload={"detail": "voice_id not found"},
            text="voice_id not found",
        )
        with patch.object(main, "MINIMAX_API_KEY", "test-key"), patch.object(
            main, "MINIMAX_VOICE_ID", "platform-default"
        ), patch.object(
            main,
            "_minimax_tts_request",
            new=AsyncMock(side_effect=[invalid, successful_tts("trace-fallback")]),
        ) as mocked:
            result = self.run_generate()

        self.assertEqual(2, mocked.await_count)
        self.assertTrue(result["fallbackVoice"])
        self.assertEqual("platform-default", result["voiceId"])
        details = store.model_usage_details(member_id=self.member["id"])
        statuses = sorted(item["status"] for item in details["receiptEvents"])
        self.assertEqual(["failed", "succeeded"], statuses)
        self.assertEqual(1, sum(item["calls"] for item in details["receiptEvents"]))

    def test_receipt_write_failure_prevents_provider(self):
        with patch.object(main, "MINIMAX_API_KEY", "test-key"), patch.object(
            store,
            "begin_model_usage_receipt",
            side_effect=store.ModelUsageReceiptWriteError("busy"),
        ), patch.object(
            main, "_minimax_tts_request", new=AsyncMock(return_value=successful_tts())
        ) as mocked:
            with self.assertRaises(HTTPException) as denied:
                self.run_generate()
        self.assertEqual(503, denied.exception.status_code)
        self.assertEqual(0, mocked.await_count)

    def test_network_uncertainty_stays_visible_without_fake_output(self):
        # The production service is deliberately pinned to Pydantic v1.  Use
        # the v1 API here as well; Pydantic v2 keeps it as a compatibility API.
        request = self.req.copy(update={"idempotencyKey": "tts-network"})
        with patch.object(main, "MINIMAX_API_KEY", "test-key"), patch.object(
            main,
            "_minimax_tts_request",
            new=AsyncMock(side_effect=httpx.ReadTimeout("timed out")),
        ):
            with self.assertRaises(HTTPException) as failed:
                self.run_generate(request, key="tts-network")
        self.assertEqual(502, failed.exception.status_code)
        details = store.model_usage_details(member_id=self.member["id"])
        self.assertEqual("unknown", details["receiptEvents"][0]["status"])
        self.assertEqual(0, details["receiptEvents"][0]["outputUnits"])

    def test_lookup_frontend_supplies_a_stable_request_key(self):
        app_dir = Path(main.__file__).resolve().parents[1]
        source = (app_dir / "js" / "api" / "providers.js").read_text("utf-8")
        self.assertIn('generationOperationKey("voice-lookup")', source)
        self.assertIn('creatorAuthHeaders({ "Idempotency-Key": requestKey })', source)


if __name__ == "__main__":
    unittest.main()
