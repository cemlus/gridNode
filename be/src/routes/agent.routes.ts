import { Router } from "express";
import { GpuVendor, Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { hashToken } from "../lib/token";
import { requireAgentAuth } from "../middleware/requireAgentAuth";

const router = Router();

// Helper: parse GPU vendor from nvidia-smi output
function parseGpuVendor(name: string): GpuVendor | null {
  const lower = name.toLowerCase();
  if (lower.includes("nvidia")) return "nvidia";
  if (lower.includes("amd") || lower.includes("radeon")) return "amd";
  if (lower.includes("intel")) return "intel";
  return null
}

// POST /api/agent/machines/register — agent initial registration with userKey
router.post("/machines/register", async (req, res) => {
  try {
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : null;
    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    // Find machine by userKey
    const machine = await prisma.machine.findFirst({
      where: { userKey: token },
    });
    if (!machine) {
      return res.status(404).json({ error: "Invalid machine key. Register machine from dashboard first." });
    }

    const { cpu_cores, ram_gb, gpu, disk_free_gb } = req.body as {
      cpu_cores?: number;
      ram_gb?: number;
      gpu?: { name: string; vram_total_mb: number } | null;
      disk_free_gb?: number;
    };

    // Update machine with actual specs from agent
    const updateData: Prisma.MachineUpdateInput = {};
    if (typeof cpu_cores === "number") {
      updateData.cpuTotal = cpu_cores;
    }
    if (typeof ram_gb === "number") {
      updateData.memoryTotal = Math.round(ram_gb * 1024); // convert GB to MB
    }
    if (gpu) {
      updateData.gpuTotal = 1; // agent currently sends single GPU
      updateData.gpuVendor = parseGpuVendor(gpu.name);
      updateData.gpuMemoryTotal = gpu.vram_total_mb;
    } else {
      updateData.gpuTotal = 0;
      updateData.gpuVendor = null;
      updateData.gpuMemoryTotal = null;
    }

    const updatedMachine = await prisma.machine.update({
      where: { id: machine.id },
      data: updateData,
    });

    // Create AgentSession for this machine so agent can use the same token for future calls
    // We'll create a session with a separate session token? But the agent uses the same token (userKey).
    // So we need to store a hash of the token and mark it active.
    const tokenHash = hashToken(token);
    // Revoke any existing sessions for this machine
    await prisma.agentSession.updateMany({
      where: { machineId: machine.id },
      data: { status: "revoked" as const },
    });
    // Create new active session
    await prisma.agentSession.create({
      data: {
        machineId: machine.id,
        tokenHash,
        status: "active" as const,
      },
    });

    res.json({ machine_id: updatedMachine.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Agent registration failed" });
  }
});


// GET /api/agent/jobs/next — agent polls for a job

router.get("/jobs/next", requireAgentAuth, async (req, res) => {
  try {
    const agentSession = (req as any).agentSession;
    
    console.log(`[jobs/next] Agent session: machineId=${agentSession.machineId}`);

    const job = await prisma.job.findFirst({
      where: {
        status: { in: ["approved", "queued"] as any },
        OR: [
          { machineId: null },
          { machineId: agentSession.machineId }
        ]
      },
      orderBy: { createdAt: "asc" },
      include: {
        requester: { select: { name: true, email: true } }
      }
    });

    console.log(`[jobs/next] Query result: ${job ? `found job ${job.id} status=${job.status} machineId=${job.machineId}` : "no job found"}`);

    if (!job) {
      // log why — check if there are any approved jobs at all
      const pendingCount = await prisma.job.count({
        where: { status: { in: ["approved", "queued"] as any } }
      });
      console.log(`[jobs/next] No job for this machine. Total approved/queued jobs in DB: ${pendingCount}`);
      return res.status(204).end();
    }

    const updatedJob = await prisma.job.update({
      where: { id: job.id },
      data: { status: "assigned", machineId: agentSession.machineId },
      include: { requester: { select: { name: true, email: true } } } // keep relation
    });

    // console.log(`[jobs/next] Assigned job ${updatedJob.id} to machine ${agentSession.machineId}`);
    // console.log(`[jobs/next] Job fields sent to agent:`, JSON.stringify({
    //   id: updatedJob.id,
    //   type: updatedJob.type,
    //   repoUrl: updatedJob.repoUrl,
    //   command: updatedJob.command,
    //   cpuTier: updatedJob.cpuTier,
    //   memoryTier: updatedJob.memoryTier,
    //   kaggleDatasetUrl: updatedJob.kaggleDatasetUrl,
    // }, null, 2));

    res.json({ job: updatedJob });
  } catch (err) {
    console.error("[jobs/next] Error:", err);
    res.status(500).json({ error: "Failed to fetch next job" });
  }
});


router.get("/kaggle-credentials", requireAgentAuth, async (req, res) => {
  const KAGGLE_USERNAME = process.env.KAGGLE_USERNAME;
  const KAGGLE_API_TOKEN = process.env.KAGGLE_API_TOKEN;

  if(!KAGGLE_API_TOKEN || !KAGGLE_USERNAME) return res.status(503).json({
    error: `Kaggle credentials not configured on this platform.`
  })
  return res.json({
    username: KAGGLE_USERNAME,
    key: KAGGLE_API_TOKEN
  })
})

// PATCH /api/jobs/:id/status — agent reports job status change
// We put this in jobs.routes.ts or agent.routes.ts? The agent.py uses /api/jobs/:id/status.
// Let's add it to jobs.routes.ts to match the agent's expected path.

export default router;
