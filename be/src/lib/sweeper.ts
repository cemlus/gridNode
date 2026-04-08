import { PrismaClient, JobStatus } from "@prisma/client";

const prisma = new PrismaClient();

const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SESSION_STALE_MS = 10 * 60 * 1000;


const ACTIVE_JOB_STATUSES: JobStatus[] = [
    JobStatus.assigned,
    JobStatus.running,
];

let sweepCount = 0;

async function sweep() {
    sweepCount++;
    const sweepId = `sweep_${sweepCount}`;
    const now = new Date();
    const cutoff = new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS);

    console.log(`[Sweeper] ${sweepId} started at ${now.toISOString()}`);

    try {
        const deadMachines = await prisma.machine.findMany({
            where: {
                lastHeartbeatAt: { lt: cutoff },
                status: { not: "offline" },
            },
            select: {
                id: true,
                ownerId: true,
                lastHeartbeatAt: true,
                status: true,
                jobs: {
                    where: { status: { in: ACTIVE_JOB_STATUSES } },
                    select: { id: true, status: true },
                },
            },
        });

        if (deadMachines.length === 0) {
            console.log(`[Sweeper] ${sweepId} — no dead machines found`);
        } else {
            console.log(`[Sweeper] ${sweepId} — found ${deadMachines.length} dead machine(s)`);
        }

        for (const machine of deadMachines) {
            const silentFor = now.getTime() - (machine.lastHeartbeatAt?.getTime() ?? 0);
            const silentSec = Math.round(silentFor / 1000);

            console.log(
                `[Sweeper] Machine ${machine.id} silent for ${silentSec}s — ` +
                `${machine.jobs.length} active job(s)`
            );

            await prisma.$transaction(async (tx) => {
                for (const job of machine.jobs) {
                    await tx.job.update({
                        where: { id: job.id },
                        data: { status: JobStatus.failed },
                    });

                    await tx.jobEvent.create({
                        data: {
                            jobId: job.id,
                            type: "sweeper_failed",
                            payload: {
                                reason: "machine_heartbeat_timeout",
                                machineId: machine.id,
                                silentForSeconds: silentSec,
                                lastHeartbeatAt: machine.lastHeartbeatAt?.toISOString() ?? null,
                                previousStatus: job.status,

                            }
                        },
                    });

                    console.log(`[Sweeper] Job ${job.id} (was: ${job.status}) → failed`);
                }

                await tx.machine.update({
                    where: { id: machine.id },
                    data: { status: "offline" },
                });

                await tx.agentSession.updateMany({
                    where: {
                        machineId: machine.id,
                        status: "active",
                    },
                    data: { status: "revoked" },
                });

                console.log(`[Sweeper] Machine ${machine.id} → offline`);
            });
        }

        const orphanedJobs = await prisma.job.findMany({
            where: {
                status: { in: ACTIVE_JOB_STATUSES },
                machine: { status: "offline" },
            },
            select: {
                id: true,
                status: true,
                machineId: true,
            },
        });

        if (orphanedJobs.length > 0) {
            console.log(`[Sweeper] ${sweepId} — found ${orphanedJobs.length} orphaned job(s)`);

            await prisma.$transaction(async (tx) => {
                for (const job of orphanedJobs) {
                    await tx.job.update({
                        where: { id: job.id },
                        data: { status: JobStatus.failed },
                    });

                    await tx.jobEvent.create({
                        data: {
                            jobId: job.id,
                            type: "sweeper_failed",
                            payload: {
                                reason: "orphaned_job_cleanup",
                                machineId: job.machineId,
                                previousStatus: job.status
                            }
                        },
                    });

                    console.log(`[Sweeper] Orphaned job ${job.id} → failed`);

                }
            });
        }

        const sessionCutoff = new Date(now.getTime() - SESSION_STALE_MS);

        const { count: expiredSessions } = await prisma.agentSession.updateMany({
            where: {
                status: "active",
                lastHeartbeatAt: { lt: sessionCutoff },
            },
            data: { status: "revoked" },
        });

        if (expiredSessions > 0) {
            console.log(`[Sweeper] ${sweepId} — expired ${expiredSessions} stale agent session(s)`);
        }

        console.log(`[Sweeper] ${sweepId} complete`);

    } catch (err) {
        console.error(`[Sweeper] ${sweepId} error:`, err);
    }
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startSweeper() {
    if (intervalHandle) {
        console.warn("[Sweeper] Already running — ignoring duplicate start");
        return;
    }
    console.log(
        `[Sweeper] Starting — ` +
        `interval: ${SWEEP_INTERVAL_MS / 1000}s, ` +
        `timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s`
    );
    sweep();
    intervalHandle = setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function stopSweeper() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        console.log("[Sweeper] Stopped");
    }
}