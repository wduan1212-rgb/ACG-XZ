import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class DeliveryStatusFiltersTest(unittest.TestCase):
    def test_creator_and_supplier_render_all_four_status_chips(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        self.assertIn('deliveryStatusFiltersHtml("creator")', source)
        self.assertIn('deliveryStatusFiltersHtml("sup")', source)
        for label in ("已下载", "未下载", "已发布", "未发布"):
            self.assertIn(f">{label}</button>", source)
        self.assertIn("matchesDeliveryStatusFilters(x.asset, supFilters)", source)
        self.assertIn("supplierHasPublished(asset)", source)
        self.assertIn("if (!changed) return;\n        draw();", source)

    def test_status_filter_semantics_reuse_download_and_publish_state(self):
        script = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
const { matchesDeliveryStatusFilters } = await import('./js/domain/delivery.js');
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
  undownloadedPublished: ids({ download:'undownloaded', publish:'published' })
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


if __name__ == "__main__":
    unittest.main()
