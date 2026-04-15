# GridNode Context & Architecture

GridNode is a decentralized compute-sharing platform that allows requesters to submit machine learning (ML) and video rendering jobs, which are then executed on hardware provided by individual nodes (providers) running a local agent.

## System Architecture

### Backend (`be/`)
- **Tech Stack:** Node.js, Express, Prisma (PostgreSQL), Better-Auth for authentication, and Socket.io for real-time log streaming.
- **Scheduling:** Implements **Best Fit (Bin Packing)** combined with a **Trust Score** reputation system. It calculates resource waste and assigns jobs to the tightest fit, using Trust Score as a tie-breaker.
- **State Management:** A background `sweeper` runs periodically to detect dead machines (no heartbeat for 3 mins). It transitions them to `offline`, forcefully fails their active jobs, and applies a Trust Score penalty (-15.0).
- **Artifact Storage:** Uses AWS S3 (or R2) via presigned URLs. The backend brokers access by generating presigned `PUT` URLs for agents and `GET` URLs for requesters, ensuring large files bypass the Node.js server.

### Frontend (`fe/`)
- **Tech Stack:** Next.js (React), Tailwind CSS, Lucide icons.
- **Features:** 
  - Real-time job logs and status updates via Socket.io.
  - Machine dashboard for providers to view their connected nodes, hardware specs, and dynamic statuses (Idle, Running Job, Offline).
  - Job creation modal with detailed resource tiering (CPU, RAM, GPU Memory) and duration estimates.

### Agent (`agent/computeshare_agent/`)
- **Tech Stack:** Python 3.10+, Docker, `psutil`, `requests`.
- **Packaging:** Compiled into a standalone, single-file binary using **PyInstaller**. Providers run an `install.sh` script that installs gVisor, Docker, and places the binary in `/usr/local/bin/computeshare-agent`.
- **Execution Flow:**
  1. **Polling:** Polls `/api/agent/jobs/next`.
  2. **Workspace Setup:** Creates isolated workspaces locally (e.g., `~/.computeshare/workspaces/job_X`).
  3. **Data Ingestion:** Intelligently handles Kaggle datasets (via CLI and temporary backend-provided credentials), normalizes GitHub blob URLs, and automatically extracts ZIP/tar.gz archives while guarding against Zip Slip vulnerabilities.
  4. **Dependency Installation:** If a `requirements.txt` is present, it boots an ephemeral container with network access to install pip packages into a dedicated Docker volume.
  5. **Secure Execution:** 
     - **CPU Jobs:** Run inside a **gVisor (`runsc`)** microVM sandbox for kernel-level protection.
     - **GPU Jobs:** Fall back to standard `runc` to support CUDA/NVIDIA passthrough.
     - All jobs execute with `--network none`, `--security-opt no-new-privileges`, and read-only volume mounts for data and code.
  6. **Teardown:** Listens for `SIGINT`/`SIGTERM` to gracefully stop running containers, delete the workspace from disk, and notify the backend of the preemption.

## Core Mandates & Conventions

- **Security First:** The agent executes untrusted code. Never bypass the `--network none` or gVisor (`runsc`) sandboxing for CPU jobs.
- **Database Consistency:** Always use `prisma.$transaction` when updating interconnected state (e.g., Machine status, Job status, AgentSession).
- **Reputation (Trust Score):** Machines start at 50.0. Successful jobs grant +2.0. Sweeper disconnects while holding a job result in -15.0. 
- **Error Handling:** Ensure that job failures or machine preemptions consistently create a `JobEvent` so the requester has an audit trail of what went wrong.