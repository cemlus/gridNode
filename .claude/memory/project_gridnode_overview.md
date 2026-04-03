---
name: GridNode Project Overview
description: Complete project overview with architecture and current implementation status
type: project
---

## GridNode - Distributed Compute Platform

**Purpose:** Platform where requesters submit computational jobs (ML notebooks, video processing), owners approve them, and agents execute them in Docker containers on the owner's machine.

### Tech Stack

**Backend:**
- Express + TypeScript
- Prisma ORM with PostgreSQL
- Better Auth for user authentication (Google OAuth)
- Socket.IO for real-time updates
- Port: 3005

**Frontend:**
- Next.js 16 (App Router)
- Tailwind CSS + shadcn/ui
- TypeScript
- Port: 3000

**Agent:**
- Python (planned, not yet implemented)

### Current Implementation Status (2026-04-03)

✅ **Fully Implemented:**
- User authentication with Google OAuth (Better Auth)
- Complete job management API with lifecycle states
- Approval workflow for job vetting
- Machine registration and management
- Agent authentication via Bearer tokens (session-based)
- Job event audit logging
- Real-time log streaming via Socket.IO
- Artifact metadata tracking
- Job stop/cancel/preempt functionality
- Role-based access control (requester/owner/admin)
- Database schema with comprehensive models

⚠️ **Partially Implemented:**
- Frontend types are misaligned with backend schema (see feedback_type_safety_issues.md)
- No actual artifact file storage (only metadata)
- Scheduler not implemented (approved jobs need manual assignment)
- Agent Python code not written

❌ **Not Implemented:**
- Resource-based job matching/assignment
- Docker container execution (agent side)
- Payment/billing system
- Job queuing automation
- Multi-tenancy isolation

### Core Workflows

**Job Submission Flow:**
1. Requester creates job with resource tiers (cpuTier, memoryTier, etc.)
2. Job status: `pending_approval`
3. Owner reviews in approvals page
4. Owner approves → `approved` or rejects → `rejected`
5. (Manual) Scheduler assigns to machine → `assigned`
6. Agent pulls job, starts execution → `running`
7. Agent reports logs & artifacts
8. Job completes → `completed` or fails → `failed`

**Machine Registration Flow:**
1. Owner posts machine specs (CPU, RAM, GPU)
2. Backend creates Machine + AgentSession with sessionToken
3. Owner copies token to agent machine
4. Agent authenticates via `Authorization: Bearer <token>`
5. Agent sends periodic heartbeats
6. Owner can reclaim machine → preempts active jobs

**Authentication:**
- **Users:** Session cookies from Better Auth (same-origin)
- **Agents:** Bearer tokens from machine registration (revocable)

### Key Design Patterns

- **Job Status State Machine:** Defined transitions between 11 states (see project_job_lifecycle.md)
- **Access Control:** Three permission types - view job, stop job, approve job (see jobAccess.ts)
- **Event Sourcing:** All status changes create JobEvent records with actor tracking
- **Real-time Updates:** Socket.IO emits job updates and log lines to connected clients
- **Tiered Resources:** CPU/memory/GPU specified as discrete tiers (not exact numbers)
- **Token-Based Agent Auth:** Hash-token storage, active/revoked status, one active session per machine

### Database Models (9 total)

**Core:**
- User (with role field)
- Machine (compute resource)
- Job (with resource tiers and status lifecycle)

**Supporting:**
- Approval (1:1 with Job)
- JobEvent (audit log)
- JobLog (sequential logs by sequence number)
- Artifact (output file metadata)
- AgentSession (machine authentication tokens)

Plus Better Auth tables: Session, Account, Verification

### File Structure Reference

```
be/
├── src/
│   ├── index.ts              # Express app + Socket.IO init
│   ├── routes/               # REST endpoints
│   │   ├── auth.routes.ts    # /api/check/me
│   │   ├── jobs.routes.ts    # Full job CRUD + logs/artifacts
│   │   ├── approvals.routes.ts
│   │   └── machines.routes.ts
│   ├── middleware/
│   │   ├── requireAuth.ts    # User session validation
│   │   ├── requireAgentAuth.ts  # Bearer token validation
│   │   └── requireRole.ts    # Role checks (unused currently)
│   ├── lib/
│   │   ├── db.ts             # Prisma client singleton
│   │   ├── auth.ts           # Better Auth config
│   │   ├── token.ts          # Token generation/hashing
│   │   ├── jobAccess.ts      # canViewJob, canStopJob, resolveStopTargetStatus
│   │   ├── jobStatus.ts      # isTerminalStatus, canTransition, canStop
│   │   ├── jobEvents.ts      # appendJobEvent helper
│   │   └── sockets/          # Socket.IO emit helpers
└── prisma/schema.prisma      # Database schema

fe/
├── app/
│   ├── page.tsx              # Dashboard
│   ├── jobs/page.tsx         # Job listing + create
│   ├── jobs/[id]/page.tsx    # Job detail with logs
│   ├── approvals/page.tsx    # Approval management
│   └── machines/page.tsx     # Machine management
├── components/               # shadcn/ui components + custom
├── lib/
│   ├── api.ts                # API client (fetch wrappers)
│   ├── socket-context.tsx    # Socket.IO React context
│   └── auth-client.ts        # Better Auth client
└── types/
    └── api.ts                # ⚠️ TypeScript interfaces (OUT OF DATE)
```

### API Endpoints Summary

**User-Authenticated (session cookie):**
- `GET /api/check/me` - Current user + machine count
- `GET /api/jobs` - List accessible jobs (optional ?status= filter)
- `POST /api/jobs` - Create job (with Approval + JobEvent)
- `GET /api/jobs/:id` - Job detail with logs count, artifacts count, events
- `POST /api/jobs/:id/stop` - Cancel/preempt job
- `GET /api/jobs/:id/logs` - Paginated logs (afterSequence, limit)
- `GET /api/jobs/:id/artifacts` - List artifacts
- `GET /api/approvals/pending` - Pending approvals where user is owner
- `POST /api/approvals/:id/approve` - Approve job (owner only)
- `POST /api/approvals/:id/reject` - Reject job (owner only)
- `GET /api/machines?all=true` - List all machines (admin) or user's machines
- `POST /api/machines/register` - Register machine + get agent token
- `POST /api/machines/:id/reclaim` - Owner reclaims, preempts active jobs

**Agent-Authenticated (Bearer token):**
- `POST /api/machines/:id/heartbeat` - Update heartbeat timestamp
- `POST /api/jobs/:id/logs` - Append log lines (batch, transactional)
- `POST /api/jobs/:id/artifacts` - Register artifact metadata

### Important Implementation Notes

1. **Job Resource Requirements:** CPU/memory/GPU specified as discrete tiers (e.g., `CpuTier.medium`, `MemoryTier.gb16`) rather than exact numbers. This enables matching across heterogeneous machines.

2. **Status Transition Rules:** Jobs follow a strict state machine (see jobStatus.ts). Some transitions are explicit (draft→pending_approval), others implicit via actions (approval→approved). Cancellation/preemption allowed from any non-terminal state.

3. **Access Control Logic:** `canViewJob` and `canStopJob` check if user is:
   - The job requester
   - The job owner (assigned approver)
   - The owner of the assigned machine
   Preemption target depends on actor: requester → cancelled, others → preempted.

4. **Event Sourcing:** Every important status change creates a JobEvent with `type` and `payload` (JSON). Events include: `job_created`, `approval_decided`, `stop_requested`, `machine_reclaim`, `artifact_registered`, etc.

5. **Agent Sessions:** Machine registration creates one AgentSession with a random token. Token is hashed in DB (`tokenHash`), returned in plain text once. Token reused for all agent requests via `Authorization: Bearer`. Sessions can be revoked (set status=revoked). On new registration, old sessions revoked.

6. **Socket.IO Events:**
   - `job_update` - Job status/field changes
   - `log_line` - New log line (broadcast to job subscribers)
   Emitted from routes using helpers in `sockets/` directory.

7. **Log Storage:** JobLog uses sequential `sequence` numbers per job, with unique constraint on (jobId, sequence). This ensures total ordering even across concurrent writes. Appending logic finds last sequence, increments, creates multiple rows in transaction.

8. **Approval Ownership:** Only the assigned `ownerId` of the job can approve/reject. This is separate from the requester. Job `ownerId` is set automatically if `machineId` provided during creation (looked up from machine). Otherwise null until assigned.

9. **Machine Reclaim:** When owner reclaims a machine, all active jobs (queued, assigned, running) are preempted with status=preempted and machineId=null. Each preemption creates a JobEvent with type=machine_reclaim.

10. **Frontend-Backend Type Mismatch:** The frontend `types/api.ts` does not match the current Prisma schema. Critical differences:
    - Backend: `cpuTier`, `memoryTier`, `gpuMemoryTier`, `estimatedDuration` (enum tiers)
    - Frontend: `cpuRequired`, `memoryRequired`, `gpuMemoryRequired` (numbers), `cpuIntensity`, `timeoutSeconds`
    - Backend: `JobStatus.draft` exists but not in frontend
    - Backend: `GpuVendor` enum only, frontend has "other" and "any"
    - **Action Required:** Align frontend types with backend schema before production
