#!/usr/bin/env python3
"""Run the main-service suite and reject every unexpected skipped test."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


OPTIONAL_SNAPSHOT_TEST_SUFFIX = (
    "ResourceScopeMigrationTest."
    "test_real_v120_snapshot_copy_closes_with_reviewed_dynamic_overrides"
)
OPTIONAL_SNAPSHOT_REASON = "ignored read-only v120 snapshot is not present"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: run_server_unittest_suite.py <server-tests-dir>", file=sys.stderr)
        return 2
    tests_dir = Path(sys.argv[1]).resolve()
    if not tests_dir.is_dir():
        print("server tests directory is missing", file=sys.stderr)
        return 2

    suite = unittest.defaultTestLoader.discover(
        str(tests_dir),
        pattern="test_*.py",
    )
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    allowed_snapshot_skips = []
    unexpected_skips = []
    for case, reason in result.skipped:
        test_id = case.id()
        if (
            test_id.endswith(OPTIONAL_SNAPSHOT_TEST_SUFFIX)
            and reason == OPTIONAL_SNAPSHOT_REASON
        ):
            allowed_snapshot_skips.append(test_id)
        else:
            unexpected_skips.append({"test": test_id, "reason": reason})

    if len(allowed_snapshot_skips) > 1 or unexpected_skips:
        print(
            "unexpected skipped tests: "
            f"allowed={allowed_snapshot_skips!r} unexpected={unexpected_skips!r}",
            file=sys.stderr,
        )
        return 1
    if not result.wasSuccessful():
        return 1

    passed = (
        result.testsRun
        - len(result.skipped)
        - len(result.expectedFailures)
        - len(result.unexpectedSuccesses)
    )
    print(
        "Secret-free main-service suite: "
        f"collected={result.testsRun} passed={passed} "
        f"allowedSnapshotSkips={len(allowed_snapshot_skips)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
