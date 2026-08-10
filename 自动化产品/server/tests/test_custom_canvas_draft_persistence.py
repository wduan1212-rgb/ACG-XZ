import base64
import hashlib
import importlib
import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, Response
from starlette.requests import Request


SERVER_DIR = Path(__file__).resolve().parents[1]
TEST_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")


def load_canvas_store(tmpdir):
    os.environ["CUSTOM_CANVAS_BLOB_DIR"] = str(Path(tmpdir) / "canvas_blobs")
    store = load_isolated_store(tmpdir)
    store._ensure_db()
    with store._lock:
        conn = store._connect()
        try:
            now = 1
            for member_id in ("creator-a", "creator-b"):
                conn.execute(
                    "INSERT OR IGNORE INTO members("
                    "id,name,username,username_key,pin_hash,role,parent_id,created_at"
                    ") VALUES(?,?,?,?,?,?,NULL,?)",
                    (
                        member_id,
                        member_id,
                        member_id,
                        member_id,
                        store.DEFAULT_ADMIN_PIN_HASH,
                        "editor",
                        now,
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    return store


def draft_payload(
    source_id="canvas-local-1",
    *,
    updated_at=100,
    items=None,
    messages=None,
    migration=False,
    base_revision=None,
):
    payload = {
        "project": {
            "id": source_id,
            "name": "权威画布草稿",
            "scene": "brand_kv",
            "targetSize": "1024x1024",
            "createdAt": 10,
            "updatedAt": updated_at,
        },
        "items": [
            {
                "id": "image-node-1",
                "projectId": source_id,
                "type": "reference",
                "assetUrl": PNG_DATA_URL,
                "position": {"x": 0, "y": 0},
                "size": {"width": 100, "height": 100},
                "z": 1,
                "createdAt": 10,
            }
        ] if items is None else items,
        "messages": [{"id": "message-1", "role": "user", "text": "保留图片", "createdAt": 11}]
        if messages is None else messages,
        "viewport": {"x": 2, "y": 3, "zoom": 1},
        "clientUpdatedAt": updated_at,
        "migration": migration,
    }
    if base_revision is not None:
        payload["baseRevision"] = base_revision
    return payload


class CustomCanvasDraftPersistenceTest(unittest.TestCase):
    @staticmethod
    def _expire_staging_and_run_gc(store, owner_id):
        with store._lock:
            conn = store._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "UPDATE custom_canvas_blob_staging SET created_at=1 "
                    "WHERE owner_id=?",
                    (owner_id,),
                )
                orphaned = store._custom_canvas_gc_blobs_locked(conn, owner_id)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
        store._custom_canvas_unlink_orphans(orphaned)
        return orphaned

    def test_gc_preserves_succeeded_background_job_result_after_staging_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            saved = store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
            fingerprint = hashlib.sha256(b"durable-job").hexdigest()
            store.create_custom_canvas_generation_job(
                "creator-a", "durable-job", fingerprint,
                source_project_id="canvas-job-source",
            )
            store.finish_custom_canvas_generation_job(
                "creator-a",
                "durable-job",
                status="succeeded",
                result={"images": [{
                    "dataUrl": saved["url"],
                    "assetUrl": saved["url"],
                    "contentHash": saved["contentHash"],
                }]},
            )

            self.assertEqual([], self._expire_staging_and_run_gc(store, "creator-a"))
            blob, error = store.get_custom_canvas_blob(
                "creator-a", saved["contentHash"]
            )
            self.assertIsNone(error)
            self.assertTrue(blob["path"].is_file())

    def test_gc_preserves_published_community_blob_after_staging_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            saved = store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
            store.create_community_post(
                "creator-a", "creator-a", "", "canvas", "community-canvas",
                "已发布画布", "", "", "视觉设计",
                [{"url": saved["url"], "type": "image"}],
            )

            self.assertEqual([], self._expire_staging_and_run_gc(store, "creator-a"))
            self.assertIsNotNone(store.get_custom_canvas_blob(
                "creator-a", saved["contentHash"]
            )[0])

    def test_gc_does_not_let_another_owner_reference_keep_this_copy_alive(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            first = store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
            second = store.save_custom_canvas_blob("creator-b", PNG_DATA_URL)
            fingerprint = hashlib.sha256(b"other-owner-job").hexdigest()
            store.create_custom_canvas_generation_job(
                "creator-b", "other-owner-job", fingerprint,
                source_project_id="creator-b-canvas",
            )
            store.finish_custom_canvas_generation_job(
                "creator-b", "other-owner-job", status="succeeded",
                result={"images": [{"assetUrl": second["url"]}]},
            )

            orphaned = self._expire_staging_and_run_gc(store, "creator-a")
            self.assertEqual(1, len(orphaned))
            self.assertIsNone(store.get_custom_canvas_blob(
                "creator-a", first["contentHash"]
            )[0])
            self.assertIsNotNone(store.get_custom_canvas_blob(
                "creator-b", second["contentHash"]
            )[0])

    def test_gc_fails_closed_on_malformed_or_cross_scope_business_reference(self):
        for mode in ("malformed", "cross-scope"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                store = load_canvas_store(tmp)
                saved = store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
                with store._lock:
                    conn = store._connect()
                    try:
                        now = 100
                        doc_id = f"gc-{mode}"
                        if mode == "malformed":
                            raw = '{"assetUrl":"' + saved["url"]
                        else:
                            raw = json.dumps({
                                "id": doc_id,
                                "ownerId": "creator-a",
                                "assetUrl": saved["url"],
                            })
                        conn.execute(
                            "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                            "VALUES('assets',?,?,?,?)",
                            (doc_id, "creator-a", now, raw),
                        )
                        if mode == "cross-scope":
                            conn.execute(
                                "UPDATE members SET role='user' "
                                "WHERE id IN ('creator-a','creator-b')"
                            )
                            conn.execute(
                                "INSERT INTO resource_scopes("
                                "resource_kind,resource_id,scope_type,scope_id,owner_id,"
                                "provenance,captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                                (
                                    "doc:assets", doc_id, "member", "creator-b",
                                    "creator-a", "test-conflict", now, now,
                                ),
                            )
                            conn.execute(
                                "INSERT OR REPLACE INTO schema_migrations("
                                "version,name,checksum,app_version,started_at,finished_at,"
                                "status,summary) VALUES(?,?,?,?,?,?,?,?)",
                                (
                                    store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                                    store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                                    store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                                    "test", now, now, "success", "{}",
                                ),
                            )
                        conn.execute(
                            "UPDATE custom_canvas_blob_staging SET created_at=1 "
                            "WHERE owner_id='creator-a'"
                        )
                        conn.commit()
                    finally:
                        conn.close()

                with self.assertRaisesRegex(
                    ValueError,
                    "invalid_custom_canvas_business_reference|"
                    "custom_canvas_business_reference_scope_conflict",
                ):
                    self._expire_staging_and_run_gc(store, "creator-a")
                self.assertIsNotNone(store.get_custom_canvas_blob(
                    "creator-a", saved["contentHash"]
                )[0])

    def test_historical_missing_reference_defers_gc_without_blocking_canvas_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            created, error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-history-gap",
                draft_payload("canvas-history-gap", updated_at=100),
            )
            self.assertIsNone(error)
            self.assertEqual("created", outcome)

            updated = draft_payload(
                "canvas-history-gap",
                updated_at=101,
                base_revision=created["project"]["revision"],
            )
            updated["messages"].append({
                "id": "message-2",
                "role": "user",
                "text": "历史缺失媒体不能阻断正常编辑",
                "createdAt": 101,
            })
            with patch.object(
                store,
                "_custom_canvas_gc_blobs_locked",
                side_effect=ValueError("custom_canvas_community_reference_blob_missing"),
            ):
                saved, error, outcome = store.save_custom_canvas_draft(
                    "creator-a", "canvas-history-gap", updated,
                )

            self.assertIsNone(error)
            self.assertEqual("updated", outcome)
            self.assertEqual(2, saved["project"]["revision"])
            self.assertEqual(2, len(saved["state"]["messages"]))
            with store._connect(read_only=True) as conn:
                self.assertEqual(
                    1,
                    conn.execute(
                        "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=?",
                        ("creator-a",),
                    ).fetchone()[0],
                )

    def test_non_historical_gc_error_still_rolls_back_canvas_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            created, _, _ = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-corrupt-state",
                draft_payload("canvas-corrupt-state", updated_at=100),
            )
            updated = draft_payload(
                "canvas-corrupt-state",
                updated_at=101,
                base_revision=created["project"]["revision"],
            )
            updated["project"]["name"] = "不能越过损坏状态"
            with patch.object(
                store,
                "_custom_canvas_gc_blobs_locked",
                side_effect=ValueError("invalid_custom_canvas_stored_state"),
            ), self.assertRaisesRegex(ValueError, "invalid_custom_canvas_stored_state"):
                store.save_custom_canvas_draft(
                    "creator-a", "canvas-corrupt-state", updated,
                )

            current, error = store.get_custom_canvas_draft(
                "creator-a", "canvas-corrupt-state",
            )
            self.assertIsNone(error)
            self.assertEqual(1, current["project"]["revision"])
            self.assertEqual("权威画布草稿", current["project"]["name"])

    def test_gc_removes_only_truly_unreferenced_blob(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            saved = store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
            orphaned = self._expire_staging_and_run_gc(store, "creator-a")
            self.assertEqual(1, len(orphaned))
            self.assertIsNone(store.get_custom_canvas_blob(
                "creator-a", saved["contentHash"]
            )[0])

    def test_http_contract_accepts_structured_migration_and_returns_source_aliases(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            main = importlib.import_module("main")
            request = main.CustomCanvasProjectDraftReq(**draft_payload(
                "canvas-route",
                migration={"source": "local-v2", "version": 1},
            ))
            with patch.object(main, "store", store):
                saved = main.custom_canvas_projects_put(
                    "canvas-route",
                    request,
                    me={"id": "creator-a", "role": "editor"},
                )
                index = main.custom_canvas_projects_list(
                    me={"id": "creator-a", "role": "editor"},
                )
                renamed_payload = draft_payload(
                    "canvas-route",
                    updated_at=101,
                    base_revision=saved["project"]["revision"],
                )
                renamed_payload["project"]["name"] = "已重命名画布"
                renamed = main.custom_canvas_projects_put(
                    "canvas-route",
                    main.CustomCanvasProjectDraftReq(**renamed_payload),
                    me={"id": "creator-a", "role": "editor"},
                )
                index_after_rename = main.custom_canvas_projects_list(
                    me={"id": "creator-a", "role": "editor"},
                )
                deleted = main.custom_canvas_projects_delete(
                    "canvas-route",
                    me={"id": "creator-a", "role": "editor"},
                )
                index_after = main.custom_canvas_projects_list(
                    me={"id": "creator-a", "role": "editor"},
                )
            self.assertEqual(saved["project"]["sourceId"], "canvas-route")
            self.assertEqual(index["items"][0]["sourceId"], "canvas-route")
            self.assertEqual(renamed["project"]["name"], "已重命名画布")
            self.assertEqual(renamed["state"]["messages"][0]["text"], "保留图片")
            self.assertEqual(index_after_rename["items"][0]["name"], "已重命名画布")
            self.assertTrue(deleted["ok"])
            self.assertEqual(index_after["tombstones"][0]["sourceId"], "canvas-route")

    def test_unsafe_svg_data_url_is_rejected_before_disk_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            unsafe = draft_payload(items=[{
                "id": "unsafe-svg",
                "type": "reference",
                "assetUrl": "data:image/svg+xml,%3Csvg%20onload%3D%22alert(1)%22%3E%3C/svg%3E",
            }])
            with self.assertRaisesRegex(ValueError, "unsafe_custom_canvas_svg"):
                store.save_custom_canvas_draft(
                    "creator-a", "canvas-unsafe", unsafe
                )
            self.assertEqual(
                store._fetchone("SELECT COUNT(*) FROM custom_canvas_blobs")[0],
                0,
            )

    def test_multi_image_migration_larger_than_eight_megabytes_is_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            large_items = []
            for index in range(3):
                # 模拟多张 1024/1536 生成图：总原始图片超过 8MB，但每张仍受单图上限保护。
                image = PNG_BYTES + bytes([index]) + (b"\0" * (3 * 1024 * 1024))
                data_url = "data:image/png;base64," + base64.b64encode(image).decode("ascii")
                large_items.append({
                    "id": f"large-image-{index}",
                    "projectId": "canvas-large",
                    "type": "generation",
                    "assetUrl": data_url,
                    "position": {"x": index * 20, "y": 0},
                    "size": {"width": 1024, "height": 1024},
                    "z": index,
                    "createdAt": 10 + index,
                })
            payload = draft_payload(
                "canvas-large",
                items=large_items,
                migration={"source": "local-v2", "version": 1},
            )
            saved, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-large", payload
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")
            returned_urls = [item["assetUrl"] for item in saved["state"]["items"]]
            self.assertEqual(len(returned_urls), 3)
            self.assertTrue(all(
                value.startswith("/api/custom-canvas/blobs/")
                for value in returned_urls
            ))
            self.assertNotIn("data:image", json.dumps(saved, ensure_ascii=False))
            self.assertLess(len(json.dumps(saved).encode("utf-8")), 20_000)
            self.assertGreater(
                store._fetchone(
                    "SELECT SUM(size) FROM custom_canvas_blobs WHERE owner_id=?",
                    ("creator-a",),
                )[0],
                8 * 1024 * 1024,
            )

    def test_owner_scoped_data_url_is_private_blob_and_returns_stable_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            payload = draft_payload(migration=True)
            payload["project"]["thumbnailUrl"] = PNG_DATA_URL
            result, error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-local-1",
                payload,
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")
            self.assertEqual(result["project"]["revision"], 1)
            stable_url = result["state"]["items"][0]["assetUrl"]
            self.assertRegex(
                stable_url,
                r"^/api/custom-canvas/blobs/[a-f0-9]{64}$",
            )
            self.assertEqual(result["project"]["thumbnailUrl"], stable_url)
            self.assertNotIn("data:image", json.dumps(result, ensure_ascii=False))

            stored = store._fetchone(
                "SELECT draft_json FROM custom_canvas_drafts WHERE owner_id=? AND source_project_id=?",
                ("creator-a", "canvas-local-1"),
            )[0]
            self.assertNotIn("data:image", stored)
            self.assertIn("custom-canvas-blob-v1", stored)
            blob_row = store._fetchone(
                "SELECT owner_id,mime,size,stored_name FROM custom_canvas_blobs",
            )
            self.assertEqual(blob_row[:3], ("creator-a", "image/png", len(PNG_BYTES)))
            private_path = Path(tmp) / "canvas_blobs" / blob_row[3]
            self.assertTrue(private_path.is_file())
            self.assertEqual(private_path.read_bytes(), PNG_BYTES)

            fetched, fetch_error = store.get_custom_canvas_draft(
                "creator-a", "canvas-local-1"
            )
            self.assertIsNone(fetch_error)
            self.assertEqual(fetched["state"]["items"][0]["assetUrl"], stable_url)
            self.assertEqual(fetched["project"]["thumbnailUrl"], stable_url)
            index_items, _ = store.list_custom_canvas_drafts("creator-a")
            encoded_index = json.dumps(index_items, ensure_ascii=False)
            self.assertNotIn("data:image", encoded_index)
            self.assertNotIn("custom-canvas-blob-v1", encoded_index)
            self.assertEqual(index_items[0]["thumbnailUrl"], stable_url)
            self.assertLess(len(encoded_index.encode("utf-8")), 10_000)
            denied, denied_error = store.get_custom_canvas_draft(
                "creator-b", "canvas-local-1"
            )
            self.assertIsNone(denied)
            self.assertEqual(denied_error, "not_found")

    def test_project_index_derives_light_thumbnail_without_reading_blob_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)

            def image_item(item_id, item_type, suffix, *, hidden=False):
                return {
                    "id": item_id,
                    "projectId": "canvas-thumbnails",
                    "type": item_type,
                    "assetUrl": "data:image/png;base64," + base64.b64encode(
                        PNG_BYTES + suffix.encode("ascii")
                    ).decode("ascii"),
                    "position": {"x": 0, "y": 0},
                    "size": {"width": 100, "height": 100},
                    "z": 1,
                    "createdAt": 10,
                    "hidden": hidden,
                }

            payload = draft_payload(
                "canvas-thumbnails",
                items=[
                    image_item("hidden-ref", "reference", "hidden", hidden=True),
                    image_item("visible-ref", "reference", "visible"),
                    image_item("visible-result", "generation", "result"),
                ],
            )
            saved, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-thumbnails", payload
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")
            result_url = next(
                item["assetUrl"]
                for item in saved["state"]["items"]
                if item["id"] == "visible-result"
            )
            with patch.object(Path, "read_bytes", side_effect=AssertionError("blob bytes read")):
                items, _ = store.list_custom_canvas_drafts("creator-a")
            self.assertEqual(items[0]["thumbnailUrl"], result_url)
            encoded = json.dumps(items, ensure_ascii=False)
            self.assertNotIn("data:image", encoded)
            self.assertNotIn("custom-canvas-blob-v1", encoded)
            self.assertNotIn("items", items[0])
            self.assertLess(len(encoded.encode("utf-8")), 10_000)

            hidden_payload = draft_payload(
                "canvas-hidden-thumbnail",
                updated_at=200,
                items=[image_item("hidden-only", "reference", "fallback", hidden=True)],
            )
            hidden_payload["items"][0]["projectId"] = "canvas-hidden-thumbnail"
            hidden_saved, hidden_error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-hidden-thumbnail", hidden_payload
            )
            self.assertIsNone(hidden_error)
            hidden_url = hidden_saved["state"]["items"][0]["assetUrl"]
            index, _ = store.list_custom_canvas_drafts("creator-a")
            hidden_summary = next(item for item in index if item["id"] == "canvas-hidden-thumbnail")
            self.assertEqual(hidden_summary["thumbnailUrl"], hidden_url)

    def test_stable_blob_url_round_trip_requires_same_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            created, error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-roundtrip", draft_payload("canvas-roundtrip")
            )
            self.assertIsNone(error)
            stable_url = created["state"]["items"][0]["assetUrl"]

            update = draft_payload(
                "canvas-roundtrip",
                updated_at=200,
                base_revision=1,
            )
            update["items"][0]["assetUrl"] = stable_url
            saved, save_error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-roundtrip", update
            )
            self.assertIsNone(save_error)
            self.assertEqual(outcome, "updated")
            self.assertEqual(saved["state"]["items"][0]["assetUrl"], stable_url)

            forged = draft_payload("canvas-forged")
            forged["items"][0]["assetUrl"] = stable_url
            with self.assertRaisesRegex(ValueError, "invalid_custom_canvas_blob_ref"):
                store.save_custom_canvas_draft(
                    "creator-b", "canvas-forged", forged
                )
            self.assertEqual(len(store.list_custom_canvas_drafts("creator-b")[0]), 0)

    def test_blob_route_is_owner_scoped_and_does_not_expose_storage_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            result, _, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-route-blob", draft_payload("canvas-route-blob")
            )
            stable_url = result["state"]["items"][0]["assetUrl"]
            digest = stable_url.rsplit("/", 1)[-1]
            request = Request({
                "type": "http",
                "method": "GET",
                "path": stable_url,
                "query_string": b"",
                "headers": [(b"cookie", b"acg_custom_canvas_session=signed-owner-token")],
            })
            main = importlib.import_module("main")
            creator_a = {"id": "creator-a", "role": "editor"}
            with patch.object(main, "store", store), patch.object(
                main, "_member_from_authorization", return_value=creator_a
            ) as authenticate:
                response = main.custom_canvas_blob_get(
                    digest,
                    request,
                    authorization="",
                )
                authenticate.assert_called_with("Bearer signed-owner-token")
                self.assertEqual(response.media_type, "image/png")
                self.assertEqual(
                    response.headers["cache-control"],
                    "private, max-age=31536000, immutable",
                )
                self.assertEqual(response.headers["vary"], "Cookie, Authorization")
                self.assertNotIn(str(tmp), stable_url)
                self.assertNotIn("creator-a", stable_url)
                ranged_request = Request({
                    "type": "http",
                    "method": "GET",
                    "path": stable_url,
                    "query_string": b"",
                    "headers": [
                        (b"range", b"bytes=0-3"),
                        (b"cookie", b"acg_custom_canvas_session=signed-owner-token"),
                    ],
                })
                ranged = main.custom_canvas_blob_get(
                    digest,
                    ranged_request,
                    authorization="",
                )
                self.assertEqual(ranged.status_code, 206)
                self.assertEqual(ranged.headers["content-range"], f"bytes 0-3/{len(PNG_BYTES)}")
                self.assertEqual(ranged.headers["accept-ranges"], "bytes")
            with patch.object(main, "store", store), patch.object(
                main,
                "_member_from_authorization",
                return_value={"id": "creator-b", "role": "editor"},
            ):
                with self.assertRaises(HTTPException) as denied:
                    main.custom_canvas_blob_get(
                        digest,
                        request,
                        authorization="",
                    )
            self.assertEqual(denied.exception.status_code, 404)

    def test_canvas_session_cookie_is_http_only_scoped_and_https_aware(self):
        main = importlib.import_module("main")
        request = Request({
            "type": "http",
            "scheme": "https",
            "server": ("example.test", 443),
            "method": "POST",
            "path": "/api/custom-canvas/session",
            "query_string": b"",
            "headers": [],
        })
        response = Response()
        member = {"id": "creator-a", "role": "editor"}
        with patch.object(main, "_member_from_authorization", return_value=member) as authenticate:
            result = main.custom_canvas_session_create(
                request,
                response,
                authorization="Bearer signed-owner-token",
                me=member,
            )
        self.assertTrue(result["ok"])
        authenticate.assert_called_with("Bearer signed-owner-token")
        cookie = response.headers["set-cookie"]
        self.assertIn("acg_custom_canvas_session=signed-owner-token", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("Path=/api/custom-canvas/blobs", cookie)
        self.assertNotIn("signed-owner-token", json.dumps(result))

    def test_replaced_and_deleted_drafts_gc_only_their_owner_orphans(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            first_a, _, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-gc", draft_payload("canvas-gc")
            )
            store.save_custom_canvas_draft(
                "creator-b", "canvas-gc", draft_payload("canvas-gc")
            )
            first_hash = first_a["state"]["items"][0]["assetUrl"].rsplit("/", 1)[-1]
            first_a_row = store._fetchone(
                "SELECT stored_name FROM custom_canvas_blobs WHERE owner_id=? AND content_hash=?",
                ("creator-a", first_hash),
            )
            first_a_path = Path(tmp) / "canvas_blobs" / first_a_row[0]

            second_bytes = PNG_BYTES + b"replacement"
            second_url = "data:image/png;base64," + base64.b64encode(second_bytes).decode("ascii")
            replacement = draft_payload(
                "canvas-gc", updated_at=200, base_revision=1
            )
            replacement["items"][0]["assetUrl"] = second_url
            second_a, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-gc", replacement
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "updated")
            second_hash = second_a["state"]["items"][0]["assetUrl"].rsplit("/", 1)[-1]
            self.assertNotEqual(first_hash, second_hash)
            self.assertFalse(first_a_path.exists())
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=? AND content_hash=?",
                ("creator-a", first_hash),
            )[0], 0)
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=? AND content_hash=?",
                ("creator-b", first_hash),
            )[0], 1)

            store.delete_custom_canvas_draft("creator-a", "canvas-gc")
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=?",
                ("creator-a",),
            )[0], 0)
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=?",
                ("creator-b",),
            )[0], 1)

    def test_failed_save_removes_only_blob_file_created_by_that_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            source_id = "canvas-rollback-new-file"
            project_id = store._custom_canvas_project_id("creator-a", source_id)
            store._ensure_db()
            conn = store._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO deleted_docs(collection,id,deleted_at)
                    VALUES('customProjects',?,?)
                    """,
                    (project_id, 100),
                )
                conn.commit()
            finally:
                conn.close()

            result, error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                source_id,
                draft_payload(source_id),
            )

            self.assertIsNone(result)
            self.assertEqual(error, "deleted")
            self.assertEqual(outcome, "rejected")
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=?",
                ("creator-a",),
            )[0], 0)
            blob_root = Path(tmp) / "canvas_blobs"
            self.assertEqual(
                [path for path in blob_root.rglob("*") if path.is_file()],
                [],
            )

    def test_failed_save_never_deletes_preexisting_untracked_blob_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            source_id = "canvas-rollback-existing-file"
            owner_id = "creator-a"
            content_hash = hashlib.sha256(
                b"image/png\0" + PNG_BYTES
            ).hexdigest()
            stored_name = store._custom_canvas_blob_relative_path(
                owner_id,
                content_hash,
                "image/png",
            )
            preexisting = Path(tmp) / "canvas_blobs" / stored_name
            preexisting.parent.mkdir(parents=True, exist_ok=True)
            preexisting.write_bytes(PNG_BYTES)

            project_id = store._custom_canvas_project_id(owner_id, source_id)
            store._ensure_db()
            conn = store._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO deleted_docs(collection,id,deleted_at)
                    VALUES('customProjects',?,?)
                    """,
                    (project_id, 100),
                )
                conn.commit()
            finally:
                conn.close()

            result, error, outcome = store.save_custom_canvas_draft(
                owner_id,
                source_id,
                draft_payload(source_id),
            )

            self.assertIsNone(result)
            self.assertEqual(error, "deleted")
            self.assertEqual(outcome, "rejected")
            self.assertTrue(preexisting.is_file())
            self.assertEqual(preexisting.read_bytes(), PNG_BYTES)
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blobs WHERE owner_id=?",
                (owner_id,),
            )[0], 0)

    def test_same_source_isolated_by_owner_and_admin_route_cannot_cross_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            first, _, _ = store.save_custom_canvas_draft(
                "creator-a", "shared-local-id", draft_payload("shared-local-id")
            )
            second, _, _ = store.save_custom_canvas_draft(
                "creator-b", "shared-local-id", draft_payload("shared-local-id")
            )
            self.assertNotEqual(
                first["project"]["customProjectId"],
                second["project"]["customProjectId"],
            )
            owner_hash = hashlib.sha256(b"creator-a").hexdigest()[:16]
            self.assertIn(owner_hash, first["project"]["customProjectId"])
            self.assertEqual(len(store.list_custom_canvas_drafts("creator-a")[0]), 1)
            self.assertEqual(len(store.list_custom_canvas_drafts("creator-b")[0]), 1)

            main = importlib.import_module("main")
            with patch.object(main, "store", store):
                with self.assertRaises(HTTPException) as denied:
                    main.custom_canvas_projects_get(
                        "shared-local-id",
                        me={"id": "admin-member", "role": "admin"},
                    )
            self.assertEqual(denied.exception.status_code, 404)

    def test_multiple_members_can_save_independent_projects_concurrently(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            jobs = [
                ("creator-a", "parallel-a-1"),
                ("creator-a", "parallel-a-2"),
                ("creator-b", "parallel-b-1"),
                ("creator-b", "parallel-b-2"),
            ]

            def save(job):
                owner_id, source_id = job
                return owner_id, source_id, store.save_custom_canvas_draft(
                    owner_id,
                    source_id,
                    draft_payload(source_id),
                )

            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(save, jobs))

            for owner_id, source_id, (saved, error, outcome) in results:
                self.assertIsNone(error, (owner_id, source_id, error))
                self.assertEqual(outcome, "created")
                self.assertEqual(saved["project"]["sourceId"], source_id)
            self.assertEqual(
                {item["sourceId"] for item in store.list_custom_canvas_drafts("creator-a")[0]},
                {"parallel-a-1", "parallel-a-2"},
            )
            self.assertEqual(
                {item["sourceId"] for item in store.list_custom_canvas_drafts("creator-b")[0]},
                {"parallel-b-1", "parallel-b-2"},
            )

    def test_migration_is_idempotent_existing_live_wins_and_normal_update_uses_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            initial = draft_payload(migration=True)
            created, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", initial
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")

            unchanged, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", initial
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "unchanged")
            self.assertEqual(unchanged["project"]["revision"], 1)

            migration_change = draft_payload(
                updated_at=300,
                migration=True,
                messages=[{"id": "new", "role": "user", "text": "旧端新内容", "createdAt": 300}],
            )
            authoritative, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", migration_change
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "server-newer")
            self.assertEqual(authoritative["state"]["messages"][0]["id"], "message-1")
            self.assertEqual(authoritative["project"]["revision"], 1)

            missing_base = draft_payload(updated_at=200, messages=[])
            result, error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", missing_base
            )
            self.assertIsNone(result)
            self.assertEqual(error, "conflict")

            update = draft_payload(updated_at=200, messages=[], base_revision=1)
            updated, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", update
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "updated")
            self.assertEqual(updated["project"]["revision"], 2)

            stale = draft_payload(
                updated_at=150,
                messages=[{"id": "stale", "role": "user", "text": "过期", "createdAt": 150}],
                base_revision=2,
            )
            result, error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", stale
            )
            self.assertIsNone(result)
            self.assertEqual(error, "server_newer")

    def test_lost_response_retry_with_same_canvas_does_not_create_false_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            created, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", draft_payload(updated_at=100)
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")

            retry = draft_payload(updated_at=900, base_revision=0)
            retry["project"]["sourceId"] = "canvas-local-1"
            retry["project"]["sourceProjectId"] = "canvas-local-1"
            retry["project"]["appVersion"] = "new-static-build"
            unchanged, retry_error, retry_outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", retry
            )

            self.assertIsNone(retry_error)
            self.assertEqual(retry_outcome, "unchanged")
            self.assertEqual(unchanged["project"]["revision"], created["project"]["revision"])

            changed = draft_payload(
                updated_at=901,
                base_revision=0,
                messages=[{"id": "new", "role": "user", "text": "真正的新编辑", "createdAt": 901}],
            )
            result, changed_error, changed_outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", changed
            )
            self.assertIsNone(result)
            self.assertEqual(changed_error, "conflict")
            self.assertEqual(changed_outcome, "conflict")

    def test_nonempty_migration_fills_empty_server_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            shell, error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-local-1",
                draft_payload(items=[], messages=[]),
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")
            self.assertEqual(shell["state"]["items"], [])
            self.assertEqual(shell["state"]["messages"], [])

            migrated, error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-local-1",
                draft_payload(updated_at=200, migration=True),
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "updated")
            self.assertEqual(migrated["project"]["revision"], 2)
            self.assertEqual(migrated["state"]["items"][0]["id"], "image-node-1")
            self.assertEqual(migrated["state"]["messages"][0]["id"], "message-1")

    def test_nonempty_server_wins_over_rich_and_empty_migrations(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            created, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", draft_payload()
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")

            rich_migration = draft_payload(
                updated_at=200,
                migration=True,
                items=[{
                    "id": "legacy-image",
                    "projectId": "canvas-local-1",
                    "type": "reference",
                    "assetUrl": PNG_DATA_URL,
                }],
                messages=[{
                    "id": "legacy-message",
                    "role": "user",
                    "text": "旧端内容",
                    "createdAt": 200,
                }],
            )
            for migration in (
                rich_migration,
                draft_payload(
                    updated_at=300,
                    migration=True,
                    items=[],
                    messages=[],
                ),
            ):
                authoritative, save_error, save_outcome = store.save_custom_canvas_draft(
                    "creator-a", "canvas-local-1", migration
                )
                self.assertIsNone(save_error)
                self.assertEqual(save_outcome, "server-newer")
                self.assertEqual(authoritative["project"]["revision"], 1)
                self.assertEqual(
                    authoritative["state"]["items"][0]["id"],
                    created["state"]["items"][0]["id"],
                )
                self.assertEqual(
                    authoritative["state"]["messages"][0]["id"],
                    created["state"]["messages"][0]["id"],
                )

    def test_nonempty_server_draft_rejects_empty_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", draft_payload()
            )
            empty = draft_payload(
                updated_at=200,
                items=[],
                messages=[],
                base_revision=1,
            )
            result, error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", empty
            )
            self.assertIsNone(result)
            self.assertEqual(error, "empty_snapshot")
            current, _ = store.get_custom_canvas_draft("creator-a", "canvas-local-1")
            self.assertEqual(len(current["state"]["items"]), 1)
            self.assertEqual(current["project"]["revision"], 1)

    def test_message_only_server_draft_rejects_empty_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            message_only = draft_payload(
                "canvas-message-only",
                items=[],
                messages=[{"id": "m1", "role": "user", "text": "保留对话"}],
            )
            store.save_custom_canvas_draft(
                "creator-a", "canvas-message-only", message_only
            )
            empty = draft_payload(
                "canvas-message-only",
                updated_at=200,
                items=[],
                messages=[],
                base_revision=1,
            )
            result, error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-message-only", empty
            )
            self.assertIsNone(result)
            self.assertEqual(error, "empty_snapshot")
            current, _ = store.get_custom_canvas_draft(
                "creator-a", "canvas-message-only"
            )
            self.assertEqual(current["state"]["messages"][0]["text"], "保留对话")

    def test_delete_leaves_tombstone_and_stale_put_cannot_resurrect(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            store.save_custom_canvas_draft(
                "creator-a", "canvas-local-1", draft_payload()
            )
            tombstone, error = store.delete_custom_canvas_draft(
                "creator-a", "canvas-local-1"
            )
            self.assertIsNone(error)
            self.assertEqual(tombstone["revision"], 2)

            items, tombstones = store.list_custom_canvas_drafts("creator-a")
            self.assertEqual(items, [])
            self.assertEqual(tombstones[0]["sourceProjectId"], "canvas-local-1")
            self.assertEqual(tombstones[0]["revision"], 2)
            missing, get_error = store.get_custom_canvas_draft(
                "creator-a", "canvas-local-1"
            )
            self.assertIsNone(missing)
            self.assertEqual(get_error, "deleted")

            for migration in (False, True):
                result, save_error, _ = store.save_custom_canvas_draft(
                    "creator-a",
                    "canvas-local-1",
                    draft_payload(updated_at=9999999999999, migration=migration),
                )
                self.assertIsNone(result)
                self.assertEqual(save_error, "deleted")

    def test_delete_before_first_put_writes_tombstone_and_blocks_late_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            tombstone, error = store.delete_custom_canvas_draft(
                "creator-a", "canvas-race"
            )
            self.assertIsNone(error)
            self.assertEqual(tombstone["revision"], 1)

            items, tombstones = store.list_custom_canvas_drafts("creator-a")
            self.assertEqual(items, [])
            self.assertEqual(tombstones[0]["sourceProjectId"], "canvas-race")

            result, save_error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-race",
                draft_payload("canvas-race", updated_at=9999999999999),
            )
            self.assertIsNone(result)
            self.assertEqual(save_error, "deleted")
            self.assertEqual(outcome, "deleted")

    def test_existing_published_custom_project_is_reused_without_losing_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            published, error = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "已发布画布",
                "status": "published",
                "publishedDeliveryId": "delivery-published",
                "projectState": {
                    "sourceProjectId": "canvas-published",
                    "publishedItemIds": ["image-node-1"],
                },
            })
            self.assertIsNone(error)
            published["publishedAt"] = 123456
            published["updatedAt"] += 1
            store.upsert_docs("customProjects", [published])
            store.upsert_docs("assets", [{
                "id": "delivery-published",
                "ownerId": "creator-a",
                "customProjectId": published["id"],
                "byMemberId": "creator-a",
                "delivered": True,
                "type": "图集",
                "updatedAt": 200,
            }])

            saved, save_error, _ = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-published",
                draft_payload("canvas-published"),
            )
            self.assertIsNone(save_error)
            self.assertEqual(saved["project"]["customProjectId"], published["id"])
            self.assertEqual(saved["project"]["status"], "published")
            self.assertEqual(
                saved["project"]["publishedDeliveryId"], "delivery-published"
            )
            self.assertEqual(saved["project"]["publishedAt"], 123456)
            self.assertEqual(saved["project"]["publishedItemIds"], ["image-node-1"])
            self.assertEqual(saved["project"]["publishedCount"], 1)
            project_count = store._fetchone(
                "SELECT COUNT(*) FROM docs WHERE collection='customProjects' AND owner_id=?",
                ("creator-a",),
            )[0]
            self.assertEqual(project_count, 1)

            updated_payload = draft_payload(
                "canvas-published",
                updated_at=300,
                base_revision=1,
                messages=[],
            )
            updated, update_error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-published", updated_payload
            )
            self.assertIsNone(update_error)
            self.assertEqual(updated["project"]["publishedDeliveryId"], "delivery-published")
            self.assertEqual(updated["project"]["publishedItemIds"], ["image-node-1"])
            self.assertEqual(updated["project"]["publishedCount"], 1)

    def test_preuploaded_blob_survives_old_draft_race_and_commits_by_stable_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            uploaded = store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
            stable_url = uploaded["url"]
            digest = uploaded["contentHash"]
            self.assertRegex(stable_url, r"^/api/custom-canvas/blobs/[a-f0-9]{64}$")
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blob_staging WHERE owner_id=? AND content_hash=?",
                ("creator-a", digest),
            )[0], 1)

            # A delayed save from before the upload must not garbage-collect the
            # newly generated image before its own lightweight draft arrives.
            old_payload = draft_payload("canvas-old", items=[], messages=[])
            saved_old, old_error, _ = store.save_custom_canvas_draft(
                "creator-a", "canvas-old", old_payload
            )
            self.assertIsNone(old_error)
            self.assertIsNotNone(saved_old)
            blob, blob_error = store.get_custom_canvas_blob("creator-a", digest)
            self.assertIsNone(blob_error)
            self.assertEqual(blob["size"], len(PNG_BYTES))

            target = draft_payload("canvas-progressive", items=[{
                "id": "generated-1",
                "projectId": "canvas-progressive",
                "type": "generation",
                "assetUrl": stable_url,
                "outputId": "output-generated-1",
                "position": {"x": 0, "y": 0},
                "size": {"width": 100, "height": 100},
                "z": 1,
                "createdAt": 10,
                "loading": False,
                "generationStatus": "done",
            }])
            saved, error, outcome = store.save_custom_canvas_draft(
                "creator-a", "canvas-progressive", target
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")
            self.assertEqual(saved["state"]["items"][0]["assetUrl"], stable_url)
            self.assertEqual(store._fetchone(
                "SELECT COUNT(*) FROM custom_canvas_blob_staging WHERE owner_id=? AND content_hash=?",
                ("creator-a", digest),
            )[0], 0)
            fetched, fetch_error = store.get_custom_canvas_draft(
                "creator-a", "canvas-progressive"
            )
            self.assertIsNone(fetch_error)
            self.assertEqual(fetched["state"]["items"][0]["assetUrl"], stable_url)

    def test_generated_blob_receipt_is_owner_hash_bound_and_blocks_unsettled_draft(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            receipt = store.issue_custom_canvas_generation_receipt(
                "creator-a",
                PNG_DATA_URL,
                points=5,
                feature="无限画布图片生成",
            )

            with self.assertRaisesRegex(
                ValueError, "custom_canvas_generation_receipt_required"
            ):
                store.save_custom_canvas_blob("creator-a", PNG_DATA_URL)
            with self.assertRaisesRegex(
                ValueError, "invalid_custom_canvas_generation_receipt"
            ):
                store.save_custom_canvas_blob(
                    "creator-b", PNG_DATA_URL, receipt["token"]
                )
            forged = receipt["token"][:-1] + (
                "0" if receipt["token"][-1] != "0" else "1"
            )
            with self.assertRaisesRegex(
                ValueError, "invalid_custom_canvas_generation_receipt"
            ):
                store.save_custom_canvas_blob("creator-a", PNG_DATA_URL, forged)

            with self.assertRaisesRegex(
                ValueError, "invalid_custom_canvas_generation_receipt"
            ):
                store.save_custom_canvas_blob(
                    "creator-a", PNG_DATA_URL, receipt["token"]
                )

            self.assertTrue(store.mark_custom_canvas_generation_receipt_charged(
                "creator-a", receipt["receiptId"]
            ))
            uploaded = store.save_custom_canvas_blob(
                "creator-a", PNG_DATA_URL, receipt["token"]
            )
            self.assertEqual(
                uploaded["generationReceipt"]["receiptId"], receipt["receiptId"]
            )
            generated_item = {
                "id": "generated-billed-1",
                "projectId": "canvas-billed",
                "type": "generation",
                "assetUrl": uploaded["url"],
                "outputId": "generated-billed-1",
                "position": {"x": 0, "y": 0},
                "size": {"width": 100, "height": 100},
                "z": 1,
                "createdAt": 10,
                "loading": False,
                "generationStatus": "done",
            }
            saved, error, outcome = store.save_custom_canvas_draft(
                "creator-a",
                "canvas-billed",
                draft_payload("canvas-billed", items=[generated_item]),
            )
            self.assertIsNone(error)
            self.assertEqual(outcome, "created")
            self.assertEqual(saved["state"]["items"][0]["assetUrl"], uploaded["url"])

    def test_blob_route_verifies_settled_receipt_without_charging_uploads(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            main = importlib.import_module("main")
            receipt = store.issue_custom_canvas_generation_receipt(
                "creator-a", PNG_DATA_URL, points=5, charged=True
            )
            generated_request = main.CustomCanvasBlobPutReq(
                dataUrl=PNG_DATA_URL,
                outputId="generated-slot-1",
                generationReceipt=receipt["token"],
            )
            quota = {
                "limit": 70,
                "used": 5,
                "remaining": 65,
                "resetAt": 123,
                "deducted": 5,
                "reused": False,
            }
            with patch.object(main, "store", store), patch.object(
                store, "deduct_personal_daily_points"
            ) as deduct, patch.object(
                store, "mark_custom_canvas_generation_receipt_charged"
            ) as mark, patch.object(
                store, "personal_daily_quota", return_value=quota
            ):
                generated = main.custom_canvas_blob_put(
                    generated_request,
                    me={"id": "creator-a", "role": "editor"},
                )
            deduct.assert_not_called()
            mark.assert_not_called()
            self.assertEqual(generated["billing"]["deductedPoints"], 0)
            self.assertTrue(generated["billing"]["settledAtGeneration"])
            self.assertEqual(generated["dailyQuota"]["remaining"], 65)

            ordinary_svg = (
                '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">'
                '<rect width="2" height="2" fill="#1677ff"/></svg>'
            )
            ordinary_request = main.CustomCanvasBlobPutReq(
                dataUrl=(
                    "data:image/svg+xml;base64,"
                    + base64.b64encode(ordinary_svg.encode("utf-8")).decode("ascii")
                ),
                outputId="uploaded-reference-1",
            )
            with patch.object(main, "store", store), patch.object(
                store, "deduct_personal_daily_points"
            ) as deduct:
                ordinary = main.custom_canvas_blob_put(
                    ordinary_request,
                    me={"id": "creator-a", "role": "editor"},
                )
            deduct.assert_not_called()
            self.assertEqual(ordinary["billing"]["deductedPoints"], 0)
            self.assertIsNone(ordinary["dailyQuota"])

    def test_blob_upload_route_returns_output_id_and_maps_oversize_to_413(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            main = importlib.import_module("main")
            request = main.CustomCanvasBlobPutReq(
                dataUrl=PNG_DATA_URL,
                outputId="image-slot-7",
            )
            with patch.object(main, "store", store):
                result = main.custom_canvas_blob_put(
                    request,
                    me={"id": "creator-a", "role": "editor"},
                )
            self.assertEqual(result["outputId"], "image-slot-7")
            self.assertRegex(result["url"], r"^/api/custom-canvas/blobs/[a-f0-9]{64}$")

            with patch.object(main, "store", store), patch.object(
                store, "MAX_CUSTOM_CANVAS_BLOB_BYTES", 1
            ):
                with self.assertRaises(HTTPException) as raised:
                    main.custom_canvas_blob_put(
                        request,
                        me={"id": "creator-a", "role": "editor"},
                    )
            self.assertEqual(raised.exception.status_code, 413)
            self.assertIn("过大", str(raised.exception.detail))


if __name__ == "__main__":
    unittest.main()
