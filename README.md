# GridNode

**GridNode** is a trusted distributed compute platform: a **requester** submits compute jobs (code + data + resource needs), an **owner** **approves** each job, and a lightweight **agent** on the owner’s machine runs the work inside **Docker**—sandboxed, logged, and without giving the requester direct access to the host.

This repo is the hackathon implementation: a **control plane** (API + database + realtime), a **Next.js** web app, and (planned) a **Python agent** that executes jobs locally.

---

## Goals

| Principle | What it means here |
|-----------|-------------------|
| **Owner control** | Jobs start only after approval; owners can reclaim or stop work. |
| **No direct machine access** | Requesters never SSH or shell into the owner’s machine; execution goes through the agent + container. |
| **Sandboxed execution** | User code runs in Docker with CPU/RAM (and later GPU) limits. |
| **Observable** | Status, logs, and output artifacts are tracked and surfaced in the UI. |

### Supported workloads (target)

1. **ML notebook training** — GitHub repo + notebook path + dataset; outputs such as executed notebook, model checkpoint, metrics.
2. **Video / FFmpeg pipelines** — repo or script + input video + command; outputs such as transcoded or processed video files.

---

## Repository structure

```text
gridNode/
├── fe/                 # Requester & owner web UI (Next.js, Tailwind)
│   ├── app/            # App Router pages (e.g. login, dashboard)
│   └── lib/            # Shared client code (e.g. auth client)
├── be/                 # Control-plane API (Express, TypeScript)
│   ├── prisma/         # Prisma schema & migrations
│   └── src/
│       ├── routes/     # REST: jobs, machines, auth helpers
│       ├── sockets/    # Socket.IO (live logs / rooms)
│       ├── lib/        # Auth, DB
│       └── middleware/
└── agent/              # Owner-machine worker (Python) — planned
```

- **`fe/`** — Portal for signing in, submitting jobs (to be built), approving jobs (to be built), and watching status/logs.
- **`be/`** — Single backend for auth, job and machine records, scheduling (to be built), and realtime events.
- **`agent/`** — Will register the machine, poll for work, prepare workspaces, run Docker, stream logs, and upload artifacts.

Artifact storage for the hackathon may stay on **local disk** or move to **MinIO** / S3-compatible storage later.

---

## Architecture (high level)

```text
Requester / Owner UI (fe, Next.js)
        ↓ HTTPS
Backend (be, Express) + PostgreSQL + Socket.IO
        ↓ polling / APIs
Agent on owner machine (agent, Python) → Docker → job outputs
```

The backend is the source of truth for users, machines, jobs, approvals, and artifacts. It does **not** execute user code; the **agent** does, on the owner’s hardware.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Frontend | Next.js, Tailwind CSS, Better Auth client |
| Backend | Express (TypeScript), Prisma, PostgreSQL |
| Auth | Better Auth (e.g. Google OAuth) on the API |
| Realtime | Socket.IO |
| Execution | Docker + Python agent (planned); notebooks via papermill/nbconvert; video via FFmpeg in container |

---

## Local development

### Prerequisites

- **Node.js** (LTS recommended)
- **PostgreSQL** running locally or reachable via `DATABASE_URL`
- Google OAuth app credentials if you use Google sign-in (see `be/.env.example`)

### Backend (`be`)

```bash
cd be
cp .env.example .env
# Edit .env: DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET

npx prisma migrate dev
npm run dev
```

API listens on **http://localhost:3005** (see `be/src/index.ts`). Auth routes are mounted under `/api/auth/*`.

### Frontend (`fe`)

```bash
cd fe
npm install
npm run dev
```

App runs at **http://localhost:3000**. The auth client is configured to talk to the backend at `http://localhost:3005`.

---

## Current status (snapshot)

Implemented in rough form: **Google login**, **session-aware** API routes, **job creation** and **machine registration** primitives, **Socket.IO** server with a `join-job` room helper. **Approvals**, **scheduling**, **agent protocol**, **artifact upload**, and **full UI flows** are not complete yet—see below.

---

## What to implement next

Suggested order (aligned with the hackathon build plan):

1. **Data model & APIs** — `job` type (notebook vs video), approval records, `job_events`, log lines, artifact metadata, agent session / heartbeat fields on machines; REST routes for pending approvals, approve/reject, job detail, logs, artifacts, stop/reclaim.
2. **Scheduler** — First-fit: pick first machine that satisfies CPU/RAM/GPU and policy; transition `approved → queued → assigned`.
3. **Owner & requester UI** — Submit job form, owner approval queue, job detail with live logs (Socket.IO), download outputs.
4. **Python agent** — Register machine, heartbeat, poll/fetch assigned job manifest, workspace layout (`repo/`, `data/`, `outputs/`, `logs/`), run Docker, stream stdout/stderr to backend, POST artifacts.
5. **Docker images** — One path for notebook + papermill; one for FFmpeg; resource limits from job spec.
6. **Hardening** — Reclaim/stop, timeouts, failure states, minimal demo datasets/repos for ML and video.

---

## Credits

GridNode by Zoltac.
