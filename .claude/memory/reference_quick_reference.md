---
name: Quick Reference Guide
description: Condensed cheatsheet for common development tasks and key facts
type: reference
---

## GridNode Quick Reference

### Prisma Schema at a Glance

```
User ──< Machine >─< Job >─< JobLog, JobEvent, Artifact
      └─< Job (as requester)
      └─< Job (as owner)
      └─< Approval

Machine ──< AgentSession

Job ──1 Approval
```

**Key Enums:**
- JobStatus: 11 states (pending_approval → approved → queued → assigned → running → completed/failed)
- CpuTier: light | medium | heavy
- MemoryTier: gb8 | gb16 | gb32 | gb64
- GpuMemoryTier: gb8 | gb12 | gb16 | gb24 | gb32 | gb48
- DurationTier: lt1h | h1_6 | h6_12 | h12_24 | gt24h

### Important Constants & Defaults

```
Job.status default: pending_approval
Machine.status default: idle
Approval.status default: pending
AgentSession.status default: active

JobLog sequence starts at 1 per job, increments by 1
Approval.jobId is UNIQUE (1:1)
```

### Access Control Functions

**`canViewJob(userId, job)`** - true if user is:
- Job requester (`job.requesterId === userId`)
- Job owner (`job.ownerId === userId`)
- Owner of assigned machine (`job.machine.ownerId === userId`)

**`canStopJob(userId, job)`** - same as canViewJob

**`resolveStopTargetStatus(job, userId)`**:
- If requester → `cancelled`
- Otherwise → `preempted`

**`isTerminalStatus(status)`** - true for completed, failed, preempted, cancelled, rejected

**`canStop(status)`** - false if terminal, true otherwise

### Job Status Lifecycle Quick Map

```
create → pending_approval
approve → approved
(manual assign) → assigned
agent start → running
agent complete → completed
agent fail → failed

reject → rejected
requester stop → cancelled (from any non-terminal)
owner reclaim → preempted (from queued/assigned/running)
```

### API Cheatsheet

**Test Job Creation (cURL):**
```bash
curl -X POST http://localhost:3005/api/jobs \
  -H "Content-Type: application/json" \
  --cookie "session=YOUR_COOKIE" \
  -d '{
    "repoUrl": "https://github.com/user/repo",
    "command": "python train.py",
    "cpuTier": "medium",
    "memoryTier": "gb16",
    "type": "notebook"
  }'
```

**Test Agent Log Append:**
```bash
curl -X POST http://localhost:3005/api/jobs/JOB_ID/logs \
  -H "Authorization: Bearer AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"lines": [{"line": "Hello", "stream": "stdout"}]}'
```

**Get Pending Approvals:**
```bash
curl -X GET "http://localhost:3005/api/approvals/pending" \
  --cookie "session=YOUR_COOKIE"
```

### Database Queries

**Jobs with approval pending for me (owner):**
```sql
SELECT j.* FROM "Job" j
JOIN "Approval" a ON a."jobId" = j.id
WHERE a."status" = 'pending'
  AND j."ownerId" = 'my-user-id'
ORDER BY j."createdAt" ASC;
```

**Jobs I can view:**
```sql
SELECT DISTINCT j.* FROM "Job" j
LEFT JOIN "Machine" m ON j."machineId" = m.id
WHERE j."requesterId" = 'my-user-id'
   OR j."ownerId" = 'my-user-id'
   OR m."ownerId" = 'my-user-id';
```

**Jobs on a specific machine:**
```sql
SELECT * FROM "Job"
WHERE "machineId" = 'machine-id'
  AND "status" IN ('queued', 'assigned', 'running');
```

### Frontend Type Fixes (Critical!)

**Wrong (current):**
```typescript
interface Job {
  cpuRequired: number;
  memoryRequired: number;
  gpuMemoryRequired: number | null;
  cpuIntensity: CpuIntensity | null;
  timeoutSeconds: number;
}
```

**Right (should be):**
```typescript
interface Job {
  cpuTier: CpuTier;
  memoryTier: MemoryTier;
  gpuMemoryTier: GpuMemoryTier | null;
  estimatedDuration: DurationTier | null;
  gpuVendor: GpuVendor | null;  // no "other" or "any"
}
```

**Create Job payload must be:**
```typescript
{
  type: JobType;
  repoUrl: string;
  command: string;
  cpuTier: CpuTier;          // "light" | "medium" | "heavy"
  memoryTier: MemoryTier;    // "gb8" | "gb16" | "gb32" | "gb64"
  gpuMemoryTier?: GpuMemoryTier;
  gpuVendor?: GpuVendor;
  estimatedDuration?: DurationTier;
  machineId?: string;
  kaggleDatasetUrl?: string;
}
```

**DO NOT SEND:** requiresGpu, minGpuMemoryGb, cpuIntensity, timeoutSeconds, notebookPath, datasetUri

### Socket Events

**Client → Server:**
- `join-job` (jobId)

**Server → Client:**
- `log` (JobLog object)
- `job-update` (partial Job update)

### Development Commands

```bash
# Backend
cd be
npm run dev          # Port 3005
npx prisma studio    # DB viewer at http://localhost:5555
npx prisma generate  # After schema change
npx prisma migrate dev

# Frontend
cd fe
npm run dev          # Port 3000

# Reset DB (WARNING: drops all data)
cd be
npx prisma migrate reset

# Create dev user with owner role
npx prisma studio    # Update user.role to 'owner'
```

### File Locations

**Backend:**
- Entry: `be/src/index.ts`
- Routes: `be/src/routes/*.ts`
- Middleware: `be/src/middleware/*.ts`
- Lib: `be/src/lib/*.ts`
- Sockets: `be/src/sockets/index.ts`
- Schema: `be/prisma/schema.prisma`

**Frontend:**
- Pages: `fe/app/`
- Components: `fe/components/`
- API client: `fe/lib/api.ts`
- Socket: `fe/lib/socket-context.tsx`
- Types: `fe/types/api.ts` ⚠️ OUT OF DATE

### Common Issues & Fixes

**"Invalid cpuTier" error:**
- Cause: Frontend sending number instead of string enum
- Fix: Change state from `number` to `CpuTier` and dropdown values

**"Only the job owner can approve" 403:**
- Cause: Job.ownerId is null (no machine assigned)
- Fix: Admin must set ownerId first (no UI yet) or ensure machineId provided on creation

**Agent logs not appearing:**
- Check: job.machineId === agent's machine
- Check: agent token is active (AgentSession.status = 'active')
- Check: socket connection and joined job room

**Socket not receiving events:**
- Verify SocketProvider in layout.tsx
- Verify `socket.emit("join-job", jobId)` called
- Check browser console for connection errors
- Ensure CORS allows localhost:3000

**TypeScript errors in JobCreateModal:**
- Refer to feedback_type_safety_issues.md
- Update types/api.ts to match backend schema

### Testing Checklist

**Backend:**
- [x] Server starts on 3005
- [x] Database connected, migrations applied
- [x] Better Auth configured (check .env)
- [x] CORS allows localhost:3000

**User Flow:**
- [ ] Login with Google works
- [ ] `/api/check/me` returns user
- [ ] Can create job (201)
- [ ] Job appears in `/api/jobs` list
- [ ] Approval sent to owner (check DB)
- [ ] Owner can approve (200) → job.status=approved
- [ ] Job detail shows events

**Machine/Agent:**
- [ ] Can register machine (201 with sessionToken)
- [ ] Agent heartbeat works (200)
- [ ] Can fetch job details with agent token
- [ ] Can append logs (201)
- [ ] Can register artifact (201)
- [ ] Logs appear in UI via Socket.IO

**Edge Cases:**
- [ ] Cannot approve if not job.ownerId (403)
- [ ] Cannot stop completed job (400)
- [ ] Cannot append logs to wrong job (403)
- [ ] Preempted jobs have machineId=null

### Environment Variables (.env)

```
DATABASE_URL="postgresql://..."
BETTER_AUTH_SECRET="random-32-chars-minimum"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
NEXT_PUBLIC_API_URL="http://localhost:3005"
NEXT_PUBLIC_SOCKET_URL="http://localhost:3005"
```

---

## Database ER Diagram (Text)

```
───────┐
│ User│◄─┐ (requestedJobs)
└──┬──┘  │
   │     │ (ownedJobs)
   │     │
   │     ▼
   │  ┌──────┐       ┌─────────┐
   └─<│Job  │─<1─>─│Approval │
      └──┬──┘       └─────────┘
         │
         ├─< JobEvent
         ├─< JobLog
         ├─< Artifact
         │
    (machine)▼
      ┌────────┐
      │Machine │◄─┐ (owner)
      └──┬─────┘  │
         │       │
         └─<─────┘ (assigned jobs)
         │
         └─< AgentSession
```

---

## Next Steps (Priority Order)

1. **Fix frontend types** (feedback_type_safety_issues.md)
2. **Update JobCreateModal** to use tier enums
3. **Test full job flow**: create → approve → (manual assign) → agent execution
4. **Implement agent** (Python) to actually run jobs
5. **Add scheduler** to auto-assign approved jobs to machines
6. **Implement artifact storage** (S3, filesystem)
7. **Add admin endpoints** (set owner, force-cancel jobs)
8. **Email notifications** for approvals
