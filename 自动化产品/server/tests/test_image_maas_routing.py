import base64
import importlib
import sys
import unittest
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class ImageMaasRoutingTest(unittest.TestCase):
    def test_endpoint_depends_on_reference_images(self):
        configured = "maas-base/v1/aiart/gtimage"
        self.assertTrue(main._maas_endpoint_for_refs(configured, False).endswith("/aiart/gttext"))
        self.assertTrue(main._maas_endpoint_for_refs(configured, True).endswith("/aiart/gtimage"))

    def test_request_body_matches_expected_image_response(self):
        body = main._maas_image_body("测试提示词", "image-model", "3:4", [])
        self.assertEqual(body["response_format"], "b64_json")
        self.assertEqual(body["output_format"], "jpeg")
        self.assertEqual(body["logo_add"], 0)
        self.assertNotIn("images", body)

        ref_body = main._maas_image_body(
            "测试提示词",
            "image-model",
            "3:4",
            [("reference.jpg", b"jpeg-bytes", "image/jpeg")],
        )
        self.assertEqual(len(ref_body["images"]), 1)
        self.assertEqual(ref_body["input_fidelity"], "high")

    def test_base64_image_response_is_preserved(self):
        raw = b"jpeg-result"
        encoded = base64.b64encode(raw).decode("ascii")
        result = main._image_from_response({"data": [{"b64_json": encoded}]}, "image/jpeg")
        self.assertTrue(result.startswith("data:image/jpeg;base64,"))
        self.assertEqual(base64.b64decode(result.split(",", 1)[1]), raw)


if __name__ == "__main__":
    unittest.main()
