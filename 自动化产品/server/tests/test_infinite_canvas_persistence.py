import json
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CANVAS_ROOT = ROOT / "apps" / "infinite-canvas-source"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "infinite_canvas_v92_storage.json"


def test_v92_fixture_contains_two_complete_projects():
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    state = payload["state"]
    assert payload["version"] == 2
    assert len(state["projects"]) >= 2
    assert set(state["itemsByProject"]) == {project["id"] for project in state["projects"]}
    assert set(state["messagesByProject"]) == set(state["itemsByProject"])
    assert set(state["viewportByProject"]) == set(state["itemsByProject"])
    items = [item for group in state["itemsByProject"].values() for item in group]
    assert any(item["type"] == "reference" and item["assetUrl"].startswith("data:image/") for item in items)
    assert any(item["type"] == "generation" and item["assetUrl"].startswith("data:image/") for item in items)


def test_uid_survives_http_crypto_without_random_uuid():
    module = (CANVAS_ROOT / "src" / "lib" / "util.ts").resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const util = await import({json.dumps(module)});
        const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
        try {{
          Object.defineProperty(globalThis, "crypto", {{
            configurable: true,
            value: {{
              randomUUID: undefined,
              getRandomValues(values) {{
                values[0] = 123456;
                values[1] = 789012;
                return values;
              }},
            }},
          }});
          assert.match(util.uid("http"), /^http_[a-z0-9]+$/);
          Object.defineProperty(globalThis, "crypto", {{
            configurable: true,
            value: {{ randomUUID: "not-a-function" }},
          }});
          assert.match(util.uid("fallback"), /^fallback_[a-z0-9]+$/);
        }} finally {{
          if (original) Object.defineProperty(globalThis, "crypto", original);
          else delete globalThis.crypto;
        }}
        """
    )
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=CANVAS_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_canvas_thumbnail_selection_matches_home_and_persistence_rules():
    module = (CANVAS_ROOT / "src" / "lib" / "canvasPersistence.ts").resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const persistence = await import({json.dumps(module)});
        const base = {{
          projectId: "p", position: {{ x: 0, y: 0 }},
          size: {{ width: 10, height: 10 }}, z: 1, createdAt: 1,
        }};
        const items = [
          {{ ...base, id: "hidden", type: "reference", hidden: true, assetUrl: "/hidden.png" }},
          {{ ...base, id: "visible-ref", type: "reference", assetUrl: "/visible.png" }},
          {{ ...base, id: "result", type: "generation", assetUrl: "/result.png", loading: false }},
        ];
        assert.equal(persistence.selectCanvasThumbnailUrl(items), "/result.png");
        assert.equal(
          persistence.selectCanvasThumbnailUrl([items[0]]),
          "/hidden.png",
          "hidden reference remains the final thumbnail fallback",
        );
        assert.equal(
          persistence.selectPersistentCanvasThumbnailUrl([
            {{ ...base, id: "data", type: "reference", assetUrl: "data:image/png;base64,AA==" }},
          ]),
          undefined,
          "large data URLs must not enter the localStorage summary",
        );
        assert.equal(
          persistence.selectPersistentCanvasThumbnailUrl([], "/api/custom-canvas/blobs/abc"),
          "/api/custom-canvas/blobs/abc",
        );
        """
    )
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=CANVAS_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_real_v92_two_phase_migration_and_empty_read_recovery():
    module = (CANVAS_ROOT / "src" / "lib" / "canvasPersistence.ts").resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        import {{ readFileSync }} from "node:fs";

        const fixture = JSON.parse(readFileSync({json.dumps(str(FIXTURE))}, "utf8"));
        const values = new Map();
        let blockBackup = false;
        let blockManifest = false;
        globalThis.window = {{ name: JSON.stringify({{
          kind: "xingzhen-canvas-bootstrap",
          storageNamespace: "fixture-member-a",
        }}) }};
        globalThis.localStorage = {{
          getItem(key) {{ return values.has(key) ? values.get(key) : null; }},
          setItem(key, value) {{
            if (blockBackup && key.endsWith(":legacy-backup")) throw new DOMException("quota", "QuotaExceededError");
            if (blockManifest && key.endsWith(":migration-v1")) throw new DOMException("quota", "QuotaExceededError");
            values.set(key, String(value));
          }},
          removeItem(key) {{ values.delete(key); }},
          clear() {{ values.clear(); }},
          key() {{ return null; }},
          get length() {{ return values.size; }},
        }};

        const records = new Map();
        let storeCreated = false;
        function complete(tx) {{ setTimeout(() => tx.oncomplete?.(), 0); }}
        const db = {{
          objectStoreNames: {{ contains() {{ return storeCreated; }} }},
          createObjectStore() {{ storeCreated = true; return {{}}; }},
          close() {{}},
          transaction() {{
            const tx = {{ oncomplete: null, onerror: null, onabort: null, error: null }};
            tx.objectStore = () => ({{
              put(value, key) {{ records.set(key, structuredClone(value)); complete(tx); }},
              delete(key) {{ records.delete(key); complete(tx); }},
              get(key) {{
                const request = {{ result: undefined, error: null, onsuccess: null, onerror: null }};
                setTimeout(() => {{
                  request.result = records.has(key) ? structuredClone(records.get(key)) : undefined;
                  request.onsuccess?.();
                  complete(tx);
                }}, 0);
                return request;
              }},
            }});
            return tx;
          }},
        }};
        globalThis.indexedDB = {{
          open() {{
            const request = {{ result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }};
            queueMicrotask(() => {{
              if (!storeCreated) request.onupgradeneeded?.();
              request.onsuccess?.();
            }});
            return request;
          }},
        }};

        const persistence = await import({json.dumps(module)});
        const raw = JSON.stringify(fixture);
        values.set(persistence.CANVAS_STORAGE_KEY, raw);
        const summaryRaw = await persistence.migrateLegacyCanvasEnvelope(persistence.CANVAS_STORAGE_KEY, raw);
        const summary = JSON.parse(summaryRaw);
        assert.equal(values.get(persistence.CANVAS_LEGACY_BACKUP_KEY), raw, "backup must be exact and durable");
        assert.deepEqual(summary.state.itemsByProject, {{}});
        assert.deepEqual(summary.state.messagesByProject, {{}});
        assert.deepEqual(summary.state.viewportByProject, {{}});
        assert.ok(values.has(persistence.CANVAS_MIGRATION_KEY), "migration manifest must be durable");

        for (const project of fixture.state.projects) {{
          const stored = await persistence.readCanvasProject(project.id);
          assert.ok(stored, `missing IDB record for ${{project.id}}`);
          assert.deepEqual(stored.state.items, fixture.state.itemsByProject[project.id]);
          assert.deepEqual(stored.state.messages, fixture.state.messagesByProject[project.id]);
          assert.deepEqual(stored.state.viewport, fixture.state.viewportByProject[project.id]);
        }}

        // Re-running an interrupted migration must not replace a canonical
        // server record with the older full local envelope.
        const canonical = structuredClone((await persistence.readCanvasProject("fixture-project-a")).state);
        canonical.messages.push({{
          id: "server-canonical-message",
          role: "agent",
          text: "server canonical",
          createdAt: 1784300999999,
        }});
        await persistence.writeCanvasProjectVerified("fixture-project-a", canonical, {{
          allowEmpty: true,
          source: "server",
        }});
        await persistence.migrateLegacyCanvasEnvelope(persistence.CANVAS_STORAGE_KEY, raw);
        assert.equal(
          (await persistence.readCanvasProject("fixture-project-a")).state.messages.at(-1).id,
          "server-canonical-message",
        );

        // Reproduce the production symptom: project summaries survive while IDB is empty.
        for (const project of fixture.state.projects) await persistence.deleteCanvasProjectState(project.id);
        assert.equal(await persistence.readCanvasProject("fixture-project-a"), null);
        const recovered = persistence.readLegacyCanvasProject("fixture-project-a");
        assert.ok(recovered, "empty IDB must fall back to the owner-scoped legacy backup");
        await persistence.writeCanvasProjectVerified("fixture-project-a", recovered, {{
          allowEmpty: false,
          source: "legacy",
        }});
        assert.deepEqual((await persistence.readCanvasProject("fixture-project-a")).state, recovered);

        await assert.rejects(
          persistence.writeCanvasProjectVerified("unrecovered", {{ items: [], messages: [] }}, {{ allowEmpty: false }}),
          /阻止空数据覆盖/,
        );

        // A viewport-only record is an ambiguous shell, not confirmed user
        // content. Only an explicit new/server-authoritative empty draft may
        // become a trusted empty checkpoint.
        const viewportShell = {{
          items: [],
          messages: [],
          viewport: {{ x: 120, y: -40, zoom: 0.8 }},
        }};
        assert.equal(persistence.isCanvasProjectEmpty(viewportShell), true);
        await persistence.writeCanvasProjectVerified("viewport-shell", viewportShell, {{
          allowEmpty: true,
          source: "local",
        }});
        assert.equal((await persistence.readCanvasProject("viewport-shell")).confirmedEmpty, false);
        await persistence.writeCanvasProjectVerified("explicit-empty", viewportShell, {{
          allowEmpty: true,
          confirmEmpty: true,
          source: "server",
          dirty: false,
          clientUpdatedAt: 200,
          serverRevision: 1,
        }});
        assert.equal((await persistence.readCanvasProject("explicit-empty")).confirmedEmpty, true);

        // Browser B with a clean revision-1 cache must install browser A's
        // newer server revision instead of uploading the stale image set.
        const browserBOld = structuredClone(recovered);
        await persistence.writeCanvasProjectVerified("cross-browser", browserBOld, {{
          allowEmpty: false,
          source: "server",
          dirty: false,
          clientUpdatedAt: 100,
          serverRevision: 1,
        }});
        const browserBRead = await persistence.readCanvasProject("cross-browser");
        assert.equal(
          persistence.decideCanvasServerReconciliation(browserBRead, 2, 200),
          "install-server",
        );
        const browserANewer = structuredClone(browserBOld);
        browserANewer.items.push({{
          id: "browser-a-new-image",
          type: "generation",
          position: {{ x: 10, y: 20 }},
          size: {{ width: 320, height: 320 }},
          z: 9,
          assetUrl: "/uploads/browser-a-new.png",
        }});
        await persistence.writeCanvasProjectVerified("cross-browser", browserANewer, {{
          allowEmpty: false,
          source: "server",
          dirty: false,
          clientUpdatedAt: 200,
          serverRevision: 2,
        }});
        const installed = await persistence.readCanvasProject("cross-browser");
        assert.equal(installed.state.items.at(-1).id, "browser-a-new-image");
        assert.equal(installed.serverRevision, 2);
        assert.equal(installed.dirty, false);
        await persistence.writeCanvasProjectVerified("cross-browser-dirty", browserBOld, {{
          allowEmpty: false,
          source: "local",
          dirty: true,
          clientUpdatedAt: 250,
          serverRevision: 1,
        }});
        assert.equal(
          persistence.decideCanvasServerReconciliation(
            await persistence.readCanvasProject("cross-browser-dirty"),
            2,
            200,
          ),
          "keep-local-dirty",
        );

        async function runCanonicalRace(projectId, source) {{
          const baseline = structuredClone(browserBOld);
          await persistence.writeCanvasProjectVerified(projectId, baseline, {{
            allowEmpty: false,
            source,
            dirty: source !== "server",
            clientUpdatedAt: 100,
            serverRevision: 1,
          }});
          let generation = 0;
          const expectedGeneration = generation;
          let release;
          const response = new Promise((resolve) => {{ release = resolve; }});
          const install = (async () => {{
            const canonical = await response;
            const latest = await persistence.readCanvasProject(projectId);
            if (!persistence.canInstallCanvasCanonical(
              expectedGeneration,
              generation,
              100,
              latest,
            )) return false;
            await persistence.writeCanvasProjectVerified(projectId, canonical, {{
              allowEmpty: false,
              source: "server",
              dirty: false,
              clientUpdatedAt: 150,
              serverRevision: 2,
            }});
            return true;
          }})();
          const edited = structuredClone(baseline);
          edited.items.push({{
            id: `${{projectId}}-new-node`,
            type: "generation",
            position: {{ x: 30, y: 40 }},
            size: {{ width: 280, height: 280 }},
            z: 10,
            assetUrl: `/uploads/${{projectId}}-new.png`,
          }});
          generation += 1;
          await persistence.writeCanvasProjectVerified(projectId, edited, {{
            allowEmpty: false,
            source: "local",
            dirty: true,
            clientUpdatedAt: 200,
            serverRevision: 1,
          }});
          release(baseline);
          assert.equal(await install, false);
          assert.equal(
            (await persistence.readCanvasProject(projectId)).state.items.at(-1).id,
            `${{projectId}}-new-node`,
          );
        }}
        // Cover both a delayed canonical GET and a delayed migration PUT
        // response: neither may erase a node created while the request waits.
        await runCanonicalRace("canonical-get-race", "server");
        await runCanonicalRace("migration-put-race", "legacy");

        // Re-running the legacy splitter must not replace a newer verified
        // dirty checkpoint with the older full localStorage envelope.
        const newerDirty = {{
          items: structuredClone(fixture.state.itemsByProject["fixture-project-b"]),
          messages: [
            ...structuredClone(fixture.state.messagesByProject["fixture-project-b"]),
            {{
              id: "newer-dirty-message",
              role: "user",
              text: "浏览器内尚未同步的新编辑",
              createdAt: 1784301501000,
            }},
          ],
          viewport: structuredClone(fixture.state.viewportByProject["fixture-project-b"]),
        }};
        await persistence.writeCanvasProjectVerified("fixture-project-b", newerDirty, {{
          allowEmpty: false,
          source: "local",
          dirty: true,
          clientUpdatedAt: 1784301501000,
          serverRevision: 3,
        }});
        await persistence.migrateLegacyCanvasEnvelope(persistence.CANVAS_STORAGE_KEY, raw);
        assert.equal(
          (await persistence.readCanvasProject("fixture-project-b")).state.messages.at(-1).id,
          "newer-dirty-message",
        );

        // A volatile/memory-only manifest is not enough to summarize the old
        // full payload. Keep the original key intact when manifest durability
        // cannot be verified.
        values.clear();
        records.clear();
        storeCreated = false;
        values.set(persistence.CANVAS_STORAGE_KEY, raw);
        blockManifest = true;
        const manifestRetained = await persistence.migrateLegacyCanvasEnvelope(
          persistence.CANVAS_STORAGE_KEY,
          raw,
        );
        assert.equal(manifestRetained, raw);
        assert.equal(values.get(persistence.CANVAS_STORAGE_KEY), raw);
        assert.equal(values.get(persistence.CANVAS_LEGACY_BACKUP_KEY), raw);
        assert.equal(values.has(persistence.CANVAS_MIGRATION_KEY), false);
        assert.match(persistence.getCanvasPersistenceWarning(), /迁移进度/);
        blockManifest = false;

        // Large base64 backup over quota: original full key must remain untouched.
        values.clear();
        records.clear();
        storeCreated = false;
        values.set(persistence.CANVAS_STORAGE_KEY, raw);
        blockBackup = true;
        const retained = await persistence.migrateLegacyCanvasEnvelope(persistence.CANVAS_STORAGE_KEY, raw);
        assert.equal(retained, raw);
        assert.equal(values.get(persistence.CANVAS_STORAGE_KEY), raw);
        assert.equal(values.has(persistence.CANVAS_LEGACY_BACKUP_KEY), false);
        assert.match(persistence.getCanvasPersistenceWarning(), /空间不足/);
        """
    )
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=CANVAS_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_client_contract_gates_empty_canvas_and_matches_server_proxy():
    persistence = (CANVAS_ROOT / "src" / "lib" / "canvasPersistence.ts").read_text(encoding="utf-8")
    sync = (CANVAS_ROOT / "src" / "lib" / "canvasSync.ts").read_text(encoding="utf-8")
    store = (CANVAS_ROOT / "src" / "lib" / "store.ts").read_text(encoding="utf-8")
    project_client = (
        CANVAS_ROOT / "src" / "components" / "workspace" / "ProjectClient.tsx"
    ).read_text(encoding="utf-8")

    assert "getAllKeys" not in persistence
    assert "legacy-backup" in persistence
    assert "writeCanvasProjectVerified" in persistence
    assert "readback = await readCanvasProject" in persistence
    assert 'platformFetch("/projects"' in sync
    assert 'platformFetch(`/projects/${encodeURIComponent(sourceId)}`' in sync
    assert 'method: "GET"' in sync
    assert 'method: "PUT"' in sync
    assert 'method: "DELETE"' in sync
    for field in ("project", "items", "messages", "viewport", "clientUpdatedAt", "baseRevision", "migration"):
        assert f"{field}:" in sync
    assert "payload.detail" in sync
    assert "Object.keys(viewport).length === 0" in sync
    assert "putChains" in sync
    assert "Evaluate lazily after the preceding request settles" in sync
    assert "putEpochs" in sync
    assert "writeDurableCanvasValue" in sync
    assert "concurrentlyQueued" in sync
    assert "queueCanvasProjectDelete(sourceId: string): boolean" in sync
    assert 'migration: true' in store
    assert "baseRevision: state.serverRevisionByProject[projectId]" in store
    migration_branch = store.split(
        "Complete every legacy migration through the idempotent server", 1
    )[1].split("for (const serverProject of remote.items)", 1)[0]
    assert "const local = await readCanvasProject(projectId)" in migration_branch
    assert "const result = await putCanvasProject(projectId" in migration_branch
    assert "migration: true" in migration_branch
    assert "await applyCanonical(projectId, result, {" in migration_branch
    assert "decideCanvasServerReconciliation" in store
    assert "removeServerTombstonedProject(projectId)" in store
    assert "cancelCanvasProjectPut(projectId)" in store
    assert "deleteCanvasProjectState(projectId)" in store
    assert "if (!queueCanvasProjectDelete(id))" in store
    assert "confirmEmpty: true" in store
    assert "未确认的空画布" in store
    assert "serverRefreshRequiredProjects" in store
    assert "stageServerSummary(serverProject)" in store
    clean_reconciliation = store.split(
        'if (decision === "install-server")', 1
    )[1].split("addItem: (projectId, item)", 1)[0]
    assert "stageServerSummary(serverProject, {" in clean_reconciliation
    assert "requiresRefresh: false" in clean_reconciliation
    assert 'projectLoadState[projectId] !== "ready"' in store
    assert "已阻止空画布写入" in store
    assert "重试恢复" in project_client
    assert 'loadState === "ready"' in project_client
    assert "<Workspace projectId={projectId} />" in project_client
