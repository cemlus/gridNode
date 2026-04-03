"use client";

import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Briefcase, CheckSquare, Monitor, Plus } from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import StatusBadge from "@/components/StatusBadge";
import type { Job, MemoryTier, GpuMemoryTier, DurationTier } from "@/types/api";

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

export default function Dashboard() {
  const { data: session, isPending } = authClient.useSession();
  const router = useRouter();
  const [stats, setStats] = useState<{ jobs: number; pendingApprovals: number; machines: number }>({ jobs: 0, pendingApprovals: 0, machines: 0 });
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    if (!isPending && !session) {
      router.push("/login");
    }
  }, [session, isPending, router]);

  useEffect(() => {
    if (session) {
      fetchJobs();
    }
  }, [session]);

  const fetchJobs = async () => {
    try {
      const res = await fetch("http://localhost:3005/api/jobs", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setJobs(data);
      }
    } catch (e) {
      console.error("Failed to fetch jobs", e);
    }
  };

  const pendingApprovalsCount = jobs.filter((j) => j.status === "pending_approval").length;

  // Derive primary role for display based on machine ownership

  if (isPending) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <div className="text-muted-foreground">
            Welcome back, {session.user.name}
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Jobs</CardTitle>
            <Briefcase className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{jobs.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Approvals</CardTitle>
            <CheckSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingApprovalsCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Registered Machines</CardTitle>
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">View in Machines page</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col space-y-2">
            <Button asChild className="w-full">
              <Link href="/jobs">
                <Plus className="mr-2 h-4 w-4" /> Create Job
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/jobs">View All Jobs</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent Jobs */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Recent Jobs</h2>
        {jobs.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              No jobs yet. Create your first job!
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {jobs.slice(0, 6).map((job) => (
              <Card key={job.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="capitalize">{job.type}</CardTitle>
                      <CardDescription className="truncate">{job.repoUrl}</CardDescription>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
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
                        <span className="text-muted-foreground">Duration:</span> {formatDurationTier(job.estimatedDuration)}
                      </div>
                    )}
                  </div>

                  {job.command && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Command:</span>{" "}
                      <code className="bg-muted px-1 rounded text-xs truncate block max-w-[200px]">{job.command}</code>
                    </p>
                  )}

                  {job.kaggleDatasetUrl && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Kaggle:</span>{" "}
                      <a href={job.kaggleDatasetUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs truncate block">
                        {job.kaggleDatasetUrl}
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
                      <Button asChild variant="secondary" size="sm" className="w-full mt-4">
                        <Link href={`/jobs/${job.id}`}>View Details</Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {jobs.length > 6 && (
          <div className="mt-4 text-center">
            <Button asChild variant="outline">
              <Link href="/jobs">View All Jobs</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
