from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POLICY_JS = ROOT / "web" / "assets" / "publishPolicy.js"
APP_JS = ROOT / "web" / "assets" / "app.js"
INDEX_HTML = ROOT / "web" / "index.html"


class PublishPolicyTest(unittest.TestCase):
    def test_specific_delivery_output_is_authoritative_not_project_status(self):
        source = POLICY_JS.read_text(encoding="utf-8")
        script = f"""
import vm from "node:vm";
const context = vm.createContext({{}});
vm.runInContext({json.dumps(source)}, context);
const resolve = context.VideoWorkshopPublishPolicy.resolvePublishableVideoOutput;
const output = (id, deliveryId, url, status = "") => ({{ id, deliveryId, url, status }});
const current = output("out-current", "delivery-current", "/outputs/project-a/current.mp4");
const historical = output("out-history", "delivery-history", "/custom-video/outputs/project-a/history.mp4");
const project = {{
  id: "project-a",
  status: "conversation",
  activeDeliveryId: "delivery-current",
  outputs: [current],
  deliveries: [
    {{ id: "delivery-current", title: "Current", outputs: [current] }},
    {{ id: "delivery-history", title: "History", outputs: [historical] }},
  ],
}};
const conversationCurrent = resolve(project, current, project.deliveries[0]);
const conversationHistory = resolve(project, historical, project.deliveries[1]);
const legacy = {{
  id: "legacy-a",
  status: "conversation",
  activeDeliveryId: "legacy-delivery",
  outputs: [output("legacy-output", "legacy-delivery", "/outputs/legacy-a/final.mp4")],
  deliveries: [],
}};
const legacyResult = resolve(legacy, legacy.outputs[0]);
const failed = resolve({{
  ...project,
  deliveries: [{{ id: "delivery-failed", outputs: [
    output("out-failed", "delivery-failed", "/outputs/project-a/failed.mp4", "failed"),
  ] }}],
}}, output("out-failed", "delivery-failed", "/outputs/project-a/failed.mp4", "failed"), {{ id: "delivery-failed" }});
const pending = resolve({{
  ...project,
  deliveries: [{{ id: "delivery-pending", outputs: [
    output("out-pending", "delivery-pending", "/outputs/project-a/pending.mp4", "running"),
  ] }}],
}}, output("out-pending", "delivery-pending", "/outputs/project-a/pending.mp4", "running"), {{ id: "delivery-pending" }});
const empty = resolve({{
  ...project,
  deliveries: [{{ id: "delivery-empty", outputs: [output("out-empty", "delivery-empty", "")] }}],
}}, output("out-empty", "delivery-empty", ""), {{ id: "delivery-empty" }});
const crossProject = resolve({{
  ...project,
  deliveries: [{{ id: "delivery-cross", outputs: [
    output("out-cross", "delivery-cross", "/outputs/project-b/foreign.mp4"),
  ] }}],
}}, output("out-cross", "delivery-cross", "/outputs/project-b/foreign.mp4"), {{ id: "delivery-cross" }});
const forged = resolve(
  project,
  output("out-history", "delivery-history", "/outputs/project-b/forged.mp4"),
  {{ id: "delivery-history" }},
);
console.log(JSON.stringify({{
  currentUrl: conversationCurrent?.videoUrl || "",
  historyUrl: conversationHistory?.videoUrl || "",
  legacyUrl: legacyResult?.videoUrl || "",
  failed: failed === null,
  pending: pending === null,
  empty: empty === null,
  crossProject: crossProject === null,
  forgedCanonicalUrl: forged?.videoUrl || "",
}}));
"""
        result = subprocess.run(
            ["node", "--input-type=module"],
            input=script,
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            self.fail(result.stderr or result.stdout)
        payload = json.loads(result.stdout)
        self.assertEqual("/outputs/project-a/current.mp4", payload["currentUrl"])
        self.assertEqual("/custom-video/outputs/project-a/history.mp4", payload["historyUrl"])
        self.assertEqual("/outputs/legacy-a/final.mp4", payload["legacyUrl"])
        self.assertTrue(payload["failed"])
        self.assertTrue(payload["pending"])
        self.assertTrue(payload["empty"])
        self.assertTrue(payload["crossProject"])
        self.assertEqual(
            "/custom-video/outputs/project-a/history.mp4",
            payload["forgedCanonicalUrl"],
        )

    def test_web_client_loads_policy_before_using_publish_payload(self):
        app = APP_JS.read_text(encoding="utf-8")
        index = INDEX_HTML.read_text(encoding="utf-8")
        self.assertIn("VideoWorkshopPublishPolicy?.resolvePublishableVideoOutput", app)
        self.assertNotIn('project?.status !== "succeeded"', app)
        self.assertIn("const resolved = resolvePublishableVideoOutput(project, output, delivery);", app)
        self.assertLess(index.index("publishPolicy.js"), index.index("app.js"))


if __name__ == "__main__":
    unittest.main()
