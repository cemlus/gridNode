---
name: Resource Tier System Design
description: Explanation of discrete tier-based resource allocation vs exact specs
type: feedback
---

## Tiered Resource Allocation - Design Deep Dive

### Problem: Heterogeneous Machine Matching

In a distributed compute marketplace, machines have varying hardware:
- CPU: 2 cores, 4 cores, 8 cores, 16 cores...
- RAM: 8 GB, 16 GB, 32 GB, 64 GB...
- GPU: Various models with different memory sizes (8 GB, 12 GB, 16 GB, 24 GB...)

If jobs requested exact numbers (e.g., "needs 6.5 GB RAM, 4.2 cores"), matching would be rigid and inefficient. A machine with 8 GB RAM and 4 cores would be rejected for the 6.5 GB job despite having sufficient capacity.

**Solution:** Use **discrete tiers** to group resources into bands. Jobs request a tier; any machine meeting that tier or higher qualifies.

---

### Current Tier Definitions

**CpuTier** - CPU core count
```typescript
enum CpuTier {
  light,   // ≈ 2-4 cores
  medium,  // ≈ 4-8 cores
  heavy,   // ≈ 8+ cores
}
```

**MemoryTier** - RAM capacity
```typescript
enum MemoryTier {
  gb8,   // 8 GB
  gb16,  // 16 GB
  gb32,  // 32 GB
  gb64,  // 64 GB
}
```

**GpuMemoryTier** - GPU memory (per GPU or total?)
```typescript
enum GpuMemoryTier {
  gb8,   // 8 GB
  gb12,  // 12 GB
  gb16,  // 16 GB
  gb24,  // 24 GB
  gb32,  // 32 GB
  gb48,  // 48 GB
}
```

**DurationTier** - Expected runtime (for pricing/prioritization)
```typescript
enum DurationTier {
  lt1h,    // < 1 hour
  h1_6,    // 1-6 hours
  h6_12,   // 6-12 hours
  h12_24,  // 12-24 hours
  gt24h,   // 24+ hours
}
```

---

### Why Tiers Instead of Exact Numbers?

**Advantages:**
1. **Better matching:** More jobs fit more machines → higher utilization
2. **Simplified UI:** Users pick from 3-6 options instead of typing numbers
3. **Backward compatibility:** Schema changes (add tier) don't break existing jobs; new tiers can be added without re-indexing
4. **Binning:** Prevents fragmentation where every job is slightly different
5. **Comparability:** Two jobs with same tier can be fairly compared

**Disadvantages:**
1. **Waste:** Light job may get medium machine (some capacity unused)
2. **Granularity loss:** Cannot express "needs exactly 12 GB GPU" (must choose gb12 even if gb16 works)
3. **Edge cases:** Job needs 7.5 GB RAM → either gb8 (tight) or gb16 (waste)
4. **Mapping overhead:** UI must convert user-friendly inputs ("8 GB") to tier enums ("gb8")

---

### Tier Design Principles (From Schema)

1. **Geometric progression** for memory tiers: 8 → 16 → 32 → 64 (2× each step)
   - Reason: Double RAM roughly doubles capability; powers of 2 align with hardware
   - Could extend: 128, 256 if needed

2. **Linear naming:** `gb8`, `gb16` clear and sortable (lexicographically groups values)

3. **GPU memory tiers include 12 GB:** Not power-of-2 because GPUs commonly have 12 GB (RTX 3060, etc.)

4. **Duration tiers are time bands:** Use prefix notation (`lt1h`, `h1_6`) for sorting and clarity

5. **CPU tiers are coarse:** Only 3 tiers because:
   - Most consumer CPUs: 4-8 cores
   - Differentiating more yields low marginal benefit
   - Core count != performance (arch matters) - tiers hide micro-differences

---

### Mapping UI to Tiers

**Example: Job Creation Form**

User sees:
```
CPU: [Dropdown]
  □ Light (2-4 cores)
  □ Medium (4-8 cores)
  □ Heavy (8+ cores)

RAM: [Dropdown]
  □ 8 GB
  □ 16 GB
  □ 32 GB
  □ 64 GB

GPU Memory: [Dropdown]
  □ None
  □ 8 GB
  □ 12 GB
  □ 16 GB
  □ 24 GB
  □ 32 GB
  □ 48 GB

Expected Duration:
  □ < 1 hour
  □ 1-6 hours
  □ 6-12 hours
  □ 12-24 hours
  □ 24+ hours
```

**Form state:**
```typescript
{
  cpuTier: "light" | "medium" | "heavy",
  memoryTier: "gb8" | "gb16" | "gb32" | "gb64",
  gpuMemoryTier: null | "gb8" | "gb12" | ...,
  estimatedDuration: null | "lt1h" | "h1_6" | ...
}
```

**Data flow:**
UI selection → enum string → sent as JSON → backend validates against enum → stored

---

### Machine Matching Algorithm (Future Scheduler)

When scheduling an approved job, find suitable machine:

```typescript
// Pseudo-SQL
SELECT * FROM Machine
WHERE status = 'idle'  -- or 'available'
  AND cpuTotal >= ?  -- convert light→4, medium→8, heavy→16
  AND memoryTotal >= ?  -- gb8→8192, gb16→16384, etc.
  AND (
    gpuTotal = 0  -- job needs no GPU
    OR (
      gpuTotal >= 1
      AND gpuMemoryTotal >= ?  -- gpuMemoryTier in MB
      AND gpuVendor = ? OR ? = 'any'  -- vendor match
    )
  )
  AND ownerId != ?  -- exclude job owner's machines? (optional)
ORDER BY fitness ASC  -- minimal waste
LIMIT 1;
```

**Fitness scoring:** Prefer machines with less overprovisioning. E.g., for gpuMemoryTier=gb16 (16384 MB):
- Machine A: 16384 MB → score 0 (exact)
- Machine B: 24576 MB → score 8192 (waste)
- Machine C: 8192 MB → invalid (too small)

---

### Backend Validation

In `jobs.routes.ts`, enums validated:

```typescript
if (!Object.values(CpuTier).includes(cpuTier)) {
  return res.status(400).json({ error: "Invalid cpuTier" });
}
// ... same for other enums
```

This rejects invalid strings early. Frontend must only send valid enum values.

---

### Converting User Input to Tiers

**Problem:** User says "I need 12 GB GPU memory" - but no `gb12` in UI? (Actually gb12 exists).

**If user enters arbitrary number:**
```typescript
function gpuMemoryToTier(gb: number): GpuMemoryTier | null {
  if (gb <= 8) return "gb8";
  if (gb <= 12) return "gb12";
  if (gb <= 16) return "gb16";
  if (gb <= 24) return "gb24";
  if (gb <= 32) return "gb32";
  if (gb <= 48) return "gb48";
  return null; // too high
}
```

**UI should offer discrete choices, not free text.** This eliminates mapping ambiguity.

---

### Duration Tier Interpretation

`estimatedDuration` is optional advisory field. Uses:
- **Scheduling priority:** Short jobs (lt1h) may jump queue
- **Pricing:** Longer jobs cost more (rate × duration estimate)
- **Resource allocation:** Long jobs might avoid certain machines

**Not enforced:** No timeout killer based on this field. It's informational for orchestration.

---

### Relationship Between Machine and Job Tiers

**Machine capacity** (exact numbers) → **Job tier request** (discrete)

Machine with:
- 6 cores → qualifies for `light` and `medium`? (6 is >4, so medium yes)
- 16 GB RAM → qualifies for `gb8`, `gb16`, but not `gb32`
- 12 GB GPU (single) → qualifies for `gb8`, `gb12`

**Comparison logic:**
```typescript
function machineMatchesTier(
  machine: Machine,
  cpuTier: CpuTier,
  memoryTier: MemoryTier,
  gpuMemoryTier?: GpuMemoryTier
): boolean {
  const cpuThreshold = { light: 2, medium: 4, heavy: 8 }[cpuTier];
  const memoryMb = { gb8: 8192, gb16: 16384, gb32: 32768, gb64: 65536 }[memoryTier];
  
  if (machine.cpuTotal < cpuThreshold) return false;
  if (machine.memoryTotal < memoryMb) return false;
  if (gpuMemoryTier) {
    const gpuMemMb = { gb8: 8192, gb12: 12288, ... }[gpuMemoryTier];
    if (!machine.gpuMemoryTotal || machine.gpuMemoryTotal < gpuMemMb) return false;
    if (machine.gpuVendor !== gpuVendor) return false;  // vendor match
  }
  return true;
}
```

---

### Potential Improvements

1. **Add more granular tiers:**
   - CpuTier: add `light_plus` (3 cores?), `heavy_plus` (16+ cores?)
   - MemoryTier: add `gb12`, `gb24`, `gb48` for GPUs already have these

2. **Separate CPU performance from count:** Core count ≠ performance (ARM vs x86, microarchitecture). Could add `CpuPerformanceTier` (low/med/high) alongside core count tier.

3. **Multi-GPU awareness:** Current `gpuTotal` and `gpuMemoryTotal` (total across GPUs). Job could require 2 GPUs with 16 GB each. Current model expresses total memory only, not per-GPU.

4. **Allow "any" GPU vendor:** Add backend enum value `any` to match current frontend expectation, or fix frontend to not send "any".

5. **Tier descriptive strings:** Store display labels in DB or constants, not just code. E.g., `{ value: "gb16", label: "16 GB" }`

6. **Machine capability reporting:** Machine should self-declare tiers it qualifies for (pre-computed) rather than on-the-fly calculations.

---

### How to Work with Tiers in Frontend

1. **Define constants:**
```typescript
const CPU_TIERS = [
  { value: "light", label: "Light (2-4 cores)" },
  { value: "medium", label: "Medium (4-8 cores)" },
  { value: "heavy", label: "Heavy (8+ cores)" },
] as const;
```

2. **Use `as const`** to preserve literal types and get type safety

3. **Select component:**
```tsx
<Select
  options={CPU_TIERS}
  value={form.cpuTier}
  onChange={(v) => setForm({ ...form, cpuTier: v as CpuTier })}
/>
```

4. **Validation:** Form schema (e.g., Zod) should enforce enum:
```typescript
const jobSchema = z.object({
  cpuTier: z.enum(["light", "medium", "heavy"]),
  // ...
});
```

---

## Summary

The tier system is a **constraint relaxation** technique to improve matching in heterogeneous environments. It's a proven pattern in cloud computing (AWS instance types, Google Cloud machine families) where resources are binned into classes.

For GridNode, tiers enable:
- More jobs to find suitable machines
- Simpler user experience
- Flexible capacity planning

Trade-offs:
- Some resource waste
- Loss of precision
- Complexity in mapping/conversion

**Keep tier definitions stable.** Adding new tiers is a schema change that requires frontend updates, migration of existing jobs, and potentially scheduler changes. Design thoughtfully upfront.
