---
name: Prisma Database Schema Structure
description: Complete schema reference with all models, enums, fields, and relationships
type: project
---

## Database Schema - Complete Reference

### Enums (7 total)

**JobType**
- `notebook` - ML notebook execution
- `video` - Video processing

**JobStatus** (11 states)
- `draft` - Unfinished/unsubmitted (not used currently)
- `pending_approval` - Awaiting owner approval
- `approved` - Approved, ready for queue
- `rejected` - Rejected by owner
- `queued` - In queue, not yet assigned
- `assigned` - Assigned to machine, not yet running
- `running` - Actively executing
- `completed` - Successful completion
- `failed` - Execution failure
- `preempted` - Reclaimed by owner
- `cancelled` - Cancelled by requester

**ApprovalStatus**
- `pending`
- `approved`
- `rejected`

**AgentSessionStatus**
- `active`
- `revoked`

**GpuVendor**
- `nvidia`
- `amd`
- `intel`

**CpuTier** (discrete CPU resource tiers)
- `light`
- `medium`
- `heavy`

**MemoryTier** (RAM in GB)
- `gb8`
- `gb16`
- `gb32`
- `gb64`

**GpuMemoryTier** (GPU memory in MB)
- `gb8` (8192 MB)
- `gb12` (12288 MB)
- `gb16` (16384 MB)
- `gb24` (24576 MB)
- `gb32` (32768 MB)
- `gb48` (49152 MB)

**DurationTier** (expected job duration)
- `lt1h` - Less than 1 hour
- `h1_6` - 1 to 6 hours
- `h6_12` - 6 to 12 hours
- `h12_24` - 12 to 24 hours
- `gt24h` - Greater than 24 hours

### Models (9 custom + 4 Better Auth)

**User** (extends Better Auth User)
```
id: String @id
name: String
email: String @@unique
emailVerified: Boolean @default(false)
image: String?
createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt

Relations:
- sessions: Session[]
- accounts: Account[]
- machines: Machine[]
- requestedJobs: Job[] (@relation("RequestedJobs"))
- ownedJobs: Job[] (@relation("OwnedJobs"))
- approvalsDecided: Approval[] (@relation("ApprovalDecider"))
```

**Machine**
```
id: String @id @default(cuid())
ownerId: String
cpuTotal: Int           # Number of CPU cores
memoryTotal: Int        # RAM in MB
gpuTotal: Int          # Number of GPUs
gpuMemoryTotal: Int?   # Total GPU memory across all GPUs in MB
gpuVendor: GpuVendor?  # Primary GPU vendor (assumes homogeneous)
status: String @default("idle")
lastHeartbeatAt: DateTime?
createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt

Indexes:
- @@index([ownerId])

Relations:
- owner: User (User.machines)
- jobs: Job[]
- sessions: AgentSession[]
```

**Job** (central entity)
```
id: String @id @default(cuid())
requesterId: String
ownerId: String?        # Assigned owner (from machine or manual)
machineId: String?      # Assigned machine

type: JobType @default(notebook)
repoUrl: String         # Git repository URL
command: String         # Command to execute
kaggleDatasetUrl: String?  # Optional Kaggle dataset

cpuTier: CpuTier
memoryTier: MemoryTier
gpuMemoryTier: GpuMemoryTier?   # Required GPU memory in MB
estimatedDuration: DurationTier?  # Expected runtime
gpuVendor: GpuVendor?   # Preferred GPU vendor

status: JobStatus @default(pending_approval)

createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt

Indexes:
- @@index([requesterId])
- @@index([ownerId])
- @@index([status])
- @@index([machineId])

Relations:
- requester: User (RequestedJobs)
- owner: User? (OwnedJobs)
- machine: Machine?
- approval: Approval? (1:1)
- events: JobEvent[]
- logs: JobLog[]
- artifacts: Artifact[]
```

**Approval** (1:1 with Job)
```
id: String @id @default(cuid())
jobId: String @@unique
status: ApprovalStatus @default(pending)
decidedById: String?
decidedAt: DateTime?
createdAt: DateTime @default(now())

Indexes:
- @@index([status])

Relations:
- job: Job (onDelete: Cascade)
- decidedBy: User?
```

**JobEvent** (audit log)
```
id: String @id @default(cuid())
jobId: String
type: String        # e.g., "job_created", "approval_decided"
payload: Json?      # Arbitrary JSON data
actorId: String?    # User who triggered the event
createdAt: DateTime @default(now())

Indexes:
- @@index([jobId])

Relations:
- job: Job (onDelete: Cascade)
```

**JobLog** (sequential log lines)
```
id: String @id @default(cuid())
jobId: String
sequence: Int       # Monotonically increasing per job
line: String        # Log line content
stream: String?     # "stdout" or "stderr"
createdAt: DateTime @default(now())

Constraints:
- @@unique([jobId, sequence])
- @@index([jobId, sequence])

Relations:
- job: Job (onDelete: Cascade)
```

**Artifact** (output file metadata)
```
id: String @id @default(cuid())
jobId: String
filename: String
storagePath: String  # Path in storage system (not yet implemented)
mimeType: String?
sizeBytes: Int?
createdAt: DateTime @default(now())

Indexes:
- @@index([jobId])

Relations:
- job: Job (onDelete: Cascade)
```

**AgentSession** (machine authentication)
```
id: String @id @default(cuid())
machineId: String
tokenHash: String @@unique   # Hashed session token
status: AgentSessionStatus @default(active)
lastHeartbeatAt: DateTime?
createdAt: DateTime @default(now())

Indexes:
- @@index([machineId])

Relations:
- machine: Machine (onDelete: Cascade)
```

### Better Auth Models (auto-generated)

**Session**
```
id: String @id
expiresAt: DateTime
token: String @@unique
createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt
ipAddress: String?
userAgent: String?
userId: String

Indexes:
- @@index([userId])

Relations:
- user: User (onDelete: Cascade)
```

**Account** (OAuth provider account)
```
id: String @id
accountId: String
providerId: String
userId: String
user: User (onDelete: Cascade)
accessToken: String?
refreshToken: String?
idToken: String?
accessTokenExpiresAt: DateTime?
refreshTokenExpiresAt: DateTime?
scope: String?
password: String?
createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt

Indexes:
- @@index([userId])
```

**Verification** (email verification tokens)
```
id: String @id
identifier: String
value: String
expiresAt: DateTime
createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt

Indexes:
- @@index([identifier])
```

### Relationship Summary

```
User (1) ----< (N) Machine
User (1) ----< (N) Job (as requester)    via RequestedJobs
User (1) ----< (N) Job (as owner)        via OwnedJobs
User (1) ----< (N) Approval (decider)

Machine (1) ----< (N) Job
Machine (1) ----< (N) AgentSession

Job (1) ----1 (1) Approval
Job (1) ----< (N) JobEvent
Job (1) ----< (N) JobLog
Job (1) ----< (N) Artifact
```

### Important Constraints

1. **Approval.jobId** is unique (1:1 relationship with Job)
2. **JobLog** has composite unique constraint on (jobId, sequence) - ensures no gaps/duplicates within a job
3. **AgentSession.tokenHash** is unique (cannot have duplicate tokens)
4. **User.email** is unique
5. **Job.ownerId** can be null (set when machine provided or manually assigned)
6. **Cascade deletes:** Approvals, JobEvents, JobLogs, Artifacts, AgentSessions all cascade when parent Job/Machine/User deleted

### Migration Notes

Recent changes (from git history):
- Added tiered resource enums (CpuTier, MemoryTier, GpuMemoryTier, DurationTier)
- Added GpuVendor enum
- Machine model: added gpuVendor, gpuMemoryTotal fields
- Job model: replaced numeric resource fields with tiered enums, added kaggleDatasetUrl
- JobLog: sequence-based ordering with unique constraint
- AgentSession: added status field, lastHeartbeatAt tracking
