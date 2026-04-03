# Runs after prerequisites pass. Detects the actual current state of the machine — not just total capacity, but what's free right now.

import psutil
import subprocess


CPU_RESERVE_CORES = 1       # always leave 1 core for the OS
RAM_RESERVE_GB   = 1.5      # always leave 1.5 GB for the OS + agent


def get_cpu():
    total = psutil.cpu_count(logical=False) or 1
    # sample over 1 second for a real reading, not cached
    used_percent = psutil.cpu_percent(interval=1)
    free_cores = round((1 - used_percent / 100) * total, 2)
    usable = max(0.5, free_cores - CPU_RESERVE_CORES)

    return {
        "total_cores": total,
        "free_cores": free_cores,
        "usable_cores": usable,
    }


def get_ram():
    mem = psutil.virtual_memory()
    total_gb    = mem.total    / 1e9
    available_gb = mem.available / 1e9
    usable_gb   = max(0.5, available_gb - RAM_RESERVE_GB)

    return {
        "total_gb":     round(total_gb, 2),
        "available_gb": round(available_gb, 2),
        "usable_gb":    round(usable_gb, 2),
    }


def get_gpu():
    try:
        out = subprocess.check_output([
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.free,utilization.gpu",
            "--format=csv,noheader,nounits"
        ], text=True, timeout=5).strip()

        name, mem_total, mem_free, util = out.split(", ")
        return {
            "name":          name.strip(),
            "vram_total_mb": int(mem_total),
            "vram_free_mb":  int(mem_free),
            "utilization_pct": int(util),
        }
    except Exception:
        return None


def get_disk():
    usage = psutil.disk_usage("/workspaces") if __import__("os").path.exists("/workspaces") \
            else psutil.disk_usage("/")
    return {
        "free_gb": round(usage.free / 1e9, 2)
    }


def snapshot():
    return {
        "cpu": get_cpu(),
        "ram": get_ram(),
        "gpu": get_gpu(),
        "disk": get_disk(),
    }


def print_summary(res):
    print(f"  CPU  : {res['cpu']['usable_cores']} usable cores "
          f"(of {res['cpu']['total_cores']} total)")
    print(f"  RAM  : {res['ram']['usable_gb']} GB usable "
          f"(of {res['ram']['total_gb']} GB total)")
    if res["gpu"]:
        g = res["gpu"]
        print(f"  GPU  : {g['name']}  "
              f"{g['vram_free_mb']} MB VRAM free "
              f"(of {g['vram_total_mb']} MB)")
    else:
        print("  GPU  : none")
    print(f"  DISK : {res['disk']['free_gb']} GB free")