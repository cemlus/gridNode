import { Router } from "express";
import { JobStatus, AgentSessionStatus, Prisma, GpuVendor } from "@prisma/client";
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
    const where: Prisma.MachineWhereInput = all ? {} : { ownerId: user.id };

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
      userKey,
      hardware_id
    } = req.body;

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
    const memoryTotal = Math.ceil((ram_gb || 0) * 1024);
    
    let gpuTotal = 0;
    let gpuVendor = null;
    let gpuMemoryTotal = 0;

    if (gpu && typeof gpu === "object") {
      gpuTotal = 1;
      gpuVendor = (gpu.name.split(' ')[0].toLowerCase() as GpuVendor) || null;
      gpuMemoryTotal = Math.ceil(gpu.vram_total_mb || 0);
    }

    // Persistent Machine ID Logic:
    // Check if this user already has this machine registered via hardware_id
    let machine = await prisma.machine.findFirst({
      where: { ownerId: user.id, hardwareId: hardware_id }
    });

    const updateData = {
      cpuTotal,
      memoryTotal,
      gpuTotal,
      gpuVendor,
      gpuMemoryTotal: gpuMemoryTotal || null,
      status: "idle", // Reset to idle upon registration/startup
      lastHeartbeatAt: new Date()
    };

    if (machine) {
      // Reconnecting existing hardware
      machine = await prisma.machine.update({
        where: { id: machine.id },
        data: updateData
      });
      console.log(`[Register] Reconnected persistent machine: ${machine.id}`);
    } else {
      // New hardware
      machine = await prisma.machine.create({
        data: {
          ownerId: user.id,
          userKey: userKey,
          hardwareId: hardware_id,
          ...updateData
        },
      });
      console.log(`[Register] Created new persistent machine: ${machine.id}`);
    }

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
      agent_token: plainToken,
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
    const { status } = req.body as { status?: string };

    if (id !== agentSession.machineId) {
      return res.status(403).json({ error: "Machine id does not match session" });
    }

    const now = new Date();

    const preemptedJob = await prisma.job.findFirst({
      where: { machineId: id, status: JobStatus.preempted }
    });

    console.log(`[heartbeat] machine=${id} status=${status} preemptedJob=${preemptedJob?.id ?? "none"} reclaim=${!!preemptedJob}`);

    // If an agent is heartbeating, the machine is definitely not offline anymore.
    const updateData: any = { 
      lastHeartbeatAt: now,
      status: (status === "running" || status === "idle") ? status : "idle"
    };

    await prisma.$transaction([
      prisma.agentSession.update({
        where: { id: agentSession.id },
        data: { lastHeartbeatAt: now },
      }),
      prisma.machine.update({
        where: { id: agentSession.machineId },
        data: updateData,
      }),
    ]);

    res.json({ 
      ok: true, 
      lastHeartbeatAt: now.toISOString(),
      reclaim: !!preemptedJob 
    });
  } catch (err) {
    console.error("[heartbeat] Error:", err);
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
      JobStatus.pending_approval,
      JobStatus.approved,
      JobStatus.queued,
      JobStatus.assigned,
      JobStatus.running,
    ];

    console.log(`[Reclaim] User ${user.id} reclaiming machine ${machineId}. Querying for statuses:`, active);

    const jobs = await prisma.job.findMany({
      where: { machineId, status: { in: active } },
      select: { id: true, status: true },
    });

    console.log(`[Reclaim] Found ${jobs.length} jobs to preempt:`, jobs.map(j => `ID=${j.id} Status=${j.status}`));

    await prisma.$transaction(async (tx) => {
      await tx.job.updateMany({
        where: { machineId, status: { in: active } },
        data: {
          status: JobStatus.preempted,
          // We DON'T nullify machineId here, so the agent can still see the 'preempted' status
          // The agent will report 'idle' in its next heartbeat, and we can cleanup then.
        },
      });

      // No longer setting machine status to 'reclaimed'. 
      // The agent receiving reclaim=true will exit, and the machine will naturally time out to 'offline'.
      
      for (const j of jobs) {
        const eventData: Prisma.JobEventUncheckedCreateInput = {
          jobId: j.id,
          type: "machine_reclaim",
          payload: { machineId, previousStatus: j.status } as Prisma.InputJsonValue,
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
    console.error(`[Reclaim] Error:`, err);
    res.status(500).json({ error: "Reclaim failed" });
  }
});

export default router;