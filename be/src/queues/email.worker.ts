import { Worker } from "bullmq";
import { connection } from "./connection";
import { prisma } from "../lib/db";
import { generateGetUrl } from "../lib/s3";
import { sendJobResultEmail } from "../lib/email";
import { emitMailUpdate } from "../sockets";

// consumes email-notifications queue's contents
export const emailWorker = new Worker(
  "email-notifications",
  async (job) => {
    const { jobId, requesterEmail, status } = job.data;
    console.log(`[Worker] Processing email for Job ${jobId}`);

    const jobDetails = await prisma.job.findUnique({
      where: { id: jobId },
      include: { requester: true },
    });

    if (!jobDetails) throw new Error(`Job ${jobId} not found`);

    const [logs, artifacts] = await Promise.all([
      prisma.jobLog.findMany({
        where: { jobId },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.artifact.findMany({
        where: { jobId },
      }),
    ]);

    const artifactsWithUrl = await Promise.all(
      artifacts.map(async (a) => ({
        ...a,
        downloadUrl: await generateGetUrl(a.storagePath, a.filename),
      }))
    );

    await sendJobResultEmail({
      to: requesterEmail,
      job: jobDetails,
      logs: logs.reverse().map((l) => l.line),
      artifacts: artifactsWithUrl,
    });

    emitMailUpdate(jobId, { to: requesterEmail, status, jobId });
    console.log(`[Worker] Successfully sent email for Job ${jobId}`);
  },
  { connection, concurrency: 5 }
);

emailWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
});
