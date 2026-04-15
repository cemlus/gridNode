import { Resend } from "resend";
import 'dotenv/config'

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
        .map(a => `- ${a.filename}: ${a.downloadUrl}`)
        .join("\n");

    const { data, error } = await resend.emails.send({
        from: process.env.EMAIL_FROM || "<GridNode <notifications@domain.com>",
        to,
        subject: `Job ${job.id} ${job.status}`,
        text: `
Job ${job.id} has ${job.status}

Command: ${job.command}

--- Logs (last 20 lines) ---
${logPreview}

--- Artifacts ---
${artifactLinks}

View full job: ${process.env.FRONTEND_URL || "http://localhost:3000"}/jobs/${job.id}
    `,
    });

    if (error) {
        console.error("[Resend] API Error:", error);
        throw new Error(`Resend Error: ${error.message}`);
    }

    console.log("[Resend] Email sent successfully:", data?.id);

}