from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from server import main, store


def _receipt(
    operation: str,
    kind: str,
    feature: str,
    *,
    status: str = "succeeded",
    provider_ref: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    output_units: int = 0,
    unit_label: str = "次",
) -> dict:
    return {
        "schemaVersion": 1,
        "operationId": operation,
        "surface": "video-workshop",
        "projectId": "workshop-usage-1",
        "feature": feature,
        "usageKind": kind,
        "provider": "minimax" if kind in {"llm", "voice"} else "seedance" if kind == "video" else "image-api",
        "providerRef": provider_ref,
        "model": {
            "llm": "MiniMax-M3",
            "image": "image-model",
            "voice": "speech-2.8-hd",
            "video": "seedance-model",
        }[kind],
        "status": status,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": input_tokens + output_tokens,
        "outputUnits": output_units,
        "unitLabel": unit_label,
        "occurredAt": "2026-08-03T12:00:00+08:00",
    }


class VideoWorkshopUsageReconciliationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "video-usage.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.owner = store.add_member(
            "视频工坊成员", "video-usage-owner", "123456", "editor"
        )
        self.other = store.add_member(
            "另一位成员", "video-usage-other", "123456", "editor"
        )
        main._VIDEO_PROJECT_INDEX_CACHE.clear()

    def tearDown(self):
        main._VIDEO_PROJECT_INDEX_CACHE.clear()
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    @staticmethod
    def _member(row) -> dict:
        return {"id": row[0], "name": row[1], "teamId": ""}

    @staticmethod
    def _project(receipts: list[dict]) -> dict:
        return {
            "id": "workshop-usage-1",
            "name": "用量回收测试",
            "status": "succeeded",
            "phase": "delivery",
            "progress": 100,
            "updatedAt": "2026-08-03T12:00:00+08:00",
            "plan": {"title": "用量回收", "aspect_ratio": "9:16"},
            "outputs": [],
            "modelUsageReceipts": receipts,
        }

    def test_four_usage_kinds_and_token_unknown_llm_replay_exactly_once(self):
        receipts = [
            _receipt(
                "vw:llm:1", "llm", "视频工坊导演", provider_ref="llm-1"
            ),
            _receipt(
                "vw:image:1", "image", "视频工坊静态分镜",
                provider_ref="image-1", output_units=1, unit_label="张",
            ),
            _receipt(
                "vw:voice:1", "voice", "视频工坊语音生成",
                provider_ref="voice-1", output_units=88, unit_label="字符",
            ),
            _receipt(
                "vw:video:1", "video", "视频工坊动态视频提交",
                status="confirmed", provider_ref="video-task-1",
                output_units=8, unit_label="秒",
            ),
        ]
        source = self._project(receipts)
        first = main._sync_video_workshop_project(self._member(self.owner), source)
        second = main._sync_video_workshop_project(self._member(self.owner), source)

        self.assertEqual(4, first["_usageReconciliation"]["reconciled"])
        self.assertEqual(4, second["_usageReconciliation"]["reconciled"])
        with sqlite3.connect(store.DB_PATH) as conn:
            rows = conn.execute(
                "SELECT usage_kind,member_id,call_status,total_tokens "
                "FROM model_usage_receipts ORDER BY usage_kind"
            ).fetchall()
            api_events = conn.execute(
                "SELECT api_type,COUNT(*) FROM api_usage_events GROUP BY api_type"
            ).fetchall()
        self.assertEqual(4, len(rows))
        self.assertEqual({"llm", "image", "voice", "video"}, {row[0] for row in rows})
        self.assertTrue(all(row[1] == self.owner[0] for row in rows))
        self.assertTrue(all(row[2] == "succeeded" for row in rows))
        self.assertEqual(0, next(row[3] for row in rows if row[0] == "llm"))
        self.assertEqual({("image", 1), ("voice", 1), ("video", 1)}, set(api_events))
        summary = next(
            item for item in store.model_usage_summary()
            if item["memberId"] == self.owner[0]
        )
        self.assertEqual(1, summary["calls"])
        self.assertEqual(1, summary["imageCalls"])
        self.assertEqual(1, summary["voiceCalls"])
        self.assertEqual(1, summary["videoCalls"])
        self.assertEqual(1, summary["tokenUnknownCalls"])

    def test_project_poll_skips_terminal_completion_and_projection_writes(self):
        source = self._project([
            _receipt(
                "vw:image:poll-once",
                "image",
                "视频工坊静态分镜",
                provider_ref="image-poll-once",
                output_units=1,
                unit_label="张",
            )
        ])
        first = main._sync_video_workshop_project(self._member(self.owner), source)
        self.assertEqual(1, first["_usageReconciliation"]["reconciled"])

        with (
            patch.object(
                store,
                "begin_model_usage_receipt",
                wraps=store.begin_model_usage_receipt,
            ) as begin_usage,
            patch.object(
                store,
                "complete_model_usage_receipt",
                wraps=store.complete_model_usage_receipt,
            ) as complete_usage,
            patch.object(
                store,
                "reconcile_model_usage_outbox",
                wraps=store.reconcile_model_usage_outbox,
            ) as reconcile_usage,
        ):
            second = main._sync_video_workshop_project(self._member(self.owner), source)

        self.assertEqual(1, second["_usageReconciliation"]["reconciled"])
        begin_usage.assert_not_called()
        complete_usage.assert_not_called()
        reconcile_usage.assert_not_called()

    def test_project_owner_conflict_cannot_reassign_sidecar_receipts(self):
        source = self._project([
            _receipt("vw:image:owner", "image", "视频工坊静态分镜", output_units=1)
        ])
        main._sync_video_workshop_project(self._member(self.owner), source)

        with self.assertRaises(HTTPException) as raised:
            main._sync_video_workshop_project(self._member(self.other), source)

        self.assertEqual(403, raised.exception.status_code)
        with sqlite3.connect(store.DB_PATH) as conn:
            owner_ids = {
                row[0]
                for row in conn.execute("SELECT DISTINCT member_id FROM model_usage_receipts")
            }
        self.assertEqual({self.owner[0]}, owner_ids)

    def test_submitted_intent_stays_pending_then_confirms_without_new_row(self):
        pending = _receipt(
            "vw:voice:pending", "voice", "视频工坊语音生成",
            status="submitted", output_units=12, unit_label="字符",
        )
        source = self._project([pending])
        first = main._sync_video_workshop_project(self._member(self.owner), source)
        self.assertEqual(1, first["_usageReconciliation"]["pending"])

        pending.update({"status": "succeeded", "providerRef": "voice-later"})
        second = main._sync_video_workshop_project(self._member(self.owner), source)
        self.assertEqual(1, second["_usageReconciliation"]["reconciled"])
        with sqlite3.connect(store.DB_PATH) as conn:
            rows = conn.execute(
                "SELECT call_status,provider_ref FROM model_usage_receipts"
            ).fetchall()
        self.assertEqual([("succeeded", "voice-later")], rows)

    def test_central_write_failure_keeps_project_visible_and_reports_pending(self):
        source = self._project([
            _receipt("vw:llm:busy", "llm", "视频工坊导演")
        ])
        with patch.object(
            store,
            "begin_model_usage_receipt",
            side_effect=sqlite3.OperationalError("database is locked"),
        ):
            response = main._sync_video_workshop_project(
                self._member(self.owner), source
            )

        self.assertEqual("workshop-usage-1", response["id"])
        self.assertEqual(1, response["_usageReconciliation"]["pending"])
        self.assertEqual(0, response["_usageReconciliation"]["reconciled"])

    def test_usage_gate_returns_machine_code_without_rewriting_evidence(self):
        with patch.object(
            store,
            "video_workshop_usage_readiness",
            return_value={"ok": False, "effectivePendingRows": 1},
        ) as readiness:
            with self.assertRaises(HTTPException) as raised:
                main._require_video_workshop_usage_ready(
                    self._member(self.owner), "workshop-usage-1"
                )

        self.assertEqual(409, raised.exception.status_code)
        self.assertEqual(
            "video_workshop_usage_pending",
            raised.exception.detail["code"],
        )
        readiness.assert_called_once()


if __name__ == "__main__":
    unittest.main()
