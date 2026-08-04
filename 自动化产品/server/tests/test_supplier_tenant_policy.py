import importlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SERVER_DIR = Path(__file__).resolve().parents[1]
TEST_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


def provision_supplier_team(store, suffix):
    owner = store.add_member(
        f"{suffix} owner", f"tenant_owner_{suffix}", "local-test-pin", "user"
    )
    activated, error = store.activate_customer_team_plan(
        owner[0], f"Tenant {suffix}", "team"
    )
    assert error is None, error
    team = store.member_team(owner[0])
    provisioned, error = store.provision_team_supplier_admin(team["id"], owner[0])
    assert error is None, error
    parent_id = provisioned["account"]["id"]
    child = store.create_supplier_children(parent_id, [{
        "name": f"{suffix} child",
        "username": f"tenant_child_{suffix}",
        "pin": "local-test-pin",
    }])[0]
    return {
        "ownerId": owner[0],
        "teamId": team["id"],
        "parentId": parent_id,
        "childId": child["id"],
        "activated": activated,
    }


def seed_account_and_delivery(store, tenant, account_id, asset_id):
    store.upsert_member_collection(tenant["ownerId"], "editor", "accounts", [{
        "id": account_id,
        "name": f"Account {account_id}",
        "platform": "小红书",
        "mode": "图文",
        "updatedAt": 100,
    }])
    store.upsert_docs("assets", [{
        "id": asset_id,
        "accountId": account_id,
        "name": f"Delivery {asset_id}",
        "type": "图集",
        "delivered": True,
        "status": "未下载",
        "ownerId": tenant["ownerId"],
        "updatedAt": 100,
    }])


class SupplierTenantPolicyTests(unittest.TestCase):
    def test_metric_projection_uses_v140_doc_asset_scope_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            tenant = provision_supplier_team(store, "scoped-metrics")
            seed_account_and_delivery(
                store, tenant, "account-scoped-metrics", "delivery-scoped-metrics"
            )
            self.assertTrue(store.set_supplier_child_accounts(
                tenant["parentId"], tenant["childId"], ["account-scoped-metrics"],
                tenant["parentId"], include_all=True,
            ))
            conn = store._connect()
            try:
                conn.executescript(store.RESOURCE_SCOPE_SCHEMA)
                actor_scope = store._member_resource_scope_locked(
                    conn, tenant["parentId"]
                )
                self.assertIsNotNone(actor_scope)
                conn.execute(
                    "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                    "scope_id,owner_id,provenance,captured_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (
                        "doc:assets", "delivery-scoped-metrics",
                        actor_scope[0], actor_scope[1], tenant["ownerId"],
                        "test", 1, 1,
                    ),
                )
                conn.execute(
                    "INSERT INTO schema_migrations(version,name,checksum,app_version,"
                    "started_at,finished_at,status,summary) VALUES(?,?,?,?,?,?,?,?)",
                    (
                        store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                        store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                        store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                        "test", 1, 1, "success", "{}",
                    ),
                )
                conn.commit()
            finally:
                conn.close()

            for actor_id, actor_role in (
                (tenant["parentId"], "supplier_parent"),
                (tenant["childId"], "supplier_child"),
                (tenant["ownerId"], "editor"),
            ):
                self.assertEqual(
                    ["delivery-scoped-metrics"],
                    [
                        row["id"] for row in store.list_delivery_asset_metrics(
                            actor_id, actor_role
                        )
                    ],
                )

    def test_same_team_parent_and_bound_child_can_read_and_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            tenant = provision_supplier_team(store, "positive")
            seed_account_and_delivery(store, tenant, "account-positive", "delivery-positive")

            parent_state = store.state_for(
                tenant["parentId"], "supplier_parent", collections=["accounts", "assets"]
            )
            self.assertEqual({"account-positive"}, {x["id"] for x in parent_state["accounts"]})
            self.assertEqual({"delivery-positive"}, {x["id"] for x in parent_state["assets"]})

            sync_result = store.upsert_supplier_assets(
                tenant["parentId"], "supplier_parent", [{
                    **parent_state["assets"][0],
                    "name": "Supplier display title",
                    "accountId": "account-positive",
                    "ownerId": "spoofed-owner",
                    "delivered": False,
                    "updatedAt": 150,
                }],
            )
            self.assertEqual(1, sync_result["written"])
            persisted = json.loads(store._fetchone(
                "SELECT data FROM docs WHERE collection='assets' AND id='delivery-positive'"
            )[0])
            self.assertTrue(persisted["delivered"])
            self.assertEqual(tenant["ownerId"], persisted["ownerId"])
            self.assertEqual("account-positive", persisted["accountId"])

            store.upsert_docs("assets", [{
                "id": "private-positive", "accountId": "account-positive",
                "ownerId": tenant["ownerId"], "delivered": False, "updatedAt": 100,
            }])
            with self.assertRaises(PermissionError):
                store.upsert_supplier_assets(
                    tenant["parentId"], "supplier_parent", [{
                        "id": "private-positive", "accountId": "account-positive",
                        "ownerId": tenant["ownerId"], "delivered": True, "updatedAt": 200,
                    }],
                )
            self.assertFalse(json.loads(store._fetchone(
                "SELECT data FROM docs WHERE collection='assets' AND id='private-positive'"
            )[0]).get("delivered"))

            account, error = store.update_supplier_account_homepage(
                "account-positive", "example.com/positive", tenant["parentId"], "supplier_parent"
            )
            self.assertIsNone(error)
            self.assertEqual("https://example.com/positive", account["homepageUrl"])

            self.assertTrue(store.set_supplier_child_accounts(
                tenant["parentId"], tenant["childId"], ["account-positive"],
                tenant["parentId"], include_all=True,
            ))
            child_state = store.state_for(
                tenant["childId"], "supplier_child", tenant["parentId"],
                ["accounts", "assets"],
            )
            self.assertEqual({"account-positive"}, {x["id"] for x in child_state["accounts"]})
            self.assertEqual({"delivery-positive"}, {x["id"] for x in child_state["assets"]})
            asset, error = store.update_supplier_asset_views(
                "delivery-positive", 321, tenant["childId"], "supplier_child"
            )
            self.assertIsNone(error)
            self.assertEqual(321, asset["viewCount"])
            asset, error = store.update_supplier_asset_exposure(
                "delivery-positive", 654, tenant["childId"], "supplier_child"
            )
            self.assertIsNone(error)
            self.assertEqual(654, asset["exposureCount"])
            authoritative = dict(asset)

            # A parent account or another old tab may later push a complete
            # document with an unrelated, newer updatedAt. Dedicated metric
            # triplets remain server-authoritative, including their actor and
            # timestamp markers.
            stale_snapshot = {
                **parent_state["assets"][0],
                "name": "Fresh non-metric title",
                "viewCount": 3,
                "viewsUpdatedAt": 2,
                "viewsUpdatedBy": "stale-parent-tab",
                "exposureCount": 4,
                "exposureUpdatedAt": 2,
                "exposureUpdatedBy": "stale-parent-tab",
                "updatedAt": authoritative["updatedAt"] + 1000,
            }
            first_stale = store.upsert_supplier_assets(
                tenant["parentId"], "supplier_parent", [stale_snapshot]
            )
            self.assertEqual(1, first_stale["written"])
            second_stale = store.upsert_supplier_assets(
                tenant["parentId"], "supplier_parent", [stale_snapshot]
            )
            self.assertEqual(
                {"written": 0, "denied": 0, "unchanged": 1}, second_stale
            )

            # The creator/admin compatibility writer has the same protection;
            # legitimate non-metric edits do not reopen the metric race.
            creator_stale = {
                **stale_snapshot,
                "name": "Creator renamed delivery",
                "viewCount": 0,
                "exposureCount": 0,
                "updatedAt": stale_snapshot["updatedAt"] + 1000,
            }
            result = store.upsert_member_assets(
                tenant["ownerId"], "admin", [creator_stale]
            )
            self.assertEqual(1, result["written"])

            expected_metrics = {
                key: authoritative[key] for key in (
                    "viewCount", "viewsUpdatedAt", "viewsUpdatedBy",
                    "exposureCount", "exposureUpdatedAt", "exposureUpdatedBy",
                )
            }
            snapshots = [
                store.state_for(
                    tenant["parentId"], "supplier_parent",
                    collections=["accounts", "assets"],
                ),
                store.state_for(
                    tenant["childId"], "supplier_child", tenant["parentId"],
                    ["accounts", "assets"],
                ),
                store.state_for(
                    tenant["ownerId"], "editor",
                    collections=["accounts", "assets"],
                ),
            ]
            for snapshot in snapshots:
                visible = next(
                    row for row in snapshot["assets"]
                    if row["id"] == "delivery-positive"
                )
                self.assertEqual(expected_metrics, {
                    key: visible[key] for key in expected_metrics
                })
                self.assertEqual("Creator renamed delivery", visible["name"])

            metric_snapshots = [
                store.list_delivery_asset_metrics(tenant["parentId"], "supplier_parent"),
                store.list_delivery_asset_metrics(tenant["childId"], "supplier_child"),
                store.list_delivery_asset_metrics(tenant["ownerId"], "editor"),
            ]
            for metrics in metric_snapshots:
                projected = next(row for row in metrics if row["id"] == "delivery-positive")
                self.assertEqual(expected_metrics, {
                    key: projected[key] for key in expected_metrics
                })

            main = importlib.import_module("main")
            with mock.patch.object(main, "store", store):
                response = main.delivery_asset_metrics(me={
                    "id": tenant["parentId"], "role": "supplier_parent",
                })
            projected = next(
                row for row in response["items"] if row["id"] == "delivery-positive"
            )
            self.assertEqual(expected_metrics, {
                key: projected[key] for key in expected_metrics
            })

            # Old delivered rows may have a useful non-zero count without the
            # newer marker fields. A whole-document write must not clear it.
            store.upsert_docs("assets", [{
                "id": "delivery-legacy-metric",
                "accountId": "account-positive",
                "name": "Legacy metric",
                "type": "图集",
                "delivered": True,
                "ownerId": tenant["ownerId"],
                "viewCount": 88,
                "exposureCount": 99,
                "updatedAt": 100,
            }])
            store.upsert_docs("assets", [{
                "id": "delivery-legacy-metric",
                "accountId": "account-positive",
                "name": "Legacy metric renamed",
                "type": "图集",
                "delivered": True,
                "ownerId": tenant["ownerId"],
                "viewCount": 0,
                "exposureCount": 0,
                "updatedAt": 200,
            }])
            legacy = json.loads(store._fetchone(
                "SELECT data FROM docs WHERE collection='assets' "
                "AND id='delivery-legacy-metric'"
            )[0])
            self.assertEqual(88, legacy["viewCount"])
            self.assertEqual(99, legacy["exposureCount"])
            self.assertNotIn("viewsUpdatedAt", legacy)
            self.assertNotIn("exposureUpdatedAt", legacy)

    def test_cross_team_reads_and_writes_reject_without_database_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            tenant_a = provision_supplier_team(store, "a")
            tenant_b = provision_supplier_team(store, "b")
            seed_account_and_delivery(store, tenant_a, "account-a", "delivery-a")
            seed_account_and_delivery(store, tenant_b, "account-b", "delivery-b")

            before_docs = store._fetchall(
                "SELECT collection,id,owner_id,updated_at,data FROM docs "
                "WHERE id IN ('account-b','delivery-b') ORDER BY collection,id"
            )
            before_bindings = store._fetchall(
                "SELECT parent_id,child_id,account_id,created_at,created_by "
                "FROM supplier_account_bindings ORDER BY parent_id,account_id"
            )
            before_member = store.get_member(tenant_b["childId"])

            conn = store._connect()
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    conn.execute(
                        "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at) "
                        "VALUES(?,?,?)",
                        (tenant_b["teamId"], tenant_a["parentId"], 1),
                    )
                conn.rollback()
            finally:
                conn.close()

            self.assertNotIn(
                "account-b",
                {x["id"] for x in store.state_for(
                    tenant_a["parentId"], "supplier_parent", collections=["accounts"]
                )["accounts"]},
            )
            updated, error = store.update_supplier_account_homepage(
                "account-b", "https://blocked.example", tenant_a["parentId"], "supplier_parent"
            )
            self.assertIsNone(updated)
            self.assertEqual("unassigned", error)
            self.assertFalse(store.set_supplier_child_accounts(
                tenant_a["parentId"], tenant_a["childId"], ["account-b"],
                tenant_a["parentId"], include_all=True,
            ))
            for actor_id, actor_role in (
                (tenant_a["parentId"], "supplier_parent"),
                (tenant_a["childId"], "supplier_child"),
            ):
                self.assertNotIn(
                    "delivery-b",
                    {
                        row["id"] for row in store.list_delivery_asset_metrics(
                            actor_id, actor_role
                        )
                    },
                )
                item, error = store.update_supplier_asset_views(
                    "delivery-b", 777, actor_id, actor_role
                )
                self.assertIsNone(item)
                self.assertEqual("unassigned", error)
                item, error = store.update_supplier_asset_exposure(
                    "delivery-b", 888, actor_id, actor_role
                )
                self.assertIsNone(item)
                self.assertEqual("unassigned", error)
            with self.assertRaises(PermissionError):
                store.upsert_supplier_assets(tenant_a["parentId"], "supplier_parent", [{
                    "id": "delivery-b",
                    "accountId": "account-b",
                    "name": "tampered",
                    "delivered": True,
                    "updatedAt": 999,
                }])
            delivery, error = store.get_delivery_asset_for_member(
                "delivery-b", tenant_a["parentId"], "supplier_parent"
            )
            self.assertIsNone(delivery)
            self.assertEqual("forbidden", error)
            self.assertIsNone(store.supplier_member_for(
                tenant_a["parentId"], tenant_b["childId"]
            ))
            updated_member, member_error = store.update_supplier_member(
                tenant_a["parentId"], tenant_b["childId"],
                name="tampered", pin="tampered-pin",
            )
            self.assertIsNone(updated_member)
            self.assertEqual("not_found", member_error)

            self.assertEqual(before_docs, store._fetchall(
                "SELECT collection,id,owner_id,updated_at,data FROM docs "
                "WHERE id IN ('account-b','delivery-b') ORDER BY collection,id"
            ))
            self.assertEqual(before_bindings, store._fetchall(
                "SELECT parent_id,child_id,account_id,created_at,created_by "
                "FROM supplier_account_bindings ORDER BY parent_id,account_id"
            ))
            self.assertEqual(before_member, store.get_member(tenant_b["childId"]))

    def test_missing_supplier_mapping_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            unmapped = store.add_member(
                "Unmapped supplier", "unmapped_supplier", "local-test-pin", "supplier_parent"
            )
            tenant = provision_supplier_team(store, "mapped")
            seed_account_and_delivery(store, tenant, "account-mapped", "delivery-mapped")

            self.assertIsNone(store.supplier_access_context(unmapped[0], "supplier_parent"))
            self.assertEqual(
                {"accounts": [], "assets": []},
                store.state_for(unmapped[0], "supplier_parent", collections=["accounts", "assets"]),
            )
            self.assertEqual([], store.list_supplier_members(unmapped[0]))
            self.assertEqual(
                [], store.list_delivery_asset_metrics(unmapped[0], "supplier_parent")
            )
            self.assertFalse(store.can_write_asset_file(
                "new-unmapped-file", unmapped[0], "supplier_parent"
            ))
            item, error = store.update_supplier_asset_views(
                "delivery-mapped", 9, unmapped[0], "supplier_parent"
            )
            self.assertIsNone(item)
            self.assertEqual("forbidden", error)


class LegacyAssetsContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = importlib.import_module("main")

    def test_legacy_assets_get_uses_member_scoped_state_and_writes_are_gone(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            member = store.add_member(
                "Legacy reader", "legacy_reader", "local-test-pin", "user"
            )
            store.upsert_docs("assets", [
                {
                    "id": "legacy-own", "ownerId": member[0], "platform": "小红书",
                    "tags": ["可见"], "name": "Own", "updatedAt": 1,
                },
                {
                    "id": "legacy-foreign", "ownerId": "somebody-else", "platform": "小红书",
                    "tags": ["可见"], "name": "Foreign", "updatedAt": 1,
                },
            ])
            response = self.main.Response()
            with mock.patch.object(self.main, "store", store):
                rows = self.main.list_assets(
                    response, platform="小红书", tag="可见",
                    me={"id": member[0], "role": "user", "parentId": None},
                )
                self.assertEqual(["legacy-own"], [row["id"] for row in rows])
                self.assertEqual("true", response.headers["Deprecation"])
                with self.assertRaises(self.main.HTTPException) as created:
                    self.main.create_asset(
                        self.main.Asset(name="blocked", accountId="account-x"),
                        _me={"id": member[0], "role": "user"},
                    )
                self.assertEqual(410, created.exception.status_code)
                with self.assertRaises(self.main.HTTPException) as downloaded:
                    self.main.mark_downloaded(
                        "legacy-own", _me={"id": member[0], "role": "user"}
                    )
                self.assertEqual(410, downloaded.exception.status_code)


if __name__ == "__main__":
    unittest.main()
