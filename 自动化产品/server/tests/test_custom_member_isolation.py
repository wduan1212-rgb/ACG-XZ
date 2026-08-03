import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


class CustomMemberIsolationStoreTest(unittest.TestCase):
    def test_shared_account_exposes_only_its_explicit_reference_assets_to_other_editors(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "shared-digital-account",
                "ownerId": "creator-a",
                "name": "共享数字人账号",
                "platform": "视频号",
                "mode": "视频",
                "subType": "数字人",
                "avatarAssetId": "account-avatar",
                "charBoardAssetId": "account-role-board",
                "imageStyleAssetId": "account-style-ref",
                "voiceRefAssetId": "account-voice-ref",
                "updatedAt": 100,
            }, {
                "id": "shared-infoflow-account",
                "ownerId": "creator-a",
                "name": "共享信息流账号",
                "platform": "视频号",
                "mode": "视频",
                "subType": "无数字人",
                "charBoardAssetId": "retired-infoflow-role",
                "updatedAt": 100,
            }])
            store.upsert_docs("assets", [{
                "id": "account-avatar",
                "ownerId": "creator-a",
                "accountId": "shared-digital-account",
                "type": "图片",
                "name": "账号头像",
                "updatedAt": 101,
            }, {
                "id": "account-role-board",
                "ownerId": "creator-a",
                "accountId": "shared-digital-account",
                "type": "图片",
                "name": "数字人角色版",
                "updatedAt": 102,
            }, {
                "id": "account-style-ref",
                "ownerId": "creator-a",
                "accountId": "shared-digital-account",
                "type": "图片",
                "name": "账号风格参考图",
                "serverFileName": "creator-a--style-ref.png",
                "updatedAt": 103,
            }, {
                "id": "account-voice-ref",
                "ownerId": "creator-a",
                "accountId": "shared-digital-account",
                "type": "音频",
                "name": "账号参考声线",
                "updatedAt": 104,
            }, {
                "id": "creator-a-private-image",
                "ownerId": "creator-a",
                "accountId": "shared-digital-account",
                "type": "图片",
                "name": "A 的其他私有图片",
                "updatedAt": 105,
            }, {
                "id": "retired-infoflow-role",
                "ownerId": "creator-a",
                "accountId": "shared-infoflow-account",
                "type": "图片",
                "name": "旧信息流长期角色图",
                "updatedAt": 106,
            }])

            creator_b_state = store.state_for("creator-b", "editor")
            self.assertIn(
                "shared-digital-account",
                {item["id"] for item in creator_b_state["accounts"]},
            )
            self.assertEqual(
                {item["id"] for item in creator_b_state["assets"]},
                {
                    "account-avatar",
                    "account-role-board",
                    "account-voice-ref",
                },
            )
            self.assertNotIn(
                "creator-a-private-image",
                {item["id"] for item in creator_b_state["assets"]},
            )
            role_board = next(
                item
                for item in creator_b_state["assets"]
                if item["id"] == "account-role-board"
            )
            # B 的旧快照可以原样回推，但账号参考资产仍是只读：不能改名、删除或覆盖文件。
            store.upsert_member_assets("creator-b", "editor", [role_board])
            with self.assertRaises(PermissionError):
                store.upsert_member_assets("creator-b", "editor", [{
                    **role_board,
                    "name": "B 试图改写角色版",
                    "updatedAt": 200,
                }])
            with self.assertRaises(PermissionError):
                store.delete_member_doc(
                    "assets", "account-role-board", "creator-b", "editor"
                )
            self.assertFalse(
                store.can_write_asset_file(
                    "account-role-board", "creator-b", "editor"
                )
            )

            # 旧版风格图不再下发或参与生成；旧页面缓存仍可由创作者
            # 安全清理，文件与资产记录权限一致，并只清空这一个旧绑定。
            self.assertTrue(
                store.can_delete_asset_file(
                    "creator-a--style-ref.png", "creator-b", "editor"
                )
            )
            store.delete_member_doc(
                "assets", "account-style-ref", "creator-b", "editor"
            )
            refreshed = store.state_for("creator-b", "editor")
            account = next(
                item for item in refreshed["accounts"]
                if item["id"] == "shared-digital-account"
            )
            self.assertIsNone(account.get("imageStyleAssetId"))
            self.assertNotIn(
                "account-style-ref",
                {item["id"] for item in store.state_for("creator-a", "editor")["assets"]},
            )

            # 供应商仍只取得既有的账号头像白名单，角色版和普通私有图均不放开。
            store.assign_team_accounts(store.INTERNAL_TEAM_ID, ["shared-digital-account"])
            supplier_parent_id = store.get_member_by_username(store.DEFAULT_SUPPLIER_USERNAME)[0]
            supplier_state = store.state_for(supplier_parent_id, "supplier_parent")
            self.assertEqual(
                {item["id"] for item in supplier_state["assets"]},
                {"account-avatar"},
            )

    def test_creator_can_delete_normal_reference_but_not_role_or_delivery_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "digital-account",
                "ownerId": "admin-a",
                "mode": "视频",
                "subType": "数字人",
                "charBoardAssetId": "role-board",
            }])
            store.upsert_docs("assets", [{
                "id": "normal-ref",
                "ownerId": "creator-b",
                "type": "图片",
                "serverFileName": "creator-b--normal.png",
            }, {
                "id": "role-board",
                "ownerId": "creator-b",
                "type": "图片",
                "serverFileName": "creator-b--role.png",
            }, {
                "id": "delivery-cover",
                "ownerId": "creator-b",
                "type": "图片",
                "serverFileName": "creator-b--cover.png",
            }, {
                "id": "delivery-item",
                "ownerId": "creator-b",
                "type": "图集",
                "delivered": True,
                "serverFileName": "creator-b--delivery.zip",
                "coverAssetId": "delivery-cover",
                "packAssetIds": ["delivery-cover"],
            }])

            self.assertTrue(store.can_delete_asset_file(
                "creator-b--normal.png", "creator-b", "editor"
            ))
            self.assertFalse(store.can_delete_asset_file(
                "creator-b--role.png", "creator-b", "editor"
            ))
            self.assertFalse(store.can_delete_asset_file(
                "creator-b--cover.png", "creator-b", "editor"
            ))
            self.assertFalse(store.can_delete_asset_file(
                "creator-b--delivery.zip", "creator-b", "editor"
            ))

            store.delete_member_doc(
                "assets", "normal-ref", "creator-b", "editor"
            )
            for protected_id in ("role-board", "delivery-cover", "delivery-item"):
                with self.assertRaises(PermissionError):
                    store.delete_member_doc(
                        "assets", protected_id, "creator-b", "editor"
                    )

    def test_creator_snapshots_isolate_custom_projects_outputs_and_private_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            project_a, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "A 的无限画布",
                "projectState": {"nodeIds": ["a-node"]},
            })
            project_b, _ = store.save_custom_project("creator-b", {
                "kind": "video",
                "title": "B 的视频工坊",
                "projectState": {"workshopProjectId": "b-video"},
            })
            store.upsert_docs("customOutputs", [{
                "id": "canvas-output-a",
                "ownerId": "creator-a",
                "projectId": project_a["id"],
                "kind": "canvas",
                "updatedAt": 10,
            }, {
                "id": "video-output-b",
                "ownerId": "creator-b",
                "projectId": project_b["id"],
                "kind": "video",
                "updatedAt": 11,
            }])
            store.upsert_docs("assets", [{
                "id": "voice-a",
                "ownerId": "creator-a",
                "type": "音频",
                "tags": ["语音素材库", "口播"],
                "updatedAt": 20,
            }, {
                "id": "voice-b",
                "ownerId": "creator-b",
                "type": "音频",
                "tags": ["参考音频库", "声线参考"],
                "updatedAt": 21,
            }, {
                "id": "shared-bgm",
                "ownerId": "creator-a",
                "type": "音频",
                "tags": ["BGM", "音乐库"],
                "updatedAt": 22,
            }, {
                "id": "shared-bgm-with-voice-name",
                "ownerId": "creator-a",
                "type": "音频",
                "name": "语音_070435",
                "tags": ["BGM", "音乐"],
                "updatedAt": 23,
            }, {
                "id": "shared-editing-image",
                "ownerId": "creator-a",
                "type": "图片",
                "tags": ["剪辑素材", "共享剪辑素材", "图片素材"],
                "updatedAt": 24,
            }])
            store.upsert_docs("voicePresets", [{
                "id": "preset-a",
                "ownerId": "creator-a",
                "voiceId": "voice-preset-a",
                "name": "A 定制音色",
                "updatedAt": 30,
            }, {
                "id": "preset-b",
                "ownerId": "creator-b",
                "voiceId": "voice-preset-b",
                "name": "B 定制音色",
                "updatedAt": 31,
            }])

            state_a = store.state_for("creator-a", "editor")
            state_b = store.state_for("creator-b", "editor")

            self.assertEqual(
                {item["id"] for item in state_a["customProjects"]},
                {project_a["id"]},
            )
            self.assertEqual(
                {item["id"] for item in state_b["customProjects"]},
                {project_b["id"]},
            )
            self.assertEqual(
                {item["id"] for item in state_a["customOutputs"]},
                {"canvas-output-a"},
            )
            self.assertEqual(
                {item["id"] for item in state_b["customOutputs"]},
                {"video-output-b"},
            )
            self.assertEqual(
                {item["id"] for item in state_a["assets"]},
                {
                    "voice-a",
                    "shared-bgm",
                    "shared-bgm-with-voice-name",
                    "shared-editing-image",
                },
            )
            self.assertEqual(
                {item["id"] for item in state_b["assets"]},
                {
                    "voice-b",
                    "shared-bgm",
                    "shared-bgm-with-voice-name",
                    "shared-editing-image",
                },
            )
            expected_presets = {"preset-a", "preset-b"}
            self.assertEqual(
                {item["id"] for item in state_a["voicePresets"]},
                expected_presets,
            )
            self.assertEqual(
                {item["id"] for item in state_b["voicePresets"]},
                expected_presets,
            )

    def test_mixed_asset_snapshot_persists_owned_rows_and_skips_foreign_mutations(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_member_assets("creator-a", "editor", [{
                "id": "shared-delivery",
                "type": "图集",
                "name": "A 的已交付内容",
                "delivered": True,
                "updatedAt": 100,
            }])

            result = store.upsert_member_assets("creator-b", "editor", [{
                "id": "shared-delivery",
                "ownerId": "creator-a",
                "type": "图集",
                "name": "B 的陈旧快照修改",
                "delivered": True,
                "updatedAt": 101,
            }, {
                "id": "creator-b-new-delivery",
                "type": "图集",
                "name": "B 的新交付内容",
                "delivered": True,
                "updatedAt": 101,
            }])

            self.assertEqual({"written": 1, "denied": 1}, result)
            shared = store._fetchone(
                "SELECT owner_id,data FROM docs WHERE collection='assets' AND id='shared-delivery'"
            )
            self.assertEqual("creator-a", shared[0])
            self.assertEqual("A 的已交付内容", json.loads(shared[1])["name"])
            created = store._fetchone(
                "SELECT owner_id,data FROM docs WHERE collection='assets' AND id='creator-b-new-delivery'"
            )
            self.assertEqual("creator-b", created[0])
            self.assertEqual("B 的新交付内容", json.loads(created[1])["name"])

    def test_private_asset_and_shared_voice_mutations_are_owner_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_member_assets("creator-a", "editor", [{
                "id": "audio-a",
                "ownerId": "spoofed-creator-b",
                "type": "音频",
                "tags": ["语音素材库"],
                "name": "A 的生成音频",
                "updatedAt": 100,
            }])
            stored_audio = store._fetchone(
                "SELECT owner_id,data FROM docs WHERE collection='assets' AND id='audio-a'"
            )
            self.assertEqual(stored_audio[0], "creator-a")
            with self.assertRaises(PermissionError):
                store.upsert_member_assets("creator-b", "editor", [{
                    "id": "audio-a",
                    "ownerId": "creator-a",
                    "type": "音频",
                    "tags": ["语音素材库"],
                    "name": "B 试图改名",
                    "updatedAt": 101,
                }])
            with self.assertRaises(PermissionError):
                store.delete_member_doc("assets", "audio-a", "creator-b", "editor")
            self.assertTrue(store.can_write_asset_file("new-audio", "creator-b", "editor"))
            self.assertFalse(store.can_write_asset_file("audio-a", "creator-b", "editor"))
            self.assertTrue(store.can_write_asset_file("audio-a", "creator-a", "editor"))

            store.upsert_voice_presets("creator-a", "editor", [{
                "id": "shared-preset",
                "ownerId": "spoofed-creator-b",
                "voiceId": "shared-voice",
                "name": "共享可选音色",
                "updatedAt": 200,
            }])
            preset = store.state_for("creator-b", "editor")["voicePresets"][0]
            self.assertEqual(preset["ownerId"], "creator-a")
            self.assertEqual(preset["name"], "共享可选音色")
            with self.assertRaises(PermissionError):
                store.upsert_voice_presets("creator-b", "editor", [{
                    **preset,
                    "name": "越权改名",
                    "updatedAt": 201,
                }])
            with self.assertRaises(PermissionError):
                store.delete_member_doc(
                    "voicePresets", "shared-preset", "creator-b", "editor"
                )

            store.upsert_voice_presets("admin-1", "admin", [{
                **preset,
                "name": "管理员维护后的名称",
                "updatedAt": 202,
            }])
            updated = store.state_for("creator-b", "editor")["voicePresets"][0]
            self.assertEqual(updated["name"], "管理员维护后的名称")
            self.assertEqual(updated["ownerId"], "creator-a")

    def test_stale_a_b_clients_sync_only_owned_voice_rows_without_lost_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_voice_presets("creator-a", "editor", [{
                "id": "preset-a",
                "voiceId": "voice-a",
                "name": "A 初始名称",
                "updatedAt": 100,
            }])
            store.upsert_voice_presets("creator-b", "editor", [{
                "id": "preset-b",
                "voiceId": "voice-b",
                "name": "B 初始名称",
                "updatedAt": 100,
            }])

            # A/B 都在此时取得包含对方音色的旧快照。新客户端只从快照中挑出
            # 本人正在修改的单条记录提交，不能把对方的旧记录一起回推。
            stale_a = store.state_for("creator-a", "editor")["voicePresets"]
            stale_b = store.state_for("creator-b", "editor")["voicePresets"]
            a_owned = next(item for item in stale_a if item["id"] == "preset-a")
            b_owned = next(item for item in stale_b if item["id"] == "preset-b")
            first_barrier = Barrier(2)

            def rename_a():
                first_barrier.wait()
                store.upsert_voice_presets("creator-a", "editor", [{
                    **a_owned,
                    "name": "A 并发改名成功",
                    "updatedAt": 200,
                }])

            def add_b():
                first_barrier.wait()
                store.upsert_voice_presets("creator-b", "editor", [{
                    "id": "preset-b-new",
                    "voiceId": "voice-b-new",
                    "name": "B 并发新增成功",
                    "updatedAt": 201,
                }])

            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda fn: fn(), (rename_a, add_b)))

            after_first = {
                item["id"]: item
                for item in store.state_for("creator-a", "editor")["voicePresets"]
            }
            self.assertEqual(after_first["preset-a"]["name"], "A 并发改名成功")
            self.assertEqual(after_first["preset-b"]["name"], b_owned["name"])
            self.assertEqual(after_first["preset-b-new"]["ownerId"], "creator-b")

            second_barrier = Barrier(2)

            def delete_a():
                second_barrier.wait()
                store.delete_member_doc(
                    "voicePresets", "preset-a", "creator-a", "editor"
                )

            def rename_b():
                second_barrier.wait()
                store.upsert_voice_presets("creator-b", "editor", [{
                    **b_owned,
                    "name": "B 并发改名成功",
                    "updatedAt": 300,
                }])

            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda fn: fn(), (delete_a, rename_b)))

            after_second = {
                item["id"]: item
                for item in store.state_for("creator-b", "editor")["voicePresets"]
            }
            self.assertNotIn("preset-a", after_second)
            self.assertEqual(after_second["preset-b"]["name"], "B 并发改名成功")
            self.assertIn("preset-b-new", after_second)

    def test_canvas_browser_namespace_is_server_derived_per_member(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            namespace_a = store.custom_canvas_storage_namespace("creator-a")
            namespace_a_again = store.custom_canvas_storage_namespace("creator-a")
            namespace_b = store.custom_canvas_storage_namespace("creator-b")
            self.assertEqual(namespace_a, namespace_a_again)
            self.assertNotEqual(namespace_a, namespace_b)
            self.assertTrue(namespace_a.startswith("member-"))
            self.assertNotIn("creator-a", namespace_a)


class CustomMemberIsolationFrontendContractTest(unittest.TestCase):
    def test_child_apps_and_voice_ui_use_member_scoped_client_state(self):
        canvas_host = (
            APP_DIR / "js" / "views" / "customCanvasIntegration.js"
        ).read_text(encoding="utf-8")
        canvas_persistence = (
            APP_DIR / "apps" / "infinite-canvas-source" / "src" / "lib" / "canvasPersistence.ts"
        ).read_text(encoding="utf-8")
        video_app = (
            APP_DIR / "apps" / "video-workshop" / "web" / "assets" / "app.js"
        ).read_text(encoding="utf-8")
        backend = (APP_DIR / "server" / "main.py").read_text(encoding="utf-8")
        core_store = (APP_DIR / "js" / "core" / "store.js").read_text(encoding="utf-8")
        voices = (APP_DIR / "js" / "domain" / "voices.js").read_text(encoding="utf-8")
        voice_lab = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")

        self.assertIn("config.storageNamespace", canvas_host)
        self.assertIn('kind: "xingzhen-canvas-bootstrap"', canvas_host)
        self.assertNotIn("owner=${encodeURIComponent", canvas_host)
        self.assertIn("JSON.parse(window.name", canvas_persistence)
        self.assertIn("storageNamespace", canvas_persistence)
        self.assertNotIn('get("owner")', canvas_persistence)
        self.assertIn("window.__XINGZHEN_VIDEO_PROJECT_KEY__", video_app)
        self.assertIn('PROJECT_KEY_PREFIX + String(session.memberId || "")', backend)
        self.assertIn('"storageNamespace": store.custom_canvas_storage_namespace(me["id"])', backend)
        self.assertIn("state.ui.voiceByMember", voices)
        self.assertIn('source === "shared"', voice_lab)
        self.assertIn("a.ownerId !== ownerId", voice_lab)
        self.assertIn("ensureRuntimeMemberScope()", voice_lab)
        self.assertIn('const EXPLICIT_REMOTE_COLLECTIONS = new Set(["voicePresets"])', core_store)
        self.assertNotIn(
            'remote.putCollection("voicePresets", JSON.parse(JSON.stringify(state.voicePresets)))',
            core_store,
        )
        self.assertIn('remote.syncCollection("voicePresets", [JSON.parse(JSON.stringify(item))])', voices)
        self.assertIn("export async function rememberCustomVoice", voices)
        self.assertIn("export async function renameCustomVoice", voices)
        self.assertIn("export async function deleteCustomVoice", voices)
        self.assertIn("await rememberCustomVoice(", voice_lab)
        self.assertIn("await renameCustomVoice(", voice_lab)
        self.assertIn("await deleteCustomVoice(", voice_lab)
        self.assertIn("音色保存失败", voice_lab)
        self.assertIn("音色改名失败", voice_lab)
        self.assertIn("音色删除失败", voice_lab)


if __name__ == "__main__":
    unittest.main()
