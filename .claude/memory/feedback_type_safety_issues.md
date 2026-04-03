---
name: Frontend/Backend Type Mismatches
description: Critical type safety issues requiring immediate attention before production
type: feedback
---

## Critical: Frontend-Backend Schema Misalignment

The frontend TypeScript types (`fe/types/api.ts`) are **out of sync** with the current Prisma schema and backend implementation. This creates runtime errors, type unsafety, and incorrect API contracts.

**Why this matters:** TypeScript's compile-time checks are undermined. Developers may pass incorrectly shaped data to APIs and only discover errors at runtime (or not at all if types are any/unknown).

---

## Detailed Mismatches

### 1. Job Resource Fields

**Backend (Prisma + routes):**
```typescript
// Prisma enums:
cpuTier: CpuTier (light | medium | heavy)
memoryTier: MemoryTier (gb8 | gb16 | gb32 | gb64)
gpuMemoryTier: GpuMemoryTier? (gb8 | gb12 | gb16 | gb24 | gb32 | gb48)
estimatedDuration: DurationTier? (lt1h | h1_6 | h6_12 | h12_24 | gt24h)
gpuVendor: GpuVendor? (nvidia | amd | intel)
```

**Frontend (types/api.ts):**
```typescript
interface Job {
  cpuRequired: number;          // ← Should be CpuTier enum string
  memoryRequired: number;       // ← Should be MemoryTier enum string
  gpuMemoryRequired: number | null;  // ← Should be GpuMemoryTier enum string
  cpuIntensity: CpuIntensity | null; // ← Should be DurationTier (estimatedDuration)
  timeoutSeconds: number;       // ← No corresponding backend field
  gpuVendor: GpuVendor | null; // ✓ Matches, but has "other" and "any" values not in backend
}
```

**Impact:**
- API client will send numeric values for `cpuRequired`, `memoryRequired`, `gpuMemoryRequired` but backend expects enum strings (validation error 400)
- `cpuIntensity` is wrong semantic meaning (not duration) and wrong type
- `timeoutSeconds` field ignored by backend (silently dropped)
- `gpuVendor` includes "other" and "any" which backend rejects (only nvidia|amd|intel)

---

### 2. Job Creation API Input

**Backend expects (`POST /api/jobs`):**
```json
{
  "type": "notebook|video",
  "repoUrl": "string",
  "command": "string",
  "kaggleDatasetUrl": "string|null",
  
  "cpuTier": "light|medium|heavy",       // REQUIRED
  "memoryTier": "gb8|gb16|gb32|gb64",    // REQUIRED
  "gpuMemoryTier": "gb8|gb12|...",       // optional
  "gpuVendor": "nvidia|amd|intel",       // optional
  "estimatedDuration": "lt1h|h1_6|...",  // optional
  
  "machineId": "string|null"
}
```

**Frontend sends (`createJob` in api.ts):**
```typescript
{
  type: "notebook|video",
  repoUrl: string,
  machineId: string,
  requiresGpu: boolean,        // ← no backend field
  minGpuMemoryGb?: number,     // ← maps to gpuMemoryTier? but needs conversion
  gpuVendor?: "nvidia|amd|intel|other|any",  // includes invalid values
  cpuIntensity?: "low|medium|high|critical", // wrong enum and meaning
  estimatedDuration?: number,  // should be DurationTier string, not hours number
  timeoutSeconds?: number,     // not used
  command?: string,
  notebookPath?: string,       // backend has "command", not "notebookPath"?
  datasetUri?: string,         // backend uses "kaggleDatasetUrl"?
  kaggleDatasetUrl?: string    // ✓ correct
}
```

**Impact:**
- Frontend must convert numeric/min values to tier strings (e.g., `minGpuMemoryGb` → `gpuMemoryTier`)
- `cpuIntensity` should be `estimatedDuration` with tier values
- `requiresGpu` should influence `gpuMemoryTier` and/or `gpuTotal` requirement (but no `gpuTotal` in job input)
- `notebookPath` might be a misnomer; backend uses `command` which executes in repo context
- `datasetUri` not present in backend (Kaggle-only?)

---

### 3. JobStatus Enum

**Backend:**
```typescript
enum JobStatus {
  draft,
  pending_approval,
  approved,
  rejected,
  queued,
  assigned,
  running,
  completed,
  failed,
  preempted,
  cancelled
}
```

**Frontend:**
```typescript
type JobStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "queued"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "preempted"
  | "cancelled";
```
✓ **This one matches** (though `draft` unused)

---

### 4. GpuVendor Enum

**Backend:**
```typescript
enum GpuVendor { nvidia, amd, intel }
```

**Frontend:**
```typescript
type GpuVendor = "nvidia" | "amd" | "intel" | "other" | "any";
```
**Issue:** "other" and "any" are invalid per backend. These will cause 400 validation errors if sent.

---

### 5. Job Interface Field Count

**Frontend Job has 25+ fields; Backend Job (from routes)** returns fewer in some responses (approval/not), more in others (detail includes events). The frontend types assume all fields always present.

**Reality:**
- `GET /api/jobs` returns flattened job with `approval?`, `machine?`, `logsCount`, `artifactsCount`
- `GET /api/jobs/:id` returns job with `approval`, `machine`, `_count.logs`, `_count.artifacts`, `events[]`
- `POST /api/jobs` returns same as list response

Frontend types should reflect optionality (e.g., `approval: Approval | null` not `Approval`).

---

## Required Fixes

### Priority 1: Immediate (Blocking Development)

**Update `fe/types/api.ts` to match backend:**

1. **Replace resource fields with tier enums:**
```typescript
export type CpuTier = "light" | "medium" | "heavy";
export type MemoryTier = "gb8" | "gb16" | "gb32" | "gb64";
export type GpuMemoryTier = "gb8" | "gb12" | "gb16" | "gb24" | "gb32" | "gb48";
export type DurationTier = "lt1h" | "h1_6" | "h6_12" | "h12_24" | "gt24h";

export interface Job {
  // Remove old fields:
  // cpuRequired, memoryRequired, gpuMemoryRequired, cpuIntensity, timeoutSeconds
  
  // Add correct fields:
  cpuTier: CpuTier;
  memoryTier: MemoryTier;
  gpuMemoryTier: GpuMemoryTier | null;
  estimatedDuration: DurationTier | null;
  gpuVendor: "nvidia" | "amd" | "intel" | null;  // remove "other", "any"
  
  // Add missing:
  kaggleDatasetUrl: string | null;
  
  // Keep (verify):
  id: string;
  type: JobType;
  repoUrl: string;
  command: string | null;
  ownerId: string | null;
  machineId: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  approval: Approval | null;
  machine: Machine | null;
  logsCount: number;
  artifactsCount: number;
  events?: JobEvent[];  // only in detail
}
```

2. **Update `createJob` input type:**
```typescript
export interface CreateJobInput {
  type: JobType;
  repoUrl: string;
  command: string;
  kaggleDatasetUrl?: string;
  
  cpuTier: CpuTier;
  memoryTier: MemoryTier;
  gpuMemoryTier?: GpuMemoryTier;
  gpuVendor?: GpuVendor;
  estimatedDuration?: DurationTier;
  
  machineId?: string;
}

// Remove: requiresGpu, minGpuMemoryGb, cpuIntensity, timeoutSeconds, notebookPath, datasetUri
// Keep but rename maybe: notebookPath → command? Or remove if unused
```

3. **Update `registerMachine` in api.ts to match backend:** Backend expects `cpuTotal`, `memoryTotal`, `gpuTotal` as numbers (MB? No: cpuTotal is cores, memoryTotal is MB, gpuTotal is count). Current api.ts matches - ✓ OK.

4. **Make fields optional/nullable correctly:**
   - `approval: Approval | null`
   - `machine: Machine | null`
   - `gpuVendor: GpuVendor | null`
   - `gpuMemoryTier: GpuMemoryTier | null`
   - `estimatedDuration: DurationTier | null`

### Priority 2: High (API Client Updates)

After type fixes, update `fe/lib/api.ts`:

1. **`getJobs`** and **`getJob`** - Already return Job[] and Job, will match new types
2. **`createJob`** - Change signature to accept `CreateJobInput` as above
3. **Frontend UI components** that build job creation form must be updated to:
   - Drop `requiresGpu` checkbox (or map to gpuMemoryTier presence)
   - Use dropdowns for `cpuTier`, `memoryTier` (discrete options)
   - Map `minGpuMemoryGb` to `gpuMemoryTier` (or remove if UI uses dropdown)
   - Replace `cpuIntensity` with `estimatedDuration` dropdown
   - Remove `timeoutSeconds` field
   - Ensure `gpuVendor` dropdown excludes "other" and "any"
4. **JobCard** and **JobCreateModal** components need updates to display new fields correctly

---

### Priority 3: Medium (Better API Design)

**Add conversion helpers:**

Since frontend may want user-friendly "8 GB" or "Medium" but backend uses tier enums, create mapping utilities:

```typescript
// fe/lib/tier-utils.ts
export const MEMORY_TIER_DISPLAY: Record<MemoryTier, string> = {
  gb8: "8 GB",
  gb16: "16 GB",
  gb32: "32 GB",
  gb64: "64 GB",
};

export const CPU_TIER_DISPLAY: Record<CpuTier, string> = {
  light: "Light (2-4 cores)",
  medium: "Medium (4-8 cores)",
  heavy: "Heavy (8+ cores)",
};

export const parseGpuMemoryGb = (tier: GpuMemoryTier): number => {
  const map = { gb8: 8, gb12: 12, gb16: 16, gb24: 24, gb32: 32, gb48: 48 };
  return map[tier];
};
```

---

## Validation

After fixing types:

1. **Compile:** `npm run build` in `fe/` should succeed with `strict: true` (check tsconfig)
2. **No `any` leaks:** Ensure all Job fields typed correctly
3. **API client matches backend:** JSON payloads should have exact field names and allowed values
4. **Manual test:** Create job through UI, verify backend accepts without 400 errors
5. **Type tests:** Consider adding type-level tests using `tsd` or `expectType` to ensure CreateJobInput matches backend expectation

---

## Root Cause Analysis

**Likely scenario:** Backend schema evolved (added tier system) but frontend types lagged. Either:
- Types were generated from old schema and not regenerated
- Frontend team not aware of breaking changes
- No shared type package (e.g., `@gridnode/api`) to enforce sync

**Prevention:**
- Generate frontend types from Prisma schema (prisma → TypeScript interfaces)
- Or extract types into shared monorepo package
- Add integration tests that validate API contracts
- Document breaking schema changes in CHANGELOG

---

## Action Items

- [ ] Update `fe/types/api.ts` with corrected enum types
- [ ] Remove unused fields (`timeoutSeconds`, `cpuIntensity` as duration, `notebookPath`, `datasetUri`)
- [ ] Fix `gpuVendor` enum to exclude "other" and "any"
- [ ] Update `createJob` signature in `api.ts`
- [ ] Update JobCreateModal UI to use tier dropdowns
- [ ] Test job creation end-to-end
- [ ] Consider generating types from Prisma schema automatically

**Blocking:** All frontend development that interacts with jobs currently relies on incorrect types. Fixing this is required before any new features or even basic job creation testing can proceed reliably.
