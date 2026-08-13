import base64
import io
import json
import subprocess
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class DeliveryExcelExportTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", source],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout.strip()

    def test_stale_publish_date_resolves_to_current_shanghai_day(self):
        result = json.loads(self.run_node(r"""
const { resolvePublishPlanDate, shanghaiDayKey } = await import('./js/domain/publishSchedule.js');
const now = Date.parse('2026-08-13T09:30:00+08:00');
console.log(JSON.stringify({
  today: shanghaiDayKey(now),
  stale: resolvePublishPlanDate('2026-08-06', now),
  current: resolvePublishPlanDate('2026-08-13', now),
  future: resolvePublishPlanDate('2026-08-20', now),
  invalid: resolvePublishPlanDate('not-a-date', now),
}));
"""))
        self.assertEqual(result["today"], "2026-08-13")
        self.assertEqual(result["stale"], "2026-08-13")
        self.assertEqual(result["current"], "2026-08-13")
        self.assertEqual(result["future"], "2026-08-20")
        self.assertEqual(result["invalid"], "2026-08-13")

        from server import store

        timestamp = int(datetime(
            2026, 8, 13, 9, 30,
            tzinfo=timezone(timedelta(hours=8)),
        ).timestamp() * 1000)
        self.assertEqual(
            store._requested_publish_day_key({"planDate": "2026-08-06"}, timestamp),
            "2026-08-13",
        )
        self.assertEqual(
            store._requested_publish_day_key({"planDate": "2026-08-20"}, timestamp),
            "2026-08-20",
        )

    def test_return_range_and_xlsx_contract(self):
        payload = self.run_node(r"""
const {
  buildDeliveryReturnWorkbook,
  collectDeliveryReturnRows,
} = await import('./js/domain/deliveryExport.js');
const items = [
  { asset: { title:'区间内 = 不执行公式', publishedUrl:'https://example.com/a?x=1&y=2', viewCount:'1200', publishedAt:Date.parse('2026-08-07T10:30:00+08:00') }, acc:{ name:'账号甲', platform:'小红书' }, publisher:'创作人甲' },
  { asset: { title:'以最后回传时间为准', publishedUrl:'https://example.com/b', viewCount:88, publishedAt:Date.parse('2026-08-06T10:30:00+08:00'), publishedUpdatedAt:Date.parse('2026-08-08T11:45:00+08:00') }, acc:{ name:'账号乙', platform:'视频号' }, publisher:'创作人乙' },
  { asset: { title:'区间外', publishedUrl:'https://example.com/c', viewCount:9, publishedAt:Date.parse('2026-08-06T09:00:00+08:00') }, acc:{ name:'账号丙', platform:'抖音' }, publisher:'创作人丙' },
  { asset: { title:'没有链接', viewCount:7, publishedAt:Date.parse('2026-08-07T09:00:00+08:00') }, acc:{ name:'账号丁', platform:'小红书' }, publisher:'创作人丁' },
];
const rows = collectDeliveryReturnRows(items, { start:'2026-08-07', end:'2026-08-08' });
const blob = buildDeliveryReturnWorkbook(rows, { start:'2026-08-07', end:'2026-08-08', generatedAt:Date.parse('2026-08-13T12:00:00+08:00') });
console.log(JSON.stringify({ rows, type:blob.type, xlsx:Buffer.from(await blob.arrayBuffer()).toString('base64') }));
""")
        data = json.loads(payload)
        self.assertEqual(data["type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.assertEqual([row["title"] for row in data["rows"]], ["以最后回传时间为准", "区间内 = 不执行公式"])
        self.assertEqual(data["rows"][1]["viewCount"], 1200)

        with zipfile.ZipFile(io.BytesIO(base64.b64decode(data["xlsx"]))) as workbook:
            names = set(workbook.namelist())
            self.assertIn("xl/worksheets/sheet1.xml", names)
            self.assertIn("xl/worksheets/_rels/sheet1.xml.rels", names)
            self.assertIn("xl/styles.xml", names)
            sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
            rels = workbook.read("xl/worksheets/_rels/sheet1.xml.rels").decode("utf-8")
            self.assertIn('pane ySplit="4"', sheet)
            self.assertIn('autoFilter ref="A4:H6"', sheet)
            self.assertIn('mergeCell ref="A1:H1"', sheet)
            self.assertIn('r="E5" s="6"><v>88</v>', sheet)
            self.assertIn('r="F5" s="2"', sheet)
            self.assertNotIn("<f>", sheet)
            self.assertIn('Target="https://example.com/a?x=1&amp;y=2"', rels)

    def test_delivery_views_share_one_export_action(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        publish = (APP_DIR / "js/views/customPublish.js").read_text(encoding="utf-8")
        self.assertIn("openDeliveryReturnExport(all)", source)
        self.assertIn("buildDeliveryReturnWorkbook(rows", source)
        self.assertIn("await refreshDeliveryMetrics({ force: true })", source)
        self.assertIn("导出发布回传 Excel", source)
        self.assertIn("supplierReturnDayKey(item.asset)", source)
        self.assertIn("const initialPlanDate = resolvePublishPlanDate(draft.planDate)", publish)
        self.assertIn('min="${esc(todayValue())}" value="${esc(initialPlanDate)}"', publish)
        self.assertNotIn('${blocked ? "disabled" : ""}', publish)


if __name__ == "__main__":
    unittest.main()
