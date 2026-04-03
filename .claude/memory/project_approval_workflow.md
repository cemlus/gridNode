---
name: Approval Workflow & Permissions
description: Detailed approval system design, ownership model, and access control rules
type: project
---

## Approval System - Complete Reference

### Overview

The approval system is the gatekeeper between job submission and execution. Only jobs that are approved can proceed to queuing/assignment. Approvals are tied 1:1 to jobs, and only the job's **owner** (not requester) can approve or reject.

### Data Model

**Approval** (1:1 relationship with Job)
- `id` (PK)
- `jobId` (unique, fk → Job.id onDelete: Cascade)
- `status` (ApprovalStatus: pending|approved|rejected)
- `decidedById` (fk → User.id, nullable)
- `decidedAt` (DateTime, nullable)
- `createdAt`

**Job** references Approval via `approval: Approval?` relation (optional because draft jobs may not have approval yet)

### Approval Workflow

```
Job Created
    ↓
┌─────────────────────┐
│ Approval Created    │  status = pending
│ (1:1 with Job)      │  decidedBy = null
└──────────┬──────────┘
           │
           ▼
    [Owner Reviews]
           │
    ┌──────┴──────┐
    ▼             ▼
Approve        Reject
    │             │
    ▼             ▼
Approval      Approval
status =      status =
approved      rejected
    │             │
    ▼             ▼
Job status =  Job status =
approved      rejected
    │             │
    └─────┬───────┘
          │
    [End - terminal]
```

### Permission Model

**Who Can View Approvals?**
- `GET /api/approvals/pending` returns approvals where `job.ownerId = currentUser.id`
- Only shows pending approvals
- Includes job details: `job.requester`, `job.machine`

**Who Can Approve/Reject?**
- Must be the `job.ownerId` (the assigned owner)
- Must be logged in (requireAuth)
- Approval must be in `pending` status
- Job must be in `pending_approval` status

**Important:** The job `ownerId` is separate from `requesterId`. The owner is the person responsible for vetting the job. This could be:
- The machine owner if job created with `machineId` (auto-assigned)
- An admin or designated approver if manually assigned

### API Endpoints

**GET /api/approvals/pending**
```http
GET /api/approvals/pending
Authorization: session cookie
Response: Approval[]
  - approval.id
  - approval.status ("pending")
  - approval.createdAt
  - approval.job:
    - job.id, type, repoUrl, command
    - job.cpuTier, memoryTier, gpuMemoryTier, estimatedDuration
    - job.requester: { id, name, email }
    - job.machine: { id, ownerId, status } (if machine assigned)
```

**POST /api/approvals/:approvalId/approve**
```http
POST /api/approvals/abc123/approve
Authorization: session cookie
Body: {}
Response: Job (with approval, machine, logsCount, artifactsCount)

Transaction:
1. Update Approval: status=approved, decidedById, decidedAt
2. Update Job: status=approved
3. Create JobEvent: type="approval_decided", payload={decision: "approved"}
```

**POST /api/approvals/:approvalId/reject**
```http
POST /api/approvals/abc123/reject
Authorization: session cookie
Body: {}
Response: Job (with approval)

Transaction:
1. Update Approval: status=rejected, decidedById, decidedAt
2. Update Job: status=rejected
3. Create JobEvent: type="approval_decided", payload={decision: "rejected"}
```

### Business Logic & Validation

**Approval Creation:**
- Happens automatically during job creation (see jobs.routes.ts line 179-181)
```typescript
approval: { create: { status: ApprovalStatus.pending } }
```

**Owner Assignment Logic:**
- If `machineId` provided in job creation → `ownerId = machine.ownerId`
- If no `machineId` → `ownerId = null` (needs manual assignment before approval possible)
- Approval endpoint checks: `if (approval.job.ownerId !== user.id) reject 403`

**Atomic Updates:**
All approve/reject operations use Prisma transactions to ensure:
- Job.status and Approval.status stay in sync
- JobEvent is created (audit trail)
- No partial state changes

### Frontend Integration

**Approvals Page** (`/approvals`):
- Fetches `GET /api/approvals/pending`
- Shows list with:
  - Job info (type, repoUrl)
  - Resource requirements (cpuTier, memoryTier, etc.)
  - Requester info (name, email)
  - Machine info (if assigned)
- Actions: Approve button, Reject button
- Click to view job details
- Real-time updates via Socket.IO (job status changes)

**Job Creation** (`/jobs` - create modal):
- When `machineId` selected, owner is automatically set
- Owner receives approval notification (not implemented - would need email/push)
- Job initially appears in owner's approvals list

**Job Detail** (`/jobs/[id]`):
- Shows approval status & decision details
- Shows approval event in timeline
- If pending_approval, may show "awaiting approval" banner
- If approved, shows transition event

### Edge Cases & Error Handling

**Job ownerId is null:**
- Job can be created without machineId
- Such jobs have no owner → cannot be approved
- Requires admin action to assign owner (not implemented)

**Already decided:**
- Approval endpoint checks `if (approval.status !== ApprovalStatus.pending)`
- Returns 400 with "Approval is not pending"

**Job not awaiting:**
- Double-checks `if (approval.job.status !== JobStatus.pending_approval)`
- Prevents approving a job that's already in different state

**Orphaned approval:**
- If Job deleted (cascade), Approval also deleted
- If approval.jobId doesn't exist, route returns 404

### Future Improvements

1. **Multiple Approvers:** Currently single owner. Could support:
   - Admin overrides
   - Multi-signature approvals (require 2+ approvals)
   - Role-based approval (any owner/admin)

2. **Assignment Before Approval:** Could allow admin to assign owner after creation for jobs without machineId.

3. **Approval Timeout:** Auto-reject after X days if not decided.

4. **Approval Comments:** Allow approver to add comment explaining decision.

5. **Email Notifications:** Notify requester when job approved/rejected.

6. **Approve & Assign:** Combined action that approves AND assigns to a specific machine in one step.

7. **Bulk Approvals:** Select multiple pending jobs and approve/reject in batch.

8. **Approval Delegation:** Owner could delegate approval authority to another user temporarily.

9. **Audit Report:** Dedicated page to see all approval decisions with filters by approver, date range, outcome.

### Testing Checklist

- [ ] Can create job → approval created with status=pending
- [ ] Job with machineId → ownerId set correctly
- [ ] Job without machineId → ownerId null (cannot approve)
- [ ] Pending approvals list shows only where user is owner
- [ ] Owner can approve → job.status=approved, approval.status=approved
- [ ] Owner can reject → job.status=rejected, approval.status=rejected
- [ ] Non-owner cannot approve/reject (403)
- [ ] Cannot approve already-decided approval (400)
- [ ] Cannot approve job not in pending_approval (400)
- [ ] Approve creates JobEvent with type="approval_decided"
- [ ] Approve emits Socket.IO job_update event
- [ ] After approval, job appears in job list with status=approved
- [ ] Job detail page shows approval info and event history
