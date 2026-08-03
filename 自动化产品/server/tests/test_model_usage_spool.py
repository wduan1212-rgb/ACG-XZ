import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from server import main, store


def _percentile(values, percentile):
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(len(ordered) * percentile + 0.999999) - 1))
    return ordered[index]


class ModelUsageLatencyAndSpoolTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        self.env_patch = patch.dict(
            os.environ, {"MODEL_USAGE_COMPLETION_SPOOL_DIR": ""}
        )
        self.env_patch.start()
        store.DB_PATH = Path(self.temp.name) / "usage-spool.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.editor = store.add_member(
            "用量并发测试", "usage-spool-editor", "123456", "editor"
        )

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.env_patch.stop()
        self.temp.cleanup()

    def begin(self, key, *, kind="llm"):
        return store.begin_model_usage_receipt(
            self.editor[0],
            surface="canvas",
            feature="无限画布并发账本",
            usage_kind=kind,
            operation="agent" if kind == "llm" else "generate",
            operation_id=key,
            idempotency_key=key,
            request_fingerprint="sha256:stable-request",
            source="latency-test",
            provider="qianfan" if kind == "llm" else "tencent-maas",
            model="ernie" if kind == "llm" else "hunyuan-image",
        )

    def _external_write_lock(self):
        conn = sqlite3.connect(store.DB_PATH, timeout=0.1)
        conn.execute("BEGIN IMMEDIATE")
        return conn

    def test_64_concurrent_unique_writes_stay_bounded_and_exactly_once(self):
        workers = 64
        barrier = threading.Barrier(workers)

        def invoke(index):
            barrier.wait(timeout=5)
            started = time.perf_counter()
            receipt = self.begin(f"canvas:agent:unique:{index}")
            return receipt, time.perf_counter() - started

        with ThreadPoolExecutor(max_workers=workers) as executor:
            rows = list(executor.map(invoke, range(workers)))
        receipts = [row[0] for row in rows]
        latencies = [row[1] for row in rows]
        p50 = _percentile(latencies, 0.50)
        p95 = _percentile(latencies, 0.95)
        p99 = _percentile(latencies, 0.99)
        print(
            "model_usage_receipt_64_unique_seconds "
            f"p50={p50:.6f} p95={p95:.6f} p99={p99:.6f} max={max(latencies):.6f}"
        )

        self.assertEqual(workers, sum(bool(item["created"]) for item in receipts))
        self.assertEqual(workers, sum(bool(item["shouldCallProvider"]) for item in receipts))
        self.assertEqual(workers, len({item["receiptId"] for item in receipts}))
        self.assertLess(p99, 0.75)
        self.assertLess(max(latencies), store.MODEL_USAGE_WRITE_MAX_SECONDS)
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                workers,
                conn.execute(
                    "SELECT COUNT(*) FROM model_usage_receipts "
                    "WHERE operation_id LIKE 'canvas:agent:unique:%'"
                ).fetchone()[0],
            )
            self.assertEqual(
                workers,
                conn.execute(
                    "SELECT COUNT(*) FROM model_usage_outbox o "
                    "JOIN model_usage_receipts r ON r.receipt_id=o.receipt_id "
                    "WHERE r.operation_id LIKE 'canvas:agent:unique:%'"
                ).fetchone()[0],
            )

    def test_128_concurrent_unique_writes_stay_bounded_and_exactly_once(self):
        workers = 128
        barrier = threading.Barrier(workers)

        def invoke(index):
            barrier.wait(timeout=10)
            started = time.perf_counter()
            receipt = self.begin(f"canvas:agent:unique-128:{index}")
            return receipt, time.perf_counter() - started

        with ThreadPoolExecutor(max_workers=workers) as executor:
            rows = list(executor.map(invoke, range(workers)))
        receipts = [row[0] for row in rows]
        latencies = [row[1] for row in rows]
        p50 = _percentile(latencies, 0.50)
        p95 = _percentile(latencies, 0.95)
        p99 = _percentile(latencies, 0.99)
        print(
            "model_usage_receipt_128_unique_seconds "
            f"p50={p50:.6f} p95={p95:.6f} p99={p99:.6f} max={max(latencies):.6f}"
        )

        self.assertEqual(workers, sum(bool(item["created"]) for item in receipts))
        self.assertEqual(workers, sum(bool(item["shouldCallProvider"]) for item in receipts))
        self.assertEqual(workers, len({item["receiptId"] for item in receipts}))
        self.assertLess(p99, 1.0)
        self.assertLess(max(latencies), store.MODEL_USAGE_WRITE_MAX_SECONDS)
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                workers,
                conn.execute(
                    "SELECT COUNT(*) FROM model_usage_receipts "
                    "WHERE operation_id LIKE 'canvas:agent:unique-128:%'"
                ).fetchone()[0],
            )
            self.assertEqual(
                workers,
                conn.execute(
                    "SELECT COUNT(*) FROM model_usage_outbox o "
                    "JOIN model_usage_receipts r ON r.receipt_id=o.receipt_id "
                    "WHERE r.operation_id LIKE 'canvas:agent:unique-128:%'"
                ).fetchone()[0],
            )

    def test_batched_write_savepoints_isolate_one_failed_operation(self):
        with sqlite3.connect(store.DB_PATH) as conn:
            conn.execute(
                "CREATE TABLE model_usage_batch_probe("
                "value TEXT PRIMARY KEY NOT NULL)"
            )
        barrier = threading.Barrier(2)

        def invoke(value, fail):
            barrier.wait(timeout=5)

            def write(conn):
                conn.execute(
                    "INSERT INTO model_usage_batch_probe(value) VALUES(?)", (value,)
                )
                if fail:
                    raise ValueError("batch-probe-failure")
                return value

            try:
                return ("ok", store._model_usage_write(write))
            except Exception as exc:  # assertions are made in the owner thread
                return ("error", exc)

        with (
            patch.object(store, "MODEL_USAGE_WRITE_BATCH_WINDOW_SECONDS", 0.02),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            rows = list(executor.map(lambda args: invoke(*args), (("keep", False), ("drop", True))))

        self.assertEqual("ok", rows[0][0])
        self.assertEqual("keep", rows[0][1])
        self.assertEqual("error", rows[1][0])
        self.assertIsInstance(rows[1][1], ValueError)
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                [("keep",)],
                conn.execute(
                    "SELECT value FROM model_usage_batch_probe ORDER BY value"
                ).fetchall(),
            )

    def test_64_concurrent_replays_are_exactly_once_with_reported_latency(self):
        workers = 64
        barrier = threading.Barrier(workers)

        def invoke(_):
            barrier.wait(timeout=5)
            started = time.perf_counter()
            receipt = self.begin("canvas:agent:64-way")
            return receipt, time.perf_counter() - started

        with ThreadPoolExecutor(max_workers=workers) as executor:
            rows = list(executor.map(invoke, range(workers)))
        receipts = [row[0] for row in rows]
        latencies = [row[1] for row in rows]
        p50 = _percentile(latencies, 0.50)
        p95 = _percentile(latencies, 0.95)
        p99 = _percentile(latencies, 0.99)
        print(
            "model_usage_receipt_64way_seconds "
            f"p50={p50:.6f} p95={p95:.6f} p99={p99:.6f} max={max(latencies):.6f}"
        )

        self.assertEqual(1, sum(bool(item["created"]) for item in receipts))
        self.assertEqual(1, sum(bool(item["shouldCallProvider"]) for item in receipts))
        self.assertEqual(1, len({item["receiptId"] for item in receipts}))
        self.assertLess(p99, 0.75)
        self.assertLess(max(latencies), store.MODEL_USAGE_WRITE_MAX_SECONDS)
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                1,
                conn.execute(
                    "SELECT COUNT(*) FROM model_usage_receipts WHERE operation_id=?",
                    ("canvas:agent:64-way",),
                ).fetchone()[0],
            )
            self.assertEqual(
                1,
                conn.execute(
                    "SELECT COUNT(*) FROM model_usage_outbox WHERE receipt_id=?",
                    (receipts[0]["receiptId"],),
                ).fetchone()[0],
            )

    def test_external_write_lock_is_bounded_and_never_holds_store_global_lock(self):
        locker = self._external_write_lock()
        outcome = {}
        started = threading.Event()

        def blocked_write():
            started.set()
            began = time.perf_counter()
            try:
                self.begin("canvas:agent:external-lock")
            except Exception as exc:  # assertion is made in the owner thread
                outcome["error"] = exc
            outcome["elapsed"] = time.perf_counter() - began

        worker = threading.Thread(target=blocked_write, daemon=True)
        try:
            worker.start()
            self.assertTrue(started.wait(timeout=1))
            time.sleep(0.15)
            acquired = store._lock.acquire(timeout=0.1)
            self.assertTrue(acquired, "receipt retry must not sleep under store._lock")
            if acquired:
                store._lock.release()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
        finally:
            locker.rollback()
            locker.close()
        self.assertIsInstance(outcome.get("error"), store.ModelUsageReceiptWriteError)
        self.assertGreater(outcome["elapsed"], 0.4)
        self.assertLess(outcome["elapsed"], 1.5)
        print(f"model_usage_external_lock_seconds elapsed={outcome['elapsed']:.6f}")

    def test_executor_offload_keeps_event_loop_schedulable_during_db_lock(self):
        locker = self._external_write_lock()

        async def probe():
            task = asyncio.create_task(
                asyncio.to_thread(self.begin, "canvas:agent:event-loop-lock")
            )
            ticks = 0
            started = time.perf_counter()
            while not task.done():
                await asyncio.sleep(0.02)
                ticks += 1
            elapsed = time.perf_counter() - started
            with self.assertRaises(store.ModelUsageReceiptWriteError):
                await task
            return ticks, elapsed

        try:
            ticks, elapsed = asyncio.run(probe())
        finally:
            locker.rollback()
            locker.close()
        self.assertGreaterEqual(ticks, 10)
        self.assertLess(elapsed, 1.5)
        print(
            "model_usage_event_loop_probe "
            f"ticks={ticks} interval=0.02 elapsed={elapsed:.6f}"
        )

    def test_completion_spool_survives_db_lock_and_replays_then_archives(self):
        receipt = self.begin("canvas:image:spool-lock", kind="image")
        locker = self._external_write_lock()
        try:
            with self.assertRaises(store.ModelUsageReceiptWriteError):
                store.complete_model_usage_receipt(
                    receipt["receiptId"],
                    provider_ref="provider-image-task-1",
                    output_units=1,
                    unit_label="张",
                )
            spooled_at = time.perf_counter()
            spooled = store.spool_model_usage_completion(
                receipt["receiptId"],
                provider_ref="provider-image-task-1",
                provider="tencent-maas",
                model="hunyuan-image",
                output_units=1,
                unit_label="张",
            )
            spool_elapsed = time.perf_counter() - spooled_at
            self.assertTrue(spooled["created"])
            self.assertLess(spool_elapsed, 0.25)
            with sqlite3.connect(store.DB_PATH) as conn:
                self.assertEqual(
                    "pending",
                    conn.execute(
                        "SELECT call_status FROM model_usage_receipts WHERE receipt_id=?",
                        (receipt["receiptId"],),
                    ).fetchone()[0],
                )
        finally:
            locker.rollback()
            locker.close()

        replay = store.reconcile_model_usage_completion_spool()
        self.assertEqual(1, replay["completed"])
        self.assertEqual(1, replay["archived"])
        self.assertEqual(0, replay["failed"])
        status = store.model_usage_completion_spool_status()
        self.assertEqual(0, status["pending"])
        self.assertEqual(1, status["archived"])
        self.assertEqual(0, status["corrupt"])
        self.assertEqual(0, store.reconcile_model_usage_completion_spool()["selected"])
        archived_replay = store.spool_model_usage_completion(
            receipt["receiptId"],
            provider_ref="provider-image-task-1",
            provider="tencent-maas",
            model="hunyuan-image",
            output_units=1,
            unit_label="张",
        )
        self.assertEqual("archived", archived_replay["state"])
        self.assertTrue(archived_replay["reused"])
        with self.assertRaises(store.ModelUsageCompletionSpoolConflict):
            store.spool_model_usage_completion(
                receipt["receiptId"],
                provider_ref="provider-image-task-1",
                provider="tencent-maas",
                model="hunyuan-image",
                output_units=2,
                unit_label="张",
            )
        self.assertEqual(0, store.model_usage_completion_spool_status()["pending"])
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                ("succeeded", "projected"),
                conn.execute(
                    "SELECT r.call_status,o.state FROM model_usage_receipts r "
                    "JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id "
                    "WHERE r.receipt_id=?",
                    (receipt["receiptId"],),
                ).fetchone(),
            )
            self.assertEqual(
                1,
                conn.execute(
                    "SELECT COUNT(*) FROM api_usage_events WHERE api_type='image'"
                ).fetchone()[0],
            )

    def test_pending_outbox_count_is_read_only_and_clears_after_projection(self):
        receipt = self.begin("canvas:image:pending-projection", kind="image")
        store.complete_model_usage_receipt(
            receipt["receiptId"],
            provider_ref="provider-pending-projection",
            output_units=1,
            unit_label="张",
        )
        self.assertEqual(1, store.pending_model_usage_outbox_count())
        readiness = store.database_readiness()
        self.assertEqual(1, readiness["modelUsageOutboxPending"])

        store.reconcile_model_usage_outbox(receipt_id=receipt["receiptId"])
        self.assertEqual(0, store.pending_model_usage_outbox_count())

    def test_background_reconciler_drains_legacy_outbox_without_unconditional_write(self):
        with (
            patch.object(
                store,
                "model_usage_completion_spool_status",
                return_value={"pending": 0},
            ),
            patch.object(
                store,
                "pending_model_usage_outbox_count",
                return_value=1,
            ) as pending_count,
            patch.object(
                store,
                "reconcile_model_usage_outbox",
                return_value={"selected": 1, "projected": 1, "failed": 0},
            ) as reconcile,
            patch.object(
                main.asyncio,
                "sleep",
                side_effect=asyncio.CancelledError,
            ),
        ):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(main._model_usage_completion_spool_reconciler())

        pending_count.assert_called_once_with()
        reconcile.assert_called_once_with(100)

    def test_main_completion_failure_spools_exact_payload_before_returning(self):
        receipt = self.begin("canvas:image:main-spool", kind="image")
        with patch.object(
            store,
            "complete_model_usage_receipt",
            side_effect=store.ModelUsageReceiptWriteError("database busy"),
        ):
            completed = main._complete_model_usage_call(
                receipt,
                provider_ref="provider-image-main-spool",
                provider="tencent-maas",
                model="hunyuan-image",
                output_units=2,
                unit_label="张",
            )
        self.assertFalse(completed)
        status = store.model_usage_completion_spool_status()
        self.assertEqual(1, status["pending"])
        pending_path = next(
            (store._model_usage_completion_spool_root() / "pending").glob("*.json")
        )
        payload = json.loads(pending_path.read_text(encoding="utf-8"))["payload"]
        self.assertEqual(receipt["receiptId"], payload["receiptId"])
        self.assertEqual("provider-image-main-spool", payload["providerRef"])
        self.assertEqual(2, payload["outputUnits"])
        self.assertGreater(payload["eventAt"], 0)
        self.assertEqual(payload["eventAt"], payload["completedAt"])

        replay = store.reconcile_model_usage_completion_spool()
        self.assertEqual(1, replay["completed"])
        self.assertEqual(1, replay["archived"])
        self.assertEqual(0, replay["pendingAfter"])

    def test_spool_is_concurrent_idempotent_and_excludes_sensitive_content(self):
        receipt = self.begin("canvas:agent:spool-concurrent")
        usage = {
            "prompt_tokens": 7,
            "completion_tokens": 3,
            "total_tokens": 10,
            "prompt": "DO-NOT-PERSIST-PROMPT",
            "content": "DO-NOT-PERSIST-CONTENT",
            "api_key": "DO-NOT-PERSIST-KEY",
        }
        workers = 32
        barrier = threading.Barrier(workers)

        def spool(_):
            barrier.wait(timeout=5)
            return store.spool_model_usage_completion(
                receipt["receiptId"],
                usage=usage,
                provider_ref="provider-llm-request-1",
                provider="qianfan",
                model="ernie",
            )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            rows = list(executor.map(spool, range(workers)))
        self.assertEqual(1, sum(bool(row["created"]) for row in rows))
        self.assertEqual(31, sum(bool(row["reused"]) for row in rows))
        status = store.model_usage_completion_spool_status()
        self.assertEqual(1, status["pending"])
        pending_path = next(
            (_model_path for _model_path in
             (store._model_usage_completion_spool_root() / "pending").glob("*.json"))
        )
        serialized = pending_path.read_text(encoding="utf-8")
        self.assertNotIn("DO-NOT-PERSIST-PROMPT", serialized)
        self.assertNotIn("DO-NOT-PERSIST-CONTENT", serialized)
        self.assertNotIn("DO-NOT-PERSIST-KEY", serialized)
        envelope = json.loads(serialized)
        self.assertEqual(
            store._MODEL_USAGE_COMPLETION_ENVELOPE_KEYS, set(envelope)
        )
        self.assertEqual(
            store._MODEL_USAGE_COMPLETION_PAYLOAD_KEYS,
            set(envelope["payload"]),
        )
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                ("pending", 0),
                conn.execute(
                    "SELECT call_status,total_tokens FROM model_usage_receipts "
                    "WHERE receipt_id=?",
                    (receipt["receiptId"],),
                ).fetchone(),
            )
            self.assertEqual(
                0, conn.execute("SELECT COUNT(*) FROM llm_usage_events").fetchone()[0]
            )

        with self.assertRaises(store.ModelUsageCompletionSpoolConflict):
            store.spool_model_usage_completion(
                receipt["receiptId"],
                usage={"total_tokens": 11},
                provider_ref="provider-llm-request-1",
                provider="qianfan",
                model="ernie",
            )
        self.assertEqual(1, store.model_usage_completion_spool_status()["pending"])

    def test_corrupt_spool_is_reported_preserved_and_fails_readiness_integrity(self):
        receipt = self.begin("canvas:agent:spool-corrupt")
        store.spool_model_usage_completion(
            receipt["receiptId"],
            usage={"total_tokens": 4},
            provider_ref="provider-corrupt-test",
            provider="qianfan",
            model="ernie",
        )
        pending_path = next(
            (store._model_usage_completion_spool_root() / "pending").glob("*.json")
        )
        envelope = json.loads(pending_path.read_text(encoding="utf-8"))
        envelope["checksum"] = "0" * 64
        pending_path.write_text(
            json.dumps(envelope, ensure_ascii=False), encoding="utf-8"
        )

        status = store.model_usage_completion_spool_status()
        self.assertEqual(1, status["pending"])
        self.assertEqual(1, status["corrupt"])
        replay = store.reconcile_model_usage_completion_spool()
        self.assertEqual(1, replay["corrupt"])
        self.assertTrue(pending_path.exists())
        readiness = store.database_readiness()
        self.assertEqual(1, readiness["modelUsageCompletionSpoolPending"])
        self.assertEqual(1, readiness["modelUsageCompletionSpoolCorrupt"])
        self.assertFalse(readiness["ok"])

    def test_receipt_connection_timeout_isolated_from_ordinary_store_connection(self):
        ordinary = store._connect(read_only=False)
        receipt = store._connect_model_usage_write()
        try:
            ordinary_timeout = ordinary.execute("PRAGMA busy_timeout").fetchone()[0]
            receipt_timeout = receipt.execute("PRAGMA busy_timeout").fetchone()[0]
        finally:
            ordinary.close()
            receipt.close()
        self.assertEqual(5000, ordinary_timeout)
        self.assertEqual(store.MODEL_USAGE_WRITE_BUSY_TIMEOUT_MS, receipt_timeout)


if __name__ == "__main__":
    unittest.main()
