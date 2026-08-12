import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ProviderStartupRaceTests(unittest.TestCase):
    def test_batch_and_video_image_paths_recheck_provider_before_submit(self):
        providers = (ROOT / "js" / "api" / "providers.js").read_text("utf-8")
        orchestrator = (ROOT / "js" / "agent" / "orchestrator.js").read_text("utf-8")

        self.assertIn("export async function imageProviderReadyForSubmit()", providers)
        helper = providers.split("export async function imageProviderReadyForSubmit()", 1)[1]
        helper = helper.split("const DEFAULT_MAAS_IMAGE_ENDPOINT", 1)[0]
        self.assertIn("await refreshProviderStatus().catch(() => null)", helper)
        self.assertIn('const provider = activeProviderFor("image")', helper)
        self.assertNotIn('return registry.get("mock-image")', helper)

        for function_name in (
            "generateBatchImagesInHouse",
            "regenerateBatchImage",
            "generateCreativeVideoStoryboards",
            "generateStaticFrames",
        ):
            function_body = orchestrator.split(f"function {function_name}", 1)[1]
            function_body = function_body.split("\n}", 1)[0]
            self.assertIn(
                "await imageProviderReadyForSubmit()",
                function_body,
                f"{function_name} must not race the async image config probe",
            )

        self.assertNotIn(
            'if (!imageApiConfigured()) throw new Error("图片生成服务未配置，无法执行站内生图")',
            orchestrator,
        )

    def test_shared_image_queue_waits_for_a_normal_busy_provider_window(self):
        main_source = (ROOT / "server" / "main.py").read_text("utf-8")
        self.assertIn(
            'IMAGE_SUBMIT_QUEUE_WAIT_SECONDS = _positive_env_int("IMAGE_SUBMIT_QUEUE_WAIT_SECONDS", 120)',
            main_source,
        )
        self.assertIn('"providerCalled": False', main_source)


if __name__ == "__main__":
    unittest.main()
