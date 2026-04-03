---
name: Job Lifecycle & Status Transitions
description: Complete job state machine, allowed transitions, and business logic
type: project
---

## Job Status Lifecycle

### All 11 Job States

```
┌─────────┐
│  draft  │ (unused)
└────┬────┘
     │ create
     ▼
┌─────────────────────┐
│ pending_approval    │ ← initial state after creation
└──────┬──────────────┘
       │ owner approves
       ▼
│   approved   │
└──────┬───────┘
       │ scheduler assigns
       ▼
│  queued   │
└──────┬────┘
       │ scheduler assigns to machine
       ▼
│ assigned  │
└──────┬────┘
       │ agent starts execution
       ▼
│ running  │
└──────┬────┘
       │ execution finishes
       ├──────────────┬─────────────┐
       ▼              ▼             ▼
┌──────────┐   ┌─────────┐   ┌─────────┐
│ completed│   │  failed │   │ preempted│
└──────────┘   └─────────┘   └──────────┘
                               ▲
                               │ owner reclaims machine
                               │
┌──────────┐   ┌─────────┐   │
│ cancelled │   │ rejected│  │
└──────────┘   └─────────┘   │
       ▲                       │
       │ requester stops       │ machine reclaimed
       └───────────────────────┘
```

### Explicit State Transitions

**From `jobStatus.ts`:**

```typescript
const transitions: Partial<Record<JobStatus, JobStatus[]>> = {
  [JobStatus.draft]: [JobStatus.pending_approval],
  [JobStatus.pending_approval]: [JobStatus.approved, JobStatus.rejected],
  [JobStatus.approved]: [JobStatus.queued],
  [JobStatus.queued]: [JobStatus.assigned],
  [JobStatus.assigned]: [JobStatus.running, JobStatus.failed],
  [JobStatus.running]: [
    JobStatus.completed,
    JobStatus.failed,
    JobStatus.preempted,
    JobStatus.cancelled,
  ],
};
```

### Terminal States

A job is **terminal** when it cannot transition to any other state:

```typescript
const terminal: JobStatus[] = [
  JobStatus.completed,
  JobStatus.failed,
  JobStatus.preempted,
  JobStatus.cancelled,
  JobStatus.rejected,
];
```

**Function:** `isTerminalStatus(status)` returns true for any terminal state.

### Stop/Preempt Logic

**Function:** `canStop(status)` returns false if terminal, true otherwise.

**Function:** `resolveStopTargetStatus(job, actorUserId)` determines where to route stop:
- If actor is the **requester** → `JobStatus.cancelled`
- If actor is **owner or machine owner** → `JobStatus.preempted`

**Route:** `POST /api/jobs/:id/stop`
- Checks `canStop(job.status)` - rejects if terminal
- Calls `resolveStopTargetStatus()` to get target state
- Updates job.status and creates JobEvent with type="stop_requested"

### Transition Validations

**Function:** `canTransition(from, to)`
- Same-state transitions always allowed (no-op)
- `cancelled` or `preempted` can be applied from any non-terminal state (override rule)
- Otherwise, check allowed transitions map

**Note:** Some state changes happen directly via API (approval, stop), others may be triggered by scheduler or agent actions. The transition map defines what's *allowed* but doesn't enforce that all transitions must go through specific routes.

### Job Creation Flow

**Route:** `POST /api/jobs`

**Inputs:**
```typescript
{
  type: JobType (notebook|video)
  repoUrl: string (required)
  command: string (required)
  kaggleDatasetUrl?: string
  
  // Resource tiers (all required)
  cpuTier: CpuTier
  memoryTier: MemoryTier
  gpuMemoryTier?: GpuMemoryTier  (optional)
  gpuVendor?: GpuVendor          (optional)
  estimatedDuration?: DurationTier (optional)
  
  machineId?: string  (optional)
}
```

**Processing:**
1. Validate required fields + enum values
2. If `machineId` provided:
   - Look up machine
   - Set `ownerId = machine.ownerId`
3. Create Job with:
   - `status = pending_approval`
   - `approval` nested create with status=pending
   - `events` nested create with type="job_created" + payload containing resource tiers
4. Emit Socket.IO `job_update` event

**Result:** Job with status `pending_approval` and associated Approval object.

### Approval Flow

**List Pending:** `GET /api/approvals/pending`
```sql
SELECT * FROM Approval
WHERE status = 'pending'
  AND job.ownerId = current_user_id
ORDER BY createdAt ASC
```

**Approve:** `POST /api/approvals/:approvalId/approve`
- Checks: approval status is pending, job.status is pending_approval, user is job.ownerId
- Transaction updates:
  - Approval: status=approved, decidedById, decidedAt
  - Job: status=approved
  - JobEvent: type="approval_decided", payload={decision: "approved"}
- Emits `job_update` with status=approved

**Reject:** Similar, sets job.status=rejected, approval.status=rejected, event payload={decision: "rejected"}

### Machine Assignment & Scheduler Gap

**Current State:** There is **no automated scheduler**. After approval, jobs stay in `approved` state indefinitely until manually assigned (admin action not yet implemented).

**Manual Assignment** (hypothetical):
```typescript
// Would need new endpoint or admin action
POST /api/jobs/:id/assign
{
  machineId: string
}
// This would:
// - Validate machine has capacity (not implemented)
// - Set job.machineId = machineId
// - Set job.status = assigned
// - Emit job_update
```

**Machine Reclaim:** Owner can reclaim their machine via `POST /api/machines/:id/reclaim`
- Finds all active jobs on machine (queued, assigned, running)
- Sets status = preempted, machineId = null
- Creates JobEvent with type="machine_reclaim" for each
- Emits `job_update` for each preempted job

### Agent Execution (Not Yet Implemented)

**Assumed Flow:**
1. Agent polls or subscribes for jobs assigned to its machine
2. Agent fetches job details (repoUrl, command, kaggleDatasetUrl)
3. Agent clones repo, sets up environment (Docker container)
4. Agent sends `POST /api/jobs/:id/logs` with initial "Job starting" line
5. Agent streams stdout/stderr in batches
6. Agent posts artifacts as they're created
7. On completion:
   - Success → agent updates job status to `completed` (endpoint not yet defined)
   - Failure → agent updates job status to `failed`
8. Both create JobEvent

**Current Gap:** No endpoint for agent to update job final status. Would need:
- `POST /api/jobs/:id/complete` (agent auth) → sets status=completed, creates event
- `POST /api/jobs/:id/fail` (agent auth) → sets status=failed, creates event

Or a generic update:
- `PATCH /api/jobs/:id/status` with validation that only agent for assigned machine can transition from running→completed|failed

### Status Transition Cheatsheet

**Allowed Transitions (by action):**

```
Create Job:
  → pending_approval

Approve Job:
  pending_approval → approved

Reject Job:
  pending_approval → rejected

Assign to Machine (scheduler):
  approved → assigned

Agent Starts Job:
  assigned → running

Agent Completes:
  running → completed

Agent Fails:
  running → failed

Machine Reclaim (owner):
  queued/assigned/running → preempted

Requester Cancels:
  any non-terminal → cancelled
```

**Forbidden Transitions (examples):**
- `rejected` → any other state (once rejected, never changes)
- `completed` → any other state (terminal)
- `pending_approval` → `queued` (must go through approved)
- `approved` → `running` (must be assigned first)

### Edge Cases & Notes

1. **Direct DB Manipulation:** State machine enforced in code, not at database level. Direct SQL updates could bypass checks.

2. **Race Conditions:** Transition checks not currently wrapped in transactions with row locks (could allow double-approval or invalid transitions under high concurrency). Consider adding `SELECT ... FOR UPDATE` in transaction if concurrent approvals possible.

3. **Status Status vs. Approval:** Job.status and Approval.status can diverge if updates are not atomic. Current implementation uses transactions to keep them in sync during approve/reject. Manual manipulations should maintain consistency.

4. **Reclaim Logic:** Machine reclaim sets `machineId = null` on preempted jobs. This returns jobs to unassigned pool. They could theoretically be re-approved and assigned again (requires admin action to set ownerId and machineId).

5. **Orphaned Jobs:** Job.ownerId can be null if created without machineId and never manually assigned. Such jobs cannot be approved (no owner). They'd need admin assignment first.

6. **Event Payloads:** JobEvent.payload is typed as `Json` (Prisma's Json type). Can store arbitrary data. Examples:
   - job_created: `{ cpuTier, memoryTier, gpuMemoryTier, gpuVendor, estimatedDuration }`
   - approval_decided: `{ decision: "approved"|"rejected" }`
   - stop_requested: `{ nextStatus: "cancelled"|"preempted" }`
   - machine_reclaim: `{ machineId }`
   - artifact_registered: `{ artifactId, filename }`
