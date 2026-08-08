import json
import subprocess
import textwrap
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class AssetUrlRevisionTest(unittest.TestCase):
    def run_node(self, source):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", textwrap.dedent(source)],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_replace_changes_versioned_url_without_replacing_asset(self):
        result = self.run_node(
            """
            globalThis.localStorage = {
              getItem(key){ return key === "dumate.token" ? "test-token" : null; },
              setItem(){},
              removeItem(){}
            };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const requests = [];
            globalThis.fetch = async (url, options = {}) => {
              const method = options.method || "GET";
              requests.push({ url: String(url), method });
              if (String(url) === "/api/health") {
                return new Response(JSON.stringify({ ok: true }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" }
                });
              }
              if (method === "PUT" && String(url).startsWith("/api/files/")) {
                return new Response(JSON.stringify({
                  ok: true,
                  name: "editor--asset-cache.png",
                  fileUrl: "/api/files/editor--asset-cache.png",
                  mime: "image/png",
                  size: 16
                }), { status: 200, headers: { "Content-Type": "application/json" } });
              }
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            };

            const remote = await import("./js/core/remote.js");
            await remote.init();
            const { state } = await import("./js/core/store.js");
            const { replaceAssetBlob, removeAsset, urlFor } = await import(
              "./js/domain/assets.js?asset-url-revision"
            );

            const asset = {
              id: "asset-cache",
              ownerId: "editor",
              accountId: "account-one",
              name: "batch-card.png",
              type: "图片",
              tags: ["站内生成"],
              createdAt: 1000,
              contentHash: "initial-hash",
              hasBlob: true,
              storage: "server",
              serverFileName: "editor--asset-cache.png",
              fileUrl: "/api/files/editor--asset-cache.png",
              url: "/api/files/editor--asset-cache.png"
            };
            state.ui.currentMemberId = "editor";
            state.assets = [asset];

            const initialUrl = urlFor(asset);
            await replaceAssetBlob(asset.id, "data:image/png;base64,aW1hZ2Utb25l");
            const firstUrl = urlFor(asset);
            const firstStableUrl = urlFor(asset);
            const firstHash = asset.contentHash;
            const firstRevision = asset.blobUpdatedAt;
            const idAfterFirst = asset.id;
            const countAfterFirst = state.assets.length;

            await replaceAssetBlob(asset.id, "data:image/png;base64,aW1hZ2UtdHdv");
            const secondUrl = urlFor(asset);
            const secondStableUrl = urlFor(asset);
            const secondHash = asset.contentHash;
            const secondRevision = asset.blobUpdatedAt;
            const idAfterSecond = asset.id;
            const countAfterSecond = state.assets.length;

            await replaceAssetBlob(asset.id, "data:image/png;base64,aW1hZ2UtdHdv");
            const thirdUrl = urlFor(asset);
            const thirdHash = asset.contentHash;
            const thirdRevision = asset.blobUpdatedAt;

            await removeAsset(asset.id);
            const deleteRequests = requests.filter(item => item.method === "DELETE");

            console.log(JSON.stringify({
              initialUrl,
              firstUrl,
              firstStableUrl,
              secondUrl,
              secondStableUrl,
              thirdUrl,
              firstHash,
              secondHash,
              thirdHash,
              firstRevision,
              secondRevision,
              thirdRevision,
              idAfterFirst,
              idAfterSecond,
              countAfterFirst,
              countAfterSecond,
              deleteRequests
            }));
            """
        )

        self.assertNotEqual(result["initialUrl"], result["firstUrl"])
        self.assertNotEqual(result["firstUrl"], result["secondUrl"])
        self.assertNotEqual(result["secondUrl"], result["thirdUrl"])
        self.assertEqual(result["firstUrl"], result["firstStableUrl"])
        self.assertEqual(result["secondUrl"], result["secondStableUrl"])
        self.assertNotEqual(result["firstHash"], result["secondHash"])
        self.assertEqual(result["secondHash"], result["thirdHash"])
        self.assertGreater(result["secondRevision"], result["firstRevision"])
        self.assertGreater(result["thirdRevision"], result["secondRevision"])
        self.assertEqual(result["idAfterFirst"], "asset-cache")
        self.assertEqual(result["idAfterSecond"], "asset-cache")
        self.assertEqual(result["countAfterFirst"], 1)
        self.assertEqual(result["countAfterSecond"], 1)
        self.assertEqual(
            result["deleteRequests"],
            [
                {"url": "/api/db/assets/asset-cache", "method": "DELETE"},
                {"url": "/api/files/editor--asset-cache.png", "method": "DELETE"},
            ],
        )

    def test_existing_query_and_hash_are_preserved_and_external_url_is_untouched(self):
        result = self.run_node(
            """
            globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
            globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
            globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
            globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

            const { urlFor } = await import("./js/domain/assets.js?asset-url-query");
            const managed = {
              id: "managed",
              storage: "server",
              serverFileName: "editor--managed.png",
              fileUrl: "/api/files/editor--managed.png?download=1#preview",
              createdAt: 1234,
              contentHash: "bl-managed"
            };
            const external = {
              id: "external",
              fileUrl: "https://cdn.example.com/picture.png?signature=abc#preview",
              createdAt: 1234,
              contentHash: "external-hash"
            };
            const localData = {
              id: "local-data",
              dataUrl: "data:image/png;base64,YWJj"
            };
            const managedFirst = urlFor(managed);
            const managedSecond = urlFor(managed);
            const parsed = new URL(managedFirst, location.origin);
            console.log(JSON.stringify({
              managedFirst,
              managedSecond,
              download: parsed.searchParams.get("download"),
              revision: parsed.searchParams.get("asset_rev"),
              hash: parsed.hash,
              external: urlFor(external),
              localData: urlFor(localData)
            }));
            """
        )

        self.assertEqual(result["managedFirst"], result["managedSecond"])
        self.assertEqual(result["download"], "1")
        self.assertTrue(result["revision"])
        self.assertEqual(result["hash"], "#preview")
        self.assertEqual(
            result["external"],
            "https://cdn.example.com/picture.png?signature=abc#preview",
        )
        self.assertEqual(result["localData"], "data:image/png;base64,YWJj")


if __name__ == "__main__":
    unittest.main()
