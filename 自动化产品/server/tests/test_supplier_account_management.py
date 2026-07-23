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

    def test_supplier_dashboard_keeps_account_tools_and_activity_history_interactive(self):
        source = (APP_DIR / "js/views/supplierViews.js").read_text(encoding="utf-8")
        self.assertIn('id="supplierContentAccountAdd"', source)
        self.assertIn('id="supplierOverviewSearch"', source)
        self.assertIn('id="supplierOverviewChildAdd"', source)
        self.assertIn('id="supplierActivityAll"', source)
        self.assertIn('data-supplier-activity-page="prev"', source)
        self.assertIn('openActivityModal', source)
        self.assertIn('账号已恢复', source)
        self.assertIn('恢复账号', source)
        self.assertIn('holdCollectionSync(["accounts"])', source)
        self.assertIn('button.textContent = disabled ? "正在恢复…" : "正在停用…"', source)
        self.assertNotIn("await persistNow()", source)

    def test_disabled_accounts_are_not_selectable_for_single_creation(self):
        source = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        self.assertIn('key: "已停用账号"', source)
        self.assertIn('tabindex="${isAccountDisabled(a) ? "-1" : "0"}"', source)
        self.assertIn("该账号已停用，恢复后才能继续创作", source)

    def test_supplier_delivery_list_reports_visible_selection_count(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        self.assertIn('id="dvSelectedCount"', source)
        self.assertIn("updateSupplierSelection", source)
        self.assertIn('data-sup-visible="${matchesFilters(item) ? "1" : "0"}"', source)

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
