# Prepares the working directory, clones the repo, and downloads the dataset or video file.

import os
import shutil
import subprocess
import requests
from tqdm import tqdm


def create(job_id):
    os.makedirs("/workspaces", exist_ok=True)
    base = f"/workspaces/job_{job_id}"
    for sub in ["repo", "data", "outputs", "logs"]:
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    return base


def clone_repo(repo_url, workspace):
    target = os.path.join(workspace, "repo")
    print(f"  Cloning {repo_url}...", end=" ")
    result = subprocess.run(
        ["git", "clone", "--depth", "1", repo_url, target],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"git clone failed: {result.stderr}")
    print("OK")


def download_file(url, workspace, filename):
    dest = os.path.join(workspace, "data", filename)
    print(f"  Downloading {filename}...")

    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with open(dest, "wb") as f, tqdm(total=total, unit="B", unit_scale=True) as bar:
            for chunk in r.iter_content(chunk_size=65536):
                f.write(chunk)
                bar.update(len(chunk))

    print(f"  Saved to {dest}")
    return dest


def cleanup(workspace):
    if os.path.exists(workspace):
        shutil.rmtree(workspace)
        print(f"  Cleaned up {workspace}")