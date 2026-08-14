"""Compatibility wrapper for the production-pinned Starlette TestClient.

Starlette 0.14.2's in-memory ``_ASGIAdapter`` deliberately does not initialize
the real HTTPAdapter connection pool.  requests 2.28 correctly tries to close
all mounted adapters, so calling ``Session.close`` on that test-only adapter
raises even though there is no socket or pool to release.  Clearing those
in-memory mounts before the normal Session cleanup preserves request behavior
while making deterministic teardown possible.
"""

from fastapi.testclient import TestClient as _FastAPITestClient


class TestClient(_FastAPITestClient):
    def close(self) -> None:
        adapters = getattr(self, "adapters", None)
        if adapters is not None:
            adapters.clear()
        super().close()
