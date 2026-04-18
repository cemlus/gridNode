# GridNode Context

This file is a high-signal handoff for another LLM working in this repository.

It is intentionally opinionated: it focuses on the parts of the codebase that define behavior, the main flows between subsystems, and the rough edges that are easy to miss.

## What This Repo Is

GridNode is a distributed compute marketplace/platform:

- A requester submits a compute job.
- The backend automatically matches it to a provider-owned machine.
- The provider approves or rejects it.
- A local Python agent running on the provider machine polls for work.
- The agent clones the repo, downloads data, runs the job in Docker, streams logs, and uploads artifacts.

This repo contains the whole stack:

- `fe/`: Next.js frontend
- `be/`: Express + Prisma backend
- `agent/computeshare_agent/`: Python agent

## Repo Layout

Top-level directories that matter most:

- `README.md`
- `fe/`
- `be/`
- `agent/computeshare_agent/`

Important files by subsystem:

### Frontend

- `fe/app/jobs/page.tsx`
- `fe/app/jobs/[id]/page.tsx`
- `fe/app/machines/page.tsx`
- `fe/app/approvals/page.tsx`
- `fe/components/JobCreateModal.tsx`
- `fe/lib/api.ts`
- `fe/types/api.ts`

### Backend

- `be/src/index.ts`
- `be/src/router/index.ts`
- `be/prisma/schema.prisma`
- `be/src/routes/jobs.routes.ts`
- `be/src/routes/agent.routes.ts`
- `be/src/routes/machines.routes.ts`
- `be/src/routes/approvals.routes.ts`
- `be/src/middleware/requireAuth.ts`
- `be/src/middleware/requireAgentAuth.ts`
- `be/src/lib/jobStatus.ts`
- `be/src/lib/jobAccess.ts`
- `be/src/lib/s3.ts`
- `be/src/sockets/index.ts`

### Agent

- `agent/computeshare_agent/computeshare_agent/agent.py`
- `agent/computeshare_agent/computeshare_agent/workspace.py`
- `agent/computeshare_agent/computeshare_agent/docker_runner.py`
- `agent/computeshare_agent/computeshare_agent/resources.py`
- `agent/computeshare_agent/computeshare_agent/log_streamer.py`
- `agent/computeshare_agent/computeshare_agent/artifact_uploader.py`
- `agent/computeshare_agent/computeshare_agent/prerequisites.py`
- `agent/computeshare_agent/computeshare_agent/config.py`

## Mental Model

Think of the system as three layers:

1. Control plane: backend
   The backend owns auth, persistence, job lifecycle, approvals, machine records, logs, and artifact metadata.

2. Execution plane: agent
   The agent runs on the provider machine and does the real work.

3. UI: frontend
   The frontend is mostly a control/inspection surface over the backend APIs and Socket.IO updates.

## Core Data Model

Defined in `be/prisma/schema.prisma`.

Main models:

- `User`
- `Machine`
- `AgentSession`
- `Job`
- `Approval`
- `JobEvent`
- `JobLog`
- `Artifact`

Key enums:

- `JobType`: `ml_notebook`, `video_render`, `server_run`, `data_processing`
- `JobStatus`: `draft`, `pending_approval`, `approved`, `rejected`, `queued`, `assigned`, `running`, `completed`, `failed`, `preempted`, `cancelled`
- resource tiers: `CpuTier`, `MemoryTier`, `GpuMemoryTier`, `DurationTier`

Important relational ideas:

- A `Job` belongs to a requester and may also have a provider and machine.
- An `Approval` is effectively one-to-one with a job.
- Logs and artifacts are separate append-only records associated with a job.
- Agent auth is based on `AgentSession`, not browser auth.

## Main Runtime Flow

### 1. Job creation

Frontend:

- `fe/components/JobCreateModal.tsx`

Backend:

- `POST /api/jobs` in `be/src/routes/jobs.routes.ts`

Behavior:

- Requester submits job type, repo URL, `command`, optional Kaggle dataset URL, and tier-based resource requirements.
- Backend validates enums and calculates effective resource minimums.
- Backend matches the job to an idle machine using a **Best Fit (Bin Packing)** algorithm. It sorts by least resource waste (CPU/RAM difference), and uses **Trust Score** as a tie-breaker if waste is within 5%.
- Backend creates the job with:
  - `status = pending_approval`
  - linked `machineId`
  - linked `providerId`
  - linked `approval` row in `pending`

### 2. Provider approval

Frontend:

- `fe/app/approvals/page.tsx`

Backend:

- `GET /api/approvals/pending`
- `POST /api/approvals/:approvalId/approve`
- `POST /api/approvals/:approvalId/reject`

Behavior:

- Only the matched provider can decide.
- Approval sets job status to `approved` or `rejected`.
- Socket updates are emitted for job status changes.

### 3. Agent polling and assignment

Agent:

- `fetch_job()` in `agent.py`

Backend:

- `GET /api/agent/jobs/next` in `be/src/routes/agent.routes.ts`

Behavior:

- Agent authenticates with Bearer token from `AgentSession`.
- Backend returns the oldest `approved` or `queued` job assignable to that machine.
- Backend updates the job to `assigned`.
- Agent normalizes backend job shape into its internal format via `normalise_job()`.

### 4. Execution

Agent:

- `execute_job()` in `agent.py`
- `workspace.py`
- `docker_runner.py`

Behavior:

- Agent snapshots host resources.
- Resolves actual allocation.
- Creates workspace under `~/.computeshare/workspaces/job_<id>`.
- Clones repo.
- Downloads dataset if present.
- For notebook jobs, injects a papermill parameters cell if needed.
- Starts Docker container.
- Streams logs to backend in near real time.
- Uploads output artifacts after success.

### 5. Logs and artifacts

Logs:

- Agent batches log lines in `log_streamer.py`
- Backend stores them via `POST /api/jobs/:id/logs`
- Frontend job detail subscribes to socket room and refetches logs

Artifacts:

- Agent requests presigned upload URL
- Agent uploads file to S3
- Agent registers artifact metadata with backend
- Frontend fetches artifact list and download URLs

## Agent Behavior in Detail

Primary entrypoint:

- `agent/computeshare_agent/computeshare_agent/agent.py`

### Registration and auth

There are two registration-related backend routes:

- `POST /api/machines/register`
- `POST /api/agent/machines/register`

The current agent code uses `POST /api/machines/register` during first-run registration.

That means:

- machine creation currently happens through `machines.routes.ts`
- later agent-authenticated calls use `AgentSession` Bearer tokens

This dual-route setup is important because it is easy to assume the agent only uses `/api/agent/*`, but it does not.

### Poll loop

`run_agent()`:

- starts prerequisite checks
- loads saved config
- starts a heartbeat thread
- polls for jobs forever

Heartbeat:

- posts to `/api/machines/:id/heartbeat`
- backend can signal reclaim
- if reclaim is seen while a container is running, the agent stops the container and reports preemption

### Workspace layout

Current workspace shape:

- `repo/`
- `repo_writable/`
- `data/input/`
- `outputs/`
- `logs/`

Important nuance:

- `repo/` is the clean cloned repo
- `repo_writable/` is the mutable copy used for notebook parameter injection and mounted into the container as `/workspace/repo`

This was a recent fix and matters a lot for notebook jobs.

### Notebook execution

Notebook jobs are special:

- backend stores notebook path in the `Job.command` field
- agent normalizes that into `job["notebook_path"]`
- `docker_runner.py` runs `papermill`
- before execution the agent may inject a cell tagged `parameters`

The agent currently passes:

- `DATA_DIR`
- `DATA_PATH`
- `OUTPUT_DIR`

to support notebooks that expect either variable name.

### Data ingestion

`workspace.py` handles:

- raw file downloads
- Kaggle datasets via backend-fetched credentials
- archive extraction
- flattening extracted content into `data/input/`

Important behavior:

- GitHub blob URLs are converted to raw URLs
- HTML responses are treated as likely auth failures
- Kaggle credentials are written temporarily to `~/.kaggle/kaggle.json` then deleted

### Docker execution

`docker_runner.py` controls:

- image selection
- runtime selection
- dependency installation into a Docker volume
- final `docker run` invocation

Important behavior:

- CPU-only jobs strictly use the `runsc` **gVisor** runtime for microVM kernel-level protection.
- GPU jobs use plain `runc` to allow hardware passthrough.
- All jobs execute with completely air-gapped networking (`--network none`) and strict security options to prevent data exfiltration or malicious breakouts.
- dependency installation uses repo `requirements.txt` if present, building into an ephemeral container before the main execution.

## Backend Behavior in Detail

### Sweeper Process

The backend runs a periodic `sweeper` to manage machine states:
- It detects machines that haven't sent a heartbeat for over 3 minutes.
- It transitions them to `offline`.
- It forcibly fails any active jobs on those machines and applies a significant Trust Score penalty (-15.0) to penalize unreliable nodes.

### Auth split

Browser/user auth:

- `requireAuth`
- Better Auth cookies/session

Agent auth:

- `requireAgentAuth`
- Bearer token hashed against `AgentSession.tokenHash`

These two auth systems are completely separate.

### Job lifecycle ownership

Useful rule of thumb:

- requester can view/stop their jobs
- provider can view/stop jobs they host
- machine owner can also view/stop jobs on their machine

This is implemented in:

- `be/src/lib/jobAccess.ts`

### Socket behavior

Socket server:

- `be/src/sockets/index.ts`

Frontend joins room:

- `job-<jobId>`

Current socket payload nuance:

- log events send just a string, not a full structured log object
- frontend therefore refetches logs instead of appending them with full metadata

### Artifact storage

Artifacts are not stored directly through the backend process.

Flow:

1. agent asks backend for presigned PUT URL
2. agent uploads to S3 directly
3. agent registers artifact metadata
4. frontend later requests presigned GET URL

This is implemented in:

- `be/src/lib/s3.ts`
- `be/src/routes/jobs.routes.ts`

## Frontend Behavior in Detail

The frontend is a straightforward Next.js app-router client-heavy UI.

Main pages:

- `/jobs`
- `/jobs/[id]`
- `/machines`
- `/approvals`

Main role of frontend:

- submit jobs
- show jobs and job detail
- show pending approvals
- show machines and agent registration key
- connect to job socket rooms for live-ish updates

Important nuance:

- many pages still hardcode `http://localhost:3005` instead of consistently using `NEXT_PUBLIC_API_URL`
- `fe/lib/api.ts` does support `NEXT_PUBLIC_API_URL`, but several page components call `fetch()` directly with hardcoded URLs

## Important Non-Obvious Nuances

These are the first things another LLM should know before editing behavior.

### 1. `Job.command` means different things depending on job type

It is not a universal shell command.

Examples:

- `ml_notebook`: notebook path inside repo
- `video_render`: shell command, likely ffmpeg
- `server_run`: startup command/script conceptually
- `data_processing`: script path / runner input conceptually

So when changing job creation or execution logic, always branch by `JobType`.

### 2. There are inconsistent resource tier mappings across backend and agent

Examples:

- backend matchmaking maps `light/medium/heavy` to `1/2/4` CPU cores
- agent normalization maps the same tiers to `2/4/8`

Memory mappings also differ in places between backend and agent/runtime.

This means:

- scheduling eligibility
- displayed expectations
- actual runtime allocation

are not perfectly aligned today.

If debugging "why did this machine get selected but run smaller/larger than expected?", start here.

### 3. The agent status vocabulary may not fully match Prisma status enum usage

The agent can report statuses like `running`, `failed`, `completed`, `preempted`, and also uses `deferred` internally in some branches.

`deferred` is not part of the Prisma `JobStatus` enum shown in `schema.prisma`.

If that branch executes, backend status validation may reject it unless other code changed elsewhere.

### 4. Notebook-path resolution is intentionally defensive now

The agent now resolves notebook files from `repo_writable` using:

- direct path match
- basename match
- single-file fallback
- fuzzy match via `difflib`

This was added because backend/user-provided notebook paths can be slightly wrong, especially with typos.

### 5. Agent config is saved relative to current working directory

`config.py` stores config in:

- `.computeshare/config.json` under `os.getcwd()`

This is unusual.

It means the saved agent config depends on where the process was started from, not a fixed user config directory.

That can create confusing behavior across shells, installs, or service runners.

### 6. Agent prerequisite checks install Python dependencies at runtime

`run_all_checks()` runs `pip install -r requirements.txt`.

So startup is not just validation; it mutates the environment.

### 7. The frontend UX around notebook jobs still reflects older wording

`JobCreateModal` labels the notebook input like a command, but backend/agent currently treat it as a notebook path for `ml_notebook`.

If improving UX, this is a good cleanup area.

### 8. Socket log streaming is only partially real-time

The server emits a string log event, not the full row with sequence number.

Frontend responds by refetching logs.

It works, but it is inefficient and not truly streaming structured state.

## Current State of Recent Agent Fix

Recent edits in this worktree added:

- creation of `repo_writable` in workspace setup
- copying cloned repo into `repo_writable`
- resolution of notebook path inside `repo_writable`
- dual parameter support for `DATA_DIR` and `DATA_PATH`

Why it matters:

- notebook execution previously failed when `repo_writable` did not exist
- the container mount path and the agent’s notebook injection path were out of sync

If notebook jobs fail again, verify:

- `workspace.create()` created `repo_writable`
- `workspace.clone_repo()` copied files into it
- `job["notebook_path"]` resolved to a real `.ipynb`

## Where To Start For Common Tasks

### Add or change job creation fields

Touch:

- `fe/components/JobCreateModal.tsx`
- `fe/types/api.ts`
- `be/src/routes/jobs.routes.ts`
- possibly `be/prisma/schema.prisma`
- agent normalization in `agent.py`

### Change job matching behavior

Touch:

- `be/src/routes/jobs.routes.ts`
- possibly `be/prisma/schema.prisma`

### Change agent execution behavior

Touch:

- `agent.py`
- `workspace.py`
- `docker_runner.py`
- maybe `resources.py`

### Change log streaming

Touch:

- `agent/computeshare_agent/computeshare_agent/log_streamer.py`
- `be/src/routes/jobs.routes.ts`
- `be/src/sockets/index.ts`
- `fe/app/jobs/[id]/page.tsx`

### Change artifact handling

Touch:

- `artifact_uploader.py`
- `be/src/lib/s3.ts`
- `be/src/routes/jobs.routes.ts`
- job detail page in frontend

## Practical Debugging Notes

For agent-side failures, the most useful files are:

- `agent.py`
- `workspace.py`
- `docker_runner.py`

Questions to ask first:

- Did the agent normalize the job correctly?
- Did it create the workspace structure expected by Docker mounts?
- Did the backend send a path or type that the agent interprets differently?
- Did Docker receive the path the agent thinks it did?
- Did auth fail because the wrong token system was used?

For backend-side job issues, ask:

- Was the job created with the expected enum values?
- Did matchmaking pick a machine based on backend tier maps that differ from agent maps?
- Did approval move the job to `approved`?
- Did `/api/agent/jobs/next` assign it to the expected machine?
- Did the agent report a status the backend actually accepts?

For frontend-side bugs, ask:

- Is the page calling the helper in `fe/lib/api.ts`, or using a hardcoded URL?
- Is the page showing backend truth, or stale client assumptions?
- Is a socket event giving full data, or only a cue to refetch?

## Testing and Risk Notes

There are tests in:

- `agent/computeshare_agent/tests/`

But the repo does not look fully test-driven end-to-end.

Expect many changes to require manual verification across:

- frontend form behavior
- backend route behavior
- live agent execution
- Docker runtime behavior

The highest-risk areas are:

- auth boundary confusion
- status transitions
- resource tier mismatches
- notebook path / dataset path plumbing
- local-machine assumptions in the agent

## Short Summary For Another LLM

If you only remember a few things, remember these:

- The backend is the source of truth; the agent is the executor.
- `Job.command` is overloaded and means different things by `JobType`.
- Notebook jobs are path-based and run through papermill, not arbitrary shell commands.
- Agent auth and browser auth are separate systems.
- Resource tier mapping is not perfectly consistent across backend and agent.
- `repo_writable` is the mutable execution copy used for notebook jobs.
- Several parts of the frontend still hardcode backend URLs.
- When debugging, always trace the same value across frontend input, backend DB field, agent normalization, Docker mount, and container entrypoint.
