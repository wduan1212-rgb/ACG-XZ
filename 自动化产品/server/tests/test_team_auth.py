import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import store


class TeamAuthorizationStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "team-auth.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _admin(self):
        return store.get_member_by_username(store.DEFAULT_ADMIN_USERNAME)

    def test_new_personal_user_only_has_base_features_and_no_team_accounts(self):
        admin = self._admin()
        store.upsert_member_collection(admin[0], "admin", "accounts", [{
            "id": "account-acg",
            "name": "ACG 内容账号",
            "platform": "小红书",
            "updatedAt": 100,
        }])
        personal = store.add_member("个人用户", "personal-user", "123456", "user")
        public = store.member_public(personal)
        self.assertIsNone(public["team"])
        self.assertEqual("personal", public["plan"])
        self.assertEqual(set(store.PERSONAL_FEATURES), set(public["entitlements"]))
        self.assertEqual(
            {"home", "video_workshop", "canvas", "voice", "assets", "profile", "team_join"},
            set(public["entitlements"]),
        )

        snapshot = store.state_for(personal[0], "user")
        self.assertEqual([], snapshot["accounts"])
        self.assertEqual([], snapshot["products"])

        store.upsert_member_assets(personal[0], "user", [{
            "id": "personal-video-output",
            "name": "我的视频工坊成片",
            "type": "视频",
            "tags": ["个人资产", "视频工坊", "生成成片"],
            "createdAt": 200,
        }])
        personal_assets = store.state_for(
            personal[0], "user", collections=["assets"]
        )["assets"]
        self.assertEqual(
            ["personal-video-output"],
            [item["id"] for item in personal_assets],
        )

    def test_team_join_requires_request_and_manager_approval(self):
        owner = self._admin()
        personal = store.add_member("申请加入者", "join-user", "123456", "user")
        request, error = store.add_team_join_request(
            personal[0], store.INTERNAL_TEAM_NAME, "申请加入市场部"
        )
        self.assertIsNone(error)
        self.assertEqual("pending", request["status"])
        listed = store.list_team_join_requests(owner[0], "pending")
        self.assertEqual([request["id"]], [item["id"] for item in listed])

        approved, error = store.review_team_join_request(
            request["id"], owner[0], True
        )
        self.assertIsNone(error)
        self.assertEqual("editor", approved["role"])
        self.assertEqual(store.INTERNAL_TEAM_ID, approved["teamId"])
        self.assertEqual("creator", approved["teamRole"])
        self.assertEqual(set(store.TEAM_FEATURES), set(approved["entitlements"]))

    def test_internal_owner_membership_is_repaired_after_migration_marker_exists(self):
        owner = self._admin()
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "DELETE FROM team_members WHERE team_id=? AND member_id=?",
                    (store.INTERNAL_TEAM_ID, owner[0]),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO meta(k,v) "
                    "VALUES('internal_team_members_migrated_v1','already-ran')"
                )
                store._ensure_internal_team_locked(conn)
                conn.commit()
            finally:
                conn.close()

        repaired = store.member_public(store.get_member(owner[0]))
        self.assertEqual(store.INTERNAL_TEAM_ID, repaired["teamId"])
        self.assertEqual(store.INTERNAL_TEAM_NAME, repaired["team"]["name"])
        self.assertEqual("owner", repaired["teamRole"])
        self.assertEqual("team-pro", repaired["plan"])
        self.assertEqual(set(store.TEAM_FEATURES), set(repaired["entitlements"]))

    def test_internal_team_is_team_pro_unlimited_and_public_plan_matches(self):
        owner = self._admin()
        team = store.member_team(owner[0])
        self.assertEqual("team-pro", team["plan"])
        self.assertEqual("unlimited", team["quotaMode"])
        public = store.member_public(owner)
        self.assertEqual("team-pro", public["plan"])

    def test_personal_daily_quota_resets_per_day_and_deduction_is_idempotent(self):
        personal = store.add_member("每日额度用户", "daily-user", "123456", "user")
        day_one = 1_800_000_000_000
        initial = store.personal_daily_quota(personal[0], day_one)
        self.assertEqual(70, initial["limit"])
        self.assertEqual(70, initial["remaining"])
        first, error = store.deduct_personal_daily_points(
            personal[0], 12, "图片生成", "job-fixed-id", day_one
        )
        self.assertIsNone(error)
        self.assertEqual(58, first["remaining"])
        repeated, error = store.deduct_personal_daily_points(
            personal[0], 12, "图片生成", "job-fixed-id", day_one
        )
        self.assertIsNone(error)
        self.assertTrue(repeated["reused"])
        self.assertEqual(58, repeated["remaining"])
        next_day = store.personal_daily_quota(personal[0], day_one + 24 * 60 * 60 * 1000)
        self.assertEqual(70, next_day["remaining"])
        too_much, error = store.deduct_personal_daily_points(
            personal[0], 71, "图片生成", "job-too-much", day_one + 24 * 60 * 60 * 1000
        )
        self.assertEqual("insufficient_points", error)
        self.assertEqual(70, too_much["remaining"])

    def test_external_team_capacity_blocks_approval_but_internal_team_is_unlimited(self):
        owner = self._admin()
        external_owner = store.add_member("外部团队所有者", "external-owner", "123456", "editor")
        capacity_members = [
            store.add_member(f"容量成员{index}", f"capacity-member-{index}", "123456", "editor")
            for index in range(4)
        ]
        now = int(time.time() * 1000)
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)",
                    ("team-capacity", "容量团队", "capacity-team", "customer", "active", "team", "metered", now, external_owner[0]),
                )
                conn.execute(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) VALUES(?,?,?,?,?,?)",
                    ("team-capacity", external_owner[0], "owner", "active", now, external_owner[0]),
                )
                for member in capacity_members:
                    conn.execute(
                        "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) VALUES(?,?,?,?,?,?)",
                        ("team-capacity", member[0], "creator", "active", now, external_owner[0]),
                    )
                conn.commit()
            finally:
                conn.close()
        applicant = store.add_member("容量申请人", "capacity-applicant", "123456", "user")
        request, error = store.add_team_join_request(applicant[0], "容量团队", "申请加入")
        self.assertIsNone(error)
        approved, error = store.review_team_join_request(request["id"], external_owner[0], True)
        self.assertIsNone(approved)
        self.assertEqual("team_full", error)

        internal_applicant = store.add_member("内部申请人", "internal-applicant", "123456", "user")
        request, error = store.add_team_join_request(internal_applicant[0], store.INTERNAL_TEAM_NAME, "申请加入")
        self.assertIsNone(error)
        approved, error = store.review_team_join_request(request["id"], owner[0], True)
        self.assertIsNone(error)
        self.assertEqual(store.INTERNAL_TEAM_ID, approved["teamId"])

    def test_internal_manager_platform_summary_exposes_no_credentials(self):
        personal = store.add_member("普通个人", "plain-personal", "123456", "user")
        summaries = store.list_platform_account_summaries()
        personal_summary = next(item for item in summaries["personal"] if item["id"] == personal[0])
        self.assertEqual("personal", personal_summary["category"])
        self.assertNotIn("pin", personal_summary)
        self.assertNotIn("hash", personal_summary)
        owner_ids = {item["id"] for item in summaries["teamOwners"]}
        self.assertIn(self._admin()[0], owner_ids)

    def test_team_supplier_login_identity_is_visible_without_exposing_or_reusing_hashes(self):
        owner = self._admin()
        supplier = store.add_member(
            "ACG 供应商管理员",
            "acg-supplier-admin",
            "old-secret",
            "supplier_parent",
        )
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                    "VALUES(?,?,?,?)",
                    (store.INTERNAL_TEAM_ID, supplier[0], int(time.time() * 1000), owner[0]),
                )
                conn.commit()
            finally:
                conn.close()

        identities = store.team_supplier_accounts(store.INTERNAL_TEAM_ID)
        identity = next(
            item for item in identities
            if item["username"] == "acg-supplier-admin"
        )
        self.assertEqual(supplier[0], identity["id"])
        self.assertNotIn("pin", identity)
        self.assertNotIn("hash", identity)

        reset = store.reset_team_supplier_pin(
            store.INTERNAL_TEAM_ID,
            supplier[0],
            "new-safe-secret",
        )
        self.assertEqual(supplier[0], reset["id"])
        stored = store.get_member(supplier[0])
        self.assertTrue(store.verify_pin("new-safe-secret", stored[3]))
        self.assertFalse(store.verify_pin("old-secret", stored[3]))
        self.assertIsNone(
            store.reset_team_supplier_pin("team-other", supplier[0], "blocked-secret")
        )

    def test_first_migration_only_adopts_preexisting_members_and_resources(self):
        conn = sqlite3.connect(store.DB_PATH)
        conn.executescript(store.SCHEMA)
        now = int(time.time() * 1000)
        members = [
            ("owner", "主管理员", store.DEFAULT_ADMIN_USERNAME, "hash", "admin", None, now),
            ("admin-2", "另一位管理员", "admin-two", "hash", "admin", None, now + 1),
            ("creator-1", "创作者", "creator-one", "hash", "editor", None, now + 2),
            ("supplier-1", "供应商", "supplier-one", "hash", "supplier_parent", None, now + 3),
        ]
        conn.executemany(
            "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            members,
        )
        conn.execute(
            "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            (
                "accounts", "account-old", "owner", now,
                json.dumps({"id": "account-old", "name": "既有账号"}),
            ),
        )
        store._ensure_internal_team_locked(conn)
        conn.commit()

        roles = dict(conn.execute(
            "SELECT member_id,team_role FROM team_members WHERE team_id=?",
            (store.INTERNAL_TEAM_ID,),
        ).fetchall())
        self.assertEqual("owner", roles["owner"])
        self.assertEqual("admin", roles["admin-2"])
        self.assertEqual("creator", roles["creator-1"])
        self.assertEqual(
            store.INTERNAL_TEAM_ID,
            conn.execute(
                "SELECT team_id FROM team_suppliers WHERE supplier_parent_id='supplier-1'"
            ).fetchone()[0],
        )
        self.assertEqual(
            store.INTERNAL_TEAM_ID,
            conn.execute(
                "SELECT team_id FROM team_accounts WHERE account_id='account-old'"
            ).fetchone()[0],
        )

        conn.execute(
            "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            ("supplier-later", "后建供应商", "supplier-later", "hash", "supplier_parent", None, now + 10),
        )
        conn.execute(
            "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            (
                "accounts", "account-later", "owner", now + 10,
                json.dumps({"id": "account-later", "name": "后建账号"}),
            ),
        )
        store._ensure_internal_team_locked(conn)
        conn.commit()
        self.assertIsNone(conn.execute(
            "SELECT team_id FROM team_suppliers WHERE supplier_parent_id='supplier-later'"
        ).fetchone())
        self.assertIsNone(conn.execute(
            "SELECT team_id FROM team_accounts WHERE account_id='account-later'"
        ).fetchone())
        conn.close()

    def test_team_account_visibility_and_management_are_tenant_scoped(self):
        owner = self._admin()
        store.upsert_member_collection(owner[0], "admin", "accounts", [{
            "id": "account-acg",
            "name": "ACG 账号",
            "platform": "视频号",
            "updatedAt": 100,
        }])
        external = store.add_member("外部团队管理员", "external-admin", "123456", "editor")
        now = int(time.time() * 1000)
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        "team-external", "外部团队", "external-team", "customer",
                        "active", "team", "metered", now, external[0],
                    ),
                )
                conn.execute(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                    "VALUES(?,?,?,?,?,?)",
                    ("team-external", external[0], "admin", "active", now, external[0]),
                )
                conn.commit()
            finally:
                conn.close()

        result = store.upsert_member_collection(external[0], "editor", "accounts", [{
            "id": "account-external",
            "name": "外部团队账号",
            "platform": "小红书",
            "updatedAt": 200,
        }])
        self.assertEqual(1, result["written"])
        external_snapshot = store.state_for(external[0], "editor")
        self.assertEqual(
            ["account-external"],
            [item["id"] for item in external_snapshot["accounts"]],
        )
        owner_snapshot = store.state_for(owner[0], "admin")
        self.assertEqual(
            ["account-acg"],
            [item["id"] for item in owner_snapshot["accounts"]],
        )

        store.upsert_member_collection(owner[0], "admin", "productions", [{
            "id": "production-acg",
            "accountId": "account-acg",
            "title": "ACG 生产记录",
            "stage": "draft",
            "updatedAt": 100,
        }])
        with self.assertRaises(PermissionError):
            store.upsert_member_collection(external[0], "editor", "accounts", [{
                "id": "account-acg",
                "name": "试图覆盖 ACG 账号",
                "platform": "视频号",
                "updatedAt": 300,
            }])
        with self.assertRaises(PermissionError):
            store.upsert_member_collection(external[0], "editor", "productions", [{
                "id": "production-acg",
                "accountId": "account-acg",
                "title": "试图覆盖 ACG 生产记录",
                "stage": "draft",
                "updatedAt": 300,
            }])
        with self.assertRaises(PermissionError):
            store.delete_member_doc(
                "accounts", "account-acg", external[0], "editor"
            )

    def test_verified_team_activation_and_owner_rename_are_atomic_and_scoped(self):
        personal = store.add_member("待升级用户", "future-team-owner", "123456", "user")
        activated, error = store.activate_customer_team_plan(
            personal[0], "未来内容团队", "team-pro"
        )
        self.assertIsNone(error)
        self.assertEqual("editor", activated["role"])
        self.assertEqual("owner", activated["teamRole"])
        self.assertEqual("未来内容团队", activated["team"]["name"])
        self.assertEqual("team-pro", activated["plan"])

        renamed, error = store.rename_team(personal[0], "未来品牌团队")
        self.assertIsNone(error)
        self.assertEqual("未来品牌团队", renamed["name"])
        self.assertEqual("owner", renamed["role"])

        repeated, error = store.activate_customer_team_plan(
            personal[0], "不应重复创建", "team"
        )
        self.assertIsNone(repeated)
        self.assertEqual("member_not_eligible", error)
        protected, error = store.rename_team(self._admin()[0], "不允许改名")
        self.assertIsNone(protected)
        self.assertEqual("internal_team_immutable", error)

    def test_assets_are_isolated_by_team_membership_with_legacy_acg_compatibility(self):
        acg_owner = self._admin()
        personal = store.add_member("个人资产用户", "asset-personal", "123456", "user")
        external_owner = store.add_member("外部所有者", "asset-team-owner", "123456", "user")
        activated, error = store.activate_customer_team_plan(
            external_owner[0], "资产隔离团队", "team"
        )
        self.assertIsNone(error)
        external_member = store.add_member("外部成员", "asset-team-member", "123456", "user")
        request, error = store.add_team_join_request(
            external_member[0], "资产隔离团队", "加入协作"
        )
        self.assertIsNone(error)
        approved, error = store.review_team_join_request(
            request["id"], external_owner[0], True
        )
        self.assertIsNone(error)
        self.assertEqual(activated["teamId"], approved["teamId"])

        store.upsert_member_assets(acg_owner[0], "admin", [{
            "id": "asset-acg-legacy", "name": "ACG 既有资产", "type": "图片",
        }])
        store.upsert_member_assets(personal[0], "user", [{
            "id": "asset-personal-private", "name": "个人私有资产", "type": "图片",
        }])
        store.upsert_member_assets(external_owner[0], "editor", [{
            "id": "asset-team-owner", "name": "团队所有者资产", "type": "图片",
        }])
        store.upsert_member_assets(external_member[0], "editor", [{
            "id": "asset-team-member", "name": "团队成员资产", "type": "图片",
        }])
        with self.assertRaises(PermissionError):
            store.upsert_member_assets(acg_owner[0], "admin", [{
                "id": "asset-team-member", "name": "试图跨团队覆盖", "type": "图片",
            }])

        ids_for = lambda member_id, role: {
            item["id"] for item in store.state_for(
                member_id, role, collections=["assets"]
            )["assets"]
        }
        self.assertEqual({"asset-acg-legacy"}, ids_for(acg_owner[0], "admin"))
        self.assertEqual({"asset-personal-private"}, ids_for(personal[0], "user"))
        expected_team_assets = {"asset-team-owner", "asset-team-member"}
        self.assertEqual(expected_team_assets, ids_for(external_owner[0], "editor"))
        self.assertEqual(expected_team_assets, ids_for(external_member[0], "editor"))


if __name__ == "__main__":
    unittest.main()
