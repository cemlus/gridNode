---
name: Dual Authentication System
description: Complete guide to user (Better Auth) and agent (Bearer token) authentication architecture
type: reference
---

## Authentication Architecture

GridNode uses **two separate authentication systems** to handle different client types:

1. **User (Browser) Authentication** - Better Auth with Google OAuth, session cookies
2. **Agent (Machine) Authentication** - Bearer tokens with hash verification, session-based

---

## User Authentication (Better Auth)

### Flow

```
1. User clicks "Login with Google"
   ↓
2. Redirect to Google OAuth consent screen
   ↓
3. Google redirects back with auth code
   ↓
4. Better Auth exchanges code for tokens
   ↓
5. Server creates/updates User record
   ↓
6. Better Auth sets HttpOnly session cookie
   ↓
7. Subsequent requests include cookie automatically
```

### Implementation

**Library:** `better-auth` (npm package)

**Config:** `be/src/lib/auth.ts`
```typescript
import { auth } from "better-auth";
export const auth = auth({
  providers: [google({ clientId, clientSecret })],
  secretKey: BETTER_AUTH_SECRET,
  database: { ...prisma integration ... }
});
```

**Route Protection:** `requireAuth` middleware
```typescript
export async function requireAuth(req, res, next) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user) return 401;
  req.user = session.user;  // Prisma User type
  next();
}
```

**User Model:** Better Auth manages these tables:
- `Session` (session tokens)
- `Account` (OAuth provider links)
- `Verification` (email verification tokens)

Plus our custom `User` table that extends the Better Auth user with:
- `role` field (not currently in schema but referenced in middleware)
- Relations to `Machine`, `Job`, `Approval`

### Session Management

- **Cookie:** HttpOnly, SameSite (Better Auth config)
- **Expiry:** Managed by Better Auth (configured in auth config)
- **Refresh:** Transparent to frontend (Better Auth handles session refreshing)
- **Logout:** `auth.api.signOut()` clears session cookie

### Endpoints for Users

All user routes require the session cookie:
- `GET /api/check/me` - Verify auth, get user data
- All `/api/jobs/*` (except agent-only logs/artifacts)
- All `/api/approvals/*`
- All `/api/machines/*` (except heartbeat)

---

## Agent Authentication (Bearer Token)

### Flow

```
1. Owner registers machine via POST /api/machines/register
   ↓
2. Backend creates Machine + AgentSession (hashed token)
   ↓
3. Plain sessionToken returned in response body (ONLY TIME)
   ↓
4. Owner copies token to agent machine (secure channel)
   ↓
5. Agent uses Authorization: Bearer <token> for all requests
   ↓
6. Token verified against hash on each request
```

### Implementation

**Token Generation:** `generateSessionToken()` in `token.ts`
```typescript
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");  // 64-char hex string
}
```

**Token Hashing:** `hashToken(token)` uses bcrypt or similar (check actual implementation)
- Stored in DB as `AgentSession.tokenHash`
- Plain token returned once, never stored

**Route Protection:** `requireAgentAuth` middleware
```typescript
export async function requireAgentAuth(req, res, next) {
  const token = extractToken(req);  // From Authorization header or body.sessionToken
  const tokenHash = await hashToken(token);
  const agentSession = await prisma.agentSession.findFirst({
    where: { tokenHash, status: "active" }
    include: { machine: true }
  });
  if (!agentSession) return 401;
  req.agentSession = agentSession;
  req.machine = agentSession.machine;
  next();
}
```

**Token Extraction:**
- First tries `Authorization: Bearer <token>` header
- Fallback to `sessionToken` in request body
- This dual support allows both header-based and body-based usage (though header preferred)

### AgentSession Model

```
id: string
machineId: string
tokenHash: string @@unique
status: "active" | "revoked"
lastHeartbeatAt: DateTime?
createdAt: DateTime

Relations:
- machine: Machine (onDelete: Cascade)
```

**One-to-Many:** Multiple AgentSessions can exist per machine historically, but only one active at a time (enforced by registration flow revoking old ones).

**Revocation:** `POST /api/machines/register` does:
```typescript
await prisma.agentSession.updateMany({
  where: { machineId: machine.id },
  data: { status: "revoked" },
});
```
Then creates new active session.

**Heartbeat:** `POST /api/machines/:id/heartbeat`
- Updates both `AgentSession.lastHeartbeatAt` and `Machine.lastHeartbeatAt`
- No automatic expiry based on heartbeat (currently just informational)
- Could be used later for auto-reclaim of dead machines

### Security Considerations

✅ **Good:**
- Token is hashed in DB (not stored in plaintext)
- Token returned only once (registration response)
- Bearer token must be kept secret by agent operator
- Sessions can be revoked by re-registering machine
- Machine ownership enforced (only owner can register/reclaim)

⚠️ **Concerns:**
- Token reuse after revocation? Check middleware correctly rejects revoked sessions (status="active" filter)
- No token expiration (could be a problem if token leaked)
- No rate limiting on agent endpoints (brute force, DoS)
- Agent auth only checks token validity, not whether job assigned matches (but routes check job.machineId against agentSession.machineId)
- Heartbeat does not validate token expiry (all tokens indefinite lifetime)

🔴 **Critical:**
- Token transmission from owner to agent operator is out-of-scope. Owners must use secure channel (SSH, encrypted messenger). If intercepted, attacker can impersonate agent.

---

## Access Control Matrix

| Endpoint                        | User Auth | Agent Auth | Additional Checks |
|---------------------------------|-----------|------------|-------------------|
| GET `/api/check/me`             | ✓         | ✗          | -                 |
| GET `/api/machines`             | ✓         | ✗          | `all` query admin only |
| POST `/api/machines/register`   | ✓         | ✗          | Owner only (implicit from session) |
| POST `/api/machines/:id/reclaim`| ✓         | ✗          | `machine.ownerId === user.id` |
| GET `/api/machines/:id/heartbeat`| ✗        | ✓          | `machineId === agentSession.machineId` |
| GET `/api/jobs`                 | ✓         | ✗          | `canViewJob` (requester/owner/machine owner) |
| POST `/api/jobs`                | ✓         | ✗          | -                 |
| GET `/api/jobs/:id`             | ✓         | ✗          | `canViewJob` |
| POST `/api/jobs/:id/stop`       | ✓         | ✗          | `canStopJob`, `canStop` |
| GET `/api/jobs/:id/logs`        | ✓         | ✓          | `canViewJob` (user) OR job.machineId===agentSession.machineId |
| POST `/api/jobs/:id/logs`       | ✗         | ✓          | `job.machineId === agentSession.machineId` |
| GET `/api/jobs/:id/artifacts`   | ✓         | ✗          | `canViewJob` |
| POST `/api/jobs/:id/artifacts`  | ✗         | ✓          | `job.machineId === agentSession.machineId` |
| GET `/api/approvals/pending`    | ✓         | ✗          | `job.ownerId === user.id` |
| POST `/api/approvals/:id/approve`| ✓        | ✗          | `job.ownerId === user.id`, job.status=pending_approval |
| POST `/api/approvals/:id/reject`| ✓         | ✗          | Same as approve |

---

## User vs Agent - Key Differences

**Session Management:**
- User: Better Auth manages session lifecycle, cookies, refresh
- Agent: Static token (no refresh), manual re-registration if revoked

**Transport:**
- User: Cookie-based (Credentialed fetch with `credentials: "include"`)
- Agent: Bearer token (Authorization header)

**Scope:**
- User: Can do anything their role permits (multi-tenant)
- Agent: Locked to single machine (token tied to machineId)

**Middleware Stack:**
- User routes: `requireAuth` → route handler
- Agent routes: `requireAgentAuth` → route handler

**Revocation:**
- User: Better Auth revokes sessions via `auth.api.revokeSession()`
- Agent: Mark AgentSession.status=revoked; new registration revokes old

---

## Middleware Deep Dive

### requireAuth

```typescript
const session = await auth.api.getSession({
  headers: fromNodeHeaders(req.headers),
});
req.user = session.user;  // Attaches Prisma User
```

**What it does:**
1. Extracts auth cookie from headers
2. Better Auth validates session, fetches user
3. Attaches `req.user` with User object (includes id, name, email, etc.)
4. Rejects with 401 if no valid session

**What it does NOT do:**
- Check user.role (role middleware exists but not used)
- Load machine count (that's done in route handler with `_count`)

### requireAgentAuth

```typescript
const token = extractToken(req);  // Header or body
const tokenHash = await hashToken(token);
const agentSession = await prisma.agentSession.findFirst({
  where: { tokenHash, status: "active" },
  include: { machine: true }
});
req.agentSession = agentSession;
req.machine = agentSession.machine;
```

**What it does:**
1. Extracts token from Authorization header or body
2. Hashes token, looks up active AgentSession
3. Includes joined Machine record
4. Attaches both `req.agentSession` and `req.machine`
5. Rejects with 401 if token invalid or session revoked

**Note:** Uses `findFirst` not `findUnique` because tokenHash is unique anyway. Could also use `findUnique` on tokenHash.

---

## Migration from Basic Auth

Original design may have used basic username/password for agents. Current implementation uses token-based (opaque random tokens). Migration:

- Old: Agent sends username/password, server verifies against stored hash
- New: Agent sends bearer token, server verifies against tokenHash in AgentSession
- Token rotation: Machine re-registration generates new token, revokes old

This is more secure than password-based because:
- Tokens are long (64 hex chars), high entropy
- Tokens can be easily revoked without affecting other machines
- No password to manage/lose

---

## Multi-Tenancy & Isolation

**Users:** Separated by session - each user only sees their own machines/jobs
**Agents:** Tied to one machine - cannot access other machines' jobs
**Cross-access:** Users can see jobs on machines they own via `machine.ownerId` check

**Example:**
- User A owns Machine X
- User B creates Job Y with machineId=X (ownerId=A)
- User A (owner) can see Job Y in approvals and job list
- User B (requester) can see Job Y in job list
- User C (neither) cannot see Job Y
- Agent for Machine X can access logs/artifacts for Job Y via token

---

## Testing Checkpoints

- [ ] User login works, session cookie set
- [ ] Session persists across page reloads
- [ ] Without session, `/api/check/me` returns 401
- [ ] Machine registration returns `sessionToken` in body
- [ ] Agent heartbeat works with Bearer token in header
- [ ] Agent can append logs to assigned job
- [ ] Agent cannot access logs for job not on its machine (403)
- [ ] Invalid token returns 401
- [ ] Revoked token returns 401
- [ ] Owner can reclaim machine, preempting jobs
- [ ] Non-owner cannot reclaim machine (403)
