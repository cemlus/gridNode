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

// GET /api/agent/jobs/next — agent polls for a job

router.get("/jobs/next", requireAgentAuth, async (req, res) => {
  try {
    const agentSession = (req as any).agentSession;
    const machine = agentSession.machine;

    if (machine.status === "reclaimed") {
      return res.status(204).end();
    }
    
    console.log(`[Polling] Agent requesting next job for machineId: ${agentSession.machineId}`);

    // Query all potentially eligible jobs to help debug
    const allApprovedJobs = await prisma.job.findMany({
      where: { status: { in: ["approved", "queued"] as any } },
      select: { id: true, status: true, machineId: true }
    });
    
    if (allApprovedJobs.length > 0) {
      console.log(`[Polling] Eligible jobs in DB:`, allApprovedJobs.map(j => `ID=${j.id} Status=${j.status} Machine=${j.machineId}`));
    }

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

    if (!job) {
      console.log(`[Polling] No matching job for machineId=${agentSession.machineId}. Total approved jobs elsewhere: ${allApprovedJobs.length}`);
      return res.status(204).end();
    }

    console.log(`[Polling] Found matching job: ${job.id}. Assigning to machine...`);

    const updatedJob = await prisma.job.update({
      where: { id: job.id },
      data: { status: "assigned", machineId: agentSession.machineId },
      include: { requester: { select: { name: true, email: true } } } // keep relation
    });

    console.log(`[Polling] Job ${updatedJob.id} successfully assigned to machine ${agentSession.machineId}`);

    res.json({ job: updatedJob });
  } catch (err) {
    console.error("[Polling] Error:", err);
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
