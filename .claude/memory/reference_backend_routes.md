---
name: Backend API Endpoints Reference
description: Complete REST API reference with all routes, methods, auth, request/response schemas
type: reference
---

## GridNode API Reference

**Base URL:** `http://localhost:3005` (dev)
**Auth:** Two schemes - Session cookie (user), Bearer token (agent)

---

## User-Authenticated Routes

All require session cookie (Better Auth). Use `credentials: "include"` in fetch.

### Authentication

#### `GET /api/check/me`

Get current user information with machine count.

**Response:**
```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "image": "string | null",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "machineCount": number
}
```

---

### Machines

#### `GET /api/machines`

List machines. By default, returns current user's machines only.

**Query:**
- `all=true` (optional) - If set, returns all machines (admin use)

**Response:** `Machine[]`

```json
{
  "id": "string",
  "ownerId": "string",
  "cpuTotal": number,
  "memoryTotal": number,      // MB
  "gpuTotal": number,
  "gpuMemoryTotal": number | null,  // MB
  "gpuVendor": "nvidia | amd | intel | null",
  "status": "string",         // default "idle"
  "lastHeartbeatAt": "ISO8601 | null",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

#### `POST /api/machines/register`

Register a new machine and get agent session token.

**Request:**
```json
{
  "cpuTotal": number,      // required
  "memoryTotal": number,   // required, MB
  "gpuTotal": number,      // required
  "gpuVendor": "nvidia | amd | intel",  // required if gpuTotal > 0
  "gpuMemoryTotal": number  // required if gpuTotal > 0, MB, min 1024
}
```

**Response (201 Created):**
```json
{
  "id": "string",
  "ownerId": "string",
  "cpuTotal": number,
  "memoryTotal": number,
  "gpuTotal": number,
  "gpuMemoryTotal": number | null,
  "gpuVendor": "nvidia | amd | intel | null",
  "status": "idle",
  "lastHeartbeatAt": null,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "sessionToken": "string"  // Plain text token, keep secure!
}
```

**Side Effects:**
- Revokes any existing AgentSession for this machine (sets status=revoked)
- Creates new AgentSession with active status and hashed token

#### `POST /api/machines/:id/reclaim`

Owner reclaims machine, preempting all active jobs.

**Response:**
```json
{
  "ok": true,
  "preemptedJobIds": ["string", ...]
}
```

**Side Effects (in transaction):**
- Updates all jobs with this machineId and status in [queued, assigned, running]:
  - Set status = preempted
  - Set machineId = null
- For each preempted job, creates JobEvent with type="machine_reclaim"

---

### Jobs

#### `GET /api/jobs`

List jobs that the current user can view.

**Query:**
- `status=JobStatus` (optional) - Filter by single status value

**Response:** `Job[]` (flattened with logsCount, artifactsCount)

```json
{
  "id": "string",
  "requesterId": "string",
  "ownerId": "string | null",
  "machineId": "string | null",
  "type": "notebook | video",
  "repoUrl": "string",
  "command": "string",
  "kaggleDatasetUrl": "string | null",
  "cpuTier": "light | medium | heavy",
  "memoryTier": "gb8 | gb16 | gb32 | gb64",
  "gpuMemoryTier": "gb8 | gb12 | gb16 | gb24 | gb32 | gb48 | null",
  "estimatedDuration": "lt1h | h1_6 | h6_12 | h12_24 | gt24h | null",
  "gpuVendor": "nvidia | amd | intel | null",
  "status": "pending_approval | approved | rejected | queued | assigned | running | completed | failed | preempted | cancelled",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "approval": {
    "id": "string",
    "status": "pending | approved | rejected",
    "decidedById": "string | null",
    "decidedAt": "ISO8601 | null",
    "createdAt": "ISO8601"
  } | null,
  "machine": {
    "id": "string",
    "ownerId": "string",
    "status": "string"
  } | null,
  "logsCount": number,
  "artifactsCount": number
}
```

#### `POST /api/jobs`

Create a new job.

**Request:**
```json
{
  "type": "notebook | video",
  "repoUrl": "string",       // required
  "command": "string",       // required
  "kaggleDatasetUrl": "string | null",
  
  "cpuTier": "light | medium | heavy",          // required
  "memoryTier": "gb8 | gb16 | gb32 | gb64",     // required
  "gpuMemoryTier": "gb8 | gb12 | gb16 | gb24 | gb32 | gb48",  // optional
  "gpuVendor": "nvidia | amd | intel",         // optional
  "estimatedDuration": "lt1h | h1_6 | h6_12 | h12_24 | gt24h",  // optional
  
  "machineId": "string"  // optional - if provided, sets ownerId from machine
}
```

**Response (201 Created):** Same as GET /api/jobs response (single job), flattened with counts.

**Validation:**
- `repoUrl` and `command` must be non-empty strings
- `cpuTier` and `memoryTier` required and must be valid enum values
- Optional enum fields validated if provided
- If `machineId` exists and `gpuTotal > 0`, requires `gpuVendor` and `gpuMemoryTotal` (handled in machine registration, not here)

**Side Effects:**
- Creates Job with status=pending_approval
- Creates Approval with status=pending
- Creates JobEvent with type="job_created" and payload containing resource tiers
- Sets `ownerId` from machine if `machineId` provided
- Emits Socket.IO `job_update` event

#### `GET /api/jobs/:id`

Get job details with related data.

**Response:**
```json
{
  "id": "string",
  "...": "...",  // all Job fields
  "approval": { ... },      // full approval object
  "machine": {              // machine with lastHeartbeatAt
    "id": "string",
    "ownerId": "string",
    "status": "string",
    "lastHeartbeatAt": "ISO8601 | null"
  } | null,
  "_count": {
    "logs": number,
    "artifacts": number
  },
  "events": [               // last 50 events, newest first
    {
      "id": "string",
      "jobId": "string",
      "type": "string",
      "payload": { ... } | null,
      "actorId": "string | null",
      "createdAt": "ISO8601"
    }
  ]
}
```

#### `POST /api/jobs/:id/stop`

Request to stop (cancel/preempt) a job.

**Auth:** User must be able to stop the job (see jobAccess.ts)

**Response:** Updated Job object (approval, machine, counts included)

**Logic:**
```typescript
if (!canStopJob(userId, job)) → 403
if (!canStop(job.status)) → 400 (already terminal)
nextStatus = resolveStopTargetStatus(job, userId)
  // requester → cancelled, others → preempted
Transaction:
  1. Update Job.status = nextStatus
  2. Create JobEvent: type="stop_requested", payload={nextStatus}
Emit: Socket.IO job_update event
```

#### `GET /api/jobs/:id/logs`

Get paginated job logs.

**Query:**
- `afterSequence=0` (optional) - Return logs with sequence > this value
- `limit=100` (optional, max 500) - Maximum number of log lines

**Response:**
```json
{
  "logs": [
    {
      "id": "string",
      "jobId": "string",
      "sequence": number,
      "line": "string",
      "stream": "stdout | stderr | null",
      "createdAt": "ISO8601"
    }
  ],
  "nextAfterSequence": number  // Last sequence from response, or input if empty
}
```

**Order:** Ascending by sequence

#### `POST /api/jobs/:id/logs`

**Agent-only.** Append log lines. Requires Bearer token.

**Request:**
```json
{
  "lines": [
    { "line": "log message", "stream": "stdout | stderr (optional)" },
    ...
  ]
}
```

**Max:** 500 lines per request

**Response (201 Created):**
```json
{
  "inserted": number,
  "lines": [
    {
      "sequence": number,
      "line": "string",
      "stream": "string | null"
    }
  ]
}
```

**Logic:**
- Finds last sequence number for job
- Within transaction, creates JobLog rows with sequential sequence numbers
- Skips invalid lines (missing or non-string line)
- For each created log, emits Socket.IO `log_line` event

#### `GET /api/jobs/:id/artifacts`

List artifacts for job.

**Response:** `Artifact[]` ordered by createdAt ascending

```json
{
  "id": "string",
  "jobId": "string",
  "filename": "string",
  "storagePath": "string",
  "mimeType": "string | null",
  "sizeBytes": "number | null",
  "createdAt": "ISO8601"
}
```

#### `POST /api/jobs/:id/artifacts`

**Agent-only.** Register an artifact produced by the job.

**Request:**
```json
{
  "filename": "string",     // required
  "storagePath": "string",  // required (file path in storage)
  "mimeType": "string | null",
  "sizeBytes": "number | null"
}
```

**Response (201 Created):** Artifact object

**Side Effects:**
- Creates Artifact record
- Creates JobEvent with type="artifact_registered"
- Emits Socket.IO `job_update` event with artifact data

---

### Approvals

*(See also project_approval_workflow.md)*

#### `GET /api/approvals/pending`

List pending approvals where current user is the job's owner.

**Includes in job:**
```json
{
  "job": {
    "id": "...",
    "type": "...",
    "repoUrl": "...",
    "command": "...",
    "cpuTier": "...",
    "memoryTier": "...",
    "gpuMemoryTier": "...",
    "requester": { "id": "...", "name": "...", "email": "..." },
    "machine": { "id": "...", "ownerId": "...", "status": "..." } | null
  }
}
```

#### `POST /api/approvals/:approvalId/approve`

Approve the associated job.

**Validations:**
- Approval must exist and be `pending`
- Job must be `pending_approval`
- User must be `job.ownerId`

**Transaction:**
```sql
UPDATE Approval SET status='approved', decidedById=?, decidedAt=? WHERE id=?;
UPDATE Job SET status='approved' WHERE id=?;
INSERT INTO JobEvent (jobId, type, payload, actorId) VALUES (...);
```

**Response:** Job object (with approval, machine, logsCount, artifactsCount)

#### `POST /api/approvals/:approvalId/reject`

Reject the associated job.

Similar to approve but sets:
- Approval.status = rejected
- Job.status = rejected
- JobEvent.payload = { decision: "rejected" }

---

## Agent-Authenticated Routes

All require `Authorization: Bearer <sessionToken>` header. Token is the `sessionToken` returned from machine registration.

### Heartbeat

#### `POST /api/machines/:id/heartbeat`

Update machine's last heartbeat timestamp.

**Path param:** `:id` must match `agentSession.machineId`

**Response:**
```json
{
  "ok": true,
  "lastHeartbeatAt": "ISO8601"
}
```

**Logic:**
- Updates both AgentSession.lastHeartbeatAt and Machine.lastHeartbeatAt in transaction

**Note:** No automatic session expiry currently implemented. Heartbeat is informational only.

### Job Execution

#### `POST /api/jobs/:id/logs`

*(Same as user route but agent auth)*

Append log lines. See user section above.

#### `POST /api/jobs/:id/artifacts`

*(Same as user route but agent auth)*

Register artifact. See user section above.

---

## Error Responses

All errors return JSON:

```json
{
  "error": "Error message"
}
```

**Status Codes:**
- `400` - Validation error (missing fields, invalid enum)
- `401` - Unauthorized (no/invalid session or token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not found (job, machine, approval don't exist)
- `500` - Server error (unhandled exception)

---

## Socket.IO Events

**Server → Client:**

**`job_update`**
```javascript
{
  status: "JobStatus",    // new status
  jobId: "string",
  // ...optional other changed fields
}
```

**`log_line`**
```javascript
{
  jobId: "string",
  line: "string",       // log line text
  stream: "stdout | stderr"  // optional
}
```

Client must join job's room to receive events. Server helpers in `sockets/` handle emission.

---

## Data Model Reference Quick Links

- **JobStatus** (11 states): draft, pending_approval, approved, rejected, queued, assigned, running, completed, failed, preempted, cancelled
- **ApprovalStatus:** pending, approved, rejected
- **JobType:** notebook, video
- **CpuTier:** light, medium, heavy
- **MemoryTier:** gb8, gb16, gb32, gb64
- **GpuMemoryTier:** gb8, gb12, gb16, gb24, gb32, gb48
- **DurationTier:** lt1h, h1_6, h6_12, h12_24, gt24h
- **GpuVendor:** nvidia, amd, intel
- **AgentSessionStatus:** active, revoked

---

## Authentication Flow Diagram

```
User (Browser)                    Agent (Machine)
      │                                │
      │ 1. Google OAuth login          │
      │ → session cookie              │
      │                                │ 2. POST /api/machines/register
      │                                │ → receives sessionToken
      │                                │
      │ 3. Fetch data                  │ 4. Heartbeat & job operations
      │ (cookie auto-sent)             │ (Authorization: Bearer token)
      │                                │
```

**Session Cookie:** Better Auth manages HttpOnly cookie, automatically included in same-origin requests.

**Bearer Token:** Plain token from `register` response, stored by agent, sent in Authorization header for agent routes.

---

## Testing cURL Examples

**Create job:**
```bash
curl -X POST http://localhost:3005/api/jobs \
  -H "Content-Type: application/json" \
  --cookie "session=..." \
  -d '{
    "repoUrl": "https://github.com/user/notebook.git",
    "command": "jupyter nbconvert --to notebook execute.ipynb",
    "cpuTier": "medium",
    "memoryTier": "gb16"
  }'
```

**Get job logs (agent):**
```bash
curl -X GET "http://localhost:3005/api/jobs/ABC123/logs?afterSequence=0&limit=100" \
  -H "Authorization: Bearer agent-token-here"
```

**Append logs (agent):**
```bash
curl -X POST http://localhost:3005/api/jobs/ABC123/logs \
  -H "Authorization: Bearer agent-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "lines": [
      { "line": "Starting execution...", "stream": "stdout" },
      { "line": "Error: ...", "stream": "stderr" }
    ]
  }'
```

**Register artifact (agent):**
```bash
curl -X POST http://localhost:3005/api/jobs/ABC123/artifacts \
  -H "Authorization: Bearer agent-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "output.csv",
    "storagePath": "/storage/jobs/ABC123/output.csv",
    "mimeType": "text/csv",
    "sizeBytes": 12345
  }'
```
