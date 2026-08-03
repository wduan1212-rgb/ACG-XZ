import unittest

from app.pipeline import (
    STATIC_IMAGE_POINTS,
    STATIC_TTS_POINTS_PER_100_CHARS,
    _static_billing_usage,
)


class StaticBillingUsageTest(unittest.TestCase):
    def test_static_usage_counts_new_images_and_ceil_tts_blocks(self):
        plan = {"narration": "字" * 201}
        usage = _static_billing_usage(
            plan,
            scene_image_count=4,
            continuity_image_count=2,
            tts_generated=True,
        )
        self.assertEqual(
            usage,
            {
                "sceneImageCount": 4,
                "continuityImageCount": 2,
                "imageCount": 6,
                "imagePoints": 6 * STATIC_IMAGE_POINTS,
                "ttsChars": 201,
                "ttsPoints": 3 * STATIC_TTS_POINTS_PER_100_CHARS,
                "totalPoints": (
                    6 * STATIC_IMAGE_POINTS
                    + 3 * STATIC_TTS_POINTS_PER_100_CHARS
                ),
                "rates": {
                    "image": STATIC_IMAGE_POINTS,
                    "ttsPer100Chars": STATIC_TTS_POINTS_PER_100_CHARS,
                },
            },
        )


    def test_reused_tts_is_not_charged_again(self):
        usage = _static_billing_usage(
            {"narration": "这段口播来自已经成功保存的旧文件"},
            scene_image_count=1,
            continuity_image_count=0,
            tts_generated=False,
        )
        self.assertEqual(usage["imagePoints"], STATIC_IMAGE_POINTS)
        self.assertEqual(usage["ttsChars"], 0)
        self.assertEqual(usage["ttsPoints"], 0)
        self.assertEqual(usage["totalPoints"], STATIC_IMAGE_POINTS)


if __name__ == "__main__":
    unittest.main()
