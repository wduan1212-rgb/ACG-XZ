import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class DeliveryStatusFiltersTest(unittest.TestCase):
    def test_creator_and_supplier_render_all_four_status_chips(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        delivery = (APP_DIR / "js/domain/delivery.js").read_text(encoding="utf-8")
        self.assertIn('deliveryStatusFiltersHtml("creator")', source)
        self.assertIn('deliveryStatusFiltersHtml("sup")', source)
        for label in ("已下载", "未下载", "已发布", "未发布"):
            self.assertIn(f">{label}</button>", source)
        self.assertIn("matchesDeliveryStatusFilters(x.asset, supFilters)", source)
        self.assertIn("supplierHasPublished(asset)", source)
        self.assertIn("const returnState = supplierReturnRowState(asset)", source)
        self.assertIn("${returnState.statusText}", source)
        self.assertIn("${returnState.actionText}", source)
        self.assertIn("applySupplierReturnResponse(asset, result)", source)
        self.assertIn("deliveryDisplaySequence(x.asset, map.get(x.asset.id))", source)
        self.assertIn("if (!changed) return;\n        draw();", source)
        self.assertIn('const SUPPLIER_ROLES = new Set(["supplier", "supplier_parent", "supplier_child"])', delivery)
        self.assertIn("markSupplierDownloadedWithRetry", delivery)
        self.assertIn("attempt < 2", delivery)
        self.assertIn("SUPPLIER_ROLES.has(state.role)", delivery)

    def test_status_filter_semantics_reuse_download_and_publish_state(self):
        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { matchesDeliveryStatusFilters, deliveryDisplaySequence } = await import('./js/domain/delivery.js');
const assets = [
  { id:'fresh', status:'未下载' },
  { id:'downloaded', status:'已下载', supplierDownloadedAt:10 },
  { id:'published-downloaded', status:'已发布', supplierDownloadedAt:20, publishedUrl:'https://example.com/a' },
  { id:'published-only', status:'已发布', publishedUrl:'https://example.com/b' }
];
const ids = filters => assets.filter(asset => matchesDeliveryStatusFilters(asset, filters)).map(asset => asset.id);
console.log(JSON.stringify({
  downloaded: ids({ download:'downloaded', publish:'all' }),
  undownloaded: ids({ download:'undownloaded', publish:'all' }),
  published: ids({ download:'all', publish:'published' }),
  unpublished: ids({ download:'all', publish:'unpublished' }),
  downloadedUnpublished: ids({ download:'downloaded', publish:'unpublished' }),
  undownloadedPublished: ids({ download:'undownloaded', publish:'published' }),
  globalSequence: deliveryDisplaySequence({ globalSeq:274, pubSeq:1 }, 7),
  stableSequence: deliveryDisplaySequence({ pubSeq:252 }, 1),
  projectedSequence: deliveryDisplaySequence({ projectedSeq:41 }, 1),
  legacySequence: deliveryDisplaySequence({}, 7)
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
        self.assertEqual(data["downloaded"], ["downloaded", "published-downloaded"])
        self.assertEqual(data["undownloaded"], ["fresh", "published-only"])
        self.assertEqual(data["published"], ["published-downloaded", "published-only"])
        self.assertEqual(data["unpublished"], ["fresh", "downloaded"])
        self.assertEqual(data["downloadedUnpublished"], ["downloaded"])
        self.assertEqual(data["undownloadedPublished"], ["published-only"])
        self.assertEqual(data["globalSequence"], 274)
        self.assertEqual(data["stableSequence"], 252)
        self.assertEqual(data["projectedSequence"], 41)
        self.assertEqual(data["legacySequence"], 7)

    def test_return_link_response_updates_same_asset_and_rerender_model(self):
        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { applySupplierReturnResponse, supplierReturnRowState } = await import('./js/domain/delivery.js');
const asset = { id:'delivery-252', pubSeq:252, status:'未下载', publishedUrl:'' };
const state = { assets:[asset] };
const before = state.assets[0];
const remote = {
  returnLink: async () => ({ asset: {
    ...asset,
    publishedUrl:'https://www.xiaohongshu.com/explore/returned',
    publishedAt:200,
    publishedUpdatedAt:200,
    publishedUpdatedBy:'supplier-child',
    status:'已发布',
    updatedAt:200
  } })
};
const response = await remote.returnLink(asset.id, { url:'https://www.xiaohongshu.com/explore/returned' });
const changed = applySupplierReturnResponse(state.assets[0], response);
const row = supplierReturnRowState(state.assets[0]);
console.log(JSON.stringify({
  changed,
  sameReference: before === state.assets[0],
  status: state.assets[0].status,
  url: state.assets[0].publishedUrl,
  statusText: row.statusText,
  actionText: row.actionText,
  statusClass: row.statusClass,
  actionClass: row.actionClass
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
        self.assertTrue(data["changed"])
        self.assertTrue(data["sameReference"])
        self.assertEqual(data["status"], "已发布")
        self.assertEqual(data["url"], "https://www.xiaohongshu.com/explore/returned")
        self.assertEqual(data["statusText"], "已回传 ✓")
        self.assertEqual(data["actionText"], "改链接")
        self.assertEqual(data["statusClass"], "pub")
        self.assertEqual(data["actionClass"], "ghost")

    def test_clear_link_response_keeps_same_asset_and_restores_unreturned_row(self):
        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { applySupplierReturnResponse, supplierReturnRowState } = await import('./js/domain/delivery.js');
const asset = {
  id:'delivery-252', pubSeq:252, status:'已发布', supplierDownloadedAt:100,
  publishedUrl:'https://www.xiaohongshu.com/explore/mistake', publishedUpdatedAt:200
};
const returned = {
  id:'delivery-252', pubSeq:252, status:'已下载', supplierDownloadedAt:100,
  publishedUpdatedAt:300, publishedClearedAt:300
};
const changed = applySupplierReturnResponse(asset, { asset: returned });
const row = supplierReturnRowState(asset);
console.log(JSON.stringify({ changed, url: asset.publishedUrl || '', status: asset.status, statusText: row.statusText, actionText: row.actionText }));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        data = json.loads(result.stdout)
        self.assertTrue(data["changed"])
        self.assertEqual(data["url"], "")
        self.assertEqual(data["status"], "已下载")
        self.assertEqual(data["statusText"], "已下载")
        self.assertEqual(data["actionText"], "回传链接")


if __name__ == "__main__":
    unittest.main()
