import sys
import time
import threading
import argparse
import requests
import signal

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
    # print(".", end="", flush=True) # Optional: dots for less noise
    resp = requests.get(
        f"{BACKEND_URL}/api/agent/jobs/next",
        headers=headers(),
        timeout=5
    )
    if resp.status_code == 204:
        return None
    resp.raise_for_status()
    print("\n  [INFO] Job found!")
    return resp.json().get("job")


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
    job_id = job["id"]
    _current_job_id = job_id
    ws = None

    print(f"\n{'─'*50}")
    print(f"  Job {job_id} | type: {job['type']}")
    print(f"{'─'*50}")

    try:
        # 1. snapshot resources and resolve allocation
        res = resources.snapshot()
        allocation = docker_runner.resolve_allocation(job, res)
        viable, reason = docker_runner.is_viable(allocation, job)

        if not viable:
            print(f"  [DEFER] {reason}")
            report_status(job_id, "deferred", reason=reason)
            return

        print(f"  Allocation → CPU: {allocation['cpu']} cores | "
              f"RAM: {allocation['ram_gb']} GB | "
              f"GPU: {'yes' if allocation['gpu'] else 'no'}")

        report_status(job_id, "running", allocation=allocation)

        # 2. prepare workspace
        ws = workspace.create(job_id)
        _current_workspace = ws
        workspace.clone_repo(job["repoUrl"], ws)

        if job.get("dataset_url"):
            workspace.download_file(
                url          = job["dataset_url"],
                workspace    = ws,
                filename     = job.get("dataset_filename", "input"),
                backend_url  = BACKEND_URL,      # needed for Kaggle credential fetch
                agent_headers= headers()         # auth headers for the credential endpoint
            )

        # 3. run Docker container
        _reclaim_flag.clear()
        process, container_name, _ = docker_runner.run(job, ws, allocation)
        _current_container = container_name

        # 4. stream logs
        streamer = LogStreamer(job_id, BACKEND_URL, headers())
        streamer.start()
        exit_code = streamer.ingest(process)   # blocks until container exits

        _current_container = None

        # 5. handle result
        if _reclaim_flag.is_set():
            report_status(job_id, "preempted", reason="Owner reclaimed machine")
            return

        if exit_code != 0:
            report_status(job_id, "failed", reason=f"Container exited with code {exit_code}")
            return

        # 6. upload artifacts
        print("\n  Uploading artifacts...")
        uploaded, failed = artifact_uploader.upload_all(
            job_id, ws, BACKEND_URL, headers()
        )
        print(f"  Uploaded: {len(uploaded)} | Failed: {len(failed)}")

        report_status(job_id, "completed")
        print(f"\n  Job {job_id} completed successfully.\n")

    except Exception as e:
        print(f"\n  [ERROR] Job {job_id} failed: {e}")
        report_status(job_id, "failed", reason=str(e))
        _current_container = None

    finally:
        _current_container = None
        _current_workspace = None
        _current_job_id = None
        if ws:
            workspace.cleanup(ws)


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
