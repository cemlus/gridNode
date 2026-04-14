import { Request, Router } from "express";
import { JobType, JobStatus, ApprovalStatus, Prisma, GpuMemoryTier, MemoryTier, CpuTier, DurationTier, GpuVendor } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireAgentAuth } from "../middleware/requireAgentAuth";
import { prisma } from "../lib/db";
import { appendJobEvent } from "../lib/jobEvents";
import { canStop } from "../lib/jobStatus";
import { canViewJob, canStopJob, resolveStopTargetStatus } from "../lib/jobAccess";
import { emitLog, emitJobUpdate, emitMailUpdate } from "../sockets";
import { generateGetUrl, generatePutUrl } from "../lib/s3";
import { sendJobResultEmail } from "../lib/email";

const router = Router();

const CPU_MAP: Record<string, number> = { light: 1, medium: 2, heavy: 4 };
const MEM_MAP: Record<string, number> = { gb8: 8192, gb16: 16384, gb32: 32768, gb64: 65536 };
const GPU_MEM_MAP: Record<string, number> = {
  gb8: 8192, gb12: 12288, gb16: 16384, gb24: 24576, gb32: 32768, gb48: 49152
};

function paramId(req: Request): string {
  return String(req.params.id);
}

function flattenJobCounts(job: any): any {
  if (job._count) {
    return {
      ...job,
      logsCount: job._count.logs,
      artifactsCount: job._count.artifacts,
    };
  }
  return job;
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// GET /api/jobs
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const statusParam = req.query.status as string | undefined;

    const statusFilter = statusParam
      ? (Object.values(JobStatus) as string[]).includes(statusParam)
        ? (statusParam as JobStatus)
        : undefined
      : undefined;

    const roleParam = req.query.role as string | undefined;

    // Default: Show jobs I requested
    // If role=provider: Show jobs I am hosting
    let where: Prisma.JobWhereInput = { requesterId: user.id };

    if (roleParam === "provider") {
      where = {
        OR: [
          { providerId: user.id },
          { machine: { ownerId: user.id } }
        ]
      };
    } else if (roleParam === "all") {
      where = {
        OR: [
          { requesterId: user.id },
          { providerId: user.id },
          { machine: { ownerId: user.id } },
        ],
      };
    }

    const jobs = await prisma.job.findMany({
      where: statusFilter ? { AND: [where, { status: statusFilter }] } : where,
      orderBy: { createdAt: "desc" },
      include: {
        approval: true,
        requester: { select: { id: true, name: true, image: true } },
        provider: { select: { id: true, name: true, image: true } },
        decidedBy: { select: { id: true, name: true } },
        machine: { select: { id: true, ownerId: true, status: true } },
        _count: { select: { logs: true, artifacts: true } },
      },
    });

    const flattenedJobs = jobs.map(flattenJobCounts);
    res.json(flattenedJobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

// POST /api/jobs
router.post("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    const {
      type = JobType.ml_notebook,
      repoUrl,
      command,
      kaggleDatasetUrl,

      // ✅ NEW ENUM-BASED INPUTS
      cpuTier,
      memoryTier,
      gpuMemoryTier,
      gpuVendor,
      estimatedDuration,

      machineId,
    } = req.body;

    // ✅ REQUIRED FIELDS
    if (!repoUrl || typeof repoUrl !== "string") {
      return res.status(400).json({ error: "repoUrl is required" });
    }

    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "command is required" });
    }

    if (!cpuTier) {
      return res.status(400).json({ error: "cpuTier is required" });
    }

    if (!memoryTier) {
      return res.status(400).json({ error: "memoryTier is required" });
    }

    // ✅ Validate enums (important)
    if (!Object.values(CpuTier).includes(cpuTier)) {
      return res.status(400).json({ error: "Invalid cpuTier" });
    }

    if (!Object.values(MemoryTier).includes(memoryTier)) {
      return res.status(400).json({ error: "Invalid memoryTier" });
    }

    if (
      gpuMemoryTier &&
      !Object.values(GpuMemoryTier).includes(gpuMemoryTier)
    ) {
      return res.status(400).json({ error: "Invalid gpuMemoryTier" });
    }

    if (
      estimatedDuration &&
      !Object.values(DurationTier).includes(estimatedDuration)
    ) {
      return res.status(400).json({ error: "Invalid estimatedDuration" });
    }

    if (
      gpuVendor &&
      !Object.values(GpuVendor).includes(gpuVendor)
    ) {
      return res.status(400).json({ error: "Invalid gpuVendor" });
    }

    console.log(`Job is recieved from FE`);


    // ✅ STRICT AUTOMATIC MATCHMAKING (Best Fit + Trust Score)
    // 1. Define minimum requirements based on tiers
    const minCpu = CPU_MAP[cpuTier as string] || 1;
    const minRam = MEM_MAP[memoryTier as string] || 8192;
    const minGpuMem = gpuMemoryTier ? (GPU_MEM_MAP[gpuMemoryTier as string] || 0) : 0;

    // 2. Determine Minimum Trust based on estimated duration
    const trustMap: Record<string, number> = {
      lt1h: 20,
      h1_6: 60,
      h6_12: 80,
      h12_24: 80,
      gt24h: 90
    };
    const minTrustScore = estimatedDuration ? (trustMap[estimatedDuration as string] || 20) : 20;

    // 3. Find all suitable machines
    const eligibleMachines = await prisma.machine.findMany({
      where: {
        status: "idle",
        ownerId: { not: user.id },
        cpuTotal: { gte: minCpu },
        memoryTotal: { gte: minRam },
        trustScore: { gte: minTrustScore },
        ...(gpuMemoryTier ? {
          gpuTotal: { gte: 1 },
          gpuMemoryTotal: { gte: minGpuMem },
          ...(gpuVendor ? { gpuVendor } : {})
        } : {})
      }
    });

    if (eligibleMachines.length === 0) {
      return res.status(404).json({
        error: "No suitable machines currently online to handle this job with the required trust level. Try lower resource requirements."
      });
    }

    // 4. Calculate Best Fit (Bin Packing) and break ties with Trust Score
    eligibleMachines.sort((a, b) => {
      const calculateWaste = (m: any) => {
        const cpuWaste = (m.cpuTotal - minCpu) / m.cpuTotal;
        const ramWaste = (m.memoryTotal - minRam) / m.memoryTotal;
        return cpuWaste + ramWaste;
      };

      const wasteA = calculateWaste(a);
      const wasteB = calculateWaste(b);

      // If waste is nearly identical (within 5%), higher trust score wins
      if (Math.abs(wasteA - wasteB) < 0.05) {
        return b.trustScore - a.trustScore;
      }

      return wasteA - wasteB;
    });

    const matchedMachine = eligibleMachines[0];
    if (!matchedMachine) {
      return res.status(403).json({
        message: `The first eligible machine that is picked isn't valid`
      })
    }
    console.log(`Suitable machine has been found: ${matchedMachine.id}`);

    const jobMachineId = matchedMachine.id;
    const jobProviderId = matchedMachine.ownerId;

    // ✅ CREATE JOB
    const job = await prisma.job.create({
      data: {
        requesterId: user.id,
        type,
        repoUrl,
        command,
        kaggleDatasetUrl: kaggleDatasetUrl ?? null,

        cpuTier,
        memoryTier,
        gpuMemoryTier: gpuMemoryTier ?? null,
        gpuVendor: gpuVendor ?? null,
        estimatedDuration: estimatedDuration ?? null,

        status: JobStatus.pending_approval,
        machineId: jobMachineId,
        providerId: jobProviderId,

        approval: {
          create: { status: ApprovalStatus.pending },
        },

        events: {
          create: {
            type: "job_created",
            payload: {
              cpuTier,
              memoryTier,
              gpuMemoryTier,
              gpuVendor,
              estimatedDuration,
              matchedMachineId: jobMachineId
            } as Prisma.InputJsonValue,
            actorId: user.id,
          },
        },
      },
      include: {
        approval: true,
        machine: {
          select: { id: true, ownerId: true, status: true },
        },
        _count: { select: { logs: true, artifacts: true } },
      },
    });

    console.log(`Job is created`);

    const flattenedJob = flattenJobCounts(job);

    emitJobUpdate(flattenedJob.id, {
      status: flattenedJob.status,
      jobId: flattenedJob.id,
    });

    res.status(201).json(flattenedJob);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create job" });
  }
});


// GET /api/jobs/:id/logs
router.get("/:id/logs", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const id = paramId(req);

    const job = await prisma.job.findUnique({
      where: { id },
      include: { machine: true },
    });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!(await canViewJob(user.id, job))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const afterSequence = parseInt(String(req.query.afterSequence ?? "0"), 10) || 0;
    const limit = parseLimit(req.query.limit, 100, 500);

    const logs = await prisma.jobLog.findMany({
      where: { jobId: id, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take: limit,
    });

    const last = logs[logs.length - 1];
    res.json({
      logs,
      nextAfterSequence: last ? last.sequence : afterSequence,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// POST /api/jobs/:id/logs — agent
router.post("/:id/logs", requireAgentAuth, async (req, res) => {
  try {
    const jobId = paramId(req);
    const agentSession = (req as any).agentSession;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.machineId !== agentSession.machineId) {
      return res.status(403).json({ error: "Job not assigned to this machine" });
    }

    const { lines } = req.body as { lines?: { line: string; stream?: string }[] };
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "lines[] required" });
    }
    if (lines.length > 500) {
      return res.status(400).json({ error: "Too many lines per request" });
    }

    const created = await prisma.$transaction(async (tx) => {
      const last = await tx.jobLog.findFirst({
        where: { jobId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      let seq = (last?.sequence ?? 0) + 1;
      const out: { sequence: number; line: string; stream: string | null }[] = [];
      for (const row of lines) {
        if (!row?.line || typeof row.line !== "string") continue;
        const log = await tx.jobLog.create({
          data: {
            jobId,
            sequence: seq,
            line: row.line,
            stream: row.stream ?? null,
          },
        });
        out.push({ sequence: log.sequence, line: log.line, stream: log.stream });
        seq += 1;
      }
      return out;
    });

    for (const row of created) {
      emitLog(jobId, row.line);
    }

    res.status(201).json({ inserted: created.length, lines: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to append logs" });
  }
});

// GET /api/jobs/:id/artifacts
router.get("/:id/artifacts", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const id = paramId(req);

    const job = await prisma.job.findUnique({
      where: { id },
      include: { machine: true },
    });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!(await canViewJob(user.id, job))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const artifacts = await prisma.artifact.findMany({
      where: { jobId: id },
      orderBy: { createdAt: "asc" },
    });
    res.json(artifacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list artifacts" });
  }
});

// POST /api/jobs/:id/artifacts — agent
router.post("/:id/artifacts", requireAgentAuth, async (req, res) => {
  try {
    const jobId = paramId(req);
    const agentSession = (req as any).agentSession;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.machineId !== agentSession.machineId) {
      return res.status(403).json({ error: "Job not assigned to this machine" });
    }

    const { filename, storagePath, mimeType, sizeBytes } = req.body as {
      filename?: string;
      storagePath?: string;
      mimeType?: string;
      sizeBytes?: number;
    };
    if (!filename || typeof filename !== "string" || !storagePath || typeof storagePath !== "string") {
      return res.status(400).json({ error: "filename and storagePath are required" });
    }

    const artifact = await prisma.artifact.create({
      data: {
        jobId,
        filename,
        storagePath,
        mimeType: mimeType ?? null,
        sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null,
      },
    });

    await appendJobEvent(
      jobId,
      "artifact_registered",
      { artifactId: artifact.id, filename } as Prisma.InputJsonValue
    );
    emitJobUpdate(jobId, { type: "artifact", jobId, artifact });
    res.status(201).json(artifact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register artifact" });
  }
});

router.post("/:id/artifacts/presign", requireAgentAuth, async (req, res) => {
  try {
    const jobId = paramId(req);
    const agentSession = (req as any).agentSession;

    const job = await prisma.job.findUnique({
      where: { id: jobId }
    })
    if (!job) return res.status(404).json({ error: `Job not found` });
    if (job.machineId !== agentSession.machineId) {
      return res.status(403).json({
        error: `Job not assigned to this machine`
      })
    }
    const { filename, mimeType } = req.body as { filename?: string, mimeType?: string };
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storagePath = `jobs/${jobId}/${Date.now()}-${safeFilename}`;
    const resolvedMime = mimeType || "application/octet-stream";

    const uploadUrl = await generatePutUrl(storagePath, resolvedMime);
    res.json({ uploadUrl, storagePath });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate presigned URL" });
  }
})

// GET /api/jobs/:id/artifacts/:artifactId/download
router.get("/:id/artifacts/:artifactId/download", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const jobId = paramId(req);
    const artifactId = String(req.params.artifactId);

    const job = await prisma.job.findUnique({ where: { id: jobId }, include: { machine: true } });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!(await canViewJob(user.id, job))) return res.status(403).json({ error: "Forbidden" });

    const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, jobId } });
    if (!artifact) return res.status(404).json({ error: "Artifact not found" });

    const downloadUrl = await generateGetUrl(artifact.storagePath, artifact.filename);
    res.json({ downloadUrl, filename: artifact.filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate download URL" });
  }
});

// POST /api/jobs/:id/stop
router.post("/:id/stop", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const id = paramId(req);

    const job = await prisma.job.findUnique({
      where: { id },
      include: { machine: true },
    });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!(await canStopJob(user.id, job))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!canStop(job.status)) {
      return res.status(400).json({ error: "Job is already terminal" });
    }

    const nextStatus = resolveStopTargetStatus(job, user.id);

    const updated = await prisma.$transaction(async (tx) => {
      const j = await tx.job.update({
        where: { id },
        data: { status: nextStatus },
      });
      const eventData: Prisma.JobEventUncheckedCreateInput = {
        jobId: id,
        type: "stop_requested",
        payload: { nextStatus } as Prisma.InputJsonValue,
        actorId: user.id,
      };
      await tx.jobEvent.create({ data: eventData });
      return j;
    });

    emitJobUpdate(id, { status: updated.status, jobId: id });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to stop job" });
  }
});

// PATCH /api/jobs/:id/status — agent
router.patch("/:id/status", requireAgentAuth, async (req, res) => {
  try {
    const jobId = paramId(req);
    const agentSession = (req as any).agentSession;
    const { status, reason, actual_allocation } = req.body as {
      status: JobStatus;
      reason?: string;
      actual_allocation?: any;
    };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { requester: true }
    });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.machineId !== agentSession.machineId) {
      return res.status(403).json({ error: "Job not assigned to this machine" });
    }

    if (!Object.values(JobStatus).includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const updated = await prisma.job.update({
      where: { id: jobId },
      data: { status },
    });

    if ((status === JobStatus.completed || status === JobStatus.failed) && updated.machineId) {
      const machine = await prisma.machine.findUnique({
        where: { id: updated.machineId },
        select: { id: true, trustScore: true }
      });
      const [logs, artifacts] = await Promise.all([
        prisma.jobLog.findMany({
          where: {
            jobId: job.id
          },
          orderBy: {
            createdAt: 'desc'
          },
          take: 100
        }),
        prisma.artifact.findMany({
          where: { jobId: job.id },
        }),
      ])
      const artifactsWithUrl = await Promise.all(
        artifacts.map(async (a) => ({
          ...a,
          downloadUrl: await generateGetUrl(a.id)
        }))
      )
      if (machine) {
        if (status === JobStatus.completed) {
          await prisma.machine.update({
            where: { id: machine.id },
            data: {
              trustScore: Math.min(100, machine.trustScore + 2.0),
              totalJobsCompleted: { increment: 1 }
            }
          });
        } else if (status === JobStatus.failed) {
          await prisma.machine.update({
            where: { id: machine.id },
            data: {
              totalJobsFailed: { increment: 1 }
            }
          });
        }
        await sendJobResultEmail({
          to: job.requester.email,
          job: job,
          logs: logs.map(l => l.line),
          artifacts: artifactsWithUrl
        }).catch(err => {
          console.error("Email failed:", err);
        });
      }
    }

    await appendJobEvent(
      jobId,
      "status_changed",
      { status, reason, actual_allocation } as Prisma.InputJsonValue,
      null // actor is agent
    );

    emitJobUpdate(jobId, { status: updated.status, jobId });
    emitMailUpdate(jobId, { to: job.requester.email, status: updated.status, jobId })
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update job status" });
  }
});

// GET /api/jobs/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const id = paramId(req);

    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        approval: true,
        requester: { select: { id: true, name: true, image: true, email: true } },
        provider: { select: { id: true, name: true, image: true, email: true } },
        decidedBy: { select: { id: true, name: true } },
        machine: { select: { id: true, ownerId: true, status: true, lastHeartbeatAt: true } },
        events: { orderBy: { createdAt: "desc" }, take: 50 },
        _count: { select: { logs: true, artifacts: true } },
      },
    });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!(await canViewJob(user.id, job))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch job" });
  }
});

export default router;
