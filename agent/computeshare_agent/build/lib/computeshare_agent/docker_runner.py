# Takes the job manifest and the live resource snapshot, reconciles them, and builds + runs the exact Docker command for this machine.

import subprocess
import shlex


MIN_VIABLE_CPU_CORES = 0.5
MIN_VIABLE_RAM_GB    = 0.5
GPU_VRAM_HEADROOM_MB = 512

IMAGES = {
    "notebook": "jupyter/scipy-notebook:latest",
    "video": "jrottenberg/ffmpeg:4.4-ubuntu",
}

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
    job_type = job["type"]
    image = IMAGES.get(job_type)
    if not image:
        raise ValueError(f"Unknown job type: {job_type}")

    container_name = f"computeshare_job_{job['id']}"

    cmd = [
        "docker", "run",
        "--name",        container_name,
        "--rm",
        f"--cpus={allocation['cpu']}",
        f"--memory={allocation['ram_gb']}g",
        "--memory-swap", f"{allocation['ram_gb']}g",
        "--network",     "none",
        "--pids-limit",  "512",
        "-v", f"{workspace}/repo:/workspace/repo:ro",
        "-v", f"{workspace}/data:/workspace/data:ro",
        "-v", f"{workspace}/outputs:/workspace/outputs",
        "-v", f"{workspace}/logs:/workspace/logs",
    ]

    # job specific flags
    if allocation["gpu"]:
        cmd += ["--gpus", f"device={allocation['gpu']['device']}"]

    if job_type == "notebook":
        # The 'command' field contains the notebook path
        cmd += [
            image,
            "papermill",
            f"/workspace/repo/{job['command']}",
            "/workspace/outputs/executed.ipynb",
            "--cwd", "/workspace/repo",
            "--log-output",
        ]

    elif job_type == "video":
        cmd += [image, "bash", "-c", job["command"]]

    return cmd, container_name


def run(job, workspace, allocation):
    image = IMAGES[job["type"]]
    pull_image(image)
    
    cmd, container_name = build_command(job, workspace, allocation)
    print(f"\n  Docker command:\n  {' '.join(shlex.quote(c) for c in cmd)}\n")

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
