# Takes the job manifest and the live resource snapshot, reconciles them, and builds + runs the exact Docker command for this machine.

import subprocess
import shlex

MIN_VIABLE_CPU_CORES = 0.5
MIN_VIABLE_RAM_GB    = 0.5
GPU_VRAM_HEADROOM_MB = 512

IMAGE_REGISTRY = {
    "ml_notebook": {
        "image":      "siddhantbh/gridnode-ml-base:latest",
        "gpu_image":  "siddhantbh/gridnode-ml-gpu:latest",   # used if job requests GPU
        "network":    "none",                      # no internet needed
        "entrypoint": None,                        # use image default
    },
    "video_render": {
        "image":      "siddhantbh/gridnode-video:latest",
        "gpu_image":  None,                        # no GPU variant for video
        "network":    "none",
        "entrypoint": None,
    },
    "server_run": {
        "image":      "siddhantbh/gridnode-server-runner:latest",
        "gpu_image":  None,
        "network":    "bridge",    # servers need network — proxied through agent
        "entrypoint": None,
    },
    "data_processing": {
        "image":      "siddhantbh/gridnode-data-processing:latest",
        "gpu_image":  None,
        "network":    "none",
        "entrypoint": None,
    },
}

def get_image_config(job):
    job_type = job["type"]
    config   = IMAGE_REGISTRY.get(job_type)

    if not config:
        raise ValueError(
            f"Unknown job type: '{job_type}'. "
            f"Supported types: {list(IMAGE_REGISTRY.keys())}"
        )

    # select GPU image if job requests it and a GPU variant exists
    if job.get("gpu_required") and config["gpu_image"]:
        image = config["gpu_image"]
    else:
        image = config["image"]

    return {**config, "resolved_image": image}


def resolve_allocation(job, resources):
    """
    job says what it wants.
    resources says what the machine has.
    this function produces what Docker will actually get.
    """
    # Backend now uses tiers (CpuTier, MemoryTier), so we need to map them
    cpu_request = job.get("cpu_request")
    if cpu_request is None:
        tier_map = {"light": 1, "medium": 2, "heavy": 4}
        cpu_request = tier_map.get(job.get("cpuTier"), 1)

    ram_request_gb = job.get("ram_request_gb")
    if ram_request_gb is None:
        tier_map = {"gb8": 4, "gb16": 8, "gb32": 16, "gb64": 32}
        ram_request_gb = tier_map.get(job.get("memoryTier"), 4)

    cpu_alloc = min(cpu_request, resources["cpu"]["usable_cores"])
    ram_alloc = min(ram_request_gb, resources["ram"]["usable_gb"])

    cpu_alloc = max(cpu_alloc, MIN_VIABLE_CPU_CORES)
    ram_alloc = max(ram_alloc, MIN_VIABLE_RAM_GB)

    gpu_alloc = None
    # Check if GPU is required based on gpuMemoryTier
    gpu_required = job.get("gpuMemoryTier") is not None
    if gpu_required and resources["gpu"]:
        gpu = resources["gpu"]
        # Simplified mapping for GPU memory tier to MB
        vram_map = {
            "gb8": 8192, "gb12": 12288, "gb16": 16384, 
            "gb24": 24576, "gb32": 32768, "gb48": 49152
        }
        needed_mb = vram_map.get(job.get("gpuMemoryTier"), 2048)
        if gpu["vram_free_mb"] >= needed_mb + GPU_VRAM_HEADROOM_MB:
            gpu_alloc = {"device": 0, "vram_mb": needed_mb}

    return {
        "cpu":    round(cpu_alloc, 1),
        "ram_gb": round(ram_alloc, 1),
        "gpu":    gpu_alloc,
    }


def is_viable(allocation, job):
    if allocation["cpu"] < MIN_VIABLE_CPU_CORES:
        return False, "Not enough CPU available right now"
    if allocation["ram_gb"] < MIN_VIABLE_RAM_GB:
        return False, "Not enough RAM available right now"
    
    gpu_required = job.get("gpuMemoryTier") is not None
    if gpu_required and allocation["gpu"] is None:
        return False, "GPU required but not available or insufficient VRAM"
    return True, None


def pull_image(image):
    print(f"  Pulling image {image}...", end=" ")
    result = subprocess.run(
        ["docker", "pull", image],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"docker pull failed:\n{result.stderr}")
    print("OK")


def build_command(job, workspace, allocation):
    config         = get_image_config(job)
    image          = config["resolved_image"]
    network        = config["network"]
    container_name = f"gridnode_job_{job['job_id']}"


    cmd = [
        "docker", "run",
        "--name",        container_name,
        "--rm",
        f"--cpus={allocation['cpu']}",
        f"--memory={allocation['ram_gb']}g",
        "--memory-swap", f"{allocation['ram_gb']}g",
        "--network",     network,
        "--pids-limit",  "512",
        "--security-opt", "no-new-privileges",
        "-v", f"{workspace}/repo:/workspace/repo:ro",
        "-v", f"{workspace}/data/input:/workspace/data:ro",
        "-v", f"{workspace}/outputs:/workspace/outputs",
        "-v", f"{workspace}/logs:/workspace/logs",
    ]

    if allocation.get("gpu"):
        cmd += ["--gpus", f"device={allocation['gpu']['device']}"]

    # job-type-specific entrypoints
    entrypoint_args = build_entrypoint(job, config)
    cmd += [image] + entrypoint_args

    return cmd, container_name

def build_entrypoint(job, config):
    job_type = job["type"]

    if job_type == "ml_notebook":
        return [
            "papermill",
            f"/workspace/repo/{job['notebook_path']}",
            "/workspace/outputs/executed.ipynb",
            "-p", "DATA_DIR",    "/workspace/data",
            "-p", "OUTPUT_DIR",  "/workspace/outputs",
            "--cwd",             "/workspace/repo",
            "--log-output",
        ]

    if job_type == "video_render":
        # command is a validated FFmpeg string from the job manifest
        return ["bash", "-c", job["command"]]

    if job_type == "server_run":
        #?? to be looked into ----------------------------------------------
        return ["bash", "/workspace/repo/start.sh"]                 
        # runs a startup script from the repo

    if job_type == "data_processing":
        return [
            "python3",
            f"/workspace/repo/{job['script_path']}",
            "--data-dir",   "/workspace/data",
            "--output-dir", "/workspace/outputs",
        ]

    raise ValueError(f"No entrypoint defined for job type: {job_type}")


def run(job, workspace, allocation):
    config = get_image_config(job)
    pull_image(config["resolved_image"])

    cmd, container_name = build_command(job, workspace, allocation)
    print(f"\n  Image   : {config['resolved_image']}")
    print(f"  Network : {config['network']}")
    print(f"  Command : {' '.join(shlex.quote(c) for c in cmd)}\n")

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )
    return process, container_name


def stop_container(container_name):
    subprocess.run(
        ["docker", "stop", "--time", "5", container_name],
        capture_output=True
    )
