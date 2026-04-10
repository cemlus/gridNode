import sys
import os
import time
import threading
import argparse
import requests
import signal
import shutil
import json as _json

from computeshare_agent import config
from computeshare_agent import resources
from computeshare_agent import workspace
from computeshare_agent import docker_runner
from computeshare_agent import artifact_uploader
from computeshare_agent.prerequisites import run_all_checks
from computeshare_agent.log_streamer import LogStreamer

BACKEND_URL = None
AUTH_HEADERS = {}
MACHINE_ID  = None
GPU_ENABLED = False

CPU_TIER_CORES = {
    "light":  2,
    "medium": 4,
    "heavy":  8,
}

MEMORY_TIER_GB = {
    "gb8":  8,
    "gb16": 16,
    "gb32": 32,
    "gb64": 64,
}

GPU_MEMORY_TIER_MB = {
    "gb8":  8192,
    "gb12": 12288,
    "gb16": 16384,
    "gb24": 24576,
    "gb32": 32768,
    "gb48": 49152,
}


def normalise_job(raw_job: dict) -> dict:
    """
    Translate the backend's Prisma job object into the internal
    format the agent functions expect.
    Logs every field so mismatches are immediately visible.
    """
    print(f"\n  [normalise_job] Raw job from backend:")
    for k, v in raw_job.items():
        print(f"    {k}: {v!r}")

    normalised = {
        # identity
        "job_id":       raw_job["id"],
        "type":         raw_job["type"],           # "notebook" | "video"

        # repo and execution
        "github_repo":  raw_job["repoUrl"],
        "notebook_path": raw_job.get("command", ""), # command holds the notebook path

        # dataset
        "dataset_url":  raw_job.get("kaggleDatasetUrl"),

        # resources — convert enums to numbers
        "cpu_request":    CPU_TIER_CORES.get(raw_job.get("cpuTier", "light"), 2),
        "ram_request_gb": MEMORY_TIER_GB.get(raw_job.get("memoryTier", "gb8"), 8),

        # GPU
        "gpu_required":  raw_job.get("gpuMemoryTier") is not None,
        "gpu_vram_mb":   GPU_MEMORY_TIER_MB.get(raw_job.get("gpuMemoryTier", ""), 0),

        # timeout derived from estimatedDuration
        "timeout_seconds": _duration_to_seconds(raw_job.get("estimatedDuration")),
    }

    print(f"\n  [normalise_job] Normalised job:")
    for k, v in normalised.items():
        print(f"    {k}: {v!r}")

    return normalised


def _duration_to_seconds(tier: str) -> int:
    mapping = {
        "lt1h":  3600,
        "h1_6":  6 * 3600,
        "h6_12": 12 * 3600,
        "h12_24": 24 * 3600,
        "gt24h": 48 * 3600,
    }
    return mapping.get(tier, 3600)  # default 1 hour


_current_container = None          # track running container for reclaim
_current_workspace = None          # track active workspace for teardown
_current_job_id = None             # track active job for teardown
_reclaim_flag = threading.Event()  # set by heartbeat thread on reclaim signal


def handle_shutdown(signum, frame):
    print("\n[SHUTDOWN] Signal received. Commencing graceful teardown...")
    if _current_container:
        print(f"  -> Stopping container: {_current_container}")
        docker_runner.stop_container(_current_container)
    if _current_workspace:
        print(f"  -> Cleaning up workspace: {_current_workspace}")
        workspace.cleanup(_current_workspace)
    if _current_job_id:
        print(f"  -> Notifying backend of job interruption...")
        report_status(_current_job_id, "failed", reason="Provider node shut down abruptly")
    print("[SHUTDOWN] Teardown complete. Exiting.")
    sys.exit(0)


def headers():
    return AUTH_HEADERS.copy()


def register(token):
    res = resources.snapshot()
    resources.print_summary(res)

    payload = {
        "agent_token": token,
        "cpu_cores":   res["cpu"]["total_cores"],
        "ram_gb":      res["ram"]["total_gb"],
        "gpu":         res["gpu"],
        "disk_free_gb": res["disk"]["free_gb"],
        "userKey":      token
    }

    print(payload)

    resp = requests.post(
        f"{BACKEND_URL}/api/machines/register",
        json=payload,
        timeout=10
    )
    resp.raise_for_status()
    data = resp.json()

    cfg = {
        "machine_id":   data["machine_id"],
        "agent_token":  data["agent_token"],
        "backend_url":  BACKEND_URL,
    }
    config.save(cfg)
    print(f"  Registered as machine: {data['machine_id']}")
    return cfg


def heartbeat_loop():
    global _current_container
    while True:
        try:
            res = resources.snapshot()
            payload = {
                "cpu_used_pct": 100 - (res["cpu"]["free_cores"] / res["cpu"]["total_cores"] * 100),
                "ram_used_gb":  res["ram"]["total_gb"] - res["ram"]["available_gb"],
                "status":       "running" if _current_container else "idle",
            }
            resp = requests.post(
                f"{BACKEND_URL}/api/machines/{MACHINE_ID}/heartbeat",
                json=payload,
                headers=headers(),
                timeout=5
            )
            data = resp.json()

            # backend can signal reclaim at any time via heartbeat response
            if data.get("reclaim") and _current_container:
                print("\n  [RECLAIM] Owner requested machine back — stopping container")
                _reclaim_flag.set()
                docker_runner.stop_container(_current_container)

        except Exception as e:
            print(f"  [WARN] Heartbeat failed: {e}")

        time.sleep(10)


def fetch_job():
    try:
        resp = requests.get(
            f"{BACKEND_URL}/api/agent/jobs/next",
            headers=headers(),
            timeout=15
        )
        print(f"  [fetch_job] Status: {resp.status_code}")

        if resp.status_code == 204:
            return None

        resp.raise_for_status()
        raw = resp.json()
        print(f"  [fetch_job] Raw response keys: {list(raw.keys())}")

        raw_job = raw.get("job")
        if not raw_job:
            print("  [fetch_job] Response had no 'job' key")
            return None

        return normalise_job(raw_job)

    except Exception as e:
        print(f"  [fetch_job] Exception: {e}")
        return None



def report_status(job_id, status, reason=None, allocation=None):
    payload = {"status": status}
    if reason:
        payload["reason"] = reason
    if allocation:
        payload["actual_allocation"] = allocation
    try:
        requests.patch(
            f"{BACKEND_URL}/api/jobs/{job_id}/status",
            json=payload,
            headers=headers(),
            timeout=5
        )
    except Exception as e:
        print(f"  [WARN] Status report failed: {e}")


def execute_job(job):
    global _current_container, _current_workspace, _current_job_id
    job_id = job["job_id"]
    _current_job_id = job_id
    ws = None

    print(f"\n{'─'*50}")
    print(f"  Job {job_id} | type: {job['type']}")
    print(f"  Repo:     {job['github_repo']}")
    print(f"  Command:  {job['notebook_path']}")
    print(f"  CPU req:  {job['cpu_request']} cores")
    print(f"  RAM req:  {job['ram_request_gb']} GB")
    print(f"  GPU req:  {job['gpu_required']}")
    print(f"  Dataset:  {job['dataset_url']}")
    print(f"  Timeout:  {job['timeout_seconds']}s")
    print(f"{'─'*50}")

    try:
        res = resources.snapshot()
        print(f"  [execute_job] Resource snapshot: cpu_usable={res['cpu']['usable_cores']} ram_usable={res['ram']['usable_gb']}")

        allocation = docker_runner.resolve_allocation(job, res)
        print(f"  [execute_job] Allocation: {allocation}")

        viable, reason = docker_runner.is_viable(allocation, job)
        print(f"  [execute_job] Viable: {viable} reason: {reason}")

        if not viable:
            print(f"  [DEFER] {reason}")
            report_status(job_id, "deferred", reason=reason)
            return

        report_status(job_id, "running", allocation=allocation)
        print(f"  [execute_job] Reported status=running")

        ws = workspace.create(job_id)
        _current_workspace = ws

        print(f"  [execute_job] Cloning repo: {job['github_repo']}")
        workspace.clone_repo(job["github_repo"], ws)

        if job.get("dataset_url"):
            print(f"  [execute_job] Downloading dataset: {job['dataset_url']}")
            workspace.download_file(
                url=job["dataset_url"],
                workspace=ws,
                filename="input",
                backend_url=BACKEND_URL,
                agent_headers=headers()
            )
        else:
            print("  [execute_job] No dataset URL — skipping download")

        # copy repo to a writable location within workspace so we can inject params
        data_input_dir = os.path.join(ws, "data", "input")
        print(f"\n  [DEBUG] data/input contents:")
        
        for root, dirs, files in os.walk(data_input_dir):
            for f in files:
                full = os.path.join(root, f)
                print(f"    {os.path.relpath(full, data_input_dir)} ({os.path.getsize(full)} bytes)")

        data_file = docker_runner.find_data_file(data_input_dir)
        print(f"  [DEBUG] find_data_file returned: {data_file!r}")

        data_file_container = "/workspace/data/" + os.path.basename(data_file)
        print(f"  [DEBUG] container path will be: {data_file_container!r}")

        notebook_host_path, resolved_notebook_relpath = workspace.resolve_repo_file(
            ws,
            job["notebook_path"],
            allowed_extensions=(".ipynb",),
        )
        print(f"  [DEBUG] resolved notebook host path: {notebook_host_path!r}")
        print(f"  [DEBUG] resolved notebook relative path: {resolved_notebook_relpath!r}")
        print(f"  [DEBUG] notebook exists: {os.path.exists(notebook_host_path)}")

        # read the notebook and check for parameters tag before injection
        with open(notebook_host_path) as _f:
            _nb = _json.load(_f)
        _tagged = [
            c for c in _nb.get("cells", [])
            if "parameters" in c.get("metadata", {}).get("tags", [])
        ]
        print(f"  [DEBUG] cells with 'parameters' tag before injection: {len(_tagged)}")

        docker_runner.inject_parameters_cell(notebook_host_path, {
            "DATA_DIR":   data_file_container,
            "DATA_PATH":  data_file_container,
            "OUTPUT_DIR": "/workspace/outputs",
        })

        # verify injection worked
        with open(notebook_host_path) as _f:
            _nb2 = _json.load(_f)
        _tagged2 = [
            c for c in _nb2.get("cells", [])
            if "parameters" in c.get("metadata", {}).get("tags", [])
        ]
        print(f"  [DEBUG] cells with 'parameters' tag after injection: {len(_tagged2)}")
        if _tagged2:
            print(f"  [DEBUG] injected cell source: {_tagged2[0]['source']!r}")

        _reclaim_flag.clear()
        
        print(f"  [execute_job] Starting Docker container")
        process, container_name, _ = docker_runner.run(job, ws, allocation)
        _current_container = container_name
        print(f"  [execute_job] Container started: {container_name}")

        streamer = LogStreamer(job_id, BACKEND_URL, headers())
        streamer.start()
        print(f"  [execute_job] Log streamer started — waiting for container to finish")
        exit_code = streamer.ingest(process)

        print(f"  [execute_job] Container exited with code: {exit_code}")
        print(f"  [execute_job] Reclaim flag set: {_reclaim_flag.is_set()}")
        _current_container = None

        if _reclaim_flag.is_set():
            print(f"  [execute_job] Reporting preempted")
            report_status(job_id, "preempted", reason="Owner reclaimed machine")
            return

        if exit_code != 0:
            print(f"  [execute_job] Reporting failed (exit code {exit_code})")
            report_status(job_id, "failed", reason=f"Container exited with code {exit_code}")
            return

        print("\n  Uploading artifacts...")
        uploaded, failed = artifact_uploader.upload_all(
            job_id, ws, BACKEND_URL, headers()
        )
        print(f"  Uploaded: {len(uploaded)} | Failed: {len(failed)}")

        report_status(job_id, "completed")
        print(f"\n  Job {job_id} completed successfully.\n")

    except KeyError as e:
        print(f"\n  [ERROR] Missing job field: {e}")
        print(f"  [ERROR] Available job keys: {list(job.keys())}")
        report_status(job_id, "failed", reason=f"Agent config error: missing field {e}")
        _current_container = None

    except Exception as e:
        import traceback
        print(f"\n  [ERROR] Job {job_id} failed: {e}")
        print(traceback.format_exc())
        report_status(job_id, "failed", reason=str(e))
        _current_container = None

    finally:
        _current_container = None
        _current_workspace = None
        _current_job_id = None
        if ws:
            # set DEBUG_KEEP_WORKSPACE=1 to skip cleanup on failure for inspection
            if os.environ.get("DEBUG_KEEP_WORKSPACE") != "1":
                workspace.cleanup(ws)
            else:
                print(f"  [DEBUG] Skipping cleanup — workspace preserved at: {ws}")     


def run_agent():
    print("\nComputeShare Agent")
    print("==================")

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    # prerequisites
    checks = run_all_checks()

    global GPU_ENABLED
    GPU_ENABLED = checks["gpu_available"]

    # load or register
    cfg = config.load()
    if not cfg:
        print("[ERROR] No config found. Run with --token <your-token> to register.")
        sys.exit(1)

    global BACKEND_URL, AUTH_HEADERS, MACHINE_ID
    BACKEND_URL  = cfg["backend_url"]
    MACHINE_ID   = cfg["machine_id"]
    AUTH_HEADERS = {"Authorization": f"Bearer {cfg['agent_token']}"}

    print(f"\nMachine ID : {MACHINE_ID}")
    print(f"Backend    : {BACKEND_URL}\n")

    # start heartbeat in background
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    print("Heartbeat started. Waiting for jobs...\n")

    # main poll loop
    while True:
        try:
            job = fetch_job()
            if job:
                execute_job(job)
            else:
                time.sleep(5)
        except KeyboardInterrupt:
            print("\nAgent stopped by user.")
            sys.exit(0)
        except Exception as e:
            print(f"  [ERROR] Poll loop error: {e}")
            time.sleep(10)   # back off before retrying


def main():
    parser = argparse.ArgumentParser(prog="computeshare-agent")
    sub = parser.add_subparsers(dest="command")

    start_cmd = sub.add_parser("start", help="Start the agent")
    start_cmd.add_argument("--token",   help="Owner token from dashboard (first run only)")
    start_cmd.add_argument("--backend", default="http://localhost:8000")

    sub.add_parser("reset", help="Clear saved config and re-register")

    args = parser.parse_args()

    if args.command == "reset":
        config.clear()
        print("Config cleared. Run `start --token <token>` to re-register.")
        return

    # default to start
    global BACKEND_URL, AUTH_HEADERS, MACHINE_ID
    backend = getattr(args, "backend", "http://localhost:8000")
    token   = getattr(args, "token", None)

    BACKEND_URL = backend

    if token:
        # first run — register then start
        checks = run_all_checks()
        GPU_ENABLED = checks["gpu_available"]
        AUTH_HEADERS = {"Authorization": f"Bearer {token}"}
        cfg = register(token)
        MACHINE_ID = cfg["machine_id"]
        AUTH_HEADERS = {"Authorization": f"Bearer {cfg['agent_token']}"}

    run_agent()


if __name__ == "__main__":
    main()
