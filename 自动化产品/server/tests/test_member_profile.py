import tempfile
import unittest
from pathlib import Path

from server import store


class MemberProfileStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "profile.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_member_avatar_is_public_to_admin_member_list_and_keeps_role(self):
        member = store.add_member("创作者甲", "creator-a", "123456", "editor")
        updated = store.update_member(member[0], name="创作者乙", avatar_url="/api/member-avatars/member-avatar-test.png")
        public = store.member_public(updated)
        self.assertEqual("创作者乙", public["name"])
        self.assertEqual("editor", public["role"])
        self.assertEqual("/api/member-avatars/member-avatar-test.png", public["avatarUrl"])
        listed = next(item for item in store.list_members() if item["id"] == member[0])
        self.assertEqual(public["avatarUrl"], listed["avatarUrl"])


if __name__ == "__main__":
    unittest.main()
