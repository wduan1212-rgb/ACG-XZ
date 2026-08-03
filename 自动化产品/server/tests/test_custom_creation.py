import tempfile
import time
import unittest
import sys
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

APP_DIR = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


def default_supplier_parent_id(store):
    return store.get_member_by_username(store.DEFAULT_SUPPLIER_USERNAME)[0]


class CustomCreationStoreTest(unittest.TestCase):
    @staticmethod
    def _video_bundle(project_id, suffix, account_id="account-video"):
        delivery = {
            "id": f"delivery-{suffix}",
            "ownerId": "creator-a",
            "accountId": account_id,
            "type": "视频",
            "title": f"发布 {suffix}",
            "name": "SPH-客户端旧账号-视频-999-定制创作-19990101",
            "delivered": True,
            "customProjectId": project_id,
            "byMemberId": "creator-a",
            "byAccount": "客户端旧账号",
            "sourceAssetId": f"source-{suffix}",
            "coverAssetId": f"cover-{suffix}",
            "videoUrl": f"/api/files/source-{suffix}",
            "productTag": "定制创作",
            "exportSeq": 999,
            "deliveredAt": 300,
        }
        return {
            "deliveryId": delivery["id"],
            "delivery": delivery,
            "assets": [
                delivery,
                {
                    "id": delivery["sourceAssetId"],
                    "ownerId": "creator-a",
                    "accountId": account_id,
                    "type": "视频",
                    "createdAt": 200,
                },
                {
                    "id": delivery["coverAssetId"],
                    "ownerId": "creator-a",
                    "accountId": account_id,
                    "type": "图片",
                    "createdAt": 201,
                },
            ],
            # 客户端账号仅用于兼容请求，服务器必须忽略这些可伪造字段。
            "account": {
                "id": account_id,
                "name": "客户端伪造账号",
                "mode": "图文",
                "monthlyDone": 999,
                "exportSeq": 999,
            },
        }

    @staticmethod
    def _canvas_bundle(project_id, suffix, account_id="account-image"):
        delivery = {
            "id": f"delivery-{suffix}",
            "ownerId": "creator-a",
            "accountId": account_id,
            "type": "图集",
            "title": f"发布 {suffix}",
            "delivered": True,
            "customProjectId": project_id,
            "byMemberId": "creator-a",
            "packAssetIds": [f"image-{suffix}-1", f"image-{suffix}-2"],
            "sourceItemIds": [f"canvas-item-{suffix}"],
        }
        return {
            "deliveryId": delivery["id"],
            "delivery": delivery,
            "assets": [
                delivery,
                *[
                    {
                        "id": asset_id,
                        "ownerId": "creator-a",
                        "accountId": account_id,
                        "type": "图片",
                        "createdAt": 200 + index,
                    }
                    for index, asset_id in enumerate(delivery["packAssetIds"])
                ],
            ],
            "account": {"id": account_id},
        }

    def test_custom_projects_are_owner_scoped_and_server_owned(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, error = store.save_custom_project("creator-a", {
                "ownerId": "spoofed-owner",
                "kind": "video",
                "title": "视频项目",
                "projectState": {"conversationId": "conversation-1"},
                "outputIds": ["output-old"],
                "thumbnailId": "thumb-old",
                "publishedDeliveryId": "delivery-old",
            })
            self.assertIsNone(error)
            self.assertEqual(made["ownerId"], "creator-a")
            self.assertEqual(store.list_custom_projects("creator-a")[0]["id"], made["id"])
            self.assertEqual(store.list_custom_projects("creator-b"), [])

            updated, update_error = store.save_custom_project(
                "creator-a",
                {
                    "title": "只更新标题",
                    "outputIds": [],
                    "thumbnailId": "",
                    "publishedDeliveryId": "",
                },
                made["id"],
            )
            self.assertIsNone(update_error)
            self.assertEqual(updated["kind"], "video")
            self.assertEqual(updated["projectState"], {"conversationId": "conversation-1"})
            self.assertEqual(updated["outputIds"], [])
            self.assertEqual(updated["thumbnailId"], "")
            self.assertEqual(updated["publishedDeliveryId"], "")

            denied, denied_error = store.get_custom_project(made["id"], "creator-b")
            self.assertIsNone(denied)
            self.assertEqual(denied_error, "forbidden")

            creator_b_state = store.state_for("creator-b", "editor")
            self.assertEqual(creator_b_state["customProjects"], [])

    def test_custom_project_rejects_embedded_media_and_cascades_owned_drafts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            with self.assertRaisesRegex(ValueError, "custom_project_binary_not_allowed"):
                store.save_custom_project("creator-a", {
                    "kind": "canvas",
                    "title": "错误项目",
                    "projectState": {"image": "data:image/png;base64,AAAA"},
                })

            made, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "画布项目",
                "projectState": {"nodeIds": ["node-1"]},
            })
            store.upsert_docs("customOutputs", [{
                "id": "output-1",
                "ownerId": "creator-a",
                "projectId": made["id"],
                "name": "草稿输出",
                "updatedAt": 2,
            }])
            deleted, error = store.delete_custom_project(made["id"], "creator-a")
            self.assertTrue(deleted)
            self.assertIsNone(error)
            self.assertEqual(store.list_custom_projects("creator-a"), [])
            output_ids = store._fetchall(
                "SELECT id FROM docs WHERE collection='customOutputs' AND owner_id=?",
                ("creator-a",),
            )
            self.assertEqual(output_ids, [])

    def test_custom_project_publish_requires_owned_synced_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, error = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "待发布项目",
                "projectState": {"workshopProjectId": "workshop-1"},
            })
            self.assertIsNone(error)

            missing, missing_error = store.mark_custom_project_published(
                made["id"], "creator-a", "delivery-missing",
            )
            self.assertIsNone(missing)
            self.assertEqual(missing_error, "delivery_not_found")

            store.upsert_docs("assets", [{
                "id": "delivery-1",
                "delivered": True,
                "customProjectId": made["id"],
                "byMemberId": "creator-a",
                "accountId": "account-1",
                "updatedAt": 3,
            }])
            published, publish_error = store.mark_custom_project_published(
                made["id"], "creator-a", "delivery-1",
            )
            self.assertIsNone(publish_error)
            self.assertEqual(published["status"], "published")
            self.assertEqual(published["publishedDeliveryId"], "delivery-1")

            denied, denied_error = store.mark_custom_project_published(
                made["id"], "creator-b", "delivery-1",
            )
            self.assertIsNone(denied)
            self.assertEqual(denied_error, "forbidden")

    def test_custom_project_bundle_publish_is_atomic_idempotent_and_retractable(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, error = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "原子发布项目",
                "projectState": {"workshopProjectId": "workshop-atomic"},
            })
            self.assertIsNone(error)

            store.upsert_docs("accounts", [{
                "id": "account-video",
                "name": "服务器视频账号",
                "mode": "视频",
                "platform": "视频号",
                "subType": "无数字人",
                "monthlyDone": 7,
                "exportSeq": 9,
                "updatedAt": 100,
            }])
            store.assign_team_accounts(store.INTERNAL_TEAM_ID, ["account-video"])
            supplier_parent_id = default_supplier_parent_id(store)
            bundle = self._video_bundle(made["id"], "atomic")
            delivery = bundle["delivery"]
            source = bundle["assets"][1]
            cover = bundle["assets"][2]
            bundle["assets"][0] = {
                **delivery,
                "title": "数组中的旧快照不应覆盖交付对象",
            }
            delivery["title"] = "原子发布"

            published, publish_error = store.publish_custom_project_bundle(
                made["id"], "creator-a", bundle,
            )
            self.assertIsNone(publish_error)
            self.assertEqual(published["project"]["status"], "published")
            self.assertEqual(published["project"]["publishedDeliveryId"], delivery["id"])
            self.assertEqual(published["account"]["name"], "服务器视频账号")
            self.assertEqual(published["account"]["monthlyDone"], 8)
            self.assertEqual(published["account"]["exportSeq"], 10)
            self.assertEqual(published["delivery"]["pubSeq"], 1)
            self.assertEqual(published["delivery"]["exportSeq"], 10)
            self.assertEqual(
                published["delivery"]["name"],
                "SPH-服务器视频账号-无数字人-010-定制创作-"
                + time.strftime("%Y%m%d", time.gmtime(time.time() + 8 * 60 * 60)),
            )
            self.assertEqual(published["delivery"]["byAccount"], "服务器视频账号")

            creator_state = store.state_for("creator-a", "editor")
            creator_assets = {item["id"]: item for item in creator_state["assets"]}
            self.assertEqual(creator_assets[delivery["id"]]["title"], "原子发布")
            self.assertFalse(creator_assets[source["id"]].get("shared", False))
            self.assertTrue(creator_assets[cover["id"]]["shared"])

            supplier_state = store.state_for(supplier_parent_id, "supplier_parent")
            supplier_assets = {item["id"]: item for item in supplier_state["assets"]}
            self.assertIn(delivery["id"], supplier_assets)
            self.assertIn(cover["id"], supplier_assets)
            self.assertNotIn(source["id"], supplier_assets)
            with self.assertRaisesRegex(ValueError, "custom_delivery_requires_unpublish"):
                store.delete_doc(
                    "assets",
                    delivery["id"],
                    protect_custom_delivery=True,
                )

            retried, retry_error = store.publish_custom_project_bundle(
                made["id"], "creator-a", bundle,
            )
            self.assertIsNone(retry_error)
            self.assertEqual(retried["delivery"]["pubSeq"], 1)
            self.assertEqual(retried["account"]["monthlyDone"], 8)
            self.assertEqual(retried["account"]["exportSeq"], 10)
            self.assertEqual(
                retried["delivery"]["name"],
                published["delivery"]["name"],
            )

            store.upsert_docs("analyticsLinks", [{
                "id": "analytics-atomic",
                "assetId": delivery["id"],
                "url": "https://example.com/published",
                "updatedAt": 400,
            }])
            store.upsert_docs("metricSnapshots", [{
                "id": "snapshot-atomic",
                "linkId": "analytics-atomic",
                "updatedAt": 401,
            }])
            store.upsert_docs("insightReports", [{
                "id": "report-atomic",
                "linkedSnapshotIds": ["snapshot-atomic"],
                "updatedAt": 402,
            }])

            retracted, retract_error = store.unpublish_custom_project_delivery(
                made["id"], "creator-a", delivery["id"],
            )
            self.assertIsNone(retract_error)
            self.assertEqual(retracted["project"]["status"], "draft")
            self.assertEqual(retracted["project"]["publishedDeliveryId"], "")
            self.assertEqual(retracted["account"]["monthlyDone"], 7)
            self.assertEqual(retracted["account"]["exportSeq"], 10)
            self.assertEqual(retracted["deliveryId"], delivery["id"])
            self.assertEqual(retracted["unsharedAssetIds"], [cover["id"]])
            self.assertEqual(retracted["removedAnalyticsIds"], ["analytics-atomic"])

            final_creator = store.state_for("creator-a", "editor")
            final_assets = {item["id"]: item for item in final_creator["assets"]}
            self.assertNotIn(delivery["id"], final_assets)
            self.assertIn(source["id"], final_assets)
            self.assertIn(cover["id"], final_assets)
            self.assertFalse(final_assets[cover["id"]].get("shared", False))
            self.assertEqual(final_creator["analyticsLinks"], [])
            self.assertEqual(final_creator["metricSnapshots"], [])
            self.assertEqual(
                final_creator["insightReports"][0]["linkedSnapshotIds"],
                [],
            )

            supplier_after = store.state_for(supplier_parent_id, "supplier_parent")
            supplier_asset_ids = {item["id"] for item in supplier_after["assets"]}
            self.assertNotIn(delivery["id"], supplier_asset_ids)
            self.assertNotIn(cover["id"], supplier_asset_ids)
            self.assertNotIn(source["id"], supplier_asset_ids)

            # 墓碑阻止旧浏览器把已回撤交付和分析链接重新推回服务器。
            store.upsert_docs("assets", [{**published["delivery"], "updatedAt": 999999}])
            store.upsert_docs("analyticsLinks", [{
                "id": "analytics-atomic",
                "assetId": delivery["id"],
                "updatedAt": 999999,
            }])
            self.assertNotIn(
                delivery["id"],
                {item["id"] for item in store.state_for("creator-a", "editor")["assets"]},
            )
            self.assertEqual(store.state_for("creator-a", "editor")["analyticsLinks"], [])
            resurrected, resurrect_error = store.publish_custom_project_bundle(
                made["id"], "creator-a", bundle,
            )
            self.assertIsNone(resurrected)
            self.assertEqual(resurrect_error, "delivery_asset_deleted")

    def test_custom_project_unpublish_rejects_downloaded_or_published_delivery_without_writes(self):
        blockers = (
            ({"supplierDownloadedAt": 123}, "delivery_already_downloaded"),
            ({"status": "已下载"}, "delivery_already_downloaded"),
            ({"publishedUrl": "https://example.com/post"}, "delivery_already_published"),
            ({"status": "已发布"}, "delivery_already_published"),
        )
        for index, (patch_fields, expected_error) in enumerate(blockers):
            with self.subTest(patch_fields=patch_fields):
                with tempfile.TemporaryDirectory() as tmp:
                    store = load_isolated_store(tmp)
                    made, _ = store.save_custom_project("creator-a", {
                        "kind": "video",
                        "title": f"不可回撤 {index}",
                    })
                    store.upsert_docs("accounts", [{
                        "id": "account-video",
                        "name": "受保护视频账号",
                        "platform": "视频号",
                        "mode": "视频",
                        "monthlyDone": 4,
                        "exportSeq": 8,
                        "updatedAt": 10,
                    }])
                    store.assign_team_accounts(store.INTERNAL_TEAM_ID, ["account-video"])
                    supplier_parent_id = default_supplier_parent_id(store)
                    bundle = self._video_bundle(made["id"], f"protected-{index}")
                    published, publish_error = store.publish_custom_project_bundle(
                        made["id"], "creator-a", bundle,
                    )
                    self.assertIsNone(publish_error)
                    delivery_id = published["delivery"]["id"]
                    protected_delivery = {
                        **published["delivery"],
                        **patch_fields,
                        "updatedAt": published["delivery"]["updatedAt"] + 1,
                    }
                    store.upsert_docs("assets", [protected_delivery])
                    store.upsert_docs("analyticsLinks", [{
                        "id": f"analytics-protected-{index}",
                        "assetId": delivery_id,
                        "url": "https://example.com/analytics",
                        "updatedAt": protected_delivery["updatedAt"] + 1,
                    }])

                    retracted, retract_error = store.unpublish_custom_project_delivery(
                        made["id"], "creator-a", delivery_id,
                    )
                    self.assertIsNone(retracted)
                    self.assertEqual(retract_error, expected_error)

                    state = store.state_for("creator-a", "editor")
                    account = next(
                        item for item in state["accounts"]
                        if item["id"] == "account-video"
                    )
                    delivery = next(
                        item for item in state["assets"]
                        if item["id"] == delivery_id
                    )
                    project = next(
                        item for item in state["customProjects"]
                        if item["id"] == made["id"]
                    )
                    self.assertEqual(account["monthlyDone"], 5)
                    self.assertEqual(account["exportSeq"], 9)
                    self.assertEqual(project["status"], "published")
                    self.assertEqual(project["publishedDeliveryId"], delivery_id)
                    self.assertEqual(
                        [item["id"] for item in state["analyticsLinks"]],
                        [f"analytics-protected-{index}"],
                    )
                    self.assertIn(
                        delivery_id,
                        {
                            item["id"]
                            for item in store.state_for(
                                supplier_parent_id,
                                "supplier_parent",
                            )["assets"]
                        },
                    )
                    for key, value in patch_fields.items():
                        self.assertEqual(delivery.get(key), value)

    def test_custom_project_unpublish_route_returns_explicit_409_for_protected_delivery(self):
        import main

        cases = (
            ("delivery_already_downloaded", "供应商已下载"),
            ("delivery_already_published", "供应商已回传发布链接"),
        )
        for error, message in cases:
            with self.subTest(error=error):
                with patch.object(
                    main.store,
                    "unpublish_custom_project_delivery",
                    return_value=(None, error),
                ):
                    with self.assertRaises(HTTPException) as raised:
                        main.custom_projects_unpublish(
                            "project-protected",
                            main.CustomProjectPublishReq(
                                deliveryId="delivery-protected",
                            ),
                            me={"id": "creator-a", "role": "editor"},
                        )
                self.assertEqual(raised.exception.status_code, 409)
                self.assertIn(message, raised.exception.detail)

    def test_custom_project_bundle_rejects_incomplete_payload_without_partial_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "不完整发布",
            })
            store.upsert_docs("accounts", [{
                "id": "account-image",
                "name": "图文账号",
                "mode": "图文",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 10,
            }])
            delivery = {
                "id": "delivery-incomplete",
                "ownerId": "creator-a",
                "accountId": "account-image",
                "type": "图集",
                "delivered": True,
                "customProjectId": made["id"],
                "byMemberId": "creator-a",
                "packAssetIds": ["missing-image"],
            }
            published, publish_error = store.publish_custom_project_bundle(
                made["id"],
                "creator-a",
                {
                    "deliveryId": delivery["id"],
                    "delivery": delivery,
                    "assets": [delivery],
                    "account": {
                        "id": "account-image",
                        "name": "图文账号",
                        "mode": "图文",
                    },
                },
            )
            self.assertIsNone(published)
            self.assertEqual(publish_error, "delivery_asset_missing")
            state = store.state_for("creator-a", "editor")
            self.assertNotIn(
                delivery["id"],
                {item["id"] for item in state["assets"]},
            )
            project, project_error = store.get_custom_project(made["id"], "creator-a")
            self.assertIsNone(project_error)
            self.assertEqual(project["status"], "draft")

    def test_canvas_publish_persists_exact_source_item_marker_and_retract_clears_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "画布精确标记",
                "projectState": {"sourceProjectId": "canvas-local-1"},
            })
            store.upsert_docs("accounts", [{
                "id": "account-image",
                "name": "图文账号",
                "mode": "图文",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 10,
            }])
            bundle = self._canvas_bundle(made["id"], "marker")
            published, publish_error = store.publish_custom_project_bundle(
                made["id"],
                "creator-a",
                bundle,
            )
            self.assertIsNone(publish_error)
            self.assertEqual(
                published["project"]["projectState"]["publishedItemIds"],
                ["canvas-item-marker"],
            )
            self.assertEqual(
                published["delivery"]["sourceItemIds"],
                ["canvas-item-marker"],
            )

            retracted, retract_error = store.unpublish_custom_project_delivery(
                made["id"],
                "creator-a",
                bundle["deliveryId"],
            )
            self.assertIsNone(retract_error)
            self.assertNotIn(
                "publishedItemIds",
                retracted["project"]["projectState"],
            )

    def test_retract_latest_custom_delivery_points_project_to_previous_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, _ = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "多次发布",
            })
            store.upsert_docs("accounts", [{
                "id": "account-video",
                "name": "视频账号",
                "mode": "视频",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 10,
            }])
            store.assign_team_accounts(store.INTERNAL_TEAM_ID, ["account-video"])
            supplier_parent_id = default_supplier_parent_id(store)
            first_bundle = self._video_bundle(made["id"], "first")
            second_bundle = self._video_bundle(made["id"], "second")
            first, first_error = store.publish_custom_project_bundle(
                made["id"], "creator-a", first_bundle,
            )
            second, second_error = store.publish_custom_project_bundle(
                made["id"], "creator-a", second_bundle,
            )
            self.assertIsNone(first_error)
            self.assertIsNone(second_error)
            self.assertEqual(first["project"]["publishedCount"], 1)
            self.assertEqual(second["project"]["publishedCount"], 2)
            self.assertEqual(
                second["project"]["publishedDeliveryId"],
                second_bundle["deliveryId"],
            )
            duplicate, duplicate_error = store.publish_custom_project_bundle(
                made["id"], "creator-a", second_bundle,
            )
            self.assertIsNone(duplicate_error)
            self.assertEqual(duplicate["project"]["publishedCount"], 2)
            self.assertEqual(
                store.count_custom_project_deliveries(
                    made["id"],
                    "creator-a",
                ),
                2,
            )
            self.assertEqual(
                store.count_custom_project_deliveries(
                    made["id"],
                    "creator-b",
                ),
                0,
            )

            retracted, retract_error = store.unpublish_custom_project_delivery(
                made["id"], "creator-a", second_bundle["deliveryId"],
            )
            self.assertIsNone(retract_error)
            self.assertEqual(retracted["project"]["status"], "published")
            self.assertEqual(
                retracted["project"]["publishedDeliveryId"],
                first_bundle["deliveryId"],
            )
            self.assertEqual(retracted["project"]["publishedCount"], 1)
            self.assertEqual(retracted["account"]["monthlyDone"], 1)
            listed = store.list_custom_projects("creator-a", "video")
            self.assertEqual(listed[0]["publishedCount"], 1)

            supplier_ids = {
                item["id"]
                for item in store.state_for(supplier_parent_id, "supplier_parent")["assets"]
            }
            self.assertIn(first_bundle["deliveryId"], supplier_ids)
            self.assertIn(first_bundle["delivery"]["coverAssetId"], supplier_ids)
            self.assertNotIn(second_bundle["deliveryId"], supplier_ids)
            self.assertNotIn(second_bundle["delivery"]["coverAssetId"], supplier_ids)

    def test_custom_project_publish_rejects_deleted_account_and_wrong_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            video_project, _ = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "账号校验",
            })
            canvas_project, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "画布账号校验",
            })
            store.upsert_docs("accounts", [{
                "id": "account-wrong-mode",
                "name": "图文账号",
                "mode": "图文",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 10,
            }, {
                "id": "account-deleted",
                "name": "已删视频账号",
                "mode": "视频",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 11,
            }, {
                "id": "account-video",
                "name": "视频账号",
                "mode": "视频",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 12,
            }])
            store.delete_doc("accounts", "account-deleted")

            wrong, wrong_error = store.publish_custom_project_bundle(
                video_project["id"],
                "creator-a",
                self._video_bundle(video_project["id"], "wrong", "account-wrong-mode"),
            )
            self.assertIsNone(wrong)
            self.assertEqual(wrong_error, "account_mode_mismatch")

            wrong_canvas, wrong_canvas_error = store.publish_custom_project_bundle(
                canvas_project["id"],
                "creator-a",
                self._canvas_bundle(
                    canvas_project["id"], "wrong-canvas", "account-video",
                ),
            )
            self.assertIsNone(wrong_canvas)
            self.assertEqual(wrong_canvas_error, "account_mode_mismatch")

            deleted_bundle = self._video_bundle(
                video_project["id"], "deleted", "account-deleted",
            )
            deleted_bundle["account"]["name"] = "试图用客户端快照复活"
            deleted, deleted_error = store.publish_custom_project_bundle(
                video_project["id"], "creator-a", deleted_bundle,
            )
            self.assertIsNone(deleted)
            self.assertEqual(deleted_error, "account_deleted")
            self.assertNotIn(
                "account-deleted",
                {item["id"] for item in store.state_for("creator-a", "editor")["accounts"]},
            )
            self.assertEqual(
                store.state_for("creator-a", "editor")["assets"],
                [],
            )

    def test_concurrent_custom_publishes_allocate_unique_server_sequences(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made, _ = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "并发发布",
            })
            store.upsert_docs("accounts", [{
                "id": "account-video",
                "name": "并发视频账号",
                "platform": "抖音",
                "mode": "视频",
                "subType": "数字人",
                "monthlyDone": 2,
                "exportSeq": 5,
                "updatedAt": 10,
            }])
            bundles = [
                self._video_bundle(made["id"], f"concurrent-{index}")
                for index in range(6)
            ]
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(
                    lambda bundle: store.publish_custom_project_bundle(
                        made["id"], "creator-a", bundle,
                    ),
                    bundles,
                ))
            self.assertTrue(all(error is None for _, error in results))
            deliveries = [
                item for item in store.state_for("creator-a", "editor")["assets"]
                if item.get("delivered") and item.get("customProjectId") == made["id"]
            ]
            pub_sequences = sorted(item["pubSeq"] for item in deliveries)
            export_sequences = sorted(item["exportSeq"] for item in deliveries)
            delivery_names = {item["name"] for item in deliveries}
            self.assertEqual(pub_sequences, list(range(1, 7)))
            self.assertEqual(export_sequences, list(range(6, 12)))
            self.assertEqual(len(delivery_names), 6)
            date_stamp = time.strftime(
                "%Y%m%d",
                time.gmtime(time.time() + 8 * 60 * 60),
            )
            for delivery in deliveries:
                self.assertEqual(
                    delivery["name"],
                    (
                        "DY-并发视频账号-数字人-"
                        f"{delivery['exportSeq']:03d}-定制创作-{date_stamp}"
                    ),
                )
                self.assertNotIn("-999-", delivery["name"])
            account = next(
                item for item in store.state_for("creator-a", "editor")["accounts"]
                if item["id"] == "account-video"
            )
            self.assertEqual(account["monthlyDone"], 8)
            self.assertEqual(account["exportSeq"], 11)

            # 同一个 deliveryId 并发重试不能重复计数。
            retry_bundle = self._video_bundle(made["id"], "idempotent")
            with ThreadPoolExecutor(max_workers=4) as pool:
                retries = list(pool.map(
                    lambda _: store.publish_custom_project_bundle(
                        made["id"], "creator-a", retry_bundle,
                    ),
                    range(4),
                ))
            self.assertTrue(all(error is None for _, error in retries))
            self.assertEqual(
                {result["delivery"]["pubSeq"] for result, _ in retries},
                {7},
            )
            account = next(
                item for item in store.state_for("creator-a", "editor")["accounts"]
                if item["id"] == "account-video"
            )
            self.assertEqual(account["monthlyDone"], 9)
            self.assertEqual(account["exportSeq"], 12)

    def test_custom_project_routes_block_generic_collection_writes(self):
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        self.assertIn('@app.get("/api/custom-projects")', backend)
        self.assertIn('@app.post("/api/custom-projects")', backend)
        self.assertIn('@app.put("/api/custom-projects/{project_id}")', backend)
        self.assertIn('@app.post("/api/custom-projects/{project_id}/publish")', backend)
        self.assertIn('@app.post("/api/custom-projects/{project_id}/unpublish")', backend)
        self.assertIn("if collection in store.CUSTOM_COLLECTIONS", backend)
        self.assertIn("禁止批量回推", backend)
        self.assertIn("发布状态只能由定制创作发布接口更新", backend)

        router = (APP_DIR / "js/core/router.js").read_text(encoding="utf-8")
        shell = (APP_DIR / "js/views/customCreation.js").read_text(encoding="utf-8")
        publishing = (APP_DIR / "js/views/customPublish.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/domain/delivery.js").read_text(encoding="utf-8")
        assets = (APP_DIR / "js/domain/assets.js").read_text(encoding="utf-8")
        remote = (APP_DIR / "js/core/remote.js").read_text(encoding="utf-8")
        self.assertIn('history.replaceState(null, "", canonical)', router)
        self.assertIn('previous.zone === "custom"', router)
        self.assertIn("hostsHtml(activePage)", shell)
        self.assertIn("root.__customCreationContext", shell)
        self.assertIn("xingzhen.customCreation.performance.v1", shell)
        self.assertIn('recordCustomPerformance("tool-mount"', shell)
        self.assertIn('recordCustomPerformance("tab-activate"', shell)
        self.assertIn("forceNew: true", publishing)
        self.assertIn('kind: "video"', publishing)
        self.assertIn("AI.generateCopy({", publishing)
        self.assertIn("AI.generateImageCopyFromTitle", publishing)
        self.assertIn('id="customPublishProduct"', publishing)
        self.assertIn('id="customPublishProductTag"', publishing)
        self.assertIn("const initialTitle = String(", publishing)
        self.assertIn('kind === "video" ? ""', publishing)
        self.assertIn(
            "accountCoverStylePrompt(account, stylePrompt, palettePrompt)",
            publishing,
        )
        self.assertIn('account.subType === "数字人"', publishing)
        self.assertIn("account.charBoardAssetId", publishing)
        self.assertIn("characterRefAssetId: roleRefAssetId || null", publishing)
        self.assertIn('id="customPublishCoverFile"', publishing)
        self.assertIn('id="customPublishCoverReferenceFile"', publishing)
        self.assertIn('id="customPublishCoverReferenceZone"', publishing)
        self.assertIn('coverPreview?.addEventListener("drop"', publishing)
        self.assertIn('coverReferenceZone?.addEventListener("drop"', publishing)
        self.assertIn("extraReferenceAssetIds: coverReferenceAssetIds", publishing)
        self.assertIn("openLightbox(img, urlFor(asset)", publishing)
        self.assertIn('if (document.querySelector(".lightbox")) return false;', publishing)
        self.assertIn('coverReferenceList?.classList.toggle("is-disabled", active)', publishing)
        self.assertIn('if (pendingSubmission) {', publishing)
        self.assertIn("交付正在等待同步，不能再修改封面参考图", publishing)
        self.assertIn('source: "uploaded"', publishing)
        self.assertIn('if (source === "generated" || source === "uploaded") createdCoverIds.add(assetId)', publishing)
        self.assertIn("if (!published) {", publishing)
        self.assertIn("persistDraft();", publishing)
        self.assertIn("if (coverAssetId) createdCoverIds.delete(coverAssetId)", publishing)
        self.assertIn("[...createdCoverIds, ...createdCoverReferenceIds].forEach(id =>", publishing)
        self.assertNotIn("generatedCoverIds", publishing)
        self.assertIn('coverSource === "generated"', publishing)
        self.assertIn("productTagLabel(product)", publishing)
        self.assertIn("remote.customProjects.list(kind)", publishing)
        self.assertIn("await remote.customProjects.get(existingId)", publishing)
        self.assertIn("![403, 404].includes", publishing)
        self.assertIn('output.customProjectId = ""', publishing)
        self.assertIn("projectState.sourceProjectId", publishing)
        self.assertIn("projectState.workshopProjectId", publishing)
        self.assertIn("activeCustomPublishModal?.el?.isConnected", publishing)
        self.assertIn("coverAccountId !== accountId", publishing)
        self.assertIn("output.customProjectId || output.projectId", delivery)
        self.assertNotIn("image.accountId = acc.id", delivery)
        self.assertIn("forceNew = false", assets)
        self.assertIn("syncCollection(name, items)", remote)
        self.assertIn("ensureRemoteCustomProject(output, kind, title)", publishing)
        self.assertIn("remote.customProjects.publish(", publishing)
        self.assertIn('remote.holdCollectionSync(["assets", "accounts"])', publishing)
        self.assertIn("requiresRemote", publishing)
        self.assertIn("登录状态已经失效", publishing)
        self.assertIn("releaseSyncHold?.({ flush: false })", publishing)
        self.assertIn(
            "onPublished(asset, { customProjectId, publishedCount }",
            shell,
        )
        self.assertIn("previous.projectId === payload.projectId", shell)
        self.assertIn("onPublishRequest: payload => requestPublishFor(key, payload)", shell)
        self.assertIn("custom-video:publish-request", (APP_DIR / "js/views/customVideoIntegration.js").read_text(encoding="utf-8"))
        self.assertIn('"publish-request"', (APP_DIR / "js/views/customCanvasIntegration.js").read_text(encoding="utf-8"))
        self.assertIn("HTTP 401 登录已过期", remote)
        self.assertIn("_heldCollectionSnapshots", remote)
        self.assertIn("await remote.customProjects.unpublish", delivery)
        self.assertIn("if (!await pullRemote())", delivery)

    def test_image_review_is_compact_and_canvas_copy_is_single_line(self):
        review = (APP_DIR / "js/views/chainCopy.js").read_text(encoding="utf-8")
        image_review = review[review.index('root.innerHTML = `', review.index("if (!isImg)")) :]
        self.assertIn("① 成图", image_review)
        self.assertIn("② 发布文案", image_review)
        self.assertNotIn("① 脚本", image_review)
        self.assertNotIn("${reviewPreviewHtml(p)}", image_review)

        publishing = (APP_DIR / "js/views/customPublish.js").read_text(encoding="utf-8")
        helper_start = publishing.index("export function compactCanvasPublishCopy")
        helper_end = publishing.index("\n}\n\nfunction outputItems", helper_start) + 2
        helper_source = publishing[helper_start:helper_end].replace("export function", "function", 1)
        script = f"""
{helper_source}
console.log(compactCanvasPublishCopy('第一段\\n第二段\\\\n第三段   结束'));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(result.stdout.strip(), "第一段 第二段 第三段 结束")
        self.assertIn("copyInput.value = generatedCopy", publishing)
        self.assertIn('rows="${kind === "canvas" ? 4 : 6}"', publishing)

    def test_custom_video_cover_defaults_to_digital_role_but_not_legacy_style_image(self):
        publishing = (
            APP_DIR / "js/views/customPublish.js"
        ).read_text(encoding="utf-8")
        helper_start = publishing.index("function accountCoverStylePrompt")
        helper_end = publishing.index("async function generateCover", helper_start)
        helper_source = publishing[helper_start:helper_end]
        behavior_check = f"""
const assets = new Map([
  ["role-ref", {{ id: "role-ref", type: "图片" }}],
  ["style-ref", {{ id: "style-ref", type: "图片" }}],
  ["legacy-ref", {{ id: "legacy-ref", type: "图片" }}],
  ["custom-ref", {{ id: "custom-ref", type: "图片" }}],
]);
function assetById(id) {{ return assets.get(id) || null; }}
{helper_source}
const account = {{
  subType: "数字人",
  charBoardAssetId: "role-ref",
  imageStyleAssetId: "style-ref",
  styleProfile: "冷静真实的都市纪实风",
  tone: "专业但自然",
}};
const refs = coverReferenceIds({{
  coverRefAssetIds: "legacy-ref",
  referenceAssetIds: ["legacy-ref"],
}}, account);
if (refs.roleRefAssetId !== "role-ref") throw new Error("digital role ref missing");
if (JSON.stringify(refs.refAssetIds) !== JSON.stringify(["role-ref", "legacy-ref"])) {{
  throw new Error(`unexpected ref order: ${{JSON.stringify(refs.refAssetIds)}}`);
}}
const customRefs = coverReferenceIds({{
  coverRefAssetIds: "legacy-ref",
}}, account, ["custom-ref"]);
if (JSON.stringify(customRefs.refAssetIds) !== JSON.stringify(["role-ref", "custom-ref", "legacy-ref"])) {{
  throw new Error(`custom ref was not prioritized: ${{JSON.stringify(customRefs.refAssetIds)}}`);
}}
const style = accountCoverStylePrompt(account);
if (!style.includes("冷静真实的都市纪实风") || !style.includes("专业但自然")) {{
  throw new Error("account style was not carried into cover prompt");
}}
"""
        subprocess.run(
            ["node", "-e", behavior_check],
            cwd=APP_DIR,
            check=True,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
