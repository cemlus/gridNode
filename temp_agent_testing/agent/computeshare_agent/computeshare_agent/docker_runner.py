# Takes the job manifest and the live resource snapshot, reconciles them, and builds + runs the exact Docker command for this machine.

import subprocess
import shlex


MIN_VIABLE_CPU_CORES = 0.5
MIN_VIABLE_RAM_GB    = 0.5
GPU_VRAM_HEADROOM_MB = 512

IMAGES = {
    "ml_notebook":  "jupyter/scipy-notebook:latest",
    "video_render": "jrottenberg/ffmpeg:4.4-ubuntu",
}



def resolve_allocation(job, resources):
    """
    job says what it wants.
    resources says what the machine has.
    this function produces what Docker will actually get.
    """
    cpu_alloc = min(job["cpu_request"], resources["cpu"]["usable_cores"])
    ram_alloc = min(job["ram_request_gb"], resources["ram"]["usable_gb"])

    cpu_alloc = max(cpu_alloc, MIN_VIABLE_CPU_CORES)
    ram_alloc = max(ram_alloc, MIN_VIABLE_RAM_GB)

    gpu_alloc = None
    if job.get("gpu_required") and resources["gpu"]:
        gpu = resources["gpu"]
        needed_mb = job.get("gpu_vram_mb", 2048)
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
    if job.get("gpu_required") and allocation["gpu"] is None:
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



# def build_command(job, workspace, allocation):
#     job_type = job["type"]
#     image = IMAGES.get(job_type)
#     if not image:
#         raise ValueError(f"Unknown job type: {job_type}")

#     container_name = f"computeshare_job_{job['job_id']}"

#     cmd = [
#         "docker", "run",
#         "--name",   container_name,
#         "--rm",                                          # auto-remove after exit
#         f"--cpus={allocation['cpu']}",
#         f"--memory={allocation['ram_gb']}g",
#         "--memory-swap", f"{allocation['ram_gb']}g",    # disable swap
#         "--network", "none",                             # no internet inside
#         "--pids-limit", "512",                           # limit process spawning

#         # workspace mounts
#         "-v", f"{workspace}/repo:/workspace/repo:ro",
#         "-v", f"{workspace}/data:/workspace/data:ro",
#         "-v", f"{workspace}/outputs:/workspace/outputs",
#         "-v", f"{workspace}/logs:/workspace/logs",
#     ]

#     # GPU flag only if actually allocated
#     if allocation["gpu"]:
#         cmd += ["--gpus", f"device={allocation['gpu']['device']}"]

#     # Job-type-specific image + entrypoint
#     job_type = job["type"]

#     if job_type == "ml_notebook":
#         cmd += [
#             "your-registry/ml-base:latest",
#             "papermill",
#             f"/workspace/repo/{job['notebook_path']}",
#             "/workspace/outputs/executed.ipynb",
#             "--cwd", "/workspace/repo",
#             "--log-output",
#         ]

#     elif job_type == "video_render":
#         # command is a pre-validated FFmpeg string from the job manifest
#         cmd += [
#             "jrottenberg/ffmpeg:4.4-ubuntu",
#             "bash", "-c", job["command"]
#         ]

#     else:
#         raise ValueError(f"Unknown job type: {job_type}")

#     return cmd, container_name

def build_command(job, workspace, allocation):
    job_type = job["type"]
    image = IMAGES.get(job_type)
    if not image:
        raise ValueError(f"Unknown job type: {job_type}")

    container_name = f"computeshare_job_{job['job_id']}"

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

    if job_type == "ml_notebook":
        cmd += [
            image,
            "papermill",
            f"/workspace/repo/{job['notebook_path']}",
            "/workspace/outputs/executed.ipynb",
            "--cwd", "/workspace/repo",
            "--log-output",
        ]

    elif job_type == "video_render":
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