import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { prisma } from "../lib/prisma";

const router = Router();

// POST /api/machines/register
router.post("/register", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    const { cpuTotal, memoryTotal, gpuTotal } = req.body;

    const machine = await prisma.machine.create({
      data: {
        ownerId: user.id,
        cpuTotal,
        memoryTotal,
        gpuTotal,
      },
    });

    res.json(machine);
  } catch (err) {
    res.status(500).json({ error: "Failed to register machine" });
  }
});

export default router;