import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_store_tombstone import load_isolated_store


APP_DIR = Path(__file__).resolve().parents[2]


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
            child = store.create_supplier_children("supplier-parent", [{
                "name": "子账号", "username": "supplier_sequence_child", "pin": "local-test-pin",
            }])[0]
            store.set_supplier_child_accounts(
                "supplier-parent", child["id"], ["account-b"], "supplier-parent"
            )

            parent_state = store.state_for("supplier-parent", "supplier_parent")
            child_state = store.state_for(child["id"], "supplier_child")
            creator_state = store.state_for("creator", "creator")
            parent_sequences = {account["id"]: account["index"] for account in parent_state["accounts"]}

            self.assertEqual(parent_sequences, {"account-a": 1, "account-b": 2, "account-c": 3})
            self.assertEqual(child_state["accounts"], [{
                "id": "account-b", "name": "账号 B", "platform": "视频号", "mode": "视频", "index": 2,
            }])
            self.assertNotIn("index", next(account for account in creator_state["accounts"] if account["id"] == "account-b"))

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


if __name__ == "__main__":
    unittest.main()
