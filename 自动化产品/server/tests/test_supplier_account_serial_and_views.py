import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_store_tombstone import load_isolated_store


APP_DIR = Path(__file__).resolve().parents[2]


def default_supplier_parent_id(store):
    return store.get_member_by_username(store.DEFAULT_SUPPLIER_USERNAME)[0]


class SupplierAccountSerialAndViewsTest(unittest.TestCase):
    def test_supplier_account_board_reuses_creator_sequence_map(self):
        source = (APP_DIR / "js/views/supplierViews.js").read_text(encoding="utf-8")
        main_source = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        self.assertIn("accountDisplaySequenceMap(state.accounts)", source)
        self.assertIn("accountDisplaySequenceMap(state.accounts)", main_source)
        self.assertIn('class="supplier-account-sequence"', source)
        self.assertRegex(
            source,
            r'<article class="supplier-account[^\"]*"[^>]*><span class="supplier-account-sequence">',
        )

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { accountDisplaySequenceMap } = await import('./js/domain/accounts.js');
const accounts = [{ id:'account-b', index:2 }, { id:'account-c', index:3 }];
const sequence = accountDisplaySequenceMap(accounts);
console.log(JSON.stringify(accounts.map(account => [account.id, sequence.get(account.id)])));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout), [["account-b", 2], ["account-c", 3]])

    def test_supplier_parent_and_filtered_child_receive_same_read_only_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [
                {"id": "account-a", "name": "账号 A", "platform": "小红书", "mode": "图文"},
                {"id": "account-b", "name": "账号 B", "platform": "视频号", "mode": "视频"},
                {"id": "account-c", "name": "账号 C", "platform": "小红书", "mode": "图文"},
            ])
            store.assign_team_accounts(
                store.INTERNAL_TEAM_ID, ["account-a", "account-b", "account-c"]
            )
            parent_id = default_supplier_parent_id(store)
            child = store.create_supplier_children(parent_id, [{
                "name": "子账号", "username": "supplier_sequence_child", "pin": "local-test-pin",
            }])[0]
            store.set_supplier_child_accounts(
                parent_id, child["id"], ["account-b"], parent_id
            )

            parent_state = store.state_for(parent_id, "supplier_parent")
            child_state = store.state_for(child["id"], "supplier_child", parent_id)
            creator_state = store.state_for("creator", "creator")
            parent_sequences = {account["id"]: account["index"] for account in parent_state["accounts"]}

            self.assertEqual(parent_sequences, {"account-a": 1, "account-b": 2, "account-c": 3})
            self.assertEqual(child_state["accounts"], [{
                "id": "account-b", "name": "账号 B", "platform": "视频号", "mode": "视频", "index": 2,
            }])
            self.assertNotIn("index", next(account for account in creator_state["accounts"] if account["id"] == "account-b"))

    def test_supplier_account_number_survives_disable_and_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [
                {"id": "account-a", "name": "账号 A", "platform": "小红书", "mode": "图文"},
                {"id": "account-b", "name": "账号 B", "platform": "视频号", "mode": "视频"},
                {"id": "account-c", "name": "账号 C", "platform": "小红书", "mode": "图文"},
            ])
            store.assign_team_accounts(
                store.INTERNAL_TEAM_ID, ["account-a", "account-b", "account-c"]
            )
            parent_id = default_supplier_parent_id(store)
            before = {
                account["id"]: account["index"]
                for account in store.state_for(parent_id, "supplier_parent")["accounts"]
            }
            account_b = next(
                account for account in store.state_for(parent_id, "supplier_parent")["accounts"]
                if account["id"] == "account-b"
            )
            disabled, error = store.upsert_supplier_account(
                "account-b", {**account_b, "status": "disabled"}, [], parent_id, create=False
            )
            self.assertIsNone(error)
            disabled_numbers = {
                account["id"]: account["index"]
                for account in store.state_for(parent_id, "supplier_parent")["accounts"]
            }
            restored, error = store.upsert_supplier_account(
                "account-b", {**disabled["account"], "status": "active"}, [], parent_id, create=False
            )
            self.assertIsNone(error)
            restored_numbers = {
                account["id"]: account["index"]
                for account in store.state_for(parent_id, "supplier_parent")["accounts"]
            }
            self.assertEqual(before, {"account-a": 1, "account-b": 2, "account-c": 3})
            self.assertEqual(disabled_numbers, before)
            self.assertEqual(restored_numbers, before)

    def test_view_count_dialog_starts_empty_and_zero_remains_valid(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        self.assertIn('value: supplierViewCountPromptValue(a)', source)
        self.assertIn("parseSupplierViewCount(value)", source)

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { parseSupplierViewCount, supplierViewCountPromptValue } = await import('./js/domain/delivery.js');
console.log(JSON.stringify({
  empty: parseSupplierViewCount(''),
  zero: parseSupplierViewCount('0'),
  grouped: parseSupplierViewCount('12,345'),
  rounded: parseSupplierViewCount('12.6'),
  negative: parseSupplierViewCount('-1'),
  invalid: parseSupplierViewCount('abc'),
  freshPrompt: supplierViewCountPromptValue({ viewCount:0 }),
  savedZeroPrompt: supplierViewCountPromptValue({ viewCount:0, viewsUpdatedAt:100 }),
  savedByZeroPrompt: supplierViewCountPromptValue({ viewCount:0, viewsUpdatedBy:'supplier-child' }),
  savedValuePrompt: supplierViewCountPromptValue({ viewCount:25, viewsUpdatedAt:100 }),
  legacyValuePrompt: supplierViewCountPromptValue({ viewCount:18 }),
  legacyZeroPrompt: supplierViewCountPromptValue({ viewCount:0 })
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        data = json.loads(result.stdout)
        self.assertFalse(data["empty"]["ok"])
        self.assertEqual(data["zero"], {"ok": True, "value": 0})
        self.assertEqual(data["grouped"], {"ok": True, "value": 12345})
        self.assertEqual(data["rounded"], {"ok": True, "value": 13})
        self.assertFalse(data["negative"]["ok"])
        self.assertFalse(data["invalid"]["ok"])
        self.assertEqual(data["freshPrompt"], "")
        self.assertEqual(data["savedZeroPrompt"], "0")
        self.assertEqual(data["savedByZeroPrompt"], "0")
        self.assertEqual(data["savedValuePrompt"], "25")
        self.assertEqual(data["legacyValuePrompt"], "18")
        self.assertEqual(data["legacyZeroPrompt"], "")

    def test_supplier_detail_uses_delivery_submission_time_and_global_account_number(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        self.assertIn("accountDisplaySequenceMap(state.accounts)", source)
        self.assertIn("发布账号编号：", source)
        self.assertIn("制作时间：", source)
        self.assertIn("deliverySubmittedAt(asset)", source)
        self.assertNotIn("deliverySubmittedAt(asset.sourceCreatedAt)", source)

        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { deliverySubmittedAt } = await import('./js/domain/delivery.js');
console.log(JSON.stringify({
  authoritative: deliverySubmittedAt({ deliveredAt:300, createdAt:200, sourceCreatedAt:100 }),
  legacy: deliverySubmittedAt({ createdAt:200, sourceCreatedAt:100 }),
  neverUseTaskCreation: deliverySubmittedAt({ sourceCreatedAt:100 }),
  isoLegacy: deliverySubmittedAt({ createdAt:'2026-07-18T10:20:00+08:00' })
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        data = json.loads(result.stdout)
        self.assertEqual(data["authoritative"], 300)
        self.assertEqual(data["legacy"], 200)
        self.assertEqual(data["neverUseTaskCreation"], 0)
        self.assertGreater(data["isoLegacy"], 0)

    def test_account_total_views_is_read_only_sum_of_content_rows(self):
        supplier = (APP_DIR / "js/views/supplierViews.js").read_text(encoding="utf-8")
        overview = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/domain/delivery.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        motion_styles = (APP_DIR / "styles/ui-motion.css").read_text(encoding="utf-8")
        self.assertNotIn("data-content-account-views=", supplier)
        self.assertNotIn("updateAccountViews(account.id, next)", supplier)
        self.assertIn("由该账号全部交付内容的观看量自动汇总", supplier)
        self.assertNotIn("totalViewCountOverride", supplier)
        self.assertNotIn("totalViewCountOverride", overview)
        self.assertIn("曝光合计", overview)
        self.assertIn("播放合计", overview)
        self.assertIn("曝光量", overview)
        self.assertIn("播放量", overview)
        self.assertNotIn("totalViewCountOverride", delivery)
        self.assertIn(".supplier-account-total-views", styles)
        self.assertNotIn(".supplier-account-total-views:hover", styles)
        self.assertIn(".supplier-account-control-row { min-width: 0; display: flex;", styles)
        self.assertIn("flex: 0 0 76px", styles)
        self.assertIn("justify-content: flex-end", styles)
        self.assertIn("grid-template-columns: repeat(3, minmax(0, 1fr))", motion_styles)
        self.assertIn("grid-template-columns: auto 34px minmax(0, 1fr) auto", motion_styles)
        self.assertIn(".supplier-account-control-row { min-width: 0; display: flex;", motion_styles)


if __name__ == "__main__":
    unittest.main()
