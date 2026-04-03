"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { Approval, Job } from "@/types/api";
import StatusBadge from "@/components/StatusBadge";
import { formatDistanceToNow } from "date-fns";

function formatMemoryTier(tier: string): string {
  return tier.replace("gb", "") + " GB";
}

function formatGpuMemory(tier: string | null): string {
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

function formatDurationTier(tier: string | null): string {
  if (!tier) return "";
  const labels: Record<string, string> = {
    lt1h: "< 1 hour",
    h1_6: "1-6 hours",
    h6_12: "6-12 hours",
    h12_24: "12-24 hours",
    gt24h: "24+ hours",
  };
  return labels[tier] || tier;
}

export default function ApprovalsPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [hasMachines, setHasMachines] = useState(false);
  const [infoLoaded, setInfoLoaded] = useState(false);

  useEffect(() => {
    if (session) {
      fetch("http://localhost:3005/api/check/me", { credentials: "include" })
        .then((res) => res.json())
        .then((user) => {
          setHasMachines(user?.machineCount ? user.machineCount > 0 : false);
          setInfoLoaded(true);
        })
        .catch((err) => {
          console.error(err);
          setInfoLoaded(true);
        });
    }
  }, [session]);

  useEffect(() => {
    if (!infoLoaded) return;
    if (!session || !hasMachines) {
      router.push("/");
      return;
    }
    if (session && hasMachines) {
      fetchApprovals();
    }
  }, [session, hasMachines, infoLoaded, router]);

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("http://localhost:3005/api/approvals/pending", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch approvals");
      const data = await res.json();
      setApprovals(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleApprove = async (approvalId: string) => {
    if (!confirm("Approve this job?")) return;
    setActing(approvalId);
    try {
      const res = await fetch(`http://localhost:3005/api/approvals/${approvalId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to approve");
      const updatedJob: Job = await res.json();
      // Remove from approvals list
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
      alert(`Job approved! Status: ${updatedJob.status}`);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setActing(null);
    }
  };

  const handleReject = async (approvalId: string) => {
    if (!confirm("Reject this job? This action cannot be undone.")) return;
    setActing(approvalId);
    try {
      const res = await fetch(`http://localhost:3005/api/approvals/${approvalId}/reject`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to reject");
      await res.json();
      // Remove from approvals list
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
      alert("Job rejected");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setActing(null);
    }
  };

  if (isPending || !session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  // The useEffect handles redirect for non-owners, but we also guard here
  if (!hasMachines) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground">Access denied. You need to own at least one machine to view approvals.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Pending Approvals</h1>
        <p className="text-muted-foreground">Review and approve jobs submitted by requesters</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      ) : error ? (
        <div className="text-center text-destructive py-12">{error}</div>
      ) : approvals.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            No pending approvals. All caught up!
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {approvals.map((approval) => (
            <Card key={approval.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="capitalize">{approval.job.type} Job</CardTitle>
                    <CardDescription className="mt-1">
                      Submitted by {approval.job.requester.name || approval.job.requester.email} •{" "}
                      {formatDistanceToNow(new Date(approval.createdAt), { addSuffix: true })}
                    </CardDescription>
                  </div>
                  <StatusBadge status={approval.job.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="font-medium">Repository:</span>{" "}
                  <a href={approval.job.repoUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {approval.job.repoUrl}
                  </a>
                </div>

                {approval.job.command && (
                  <div>
                    <span className="font-medium">Command:</span>{" "}
                    <code className="bg-muted px-2 py-1 rounded text-xs">{approval.job.command}</code>
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">CPU:</span> {formatCpuTier(approval.job.cpuTier)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">RAM:</span> {formatMemoryTier(approval.job.memoryTier)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">GPU:</span> {formatGpuMemory(approval.job.gpuMemoryTier)}
                    {approval.job.gpuVendor && approval.job.gpuMemoryTier && (
                      <span> ({approval.job.gpuVendor})</span>
                    )}
                  </div>
                  {approval.job.estimatedDuration && (
                    <div>
                      <span className="text-muted-foreground">Duration:</span> {formatDurationTier(approval.job.estimatedDuration)}
                    </div>
                  )}
                </div>

                {approval.job.kaggleDatasetUrl && (
                  <div className="text-sm pt-2 border-t">
                    <span className="font-medium">Kaggle Dataset:</span>{" "}
                    <a href={approval.job.kaggleDatasetUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      {approval.job.kaggleDatasetUrl}
                    </a>
                  </div>
                )}

                {approval.job.machine && (
                  <div className="text-sm pt-2 border-t">
                    <span className="font-medium">Target Machine:</span> {approval.job.machine.id} ({approval.job.machine.status})
                  </div>
                )}
              </CardContent>
              <CardFooter className="flex justify-end space-x-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleReject(approval.id)}
                  disabled={acting === approval.id}
                >
                  {acting === approval.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <XCircle className="mr-2 h-4 w-4" />
                  Reject
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleApprove(approval.id)}
                  disabled={acting === approval.id}
                >
                  {acting === approval.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Approve
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
