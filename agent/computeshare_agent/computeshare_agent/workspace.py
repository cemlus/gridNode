# Prepares the working directory, clones the repo, and downloads the dataset or video file.

import os
import re
import sys
import json
import shutil
import hashlib
import tarfile
import zipfile
import subprocess
import mimetypes
import requests
from tqdm import tqdm


WORKSPACE_ROOT   = os.environ.get("COMPUTESHARE_WORKSPACE_ROOT",
                                   os.path.expanduser("~/.computeshare/workspaces"))
DOWNLOAD_TIMEOUT = 120           # seconds for initial connection
STREAM_TIMEOUT   = (10, 60)      # (connect, read) timeouts for streaming
CHUNK_SIZE       = 8 * 1024 * 1024  # 8 MB chunks
MAX_DATASET_SIZE_GB = 20


def create(job_id):
    os.makedirs(WORKSPACE_ROOT, exist_ok=True)
    base = os.path.join(WORKSPACE_ROOT, f"job_{job_id}")
    for sub in ["repo", "repo_writable", "data", "data/input", "outputs", "logs"]:
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    print(f"  Workspace: {base}")
    return base


def cleanup(workspace):
    if os.path.exists(workspace):
        shutil.rmtree(workspace)
        print(f"  Cleaned up {workspace}")


# GitHub blob URLs -> converted to raw URLs automatically
def normalise_github_url(url):
    """
    Convert any GitHub web URL to its raw content equivalent.

    GitHub blob URLs (what you see when browsing files):
      https://github.com/user/repo/blob/main/data/train.csv
      → https://raw.githubusercontent.com/user/repo/main/data/train.csv

    GitHub "Download" button URLs already work — leave them alone:
      https://raw.githubusercontent.com/...   → unchanged
      https://github.com/user/repo/releases/download/...  → unchanged
    """
    blob_pattern = re.compile(
        r"https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.*)"
    )
    match = blob_pattern.match(url)
    if match:
        user, repo, branch, path = match.groups()
        raw = f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{path}"
        print(f"  [URL] Converted GitHub blob → raw: {raw}")
        return raw
    return url


def is_kaggle_url(url):
    return "kaggle.com/datasets/" in url or "kaggle.com/c/" in url


def extract_kaggle_slug(url):
    """
    Pull the dataset slug (name of the dataset) out of a Kaggle URL.
    """
    pattern = re.compile(r"kaggle\.com/datasets/([^/]+/[^/?#]+)")
    match = pattern.search(url)
    if not match:
        raise ValueError(f"Could not extract Kaggle dataset slug from: {url}")
    return match.group(1)


def setup_kaggle_credentials(backend_url, agent_headers):
    resp = requests.get(
        f"{backend_url}/api/agent/kaggle-credentials",
        headers=agent_headers,
        timeout=10
    )

    if resp.status_code == 503:
        raise RuntimeError(
            "Kaggle credentials are not configured on this platform. "
            "Ask the platform admin to add KAGGLE_USERNAME and KAGGLE_KEY."
        )

    resp.raise_for_status()
    creds = resp.json()

    kaggle_dir  = os.path.expanduser("~/.kaggle")
    creds_path  = os.path.join(kaggle_dir, "kaggle.json")
    os.makedirs(kaggle_dir, exist_ok=True)

    with open(creds_path, "w") as f:
        json.dump({
            "username": creds["username"],
            "key":      creds["key"]
        }, f)

    # kaggle CLI requires the file to be owner-readable only
    os.chmod(creds_path, 0o600)
    return creds_path


def remove_kaggle_credentials(creds_path):
    if os.path.exists(creds_path):
        os.remove(creds_path)
        print("  [Kaggle] Credentials removed from disk")


def sanitise_data_filenames(input_dir):
    """Rename files with spaces to use underscores — prevents gVisor/shell issues."""
    for filename in os.listdir(input_dir):
        if " " in filename:
            safe_name = filename.replace(" ", "_")
            os.rename(
                os.path.join(input_dir, filename),
                os.path.join(input_dir, safe_name)
            )
            print(f"  [Workspace] Renamed: {filename!r} → {safe_name!r}")


def download_kaggle_dataset(url, workspace, backend_url, agent_headers):
    """
    Download a Kaggle dataset using the official Kaggle CLI.
    Credentials are fetched from the backend, used, then deleted.
    """
    slug       = extract_kaggle_slug(url)
    dest_dir   = os.path.join(workspace, "data")
    creds_path = None

    print(f"  [Kaggle] Dataset: {slug}")

    try:
        # write credentials
        creds_path = setup_kaggle_credentials(backend_url, agent_headers)
        print(f"  [Kaggle] Credentials configured")

        # check kaggle CLI is available
        if shutil.which("kaggle") is None:
            raise RuntimeError(
                "kaggle CLI not found. Run: pip install kaggle"
            )
                
        print(f"  [Kaggle] Downloading {slug}...")
        result = subprocess.run(
            [
                "kaggle", "datasets", "download",
                "--dataset", slug,
                "--path",    dest_dir,
                "--unzip",                   # extract automatically
            ],
            capture_output=True,
            text=True,
            timeout=600                      # 10 minutes for large datasets
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"kaggle CLI failed:\n"
                f"stdout: {result.stdout}\n"
                f"stderr: {result.stderr}"
            )

        print(f"  [Kaggle] Download complete")

        # move extracted files into data/input/ for consistency
        _normalise_into_input_dir(dest_dir)
        sanitise_data_filenames(os.path.join(dest_dir, "input"))  
        return dest_dir

    finally:
        # always clean up credentials whether download succeeded or not
        if creds_path:
            remove_kaggle_credentials(creds_path)


def detect_file_type(filepath): 
    with open(filepath, "rb") as f:
        header = f.read(8)
     # ZIP: PK signature
    if header[:4] == b"PK\x03\x04":
        return "zip"

    # gzip (covers .tar.gz and .gz)
    if header[:2] == b"\x1f\x8b":
        return "gzip"

    # bzip2
    if header[:3] == b"BZh":
        return "bzip2"

    # tar without compression (rare but valid)
    if header[0:5] == b"ustar":
        return "tar"

    return "raw"


def detect_likely_html(filepath):
    try:
        with open(filepath, "rb") as f:
            # read first 512 bytes
            start = f.read(512).lower()
        return b"<!doctype html" in start or b"<html" in start
    except Exception:
        return False
    

def verify_size(filepath):
    size_gb = os.path.getsize(filepath) / 1e9
    if size_gb > MAX_DATASET_SIZE_GB:
        raise RuntimeError(
            f"Downloaded file is {size_gb:.1f} GB which exceeds the "
            f"{MAX_DATASET_SIZE_GB} GB limit."
        )


def extract_archive(filepath, dest_dir):
    """
    Extract a ZIP or tar.gz into dest_dir.
    Handles nested single-directory archives by flattening them.
    Returns the list of extracted file paths.
    """
    file_type = detect_file_type(filepath)
    print(f"  [Extract] Detected archive type: {file_type}")

    extracted = []

    if file_type == "zip":
        with zipfile.ZipFile(filepath, "r") as zf:
            # security: reject zip-slip paths
            for member in zf.namelist():
                target = os.path.realpath(os.path.join(dest_dir, member))
                if not target.startswith(os.path.realpath(dest_dir)):
                    raise RuntimeError(f"Zip slip detected in member: {member}")
            zf.extractall(dest_dir)
            extracted = zf.namelist()

    elif file_type in ("gzip", "bzip2", "tar"):
        mode_map = {"gzip": "r:gz", "bzip2": "r:bz2", "tar": "r:"}
        with tarfile.open(filepath, mode_map[file_type]) as tf:
            # security: reject tar-slip paths
            for member in tf.getmembers():
                target = os.path.realpath(os.path.join(dest_dir, member.name))
                if not target.startswith(os.path.realpath(dest_dir)):
                    raise RuntimeError(f"Tar slip detected in: {member.name}")
            tf.extractall(dest_dir)
            extracted = [m.name for m in tf.getmembers()]

    print(f"  [Extract] Extracted {len(extracted)} file(s)")

    os.remove(filepath)
    return extracted


def _normalise_into_input_dir(data_dir):
    """
    After extraction, ensure all files end up directly in data/input/
    rather than in a nested subdirectory.

    Handles the common Kaggle pattern where the ZIP contains a single
    subdirectory: data/yasserh-housing-prices-dataset/Housing.csv
    → data/input/Housing.csv
    """
    input_dir = os.path.join(data_dir, "input")
    os.makedirs(input_dir, exist_ok=True)

    entries = [
        e for e in os.listdir(data_dir)
        if e != "input"
    ]

    # if there's exactly one subdirectory, flatten it
    if len(entries) == 1:
        single = os.path.join(data_dir, entries[0])
        if os.path.isdir(single):
            for item in os.listdir(single):
                shutil.move(
                    os.path.join(single, item),
                    os.path.join(input_dir, item)
                )
            shutil.rmtree(single)
            return

    # otherwise move everything into input/
    for entry in entries:
        shutil.move(
            os.path.join(data_dir, entry),
            os.path.join(input_dir, entry)
        )


def download_file(url, workspace, filename, backend_url=None, agent_headers=None):
    """
    Main entry point for all dataset downloads.

    Routing logic:
      1. Kaggle URL → use Kaggle CLI (requires backend_url + agent_headers)
      2. GitHub blob URL → convert to raw URL, then generic download
      3. Everything else → generic streaming download

    After download, archives are automatically extracted.
    HTML responses (auth redirects) are detected and rejected.
    """
    # route Kaggle URLs through the CLI
    if is_kaggle_url(url):
        if not backend_url or not agent_headers:
            raise RuntimeError(
                "Kaggle URL detected but backend_url/agent_headers "
                "not provided to download_file()."
            )
        return download_kaggle_dataset(url, workspace, backend_url, agent_headers)

    # normalise GitHub blob URLs
    url = normalise_github_url(url)

    # generic streaming download
    input_dir = os.path.join(workspace, "data", "input")
    dest_path = os.path.join(input_dir, filename)

    print(f"  Downloading {filename}...")
    print(f"  URL: {url}")

    resp = requests.get(
        url,
        stream=True,
        timeout=STREAM_TIMEOUT,
        headers={
            # some servers reject requests without a user-agent
            "User-Agent": "ComputeShare-Agent/1.0"
        },
        allow_redirects=True
    )

    # catch auth redirects that return 200 with HTML body
    content_type = resp.headers.get("Content-Type", "")
    if "text/html" in content_type:
        raise RuntimeError(
            f"Server returned HTML instead of a file. "
            f"This URL likely requires authentication.\n"
            f"URL: {url}\n"
            f"If this is a Kaggle dataset, use the Kaggle dataset URL format:\n"
            f"  https://www.kaggle.com/datasets/username/dataset-name"
        )

    resp.raise_for_status()

    total_bytes = int(resp.headers.get("content-length", 0))
    total_gb    = total_bytes / 1e9
    if total_bytes and total_gb > MAX_DATASET_SIZE_GB:
        raise RuntimeError(
            f"Dataset is {total_gb:.1f} GB — exceeds {MAX_DATASET_SIZE_GB} GB limit"
        )

    # stream to disk
    with open(dest_path, "wb") as f, tqdm(
        total=total_bytes or None,
        unit="B",
        unit_scale=True,
        desc=filename,
        leave=False
    ) as bar:
        for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
            f.write(chunk)
            bar.update(len(chunk))

    print(f"  Downloaded: {os.path.getsize(dest_path) / 1e6:.1f} MB")

    # reject HTML disguised as data (Kaggle login redirect, etc.)
    if detect_likely_html(dest_path):
        os.remove(dest_path)
        raise RuntimeError(
            f"Downloaded file appears to be an HTML page, not a dataset.\n"
            f"URL: {url}\n"
            f"This usually means the URL requires authentication or has expired.\n"
            f"For Kaggle datasets, use the full dataset URL:\n"
            f"  https://www.kaggle.com/datasets/username/dataset-name"
        )

    verify_size(dest_path)

    # extract if archive
    file_type = detect_file_type(dest_path)
    if file_type != "raw":
        print(f"  Archive detected ({file_type}) — extracting...")
        extract_archive(dest_path, input_dir)
    else:
        print(f"  File type: raw data (no extraction needed)")

    # show what ended up in input/
    sanitise_data_filenames(input_dir)
    _print_input_contents(input_dir)
    return input_dir


def _print_input_contents(input_dir):
    files = []
    for root, _, filenames in os.walk(input_dir):
        for f in filenames:
            full = os.path.join(root, f)
            rel  = os.path.relpath(full, input_dir)
            size = os.path.getsize(full) / 1e6
            files.append((rel, size))

    print(f"\n  Data directory contents ({len(files)} file(s)):")
    for name, size in sorted(files):
        print(f"    {name:<40} {size:.2f} MB")
    print()


def clone_repo(repo_url, workspace):
    target = os.path.join(workspace, "repo")
    writable_target = os.path.join(workspace, "repo_writable")

    if os.listdir(target):
        shutil.rmtree(target)
        os.makedirs(target)

    print(f"  Cloning {repo_url}...", end=" ", flush=True)
    result = subprocess.run(
        ["git", "clone", "--depth", "1", repo_url, target],
        capture_output=True,
        text=True,
        timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(f"git clone failed:\n{result.stderr}")
    print("OK")

    if os.path.exists(writable_target):
        shutil.rmtree(writable_target)
    shutil.copytree(target, writable_target)
    print(f"  Created writable repo copy at {writable_target}")
    return target


def resolve_repo_file(workspace, requested_path, allowed_extensions=None):
    repo_root = os.path.join(workspace, "repo_writable")
    normalized = (requested_path or "").strip().lstrip("/").replace("\\", "/")

    if normalized:
        direct_path = os.path.join(repo_root, normalized)
        if os.path.exists(direct_path):
            return direct_path, normalized

    matches = []
    for root, _, files in os.walk(repo_root):
        for name in files:
            rel_path = os.path.relpath(os.path.join(root, name), repo_root)
            rel_path = rel_path.replace(os.sep, "/")
            if allowed_extensions and not rel_path.endswith(allowed_extensions):
                continue
            matches.append(rel_path)

    preview = ", ".join(matches[:10])
    if len(matches) > 10:
        preview += ", ..."
    raise FileNotFoundError(
        f"Could not find repo file {requested_path!r} in {repo_root}. "
        f"Available candidates: {preview}"
    )
