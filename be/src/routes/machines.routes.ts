import { Router } from "express";
import { JobStatus, AgentSessionStatus, Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireAgentAuth } from "../middleware/requireAgentAuth";
import { prisma } from "../lib/db";
import { generateSessionToken, hashToken } from "../lib/token";
import { emitJobUpdate } from "../sockets";

const router = Router();

// GET /api/machines - list current user's machines, or all machines if ?all=true
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const all = String(req.query.all) === "true";
    const where = all ? {} : { ownerId: user.id };
    const machines = await prisma.machine.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(machines);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list machines" });
  }
});

// POST /api/machines/register - used by agents to register themselves
router.post("/register", async (req, res) => {
  try {
    const { 
      agent_token, 
      cpu_cores, 
      ram_gb, 
      gpu, 
      disk_free_gb,
      userKey
    } = req.body;

    console.log(req.body)

    if (!agent_token) {
      return res.status(400).json({ error: "agent_token is required" });
    }

    // Find user by userKey
    const user = await prisma.user.findUnique({
      where: { userKey: agent_token }
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid agent token" });
    }

    const cpuTotal = cpu_cores || 0;
    const memoryTotal = Math.round((ram_gb || 0) * 1024); // GB to MB
    
    // Parse GPU info if provided
    let gpuTotal = 0;
    let gpuVendor = null;
    let gpuMemoryTotal = 0;

    if (gpu && typeof gpu === "object") {
      gpuTotal = gpu.count || 0;
      gpuVendor = gpu.vendor?.toLowerCase();
      gpuMemoryTotal = gpu.vram_mb || 0;
    }

    const machine = await prisma.machine.create({
      data: {
        ownerId: user.id,
        userKey: userKey, // Link the user's registration key to this machine
        cpuTotal,
        memoryTotal,
        gpuTotal,
        gpuVendor: (gpuVendor as any) || null,
        gpuMemoryTotal: gpuMemoryTotal || null,
        status: "idle",
      },
    });

    const plainToken = generateSessionToken();
    const tokenHash = hashToken(plainToken);

    await prisma.agentSession.create({
      data: {
        machineId: machine.id,
        tokenHash,
        status: AgentSessionStatus.active,
      },
    });

    res.status(201).json({
      machine_id: machine.id,
      agent_token: plainToken, // Return the long-lived session token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register machine" });
  }
});

// POST /api/machines/:id/heartbeat — agent
router.post("/:id/heartbeat", requireAgentAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const agentSession = (req as any).agentSession;

    if (id !== agentSession.machineId) {
      return res.status(403).json({ error: "Machine id does not match session" });
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.agentSession.update({
        where: { id: agentSession.id },
        data: { lastHeartbeatAt: now },
      }),
      prisma.machine.update({
        where: { id: agentSession.machineId },
        data: { lastHeartbeatAt: now },
      }),
    ]);

    res.json({ ok: true, lastHeartbeatAt: now.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

// POST /api/machines/:id/reclaim — owner
router.post("/:id/reclaim", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const machineId = String(req.params.id);

    const machine = await prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) return res.status(404).json({ error: "Machine not found" });
    if (machine.ownerId !== user.id) {
      return res.status(403).json({ error: "Only the machine owner can reclaim" });
    }

    const active = [
      JobStatus.queued,
      JobStatus.assigned,
      JobStatus.running,
    ];

    const jobs = await prisma.job.findMany({
      where: { machineId, status: { in: active } },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.job.updateMany({
        where: { machineId, status: { in: active } },
        data: {
          status: JobStatus.preempted,
          machineId: null,
        },
      });
      for (const j of jobs) {
        const eventData: Prisma.JobEventUncheckedCreateInput = {
          jobId: j.id,
          type: "machine_reclaim",
          payload: { machineId } as Prisma.InputJsonValue,
          actorId: user.id,
        };
        await tx.jobEvent.create({ data: eventData });
      }
    });

    for (const j of jobs) {
      emitJobUpdate(j.id, { status: JobStatus.preempted, jobId: j.id });
    }

    res.json({ ok: true, preemptedJobIds: jobs.map((j) => j.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Reclaim failed" });
  }
});

export default router;