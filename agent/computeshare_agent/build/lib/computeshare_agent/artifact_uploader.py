# After the job exits cleanly, scan the outputs/ folder and upload every file to the backend.

import os
import requests


IGNORED_EXTENSIONS = {".tmp", ".part", ".lock"}
MAX_ARTIFACT_SIZE_MB = 500


def upload_all(job_id, workspace, backend_url, headers):
    outputs_dir = os.path.join(workspace, "outputs")
    uploaded = []
    failed = []

    if not os.path.exists(outputs_dir):
        print("  [WARN] outputs/ directory does not exist")
        return uploaded, failed

    files = [
        f for f in os.listdir(outputs_dir)
        if os.path.isfile(os.path.join(outputs_dir, f))
        and os.path.splitext(f)[1] not in IGNORED_EXTENSIONS
    ]

    if not files:
        print("  [WARN] No output files found in outputs/")
        return uploaded, failed

    for filename in files:
        filepath = os.path.join(outputs_dir, filename)
        size_mb = os.path.getsize(filepath) / 1e6

        if size_mb > MAX_ARTIFACT_SIZE_MB:
            print(f"  [SKIP] {filename} ({size_mb:.1f} MB) exceeds limit")
            failed.append({"file": filename, "reason": "too large"})
            continue

        print(f"  Uploading {filename} ({size_mb:.1f} MB)...", end=" ")

        try:
            with open(filepath, "rb") as f:
                resp = requests.post(
                    f"{backend_url}/api/jobs/{job_id}/artifacts",
                    files={"file": (filename, f)},
                    headers=headers,
                    timeout=120
                )
            resp.raise_for_status()
            artifact_id = resp.json().get("artifact_id")
            uploaded.append({"file": filename, "artifact_id": artifact_id})
            print("OK")

        except Exception as e:
            print(f"FAIL ({e})")
            failed.append({"file": filename, "reason": str(e)})

    return uploaded, failed