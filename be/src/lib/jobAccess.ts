import { Job, JobStatus } from "@prisma/client";
import { prisma } from "./db";

/** Machine may be a full row or only `{ ownerId }` from a select. */
type JobWithMachineOwner = Job & { machine?: { ownerId: string } | null };

export async function canViewJob(
  userId: string,
  job: JobWithMachineOwner
): Promise<boolean> {
  if (job.requesterId === userId) return true;
  if (job.providerId && job.providerId === userId) return true;
  if (job.machineId) {
    const ownerId =
      job.machine?.ownerId ??
      (await prisma.machine.findUnique({ where: { id: job.machineId }, select: { ownerId: true } }))
        ?.ownerId;
    if (ownerId === userId) return true;
  }
  return false;
}

export async function canStopJob(
  userId: string,
  job: JobWithMachineOwner
): Promise<boolean> {
  if (job.requesterId === userId) return true;
  if (job.providerId && job.providerId === userId) return true;
  if (job.machineId) {
    const ownerId =
      job.machine?.ownerId ??
      (await prisma.machine.findUnique({ where: { id: job.machineId }, select: { ownerId: true } }))
        ?.ownerId;
    if (ownerId === userId) return true;
  }
  return false;
}

export function resolveStopTargetStatus(job: Job, actorUserId: string): JobStatus {
  if (job.requesterId === actorUserId) return JobStatus.cancelled;
  return JobStatus.preempted;
}
