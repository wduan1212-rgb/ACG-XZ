import sys
import tempfile
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]
SERVER_DIR = APP_DIR / "server"
TEST_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


class SupplierAccountManagementTests(unittest.TestCase):
    def test_supplier_account_editor_keeps_creator_style_configuration_private(self):
        source = (APP_DIR / "js/views/accountDialog.js").read_text(encoding="utf-8")
        self.assertIn('const isSupplierManager = ["supplier", "supplier_parent"].includes(state.role)', source)
        self.assertIn('!isSupplierManager ? `<label class="field full">创作风格', source)
        self.assertIn('draft.mode === "图文" && !isSupplierManager', source)
        self.assertIn('styleProfile: isSupplierManager ? (editing?.styleProfile || "")', source)
        self.assertIn('imagePromptTemplate: isSupplierManager ? (editing?.imagePromptTemplate || "")', source)
        self.assertIn('${isVideo && !isSupplierManager ? `', source)
        self.assertIn('${isDH && !isSupplierManager ? `', source)
        self.assertIn('${!isSupplierManager ? `<div class="ad-block">', source)
        self.assertIn('$("#adAssets", root)?.addEventListener', source)
        self.assertIn('if (charDrop) wireDropZone', source)

    def test_supplier_account_assets_only_accept_avatar(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            base = {
                "id": "supplier-upload-01",
                "accountId": "supplier-account-01",
                "serverFileName": "supplier-parent-a--account-image.png",
                "fileUrl": "/api/files/supplier-parent-a--account-image.png",
            }
            self.assertEqual([], store._supplier_account_assets("supplier-account-01", [{**base, "tags": ["账号资产"]}], "supplier-parent-a"))
            accepted = store._supplier_account_assets("supplier-account-01", [{**base, "tags": ["头像"]}], "supplier-parent-a")
            self.assertEqual(1, len(accepted))
            self.assertEqual("supplier-account-01", accepted[0]["accountId"])

    def test_supplier_account_patch_preserves_voice_and_character_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "supplier-private-01",
                "name": "已有数字人账号",
                "platform": "视频号",
                "mode": "视频",
                "subType": "数字人",
                "charBoardAssetId": "creator-role-board",
                "voiceId": "creator-voice-id",
                "voiceName": "创作者专属声线",
                "voiceRefAssetId": "creator-voice-reference",
                "status": "active",
            }])
            result, error = store.upsert_supplier_account(
                "supplier-private-01",
                {
                    "name": "供应商更新后的名称",
                    "platform": "视频号",
                    "mode": "视频",
                    "subType": "数字人",
                    "charBoardAssetId": "supplier-role-board",
                    "voiceId": "supplier-voice-id",
                    "voiceName": "供应商声线",
                    "voiceRefAssetId": "supplier-voice-reference",
                },
                [],
                "supplier-parent-a",
                create=False,
            )
            self.assertIsNone(error)
            self.assertEqual("供应商更新后的名称", result["account"]["name"])
            self.assertEqual("creator-role-board", result["account"]["charBoardAssetId"])
            self.assertEqual("creator-voice-id", result["account"]["voiceId"])
            self.assertEqual("创作者专属声线", result["account"]["voiceName"])
            self.assertEqual("creator-voice-reference", result["account"]["voiceRefAssetId"])

    def test_supplier_dashboard_keeps_account_tools_and_activity_history_interactive(self):
        source = (APP_DIR / "js/views/supplierViews.js").read_text(encoding="utf-8")
        main_source = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        self.assertIn('id="topSupplierOverviewSearch"', main_source)
        self.assertIn('id="topSupplierOverviewChildAdd"', main_source)
        self.assertIn('id="topSupplierAccountSearch"', main_source)
        self.assertIn('id="topSupplierContentAccountAdd"', main_source)
        self.assertIn('id="topSupplierSettingsChildAdd"', main_source)
        self.assertIn('$("#topSupplierContentAccountAdd")', source)
        self.assertIn('$("#topSupplierSettingsChildAdd")', source)
        self.assertIn('id="supplierRequestRefresh"', source)
        self.assertIn('编辑账号（含主页链接）', source)
        self.assertIn('supplier-account-control-row', source)
        self.assertNotIn('主页链接请在编辑账号中填写', source)
        self.assertNotIn('data-homepage-edit=', source)
        self.assertIn('class="supplier-member-grid"', source)
        self.assertIn('id="supplierActivityAll"', source)
        self.assertIn('data-supplier-activity-page="prev"', source)
        self.assertIn('openActivityModal', source)
        self.assertIn('updateSupplierActivityCarousel', source)
        self.assertIn('scheduleSupplierActivityCarousel(root, visibleActivity, activityPages)', source)
        self.assertIn('xingzhen:supplier-data-assistant:', source)
        self.assertIn('loadSupplierAssistantHistory()', source)
        self.assertIn('id="supplierTodayLinks"', source)
        self.assertIn('id="supplierTodayLinksCopyAll"', source)
        self.assertIn('supplierTodayLinksAnswer(rows)', source)
        self.assertIn('supplierTodayLinkLines(rows)', source)
        self.assertIn('data-copy-supplier-link=', source)
        self.assertIn('copyText(button.dataset.copySupplierLink', source)
        self.assertIn('accountDisplaySequenceMap(state.accounts)', source)
        self.assertIn('event.key !== "Enter" || event.isComposing', source)
        motion = (APP_DIR / "styles/ui-motion.css").read_text(encoding="utf-8")
        self.assertIn('grid-template-columns: 64px minmax(0, 1fr)', motion)
        self.assertNotIn('Supplier-only bottom dock', motion)
        self.assertIn('账号已恢复', source)
        self.assertIn('恢复账号', source)
        self.assertIn('holdCollectionSync(["accounts"])', source)
        self.assertIn('button.innerHTML = `<span class="spin-dot"', source)
        self.assertNotIn("await persistNow()", source)
        supplier_css = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn(
            ".supplier-data-assistant { position: relative; top: auto; align-self: start; margin: 0; height: 100%; min-height: 0;",
            supplier_css,
        )
        self.assertIn("--supplier-dashboard-height: clamp(480px, calc(100dvh - 104px), 680px);", supplier_css)
        self.assertIn(".supplier-dashboard-grid > .supplier-data-assistant { align-self: start; height: var(--supplier-dashboard-height); min-height: 0; margin-block: 0; }", supplier_css)
        self.assertIn(".supplier-dashboard-main { min-width: 0; display: grid; align-content: start; height: var(--supplier-dashboard-height);", supplier_css)
        self.assertIn("grid-template-rows: auto minmax(0, 1fr) auto auto;", supplier_css)
        self.assertIn(".supplier-data-messages { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;", supplier_css)
        self.assertIn(".supplier-today-links", supplier_css)
        self.assertIn(".supplier-today-link-actions", supplier_css)
        self.assertIn(".supplier-data-copy", supplier_css)
        self.assertIn(".supplier-donut-segment.is-xhs", supplier_css)
        self.assertIn(".supplier-trend-scroll", supplier_css)
        self.assertIn('data-supplier-platform="小红书"', source)
        self.assertIn('data-supplier-trend-window="30"', source)
        self.assertIn("openSupplierTrendDetail", source)

    def test_disabled_accounts_are_not_selectable_for_single_creation(self):
        source = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        self.assertIn('key: "已停用账号"', source)
        self.assertIn('tabindex="${isAccountDisabled(a) ? "-1" : "0"}"', source)
        self.assertIn("该账号已停用，恢复后才能继续创作", source)

    def test_supplier_delivery_list_reports_visible_selection_count(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        motion = (APP_DIR / "styles/ui-motion.css").read_text(encoding="utf-8")
        self.assertIn('id="dvSelectedCount"', source)
        self.assertIn("updateSupplierSelection", source)
        self.assertIn('data-sup-visible="${matchesFilters(item) ? "1" : "0"}"', source)
        self.assertIn("position: fixed;", motion)
        self.assertIn(".supplier-filters .supplier-selection-count", motion)

    def test_registration_name_field_requests_real_name(self):
        html = (APP_DIR / "index.html").read_text(encoding="utf-8")
        css = (APP_DIR / "styles/base.css").read_text(encoding="utf-8")
        self.assertIn("请使用真实姓名", html)
        self.assertIn(".lg-real-name-hint", css)
        self.assertIn("@keyframes lgRealNameHint", css)

    def test_create_disable_and_restore_preserve_account_identity_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            result, error = store.upsert_supplier_account(
                "supplier-new-01",
                {
                    "id": "supplier-new-01",
                    "name": "供应商新账号",
                    "platform": "小红书",
                    "mode": "图文",
                    "homepageUrl": "https://example.com/home",
                    "status": "active",
                },
                [],
                "supplier-parent-a",
                create=True,
            )
            self.assertIsNone(error)
            account_id = result["account"]["id"]
            store.upsert_docs("assets", [{
                "id": "historical-delivery",
                "accountId": account_id,
                "delivered": True,
                "title": "历史交付",
            }])

            disabled, error = store.upsert_supplier_account(
                account_id,
                {**result["account"], "status": "disabled"},
                [],
                "supplier-parent-a",
                create=False,
            )
            self.assertIsNone(error)
            self.assertEqual("disabled", disabled["account"]["status"])
            self.assertTrue(disabled["account"].get("disabledAt"))

            restored, error = store.upsert_supplier_account(
                account_id,
                {**disabled["account"], "status": "active"},
                [],
                "supplier-parent-a",
                create=False,
            )
            self.assertIsNone(error)
            self.assertEqual(account_id, restored["account"]["id"])
            self.assertEqual("active", restored["account"]["status"])
            self.assertNotIn("disabledAt", restored["account"])
            history = store.state_for("creator-a", "editor")["assets"]
            self.assertTrue(any(item["id"] == "historical-delivery" for item in history))

    def test_supplier_account_semantic_duplicate_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            payload = {"name": "同名账号", "platform": "视频号", "mode": "视频", "subType": "无数字人"}
            _, first_error = store.upsert_supplier_account("supplier-a1", payload, [], "supplier-parent-a", create=True)
            _, second_error = store.upsert_supplier_account("supplier-a2", payload, [], "supplier-parent-a", create=True)
            self.assertIsNone(first_error)
            self.assertEqual("duplicate", second_error)


if __name__ == "__main__":
    unittest.main()
