"""
Full integration test.
Requires the mock backend to be running:
    python tests/mock_backend.py

Then in another terminal:
    python tests/test_full_flow.py
"""

import sys
import time
import requests

BACKEND = "http://localhost:8000"


def wait_for_backend(timeout=5):
    start = time.time()
    while time.time() - start < timeout:
        try:
            requests.get(f"{BACKEND}/api/mock/summary", timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def test_full_flow():
    print("\nFull flow integration test")
    print("==========================")

    if not wait_for_backend():
        print("[FAIL] Mock backend is not running.")
        print("       Start it first: python tests/mock_backend.py")
        sys.exit(1)

    print("[OK] Mock backend reachable")

    # Give the agent time to complete the test job
    # (agent must already be running pointed at localhost:8000)
    print("Waiting 60s for agent to process test job...")
    time.sleep(60)

    summary = requests.get(f"{BACKEND}/api/mock/summary").json()

    print(f"\nResults:")
    print(f"  Machines registered : {len(summary['machines'])}")
    print(f"  Log lines received  : {summary['log_lines_received']}")
    print(f"  Artifacts received  : {summary['artifacts_received']}")
    print(f"  Status updates      : {[s['status'] for s in summary['status_updates']]}")

    assert len(summary["machines"]) >= 1,      "Agent did not register"
    assert summary["log_lines_received"] > 0,  "No logs were streamed"
    assert "completed" in [s["status"] for s in summary["status_updates"]], \
        "Job did not reach completed status"

    print("\n[PASS] Full flow test passed.")


if __name__ == "__main__":
    test_full_flow()