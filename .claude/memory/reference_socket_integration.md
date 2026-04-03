---
name: Socket.IO Real-Time Integration
description: Complete Socket.IO setup, events, rooms, and frontend integration patterns
type: reference
---

## Socket.IO Architecture

### Server Setup

**File:** `be/src/sockets/index.ts`

**Initialization:** Called from `be/src/index.ts`
```typescript
const server = http.createServer(app);
initSocket(server);
server.listen(3005);
```

**Configuration:**
```typescript
io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    credentials: true,
  },
});
```

**Connection Handler:**
```typescript
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  
  socket.on("join-job", (jobId) => {
    socket.join(`job-${jobId}`);
  });
  
  // No leave handler needed (Socket.IO auto-leaves on disconnect)
});
```

### Events

#### Server → Client Events

**`log`** (legacy name, actually emits full line object)
```javascript
// Emitted when new log line is created via POST /api/jobs/:id/logs
io.to(`job-${jobId}`).emit("log", log);

// Frontend receives:
socket.on("log", (logLine) => {
  // { id, jobId, sequence, line, stream, createdAt }
});
```

**`job-update`**
```javascript
// Emitted when job status or other fields change
io.to(`job-${jobId}`).emit("job-update", data);

// Data varies by context:
// From job creation: { status: "pending_approval", jobId }
// From approval: { status: "approved", jobId }
// From stop: { status: "preempted" | "cancelled", jobId }
// From artifact: { type: "artifact", jobId, artifact }
// Possible: all job fields if needed

// Frontend receives:
socket.on("job-update", (update) => {
  // { status?, jobId, ...otherFields }
});
```

#### Client → Server Events

**`join-job`**
```javascript
socket.emit("join-job", jobId);

// Server adds socket to room: `job-${jobId}`
// Client will receive all `log` and `job-update` events for this job
```

**Note:** No authentication on Socket connection itself. Access control is enforced:
- Client must be authorized to view job via REST API before joining
- Or join only after fetching job details (frontend logic)
- No verification that socket.joining user has permission (could be added)

---

## Emission Points in Backend

All route handlers emit events after state changes:

### `be/src/routes/jobs.routes.ts`

**POST /api/jobs** (create)
```typescript
const flattenedJob = flattenJobCounts(job);
emitJobUpdate(flattenedJob.id, {
  status: flattenedJob.status,
  jobId: flattenedJob.id,
});
```

**POST /api/jobs/:id/logs** (agent append)
```typescript
for (const row of created) {
  emitLog(jobId, row.line);  // Actually emits full row with metadata
}
```

### `be/src/routes/approvals.routes.ts`

**POST /api/approvals/:id/approve**
```typescript
emitJobUpdate(approval.jobId, { status: JobStatus.approved, jobId: approval.jobId });
```

**POST /api/approvals/:id/reject**
```typescript
emitJobUpdate(approval.jobId, { status: JobStatus.rejected, jobId: approval.jobId });
```

**Note:** These only emit status, not full job object. Frontend must re-fetch if needed.

### `be/src/routes/machines.routes.ts`

**POST /api/machines/:id/reclaim** (multiple jobs preempted)
```typescript
for (const j of jobs) {
  emitJobUpdate(j.id, { status: JobStatus.preempted, jobId: j.id });
}
```

### `be/src/sockets/index.ts` exports

```typescript
export const initSocket = (server: HttpServer) => { ... };
export const emitLog = (jobId: string, log: string) => { ... };
export const emitJobUpdate = (jobId: string, data: unknown) => { ... };
```

---

## Frontend Integration

### Socket Context

**File:** `fe/lib/socket-context.tsx` (assumed - verify exists)

Pattern:
```typescript
import { io, Socket } from "socket.io-client";

const SocketContext = createContext<Socket | null>(null);

export function useSocket() {
  return useContext(SocketContext);
}

export function SocketProvider({ children }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  
  useEffect(() => {
    const socketInstance = io("http://localhost:3005", {
      withCredentials: true,  // send session cookies
    });
    setSocket(socketInstance);
    
    return () => socketInstance.disconnect();
  }, []);
  
  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
}
```

### Using Socket in Job Detail Page

**File:** `fe/app/jobs/[id]/page.tsx`

Pattern:

```typescript
const jobId = params.id;
const socket = useSocket();

// Join job room on mount
useEffect(() => {
  if (!socket) return;
  
  socket.emit("join-job", jobId);
  
  const handleLog = (logLine) => {
    // Append to logs state
    setLogs(prev => [...prev, logLine]);
  };
  
  const handleJobUpdate = (update) => {
    // Update job state
    if (update.status) {
      setJob(prev => ({ ...prev, status: update.status }));
    }
    // Handle artifact, etc.
  };
  
  socket.on("log", handleLog);
  socket.on("job-update", handleJobUpdate);
  
  return () => {
    socket.off("log", handleLog);
    socket.off("job-update", handleJobUpdate);
  };
}, [socket, jobId]);

// Initial data fetch: GET /api/jobs/:id + GET /api/jobs/:id/logs
```

### Using Socket in Jobs List

**File:** `fe/app/jobs/page.tsx`

- Each JobCard may subscribe to its job's updates
- Or just poll/gate on manual refresh
- Real-time update of job status in list when job transitions

Pattern:

```typescript
useEffect(() => {
  if (!socket) return;
  
  // Only join jobs currently visible? Or join all?
  // Better: join when user views job detail, not list
  
  const handleJobUpdate = (update) => {
    setJobs(prev => prev.map(job =>
      job.id === update.jobId ? { ...job, ...update } : job
    ));
  };
  
  socket.on("job-update", handleJobUpdate);
  return () => socket.off("job-update", handleJobUpdate);
}, [socket]);
```

**Note:** jobs list typically shows summary, not full logs. May not need per-job rooms for list, just job-update events for status changes.

### Using Socket in Approvals Page

**File:** `fe/app/approvals/page.tsx`

- Approvals list shows job.status
- When job approved/rejected, socket updates job in list
- May auto-remove from pending list when status changes from pending_approval

Pattern:

```typescript
useEffect(() => {
  if (!socket) return;
  
  const handleJobUpdate = (update) => {
    // Update the approval's job status
    setApprovals(prev => prev.map(approval =>
      approval.job.id === update.jobId
        ? { ...approval, job: { ...approval.job, ...update } }
        : approval
    ).filter(a => a.job.status === "pending_approval" || a.approval.status === "pending"));
  };
  
  socket.on("job-update", handleJobUpdate);
  return () => socket.off("job-update", handleJobUpdate);
}, [socket]);
```

---

## Rooms & Namespacing

### Room Naming Convention

`job-${jobId}` - All sockets interested in a specific job's events join this room.

**Sending to job room:**
```typescript
io.to(`job-${jobId}`).emit("event-name", data);
```

**Multi-room support:** Socket can join multiple job rooms (e.g., if user views 3 job details simultaneously). Server emits to all rooms socket has joined.

### Alternative Patterns

**Global room:** All events to all clients (not recommended - too much noise)
**User room:** `user-${userId}` - Sends all user's job events (requires server to track user→jobs mapping)
**Currently used:** Job-scoped rooms only (minimal, no extra tracking)

---

## Event Design Principles

1. **Small payloads:** Send only changed fields, not full job object (except when necessary)
2. **Use `jobId` always:** Allows client to correlate without deep object matching
3. **Consistent naming:** `job-update`, `log` (snake_case)
4. **No sensitive data:** Don't emit session tokens, internal IDs beyond what's already in job object
5. **Backward compatibility:** Adding new fields to payloads is safe, removing is breaking

---

## Error Handling & Reconnection

### Client-Side

```typescript
socket.on("connect_error", (error) => {
  console.error("Socket connection error:", error);
  // Show offline indicator, retry logic
});

socket.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
  // Attempt reconnection (Socket.IO does this automatically)
  // Show UI feedback if prolonged disconnect
});
```

**Reconnection:** Socket.IO auto-reconnects with exponential backoff. No special code needed.

**Missed Events:** While disconnected, events are not queued. Client should re-fetch data on reconnect or rely on REST for state recovery.

### Server-Side

No error handling in `emitLog` or `emitJobUpdate` - failures are silent (e.g., no listeners, socket disconnected). This is acceptable because:
- Events are best-effort notifications
- Client can always re-fetch via REST API
- No critical business logic depends on event delivery

---

## Security Considerations

⚠️ **Access Control:** Currently, serverside emission does NOT verify that recipients are authorized to receive the job update. Any socket that has joined `job-{id}` room receives events.

**Attack scenario:**
1. Client joins room for job they shouldn't access
2. Server emits job.update event (from any route)
3. Client receives data they shouldn't see

**Mitigation:**
- Client-side: Only join rooms for jobs they're authorized to view (frontend trusts user session)
- Server-side: Could add guard, e.g., before emitting, check that socket user has access (requires storing user in socket.handshake.auth)
- Current approach: Relies on frontend not joining unauthorized jobs. If malicious client, could join arbitrary job IDs and receive events. Sensitive data should not be in events; use REST with auth for actual data.

**Recommendation:**
- Either: Don't put sensitive fields in event payloads (just status=completed OK, but don't include repoUrl, command, etc.)
- Or: Add server-side validation before emitting (track socket.userId in connection, check canViewJob)
- Current implementation: Minimal data (status, jobId, maybe artifact metadata) - likely acceptable

---

## Testing Socket Events

### Manual Testing (dev)

1. Start backend + frontend
2. Open browser console on jobs page
3. Run:
```javascript
const socket = io("http://localhost:3005", { withCredentials: true });
socket.on("log", console.log);
socket.on("job-update", console.log);
socket.emit("join-job", "your-job-id-here");
```
4. Trigger events via API (e.g., approve job)
5. See events in console

### Automated Testing

- Use `socket.io-client` in integration tests
- Create test job, connect socket, join room, perform actions, assert events received
- Libraries: `socket.io-client`, Jest or Vitest

### Known Issues

1. **Event name mismatch:** Server emits `"log"` but may be expected as `"log_line"` by frontend. Check actual usage in components.
2. **Socket context missing:** Need to verify `fe/lib/socket-context.tsx` exists and is used.
3. **No rejoin on page navigation:** When navigating between pages, socket connection persists (SPA), but room join/leave may not be cleaned up properly.
4. **Memory leak risk:** Many jobs joined → many rooms. Should leave job rooms when leaving detail page.

---

## Future Enhancements

1. **Typed events:** Use TypeScript discriminated unions for event types
2. **Room management helper:** Track which sockets are in which rooms, for cleanup
3. **Per-user namespacing:** User room for all their jobs, avoiding per-job joins
4. **Authentication on socket handshake:** Pass session token in `auth` option, validate on server, attach user to socket
5. **Private rooms:** Enforce that only authorized users can join a job room (server-side validation)
6. **Event buffering:** Queue events while disconnected, deliver on reconnect (complex, usually solve with REST refetch)
7. **Metrics:** Track connected sockets, rooms, messages/sec

---

## Current State Check

- ✅ Server initializes Socket.IO on HTTP server
- ✅ CORS configured for localhost:3000
- ✅ Client joins job rooms via `join-job` event
- ✅ Events emitted on job status changes, log lines, artifact registration
- ❓ Frontend Socket implementation needs verification (socket-context.tsx)
- ❓ Event payload formats may differ from frontend expectations (check `log` vs `log_line`)
