"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useSocket } from "@/lib/socket-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ArrowLeft, Play, Square } from "lucide-react";
import Link from "next/link";
import { Job, JobLog, JobEvent, JobStatus, MemoryTier, GpuMemoryTier, DurationTier } from "@/types/api";
import StatusBadge from "@/components/StatusBadge";
import { formatDistanceToNow } from "date-fns";

function formatMemoryTier(tier: MemoryTier): string {
  return tier.replace("gb", "") + " GB";
}

function formatGpuMemory(tier: GpuMemoryTier | null): string {
  if (!tier) return "None";
  return tier.replace("gb", "") + " GB";
}

function formatCpuTier(tier: string): string {
  const labels: Record<string, string> = {
    light: "Light (2-4 cores)",
    medium: "Medium (4-8 cores)",
    heavy: "Heavy (8+ cores)",
  };
  return labels[tier] || tier;
}

function formatDurationTier(tier: DurationTier | null): string {
  if (!tier) return "";
  const labels: Record<DurationTier, string> = {
    lt1h: "< 1 hour",
    h1_6: "1-6 hours",
    h6_12: "6-12 hours",
    h12_24: "12-24 hours",
    gt24h: "24+ hours",
  };
  return labels[tier];
}

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id as string;
  const { socket, isConnected, joinJob } = useSocket();
  const { data: session } = authClient.useSession();

  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`http://localhost:3005/api/jobs/${jobId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch job");
      const data = await res.json();
      setJob(data);
      setEvents(data.events || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const fetchLogs = useCallback(async (afterSequence = 0) => {
    try {
      const res = await fetch(`http://localhost:3005/api/jobs/${jobId}/logs?afterSequence=${afterSequence}&limit=100`, {
        credentials: "include",
      });
      if (res.ok) {
        const data: { logs: JobLog[]; nextAfterSequence: number } = await res.json();
        setLogs((prev) => {
          const existingSeqs = new Set(prev.map((l) => l.sequence));
          const newLogs = data.logs.filter((l) => !existingSeqs.has(l.sequence));
          return [...prev, ...newLogs].sort((a, b) => a.sequence - b.sequence);
        });
        return data.nextAfterSequence;
      }
    } catch (e) {
      console.error("Failed to fetch logs", e);
    }
    return afterSequence;
  }, [jobId]);

  const fetchArtifacts = useCallback(async () => {
    try {
      const res = await fetch(`http://localhost:3005/api/jobs/${jobId}/artifacts`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setArtifacts(data);
      }
    } catch (e) {
      console.error("Failed to fetch artifacts", e);
    }
  }, [jobId]);

  useEffect(() => {
    fetchJob();
    fetchLogs();
    fetchArtifacts();
  }, [fetchJob, fetchLogs, fetchArtifacts]);

  // Socket.IO: join room and listen for logs
  useEffect(() => {
    if (socket && isConnected && jobId) {
      joinJob(jobId);

      const handleLog = (logLine: string) => {
        // Append a pseudo-log (server doesn't send full object, just string)
        // In a real implementation, the server should send { line, sequence, stream }
        // For now, we'll refetch logs
        fetchLogs();
      };

      const handleJobUpdate = (data: any) => {
        if (data.jobId === jobId) {
          fetchJob(); // refresh job status
          if (data.type === "artifact") {
            fetchArtifacts();
          }
        }
      };

      socket.on("log", handleLog);
      socket.on("job-update", handleJobUpdate);

      return () => {
        socket.off("log", handleLog);
        socket.off("job-update", handleJobUpdate);
      };
    }
  }, [socket, isConnected, jobId, joinJob, fetchJob, fetchLogs, fetchArtifacts]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleStop = async () => {
    if (!confirm("Stop this job?")) return;
    setStopping(true);
    try {
      const res = await fetch(`http://localhost:3005/api/jobs/${jobId}/stop`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to stop job");
      await fetchJob();
      alert("Job stopped");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setStopping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="text-center text-destructive py-12">
        {error || "Job not found"}
        <Button variant="outline" className="ml-4" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
      </div>
    );
  }

  const isTerminal = ["completed", "failed", "preempted", "cancelled", "rejected"].includes(job.status);
  const canStop = !isTerminal;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/jobs">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Jobs
            </Link>
          </Button>
          <h1 className="text-3xl font-bold">Job Details</h1>
          <div className="flex items-center space-x-4">
            <Badge variant="outline" className="capitalize">{job.type}</Badge>
            <StatusBadge status={job.status} />
          </div>
        </div>
        {canStop && (
          <Button variant="destructive" onClick={handleStop} disabled={stopping}>
            {stopping && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Square className="mr-2 h-4 w-4" />
            Stop Job
          </Button>
        )}
      </div>

      {/* Job Info */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Job Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <span className="font-medium">Repository:</span>{" "}
              <a href={job.repoUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {job.repoUrl}
              </a>
            </div>

            {job.command && (
              <div>
                <span className="font-medium">Command:</span>
                <code className="ml-2 bg-muted px-2 py-1 rounded text-sm">{job.command}</code>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div>
                <span className="font-medium">Resources:</span>
                <ul className="text-sm text-muted-foreground list-disc list-inside">
                  <li>CPU: {formatCpuTier(job.cpuTier)}</li>
                  <li>Memory: {formatMemoryTier(job.memoryTier)}</li>
                  <li>
                    GPU: {formatGpuMemory(job.gpuMemoryTier)}
                    {job.gpuVendor && job.gpuMemoryTier && (
                      <span> ({job.gpuVendor})</span>
                    )}
                  </li>
                </ul>
              </div>
              <div>
                <span className="font-medium">Time Estimates:</span>
                <ul className="text-sm text-muted-foreground list-disc list-inside">
                  {job.estimatedDuration && (
                    <li>Estimated Duration: {formatDurationTier(job.estimatedDuration)}</li>
                  )}
                </ul>
              </div>
            </div>

            {job.kaggleDatasetUrl && (
              <div className="pt-2 border-t">
                <span className="font-medium">Kaggle Dataset:</span>{" "}
                <a href={job.kaggleDatasetUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {job.kaggleDatasetUrl}
                </a>
              </div>
            )}

            <div className="text-sm text-muted-foreground pt-2 border-t">
              <div>Created: {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}</div>
              <div>Updated: {formatDistanceToNow(new Date(job.updatedAt), { addSuffix: true })}</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Assignment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <span className="font-medium">Requester:</span> {job.requesterId}
            </div>
            {job.ownerId && (
              <div>
                <span className="font-medium">Owner:</span> {job.ownerId}
              </div>
            )}
            {job.machine ? (
              <div>
                <span className="font-medium">Machine:</span>
                <div className="text-sm text-muted-foreground">
                  {job.machine.id} (CPU: {job.machine.cpuTotal}, RAM: {job.machine.memoryTotal}MB, GPU: {job.machine.gpuTotal}
                  {job.machine.gpuTotal > 0 && job.machine.gpuVendor && `, ${job.machine.gpuVendor} (${job.machine.gpuMemoryTotal}MB total)`})
                  {job.machine.lastHeartbeatAt && (
                    <div className="text-xs">
                      Last heartbeat: {formatDistanceToNow(new Date(job.machine.lastHeartbeatAt), { addSuffix: true })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground">No machine assigned</div>
            )}
            {job.approval && (
              <div>
                <span className="font-medium">Approval:</span>{" "}
                <Badge variant={job.approval.status === "approved" ? "success" : job.approval.status === "rejected" ? "destructive" : "warning"}>
                  {job.approval.status}
                </Badge>
                {job.approval.decidedAt && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Decided {formatDistanceToNow(new Date(job.approval.decidedAt), { addSuffix: true })}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Live Logs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Live Logs</CardTitle>
            <CardDescription>
              Real-time stream (Socket: {isConnected ? <span className="text-green-500">connected</span> : <span className="text-red-500">disconnected</span>})
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => fetchLogs()}>Refresh</Button>
        </CardHeader>
        <CardContent>
          <div className="log-viewer">
            {logs.length === 0 ? (
              <div className="text-muted-foreground text-sm">No logs yet. Agent will stream logs here.</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className={`log-line ${log.stream || ""}`}>
                  <span className="text-xs text-muted-foreground mr-2">
                    [{log.sequence} {log.stream || "stdout"}]
                  </span>
                  {log.line}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </CardContent>
      </Card>

      {/* Artifacts */}
      <Card>
        <CardHeader>
          <CardTitle>Artifacts ({artifacts.length})</CardTitle>
          <CardDescription>Output files registered by the agent</CardDescription>
        </CardHeader>
        <CardContent>
          {artifacts.length === 0 ? (
            <div className="text-muted-foreground text-sm">No artifacts yet</div>
          ) : (
            <div className="space-y-2">
              {artifacts.map((art) => (
                <div key={art.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div>
                    <div className="font-medium">{art.filename}</div>
                    <div className="text-xs text-muted-foreground">
                      {art.mimeType && `${art.mimeType} • `}
                      {art.sizeBytes ? `${(art.sizeBytes / 1024).toFixed(1)} KB` : "Size unknown"}
                    </div>
                  </div>
                  {/* Placeholder download button */}
                  <Button size="sm" variant="outline" disabled>
                    Download
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Events */}
      <Card>
        <CardHeader>
          <CardTitle>Job Events</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="text-muted-foreground text-sm">No events</div>
          ) : (
            <div className="space-y-3">
              {events.map((ev) => (
                <div key={ev.id} className="text-sm border-b pb-2 last:border-0">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline">{ev.type}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(ev.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                  {ev.payload && (
                    <pre className="mt-1 text-xs bg-muted p-2 rounded overflow-auto">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
