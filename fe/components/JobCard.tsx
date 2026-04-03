"use client";

import Link from "next/link";
import type { Job, MemoryTier, GpuMemoryTier } from "@/types/api";
import StatusBadge from "./StatusBadge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { formatDistanceToNow } from "date-fns";

interface JobCardProps {
  job: Job;
  onStop?: (id: string) => void;
}

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

export default function JobCard({ job, onStop }: JobCardProps) {
  const isTerminal = ["completed", "failed", "preempted", "cancelled", "rejected"].includes(job.status);
  const canStop = !isTerminal;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="capitalize">{job.type}</CardTitle>
            <CardDescription className="line-clamp-1">{job.repoUrl}</CardDescription>
          </div>
          <StatusBadge status={job.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">CPU:</span> {formatCpuTier(job.cpuTier)}
          </div>
          <div>
            <span className="text-muted-foreground">RAM:</span> {formatMemoryTier(job.memoryTier)}
          </div>
          <div>
            <span className="text-muted-foreground">GPU:</span> {formatGpuMemory(job.gpuMemoryTier)}
            {job.gpuVendor && job.gpuMemoryTier && (
              <span className="text-xs block text-muted-foreground">{job.gpuVendor}</span>
            )}
          </div>
          {job.estimatedDuration && (
            <div>
              <span className="text-muted-foreground">Duration:</span> {job.estimatedDuration.replace("h", " hours")}
            </div>
          )}
        </div>

        {/* Command */}
        {job.command && (
          <p className="text-sm">
            <span className="text-muted-foreground">Command:</span>{" "}
            <code className="bg-muted px-1 rounded text-xs truncate inline-block max-w-full">{job.command}</code>
          </p>
        )}

        {/* Kaggle Dataset */}
        {job.kaggleDatasetUrl && (
          <p className="text-sm">
            <span className="text-muted-foreground">Dataset:</span>{" "}
            <a href={job.kaggleDatasetUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate inline-block max-w-full">
              Kaggle
            </a>
          </p>
        )}

        <div className="text-xs text-muted-foreground">
          Created {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="text-sm">
            {job.logsCount > 0 && (
              <span className="text-muted-foreground">{job.logsCount} log lines</span>
            )}
            {job.artifactsCount > 0 && (
              <span className="ml-3 text-muted-foreground">{job.artifactsCount} artifacts</span>
            )}
          </div>
          <div className="flex space-x-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${job.id}`}>Details</Link>
            </Button>
            {canStop && onStop && (
              <Button size="sm" variant="destructive" onClick={() => onStop(job.id)}>
                Stop
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
