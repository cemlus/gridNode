import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendJobResultEmail({
    to,
    job,
    logs,
    artifacts,
}: {
    to: string;
    job: any;
    logs: string[];
    artifacts: any[];
}) {
    const logPreview = logs.slice(-20).join("\n");

    const artifactLinks = artifacts
        .map(a => `- ${a.fileName}: ${a.downloadUrl}`)
        .join("\n");

    await resend.emails.send({
        from: "GridNode <siddhantbhardwaj47@gmail.com>",
        to,
        subject: `Job ${job.id} ${job.status}`,
        text: `
Job ${job.id} has ${job.status}

Command: ${job.command}

--- Logs (last 20 lines) ---
${logPreview}

--- Artifacts ---
${artifactLinks}

View full job: https://yourfrontend/jobs/${job.id}
    `,
    });
}