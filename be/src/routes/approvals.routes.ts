import { Router } from "express";
import { JobStatus, ApprovalStatus, Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { prisma } from "../lib/db";
import { emitJobUpdate } from "../sockets";

const router = Router();

// GET /api/approvals/pending
// Returns pending approvals for jobs where the current user is the provider (providerId matches)
router.get("/pending", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const approvals = await prisma.approval.findMany({
      where: {
        status: ApprovalStatus.pending,
        job: { providerId: user.id },
      },
      include: {
        job: {
          include: {
            requester: { select: { id: true, name: true, email: true } },
            machine: { select: { id: true, ownerId: true, status: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json(approvals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list pending approvals" });
  }
});

// POST /api/approvals/:approvalId/approve
router.post("/:approvalId/approve", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const approvalId = String(req.params.approvalId);

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      include: { job: true },
    });
    if (!approval) return res.status(404).json({ error: "Approval not found" });
    if (approval.status !== ApprovalStatus.pending) {
      return res.status(400).json({ error: "Approval is not pending" });
    }
    if (approval.job.status !== JobStatus.pending_approval) {
      return res.status(400).json({ error: "Job is not awaiting approval" });
    }
    // Check: only the job's provider can approve
    if (approval.job.providerId !== user.id) {
      return res.status(403).json({ error: "Only the job provider can approve" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id: approvalId },
        data: {
          status: ApprovalStatus.approved,
          decidedById: user.id,
          decidedAt: new Date(),
        },
      });
      await tx.job.update({
        where: { id: approval.jobId },
        data: { 
          status: JobStatus.approved,
          decidedById: user.id 
        },
      });
      await tx.jobEvent.create({
        data: {
          jobId: approval.jobId,
          type: "approval_decided",
          payload: { decision: "approved" } as Prisma.InputJsonValue,
          actorId: user.id,
        },
      });
    });

    const job = await prisma.job.findUnique({
      where: { id: approval.jobId },
      include: {
        approval: true,
        machine: { select: { id: true, ownerId: true, status: true } },
        _count: { select: { logs: true, artifacts: true } },
      },
    });

    emitJobUpdate(approval.jobId, { status: JobStatus.approved, jobId: approval.jobId });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve" });
  }
});

// POST /api/approvals/:approvalId/reject
router.post("/:approvalId/reject", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const approvalId = String(req.params.approvalId);

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      include: { job: true },
    });
    if (!approval) return res.status(404).json({ error: "Approval not found" });
    if (approval.status !== ApprovalStatus.pending) {
      return res.status(400).json({ error: "Approval is not pending" });
    }
    if (approval.job.status !== JobStatus.pending_approval) {
      return res.status(400).json({ error: "Job is not awaiting approval" });
    }
    // Check: only the job's provider can reject
    if (approval.job.providerId !== user.id) {
      return res.status(403).json({ error: "Only the job provider can reject" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id: approvalId },
        data: {
          status: ApprovalStatus.rejected,
          decidedById: user.id,
          decidedAt: new Date(),
        },
      });
      await tx.job.update({
        where: { id: approval.jobId },
        data: { 
          status: JobStatus.rejected,
          decidedById: user.id
        },
      });
      await tx.jobEvent.create({
        data: {
          jobId: approval.jobId,
          type: "approval_decided",
          payload: { decision: "rejected" } as Prisma.InputJsonValue,
          actorId: user.id,
        },
      });
    });

    const job = await prisma.job.findUnique({
      where: { id: approval.jobId },
      include: { approval: true },
    });

    emitJobUpdate(approval.jobId, { status: JobStatus.rejected, jobId: approval.jobId });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reject" });
  }
});

export default router;
