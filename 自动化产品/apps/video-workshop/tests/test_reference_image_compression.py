import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import media
from app.pipeline import VideoPipeline


class ReferenceImageCompressionTest(unittest.IsolatedAsyncioTestCase):
    async def test_large_reference_uses_cached_copy_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "large-reference.png"
            source.write_bytes(b"original" * 200_000)
            original_size = source.stat().st_size

            async def fake_run(command, cwd=None):
                Path(command[-1]).write_bytes(b"jpeg" * 100)
                return None

            with (
                patch.object(media, "run", new=fake_run),
                patch.object(media, "_binary", return_value="ffmpeg"),
            ):
                output = await media.compress_image_for_provider(
                    source, root / "cache", max_bytes=1024
                )

            self.assertNotEqual(source, output)
            self.assertTrue(output.is_file())
            self.assertLessEqual(output.stat().st_size, 1024)
            self.assertEqual(original_size, source.stat().st_size)
            self.assertTrue(source.read_bytes().startswith(b"original"))

    async def test_final_reference_set_shares_one_request_budget(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            items = []
            for index in range(8):
                path = root / f"reference-{index}.png"
                path.write_bytes(b"image")
                items.append({"path": str(path), "label": f"参考{index}"})

            with patch(
                "app.pipeline.compress_image_for_provider",
                new=AsyncMock(side_effect=lambda source, _cache, **_kwargs: source),
            ) as compress:
                result = await VideoPipeline._budget_static_reference_images(
                    items,
                    root / "work",
                )

            self.assertEqual(len(result), 8)
            self.assertEqual(compress.await_count, 8)
            self.assertEqual(
                {call.kwargs["max_bytes"] for call in compress.await_args_list},
                {5_500_000 // 8},
            )


if __name__ == "__main__":
    unittest.main()
