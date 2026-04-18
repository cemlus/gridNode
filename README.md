# GridNode

GridNode is a distributed compute platform for running user-submitted jobs on provider-owned machines without giving requesters direct host access. A requester submits a job, a provider approves it, the backend tracks scheduling and state, and the local `computeshare-agent` executes the work inside Docker on the provider's machine.

This repository contains the full stack:

- a Next.js frontend for requesters and providers
- an Express + Prisma backend for auth, jobs, approvals, machines, logs, and artifacts
- a Python agent that registers machines, polls for work, runs Docker containers, streams logs, and uploads outputs
- Docker runner images for notebook, video, server, and data-processing workloads

## How GridNode Works

1. A requester signs in and creates a compute job with specific resource tier requirements (CPU, RAM, GPU).
2. The backend uses a **Best Fit (Bin Packing)** algorithm combined with a **Trust Score** system to match that job to the most suitable idle machine, and routes it to the provider for approval.
3. The provider reviews pending work and approves or rejects it.
4. The provider's local `computeshare-agent` polls for assigned jobs.
5. The agent prepares a workspace, safely runs the job in Docker (using **gVisor** for CPU jobs and `runc` for GPU jobs, both completely air-gapped with `--network none`), streams logs, and uploads artifacts via direct S3 presigned URLs.
6. The frontend shows job state, live logs, approvals, machines, and output artifacts.

## Repository Overview

```text
gridNode/
├── fe/                         # Next.js frontend
├── be/                         # Express + Prisma backend
├── agent/computeshare_agent/   # Python agent, installer, tests, build scripts
├── docker/                     # Workload runner images
└── README.md
```

### Main parts of the repo

- `fe/`
  Requester/provider UI built with Next.js 16, React 19, Tailwind, and shadcn/ui.
- `be/`
  Control plane built with Express, Prisma, PostgreSQL, Better Auth, Socket.IO, and S3 helpers.
- `agent/computeshare_agent/`
  Owner-side agent CLI and runtime. This is the code behind `computeshare-agent`.
- `docker/`
  Base images and workload-specific runner images used by the agent.

## Current Capabilities

The repo already contains working code for:

- Google-based sign-in via Better Auth
- job creation, listing, filtering, detail pages, and stop actions
- provider approval and rejection flows
- machine registration, listing, and reclaim actions
- live job logs and artifact views in the frontend
- agent registration and long-lived session token creation
- agent heartbeat, job polling, job status updates, artifact registration, and log ingestion
- Docker-based execution plumbing for notebook, video, server, and data-processing jobs

## Architecture Snapshot

- Frontend:
  Next.js app for login, dashboard, jobs, approvals, and machines.
- Backend:
  Source of truth for users, machines, approvals, jobs, logs, and artifacts. Responsible for **Best Fit Bin-Packing** matchmaking, Trust Score management, background sweepers for dead nodes, and generating AWS S3 presigned URLs for artifact brokering.
- Agent:
  Execution plane running on the provider's machine. Handles secure sandboxed execution using **gVisor (`runsc`)** for microVM kernel-level protection on CPU jobs and `runc` for GPU jobs, along with workspace preparation and data ingestion (including Kaggle datasets and GitHub repositories).
- Docker images:
  Workload runtimes stored under `docker/`. Containers run isolated without network access (`--network none`) to prevent malicious activity.

At a high level, the backend owns coordination and state, while the agent strictly performs secure execution on provider hardware.

## Local Development Quickstart

### Prerequisites

- Node.js
- npm
- PostgreSQL accessible through `DATABASE_URL`
- Google OAuth credentials for Better Auth if you want login to work end-to-end
- Docker if you plan to run or test the agent

### Backend

```bash
cd be
npm install
cp .env.example .env
```

Set at least these values in `be/.env`:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL=http://localhost:3005`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Optional env vars already supported in the repo include AWS and Kaggle credentials:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_BUCKET_NAME`
- `KAGGLE_USERNAME`
- `KAGGLE_API_TOKEN`

Then start the backend:

```bash
cd be
npx prisma generate
npx prisma migrate dev
npm run dev
```

The backend listens on `http://localhost:3005`.

### Frontend

```bash
cd fe
npm install
npm run dev
```

The frontend runs on `http://localhost:3000`.

By default, the frontend talks to the backend at `http://localhost:3005`.

## New User: Connect Your Machine

If you want to provide compute to GridNode, this is the current Linux-first flow:

1. Start the frontend and backend.
2. Sign in through the web app.
3. Open the machines page at `/machines`.
4. Generate or copy your personal agent registration key.
5. Install the agent locally on the machine you want to connect.
6. Run the agent for first-time registration:

```bash
computeshare-agent start --token <your-agent-key> --backend http://localhost:3005
```

On first run, the agent registers the machine and stores its long-lived config locally. After that, you can start it without the one-time registration key:

```bash
computeshare-agent start
```

## Agent Install Details

The current agent onboarding is repo-based and Linux-first. It is not yet packaged as a polished public download or release flow.

### What the current Linux installer expects

- Python `3.9+`
- Docker installed and available on `PATH`
- `sudo` access for system-level setup
- an Ubuntu/Debian-style environment with `apt-get`, because the installer sets up `runsc`/gVisor and restarts Docker

### Current install path in this repo

The installer lives at `agent/computeshare_agent/install.sh`, and it expects a built binary at:

```text
agent/computeshare_agent/dist/computeshare-agent
```

That means the current flow is:

```bash
cd agent/computeshare_agent
./build.sh
./install.sh
```

After installation, start the agent with:

```bash
computeshare-agent start --token <your-agent-key> --backend http://localhost:3005
```

On later runs:

```bash
computeshare-agent start
```

### What the installer does

- verifies Python and Docker
- installs `runsc` / gVisor
- restarts Docker
- copies the built `computeshare-agent` binary into `/usr/local/bin`

### Windows note

There is also a Windows installer stub at `agent/computeshare_agent/install.bat`, but the Linux flow is the more current path reflected by this repo and its system setup assumptions.

## API and Product Surface

Some of the main user- and agent-facing flows exposed by the repo are:

- `/machines`
  generate a personal machine registration key and manage connected machines
- `/jobs`
  create, view, filter, and stop jobs
- `/approvals`
  review and decide pending provider approvals
- `computeshare-agent start --token <key> --backend <url>`
  first-run machine registration
- `computeshare-agent start`
  subsequent agent startup using saved config

## Known Gaps and Current Limitations

- The agent install/distribution story is still rough and repo-oriented.
- Some older docs in the repo still describe parts of the system as planned or use outdated paths.
- The agent defaults to `http://localhost:8000` if `--backend` is omitted, while the backend in this repo runs on `http://localhost:3005`, so the README should always use the explicit backend flag for local setup.
- The project still has hackathon-level edges around packaging, hardening, and cross-platform polish.

## Tech Stack

- Frontend: Next.js 16, React 19, Tailwind CSS, shadcn/ui
- Backend: Express, TypeScript, Prisma, PostgreSQL, Better Auth, Socket.IO
- Agent: Python
- Execution: Docker plus workload-specific images under `docker/`

## Why This README Exists

This root README is the canonical repo-level introduction for:

- someone trying to understand what GridNode is
- a developer trying to run the stack locally
- a provider trying to connect a machine with the agent

If you need deeper implementation detail, the backend, frontend, and agent directories contain the code and supporting docs for each subsystem.
