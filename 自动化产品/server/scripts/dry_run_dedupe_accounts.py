#!/usr/bin/env python3
"""账号去重 dry-run 工具：只输出计划，不修改线上 SQLite。

用途：
  python3 server/scripts/dry_run_dedupe_accounts.py
  python3 server/scripts/dry_run_dedupe_accounts.py --db /path/to/data.sqlite

规则：
  - 按 name + platform + mode + subType 归组。
  - 任何被 assets / productions / sessions / batches / jobs 引用的账号都保留。
  - 重复且无引用的账号列为可删除候选。
  - 如果同组多个账号都有内容，只输出冲突报告，不自动合并。
"""
from __future__ import print_function

import argparse
import json
import os
import sqlite3
from collections import defaultdict


def load_collection(conn, name):
    rows = conn.execute("SELECT data FROM docs WHERE collection=?", (name,)).fetchall()
    out = []
    for (raw,) in rows:
        try:
            item = json.loads(raw)
            if isinstance(item, dict):
                out.append(item)
        except Exception:
            pass
    return out


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.path.join(here, "data.sqlite"))
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    accounts = load_collection(conn, "accounts")
    assets = load_collection(conn, "assets")
    productions = load_collection(conn, "productions")
    sessions = load_collection(conn, "sessions")
    batches = load_collection(conn, "batches")
    jobs = load_collection(conn, "jobs")

    refs = defaultdict(lambda: defaultdict(int))
    for x in assets:
        if x.get("accountId"):
            refs[x.get("accountId")]["assets"] += 1
    prod_by_id = {}
    for x in productions:
        if x.get("id"):
            prod_by_id[x.get("id")] = x
        if x.get("accountId"):
            refs[x.get("accountId")]["productions"] += 1
    for x in sessions:
        if x.get("accountId"):
            refs[x.get("accountId")]["sessions"] += 1
    for x in batches:
        if x.get("accountId"):
            refs[x.get("accountId")]["batches"] += 1
    for x in jobs:
        pid = x.get("productionId")
        acc = prod_by_id.get(pid, {}).get("accountId")
        if acc:
            refs[acc]["jobs"] += 1

    groups = defaultdict(list)
    for a in accounts:
        key = (
            (a.get("name") or "").strip(),
            (a.get("platform") or "").strip(),
            (a.get("mode") or "").strip(),
            (a.get("subType") or "").strip(),
        )
        groups[key].append(a)

    deletable = []
    conflicts = []
    for key, items in sorted(groups.items()):
        if len(items) <= 1:
            continue
        used = [a for a in items if refs.get(a.get("id"))]
        unused = [a for a in items if not refs.get(a.get("id"))]
        if len(used) > 1:
            conflicts.append((key, used, unused))
        elif used:
            deletable.extend(unused)
        else:
            keep = sorted(items, key=lambda x: x.get("createdAt") or 0)[0]
            deletable.extend([a for a in items if a.get("id") != keep.get("id")])

    print("accounts_total=%d" % len(accounts))
    print("duplicate_groups=%d" % sum(1 for v in groups.values() if len(v) > 1))
    print("deletable_unused_duplicates=%d" % len(deletable))
    for a in deletable:
        print("DELETE_CANDIDATE\t%s\t%s\t%s" % (a.get("id"), a.get("name"), a.get("platform")))
    print("conflict_groups=%d" % len(conflicts))
    for key, used, unused in conflicts:
        print("CONFLICT\t%s\tused=%s\tunused=%s" % (
            " / ".join(key),
            ",".join(a.get("id", "") for a in used),
            ",".join(a.get("id", "") for a in unused),
        ))


if __name__ == "__main__":
    main()
