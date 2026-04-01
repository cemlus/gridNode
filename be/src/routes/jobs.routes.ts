import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { prisma } from "../lib/prisma";

const router = Router();

// POST /api/jobs
router.post("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    const {
      repoUrl,
      command,
      datasetUri,
      cpuRequired,
      memoryRequired,
      gpuRequired,
    } = req.body;

    const job = await prisma.job.create({
      data: {
        requesterId: user.id,
        repoUrl,
        command,
        datasetUri,
        cpuRequired,
        memoryRequired,
        gpuRequired,
      },
    });

    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

export default router;