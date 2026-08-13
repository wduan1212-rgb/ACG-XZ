import asyncio
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

    def test_shared_image_queue_never_rejects_a_creator_for_waiting(self):
        main_source = (ROOT / "server" / "main.py").read_text("utf-8")
        self.assertIn(
            'IMAGE_SUBMIT_CONCURRENCY = _positive_env_int("IMAGE_SUBMIT_CONCURRENCY", 2)',
            main_source,
        )
        queue_section = main_source.split("async def _bounded_submit_slot", 1)[1]
        queue_section = queue_section.split("def _image_submit_queue", 1)[0]
        self.assertIn("await queue.acquire()", queue_section)
        self.assertNotIn("asyncio.wait_for", queue_section)
        self.assertNotIn("image_queue_busy", main_source)

    def test_shared_image_queue_drains_all_waiters_at_provider_capacity(self):
        from server import main

        async def scenario():
            queue = asyncio.Semaphore(2)
            active = 0
            peak = 0
            completed = []

            async def worker(index):
                nonlocal active, peak
                async with main._bounded_submit_slot(queue):
                    active += 1
                    peak = max(peak, active)
                    await asyncio.sleep(0.01)
                    completed.append(index)
                    active -= 1

            await asyncio.gather(*(worker(index) for index in range(8)))
            return peak, completed

        peak, completed = asyncio.run(scenario())
        self.assertEqual(peak, 2)
        self.assertEqual(sorted(completed), list(range(8)))


if __name__ == "__main__":
    unittest.main()
