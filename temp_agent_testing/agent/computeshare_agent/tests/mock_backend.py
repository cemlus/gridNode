"""
Run this before starting the agent in test mode.
It pretends to be the real backend.

Usage:
    python tests/mock_backend.py
"""

from flask import Flask, request, jsonify
import time
import os

app = Flask(__name__)

# ── State ─────────────────────────────────────────────────────────────────────

registered_machines = {}
job_queue = []
logs_received = []
artifacts_received = []
status_updates = []

# Pre-load a test job that the agent will pick up
TEST_JOB = {
    "job_id": "test_job_001",
    "type": "ml_notebook",
    "github_repo": "https://github.com/fastai/fastbook",  # real public repo
    "notebook_path": "01_intro.ipynb",
    "dataset_url": None,
    "cpu_request": 2,
    "ram_request_gb": 2,
    "gpu_required": False,
    "timeout_seconds": 300,
}

job_served = False   # only serve the job once

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.route("/api/machines/register", methods=["POST"])
def register():
    data = request.json
    machine_id = f"mock_machine_{int(time.time())}"
    registered_machines[machine_id] = data
    print(f"\n[MOCK] Machine registered: {machine_id}")
    print(f"       CPU: {data.get('cpu_cores')} cores")
    print(f"       RAM: {data.get('ram_gb')} GB")
    print(f"       GPU: {data.get('gpu')}")
    return jsonify({"machine_id": machine_id, "status": "registered"})


@app.route("/api/machines/<machine_id>/heartbeat", methods=["POST"])
def heartbeat(machine_id):
    data = request.json
    # Uncomment the next line to test reclaim:
    # return jsonify({"reclaim": True})
    return jsonify({"reclaim": False, "status": "ok"})


@app.route("/api/agent/jobs/next", methods=["GET"])
def next_job():
    global job_served
    if not job_served:
        job_served = True
        print("\n[MOCK] Serving test job to agent")
        return jsonify({"job": TEST_JOB})
    return "", 204   # no content = no job available


@app.route("/api/jobs/<job_id>/logs", methods=["POST"])
def receive_logs(job_id):
    lines = request.json.get("lines", [])
    logs_received.extend(lines)
    for entry in lines:
        print(f"  [LOG] {entry['line']}")
    return jsonify({"ok": True})


@app.route("/api/jobs/<job_id>/artifacts", methods=["POST"])
def receive_artifact(job_id):
    f = request.files.get("file")
    if f:
        save_path = f"/tmp/mock_artifacts/{job_id}"
        os.makedirs(save_path, exist_ok=True)
        f.save(os.path.join(save_path, f.filename))
        artifacts_received.append(f.filename)
        print(f"\n[MOCK] Artifact received: {f.filename}")
        return jsonify({"artifact_id": f"art_{int(time.time())}"})
    return jsonify({"error": "no file"}), 400


@app.route("/api/jobs/<job_id>/status", methods=["PATCH"])
def update_status(job_id):
    data = request.json
    status_updates.append({"job_id": job_id, **data})
    print(f"\n[MOCK] Job {job_id} → status: {data.get('status')}")
    if data.get("reason"):
        print(f"       reason: {data['reason']}")
    if data.get("actual_allocation"):
        print(f"       allocation: {data['actual_allocation']}")
    return jsonify({"ok": True})


# ── Summary on exit ───────────────────────────────────────────────────────────

@app.route("/api/mock/summary", methods=["GET"])
def summary():
    return jsonify({
        "machines": list(registered_machines.keys()),
        "log_lines_received": len(logs_received),
        "artifacts_received": artifacts_received,
        "status_updates": status_updates,
    })


if __name__ == "__main__":
    print("\nMock backend running at http://localhost:8000")
    print("Waiting for agent to connect...\n")
    app.run(port=8000, debug=False)