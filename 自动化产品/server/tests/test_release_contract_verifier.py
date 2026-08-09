import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[2]
VERIFIER_PATH = APP_ROOT / "tools" / "verify_release_contracts.py"
SPEC = importlib.util.spec_from_file_location("release_contract_verifier", VERIFIER_PATH)
verifier = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verifier
SPEC.loader.exec_module(verifier)


class ReleaseContractVerifierTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def write(self, relative_path, content):
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        return path

    def make_canvas_manifest(self, files):
        entries = []
        for relative_path, content in files:
            self.write(f"vendor/infinite-canvas/{relative_path}", content)
            raw = content if isinstance(content, bytes) else content.encode("utf-8")
            entries.append(
                {
                    "path": relative_path,
                    "size": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                }
            )
        manifest = {
            "schemaVersion": 1,
            "basePath": "/XZ-Design",
            "fileCount": len(entries),
            "totalBytes": sum(entry["size"] for entry in entries),
            "files": entries,
        }
        self.write(
            "vendor/infinite-canvas.manifest.json",
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        )

    def make_runtime_manifest(self, release_id="test-release"):
        for relative in verifier.RUNTIME_EXACT_PATHS:
            self.write(relative, f"fixture for {relative}\n")
        for prefix, suffix in verifier.RUNTIME_PREFIX_RULES:
            name = f"fixture{suffix}" if suffix else "index.html"
            self.write(f"{prefix}/{name}", f"fixture for {prefix}\n")
        self.write(
            "apps/video-workshop/skills/video-production/references/workflow.md",
            "audited director workflow\n",
        )
        self.write(
            "apps/video-workshop/vendor/OpenMontage/tools/analysis/visual_qa.py",
            "class VisualQA: pass\n",
        )
        manifest = verifier.build_runtime_manifest_data(self.root, release_id)
        self.write(
            verifier.RUNTIME_MANIFEST_PATH.as_posix(),
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        )

    def test_esm_rejects_two_urls_for_one_physical_module(self):
        self.write(
            "index.html",
            '<script type="module" src="./js/main.js?v=release"></script>',
        )
        self.write(
            "js/main.js",
            'import "./first.js"; import "./second.js";',
        )
        self.write("js/first.js", 'import "./shared.js?v=one";')
        self.write("js/second.js", 'import "./shared.js?v=two";')
        self.write("js/shared.js", "export const value = 1;")

        result = verifier.verify_esm(self.root)

        self.assertFalse(result["ok"])
        self.assertEqual(["js/shared.js"], [item["module"] for item in result["conflicts"]])
        self.assertEqual(
            ["/js/shared.js?v=one", "/js/shared.js?v=two"],
            result["conflicts"][0]["identities"],
        )

    def test_esm_handles_regex_comments_and_nested_templates(self):
        self.write(
            "index.html",
            '<script src="./js/main.js?v=release" type="module"></script>',
        )
        self.write(
            "js/main.js",
            """
            // import("./ignored.js?v=comment")
            const matcher = /[&<>\"]/g;
            const markup = `<div>${items.map(item => `<b>${item}</b>`).join("")}</div>`;
            import "./shared.js";
            """,
        )
        self.write("js/shared.js", "export const value = 1;")

        result = verifier.verify_esm(self.root)

        self.assertTrue(result["ok"])
        self.assertEqual(2, result["reachableModules"])

    def test_esm_rejects_nonliteral_dynamic_imports(self):
        self.write(
            "index.html",
            '<script type="module" src="./js/main.js?v=release"></script>',
        )
        self.write("js/main.js", "const path = './feature.js'; import(path);")

        with self.assertRaisesRegex(verifier.ContractError, "literal string"):
            verifier.verify_esm(self.root)

    def test_esm_rejects_inline_module_entries(self):
        self.write(
            "index.html",
            """
            <script type="module">import "./js/inline.js";</script>
            <script type="module" src="./js/main.js?v=release"></script>
            """,
        )
        self.write("js/main.js", "export const main = true;")
        self.write("js/inline.js", "export const inline = true;")

        with self.assertRaisesRegex(verifier.ContractError, "inline type=module"):
            verifier.verify_esm(self.root)

    def test_esm_rejects_unbundled_nested_dependency(self):
        self.write(
            "index.html",
            '<script type="module" src="./js/main.js?v=release"></script>',
        )
        self.write("js/main.js", 'import "https://cdn.example.invalid/runtime.js";')

        with self.assertRaisesRegex(verifier.ContractError, "bundled and same-origin"):
            verifier.verify_esm(self.root)

    def test_esm_rejects_symlink_alias_before_resolution(self):
        self.write(
            "index.html",
            '<script type="module" src="./js/main.js?v=release"></script>',
        )
        self.write("js/main.js", 'import "./alias.js";')
        target = self.write("js/shared.js", "export const value = 1;")
        (self.root / "js" / "alias.js").symlink_to(target.name)

        with self.assertRaisesRegex(verifier.ContractError, "symlink"):
            verifier.verify_esm(self.root)

    def test_canvas_verifies_without_source_out_directory(self):
        self.make_canvas_manifest(
            [
                ("index.html", "<title>canvas</title>"),
                ("_next/static/chunks/app.js", b"console.log('canvas')"),
            ]
        )

        result = verifier.verify_canvas(self.root)

        self.assertTrue(result["ok"])
        self.assertEqual(2, result["fileCount"])
        self.assertFalse((self.root / "apps" / "infinite-canvas-source" / "out").exists())

    def test_canvas_rejects_content_not_matching_manifest(self):
        self.make_canvas_manifest([("index.html", "original")])
        self.write("vendor/infinite-canvas/index.html", "tampered")

        with self.assertRaisesRegex(verifier.ContractError, "SHA-256 mismatch"):
            verifier.verify_canvas(self.root)

    def test_runtime_manifest_rejects_wrong_release_and_tampered_backend(self):
        self.make_runtime_manifest("release-one")
        self.assertTrue(verifier.verify_runtime(self.root, "release-one")["ok"])

        with self.assertRaisesRegex(verifier.ContractError, "releaseId mismatch"):
            verifier.verify_runtime(self.root, "release-two")

        self.write("server/main.py", "tampered\n")
        with self.assertRaisesRegex(verifier.ContractError, "does not match manifest"):
            verifier.verify_runtime(self.root, "release-one")

    def test_runtime_manifest_covers_active_sidecar_skill_and_openmontage_code(self):
        self.make_runtime_manifest("release-one")
        active_paths = (
            "apps/video-workshop/skills/video-production/references/workflow.md",
            "apps/video-workshop/vendor/OpenMontage/tools/analysis/visual_qa.py",
        )
        for relative in active_paths:
            with self.subTest(relative=relative):
                path = self.root / relative
                original = path.read_bytes()
                path.write_bytes(original + b"tampered\n")
                with self.assertRaisesRegex(
                    verifier.ContractError, "does not match manifest"
                ):
                    verifier.verify_runtime(self.root, "release-one")
                path.write_bytes(original)
                self.assertTrue(
                    verifier.verify_runtime(self.root, "release-one")["ok"]
                )

    def test_runtime_rejects_symlink_in_intermediate_directory(self):
        self.make_runtime_manifest("release-one")
        server = self.root / "server"
        real_server = self.root / "server-real"
        server.rename(real_server)
        server.symlink_to(real_server.name, target_is_directory=True)

        with self.assertRaisesRegex(verifier.ContractError, "traverses a symlink"):
            verifier.verify_runtime(self.root, "release-one")

    def test_runtime_rejects_symlink_even_when_directory_name_is_ignored(self):
        self.make_runtime_manifest("release-one")
        target = self.root / "generated-cache"
        target.mkdir()
        (self.root / "apps/video-workshop/app/__pycache__").symlink_to(
            target, target_is_directory=True
        )

        with self.assertRaisesRegex(verifier.ContractError, "directory symlink"):
            verifier.verify_runtime(self.root, "release-one")

    def test_canvas_rejects_symlink_in_intermediate_directory(self):
        self.make_canvas_manifest([("index.html", "canvas")])
        vendor = self.root / "vendor"
        real_vendor = self.root / "vendor-real"
        vendor.rename(real_vendor)
        vendor.symlink_to(real_vendor.name, target_is_directory=True)

        with self.assertRaisesRegex(verifier.ContractError, "traverses a symlink"):
            verifier.verify_canvas(self.root)

    def test_repository_runtime_closure_excludes_tests_and_runtime_data(self):
        paths = verifier.runtime_release_files(APP_ROOT)
        path_set = set(paths)
        required = {
            "apps/video-workshop/skills/video-production/references/workflow.md",
            "apps/video-workshop/vendor/OpenMontage/tools/analysis/visual_qa.py",
        }
        self.assertTrue(required.issubset(path_set))
        for prefix in (
            "apps/video-workshop/app",
            "apps/video-workshop/web",
            "apps/video-workshop/skills/video-production",
            "apps/video-workshop/vendor/OpenMontage",
        ):
            for candidate in (APP_ROOT / prefix).rglob("*"):
                if not candidate.is_file() or candidate.suffix == ".pyc":
                    continue
                self.assertIn(candidate.relative_to(APP_ROOT).as_posix(), path_set)
        for path in paths:
            normalized = f"/{path}/"
            self.assertNotIn("/tests/", normalized)
            self.assertNotIn("/.venv/", normalized)
            self.assertNotIn("/outputs/", normalized)
            self.assertNotIn("/uploads/", normalized)
            self.assertNotIn("/data/projects/", normalized)

    def test_repository_phase0_contracts_pass(self):
        result = verifier.verify_all(APP_ROOT)

        self.assertTrue(result["ok"], result)
        self.assertGreaterEqual(result["esm"]["reachableModules"], 50)
        self.assertEqual(63, result["canvas"]["fileCount"])
        self.assertEqual(
            "20260809-v141-content-governance-2",
            result["runtime"]["releaseId"],
        )
        self.assertGreaterEqual(result["runtime"]["fileCount"], 45)


if __name__ == "__main__":
    unittest.main()
