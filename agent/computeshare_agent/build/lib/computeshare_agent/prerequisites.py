# This runs before anything else. It checks Python version, Docker, and optionally NVIDIA Docker. If anything fails it prints a clear fix and exits — it never silently continues.

import sys
import shutil
import subprocess
import importlib


def check_python_version():
    print("  Checking Python version...", end=" ")
    major = sys.version_info.major
    minor = sys.version_info.minor

    if major < 3 or (major == 3 and minor < 9):
        print("FAIL")
        print(f"\n  [ERROR] Python 3.9+ is required. You have {major}.{minor}.")
        print("  Fix: https://www.python.org/downloads/")
        sys.exit(1)

    print(f"OK (Python {major}.{minor})")


def check_docker():
    print("  Checking Docker...", end=" ")

    if shutil.which("docker") is None:
        print("FAIL")
        print("\n  [ERROR] Docker is not installed or not on PATH.")
        print("  Fix: https://docs.docker.com/get-docker/")
        sys.exit(1)

    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            print("FAIL")
            print("\n  [ERROR] Docker is installed but the daemon is not running.")
            print("  Fix: Start Docker Desktop, or run: sudo systemctl start docker")
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print("FAIL")
        print("\n  [ERROR] Docker daemon did not respond in time.")
        sys.exit(1)

    print("OK")


def check_nvidia_docker():
    print("  Checking NVIDIA Docker runtime...", end=" ")

    if shutil.which("nvidia-smi") is None:
        print("SKIP (no NVIDIA GPU detected — CPU-only mode)")
        return False

    try:
        result = subprocess.run(
            ["docker", "run", "--rm", "--gpus", "all",
             "nvidia/cuda:12.0-base-ubuntu22.04", "nvidia-smi"],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            print("WARN")
            print("  [WARN] GPU found but nvidia-container-toolkit is not set up.")
            print("  GPU jobs will not be accepted on this machine.")
            print("  Fix: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html")
            return False
    except subprocess.TimeoutExpired:
        print("WARN (nvidia-docker check timed out)")
        return False

    print("OK (GPU sharing enabled)")
    return True


def install_dependencies():
    import os
    
    # go up one level from computeshare_agent/ to find requirements.txt
    package_dir = os.path.dirname(__file__)
    project_root = os.path.dirname(package_dir)
    req_path = os.path.join(project_root, "requirements.txt")

    if not os.path.exists(req_path):
        print("SKIP (requirements.txt not found)")
        return

    print("  Installing dependencies...", end=" ")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", req_path, "-q"],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        print("FAIL")
        print(f"\n  [ERROR] pip install failed:\n{result.stderr}")
        sys.exit(1)

    print("OK")


def run_all_checks():
    print("\n=== Checking prerequisites ===\n")
    check_python_version()
    install_dependencies()
    check_docker()
    gpu_available = check_nvidia_docker()
    print("\n=== All checks passed ===\n")
    return {"gpu_available": gpu_available}