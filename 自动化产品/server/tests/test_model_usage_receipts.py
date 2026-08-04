import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import store


class ModelUsageReceiptStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "usage-receipts.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.editor = store.add_member(
            "画布创作者", "canvas-receipt-editor", "123456", "editor"
        )

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def begin(self, *, member_id=None, key="canvas:agent:1", fingerprint="request-a", kind="llm"):
        return store.begin_model_usage_receipt(
            member_id or self.editor[0],
            surface="canvas",
            feature="无限画布导演理解" if kind == "llm" else "无限画布图片生成",
            usage_kind=kind,
            operation="agent" if kind == "llm" else "generate",
            operation_id=key,
            idempotency_key=key,
            request_fingerprint=fingerprint,
            source="main-canvas",
            provider="qianfan" if kind == "llm" else "tencent-maas",
            model="ernie" if kind == "llm" else "hunyuan-image",
            now_ms=1_800_000_000_000,
        )

    def test_precall_intent_is_member_scoped_and_replay_never_calls_provider(self):
        first = self.begin()
        self.assertTrue(first["created"])
        self.assertTrue(first["shouldCallProvider"])
        replay = self.begin()
        self.assertTrue(replay["reused"])
        self.assertFalse(replay["shouldCallProvider"])
        self.assertEqual(first["receiptId"], replay["receiptId"])

        other = store.add_member("另一位创作者", "canvas-receipt-other", "123456", "user")
        other_receipt = self.begin(member_id=other[0])
        self.assertNotEqual(first["receiptId"], other_receipt["receiptId"])
        user_summary = next(
            item for item in store.model_usage_summary() if item["memberId"] == other[0]
        )
        self.assertEqual("user", user_summary["role"])

        with self.assertRaises(store.ModelUsageReceiptConflict):
            self.begin(fingerprint="different-request")

    def test_token_unknown_llm_call_remains_visible_without_fake_tokens(self):
        receipt = self.begin()
        completed = store.complete_model_usage_receipt(
            receipt["receiptId"], provider_ref="llm-request-1", usage={}, now_ms=1_800_000_000_100
        )
        self.assertEqual("succeeded", completed["status"])
        projected = store.reconcile_model_usage_outbox(
            receipt_id=receipt["receiptId"], now_ms=1_800_000_000_200
        )
        self.assertEqual(1, projected["receiptOnly"])

        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(0, conn.execute("SELECT COUNT(*) FROM llm_usage_events").fetchone()[0])
        summary = next(
            item for item in store.model_usage_summary()
            if item["memberId"] == self.editor[0]
        )
        self.assertEqual(1, summary["calls"])
        self.assertEqual(1, summary["confirmedLlmCalls"])
        self.assertEqual(1, summary["tokenUnknownCalls"])
        self.assertEqual(0, summary["totalTokens"])

        details = store.model_usage_details(member_id=self.editor[0])
        self.assertEqual(1, len(details["receiptEvents"]))
        self.assertFalse(details["receiptEvents"][0]["tokenUsageKnown"])
        self.assertEqual(1, details["receiptRows"][0]["tokenUnknownCalls"])

    def test_provider_accepted_image_with_zero_output_is_still_counted(self):
        receipt = self.begin(key="canvas:image:accepted", kind="image")
        store.complete_model_usage_receipt(
            receipt["receiptId"],
            provider_ref="image-request-accepted",
            output_units=0,
            unit_label="张",
            now_ms=1_800_000_000_100,
        )
        store.reconcile_model_usage_outbox(
            receipt_id=receipt["receiptId"], now_ms=1_800_000_000_200
        )
        with sqlite3.connect(store.DB_PATH) as conn:
            event = conn.execute(
                "SELECT calls,output_units FROM api_usage_events WHERE api_type='image'"
            ).fetchone()
        self.assertEqual((1, 0), event)
        summary = next(
            item for item in store.model_usage_summary()
            if item["memberId"] == self.editor[0]
        )
        self.assertEqual(1, summary["imageCalls"])
        self.assertEqual(0, summary["imageOutputs"])
        self.assertEqual(1, summary["confirmedImageCalls"])

    def test_completion_and_legacy_projection_are_exactly_once(self):
        receipt = self.begin(key="canvas:agent:tokens")
        completed = store.complete_model_usage_receipt(
            receipt["receiptId"],
            provider_ref="llm-request-tokenized",
            usage={"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            now_ms=1_800_000_000_100,
        )
        replay = store.complete_model_usage_receipt(
            receipt["receiptId"],
            provider_ref="llm-request-tokenized",
            usage={"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            now_ms=1_800_000_000_300,
        )
        self.assertTrue(replay["reused"])
        self.assertEqual(completed["receiptId"], replay["receiptId"])
        first = store.reconcile_model_usage_outbox(
            receipt_id=receipt["receiptId"], now_ms=1_800_000_000_400
        )
        second = store.reconcile_model_usage_outbox(
            receipt_id=receipt["receiptId"], now_ms=1_800_000_000_500
        )
        self.assertEqual(1, first["projected"])
        self.assertEqual(0, second["selected"])
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(1, conn.execute("SELECT COUNT(*) FROM llm_usage_events").fetchone()[0])
            self.assertEqual(20, conn.execute("SELECT total_tokens FROM llm_usage_events").fetchone()[0])

    def test_legacy_event_id_collision_is_not_silently_marked_projected(self):
        receipt = self.begin(key="canvas:agent:collision")
        store.complete_model_usage_receipt(
            receipt["receiptId"],
            provider_ref="llm-request-collision",
            usage={"total_tokens": 9},
        )
        legacy_id = store._model_usage_legacy_event_id(receipt["receiptId"], "llm")
        with sqlite3.connect(store.DB_PATH) as conn:
            conn.execute(
                "INSERT INTO llm_usage_events("
                "id,member_id,member_name,feature,model,prompt_tokens,completion_tokens,"
                "total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (legacy_id, "wrong", "wrong", "wrong", "wrong", 0, 0, 999, 1),
            )
        result = store.reconcile_model_usage_outbox(receipt_id=receipt["receiptId"])
        self.assertEqual(1, result["failed"])
        with sqlite3.connect(store.DB_PATH) as conn:
            state = conn.execute(
                "SELECT state,last_error FROM model_usage_outbox WHERE receipt_id=?",
                (receipt["receiptId"],),
            ).fetchone()
            token_value = conn.execute(
                "SELECT total_tokens FROM llm_usage_events WHERE id=?", (legacy_id,)
            ).fetchone()[0]
        self.assertEqual("conflict", state[0])
        self.assertEqual("ModelUsageReceiptConflict", state[1])
        self.assertEqual(999, token_value)

    def test_unknown_is_auditable_and_failed_attempt_requires_new_key(self):
        unknown = self.begin(key="canvas:agent:unknown")
        marked = store.mark_model_usage_receipt_unknown(
            unknown["receiptId"], "provider response lost"
        )
        self.assertEqual("unknown", marked["status"])
        self.assertIn(
            unknown["receiptId"],
            {item["receiptId"] for item in store.unresolved_model_usage_receipts()},
        )
        self.assertFalse(self.begin(key="canvas:agent:unknown")["shouldCallProvider"])

        failed = self.begin(key="canvas:agent:failed")
        store.fail_model_usage_receipt(failed["receiptId"], "definite upstream rejection")
        with self.assertRaises(store.ModelUsageReceiptConflict):
            store.complete_model_usage_receipt(failed["receiptId"], usage={"total_tokens": 2})
        retry = self.begin(key="canvas:agent:failed:attempt-2")
        self.assertTrue(retry["shouldCallProvider"])

    def test_busy_retry_is_bounded_and_completion_failure_keeps_intent(self):
        original_connect = store._connect_model_usage_write
        calls = {"count": 0}

        def flaky_connect(*args, **kwargs):
            calls["count"] += 1
            if calls["count"] <= 2:
                raise sqlite3.OperationalError("database is locked")
            return original_connect(*args, **kwargs)

        with patch.object(
            store, "_connect_model_usage_write", side_effect=flaky_connect
        ), patch.object(
            store.time, "sleep", return_value=None
        ):
            receipt = self.begin(key="canvas:agent:busy-retry")
        self.assertTrue(receipt["created"])
        self.assertEqual(3, calls["count"])

        with patch.object(
            store,
            "_connect_model_usage_write",
            side_effect=sqlite3.OperationalError("database is locked"),
        ), patch.object(store.time, "sleep", return_value=None):
            with self.assertRaises(store.ModelUsageReceiptWriteError):
                store.complete_model_usage_receipt(receipt["receiptId"], usage={"total_tokens": 5})
        with sqlite3.connect(store.DB_PATH) as conn:
            status = conn.execute(
                "SELECT call_status FROM model_usage_receipts WHERE receipt_id=?",
                (receipt["receiptId"],),
            ).fetchone()[0]
        self.assertEqual("pending", status)

    def test_local_schema_preserves_v139_receipt_and_advances_forward_only(self):
        with sqlite3.connect(store.DB_PATH) as conn:
            ledger = conn.execute(
                "SELECT checksum,status FROM schema_migrations WHERE version=?",
                (store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            media_ledger = conn.execute(
                "SELECT checksum,status FROM schema_migrations WHERE version=?",
                (store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            compose_ledger = conn.execute(
                "SELECT checksum,status FROM schema_migrations WHERE version=?",
                (store.VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
        self.assertEqual(
            (store.MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM, "success"), ledger
        )
        self.assertEqual(
            (store.PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM, "success"),
            media_ledger,
        )
        self.assertEqual(
            (store.VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM, "success"),
            compose_ledger,
        )
        self.assertEqual(
            store.VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,
            store.LATEST_SCHEMA_MIGRATION_VERSION,
        )


if __name__ == "__main__":
    unittest.main()
