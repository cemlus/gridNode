"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Monitor, Copy, Check, Power } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { Machine } from "@/types/api";

interface MachineStatusBadgeProps {
  lastHeartbeatAt: string | null;
}

function MachineStatusBadge({ lastHeartbeatAt }: MachineStatusBadgeProps) {
  const isRecent = lastHeartbeatAt && new Date(lastHeartbeatAt) > new Date(Date.now() - 5 * 60 * 1000);
  return (
    <Badge variant={isRecent ? "success" : lastHeartbeatAt ? "warning" : "outline"}>
      {isRecent ? "Active" : lastHeartbeatAt ? "Stale" : "Never"}
    </Badge>
  );
}

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [newMachine, setNewMachine] = useState({
    cpuTotal: 2,
    memoryTotal: 4096,
    gpuTotal: 0,
    gpuVendor: undefined as "nvidia" | "amd" | "intel" | undefined,
    gpuMemoryTotal: 0,
  });
  const [showToken, setShowToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reclaiming, setReclaiming] = useState<string | null>(null);

  const fetchMachines = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("http://localhost:3005/api/machines", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch machines");
      const data = await res.json();
      setMachines(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMachines();
  }, [fetchMachines]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegistering(true);
    setError(null);
    try {
      const res = await fetch("http://localhost:3005/api/machines/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newMachine),
      });
      if (!res.ok) throw new Error("Failed to register machine");
      const machine: Machine & { sessionToken: string } = await res.json();
      setShowToken(machine.sessionToken);
      await fetchMachines(); // Refresh list
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRegistering(false);
    }
  };

  const handleCopyToken = async () => {
    if (showToken) {
      await navigator.clipboard.writeText(showToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleHeartbeat = async (machineId: string) => {
    try {
      // Need the session token - in real app, we'd store it; for demo, we'll just fetch and hope agent stored it
      // For now, we'll just GET the machine and if has agent session, it will work (but we need token)
      alert("Heartbeat test requires the agent token. This would be sent by the agent automatically.");
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleReclaim = async (machineId: string) => {
    if (!confirm("Reclaim this machine? All running jobs on this machine will be preempted.")) return;
    setReclaiming(machineId);
    try {
      const res = await fetch(`http://localhost:3005/api/machines/${machineId}/reclaim`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to reclaim machine");
      await fetchMachines();
      alert("Machine reclaimed, jobs preempted");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setReclaiming(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Machines</h1>
        <p className="text-muted-foreground">Register your machines for job execution</p>
      </div>

      {/* Register Form */}
      <Card>
        <CardHeader>
          <CardTitle>Register New Machine</CardTitle>
          <CardDescription>
            Define the compute resources of this machine. You'll receive a session token for the agent.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleRegister}>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">CPU Cores</label>
                <Input
                  type="number"
                  min={1}
                  value={newMachine.cpuTotal}
                  onChange={(e) => setNewMachine({ ...newMachine, cpuTotal: parseInt(e.target.value) || 1 })}
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Memory (MB)</label>
                <Input
                  type="number"
                  min={128}
                  value={newMachine.memoryTotal}
                  onChange={(e) => setNewMachine({ ...newMachine, memoryTotal: parseInt(e.target.value) || 4096 })}
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">GPU Count</label>
                <Input
                  type="number"
                  min={0}
                  value={newMachine.gpuTotal}
                  onChange={(e) => {
                    const gpuTotal = parseInt(e.target.value) || 0;
                    setNewMachine({ ...newMachine, gpuTotal });
                    // Reset GPU fields if no GPUs
                    if (gpuTotal === 0) {
                      setNewMachine(prev => ({ ...prev, gpuVendor: undefined, gpuMemoryTotal: 0 }));
                    }
                  }}
                  required
                />
              </div>
            </div>

            {/* GPU-specific fields - show only if GPU count > 0 */}
            {newMachine.gpuTotal > 0 && (
              <div className="grid grid-cols-2 gap-4 border-t pt-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">GPU Vendor *</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={newMachine.gpuVendor || ""}
                    onChange={(e) => setNewMachine({ ...newMachine, gpuVendor: e.target.value as "nvidia" | "amd" | "intel" | undefined })}
                    required
                  >
                    <option value="" disabled>Select vendor</option>
                    <option value="nvidia">NVIDIA</option>
                    <option value="amd">AMD</option>
                    <option value="intel">Intel</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">GPU Memory per GPU (MB) *</label>
                  <Input
                    type="number"
                    min={1024}
                    step={1024}
                    value={newMachine.gpuMemoryTotal}
                    onChange={(e) => setNewMachine({ ...newMachine, gpuMemoryTotal: parseInt(e.target.value) || 0 })}
                    placeholder="e.g., 16384 for 16GB"
                    required
                  />
                </div>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {showToken && (
              <div className="p-4 bg-muted rounded-md space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Session Token (save this for the agent):</span>
                  <Button type="button" size="sm" variant="outline" onClick={handleCopyToken}>
                    {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                </div>
                <code className="block text-xs break-all bg-background p-2 rounded border">{showToken}</code>
                <p className="text-xs text-muted-foreground">This token will be used by the agent for authentication. Keep it secret.</p>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={registering}>
              {registering && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Plus className="mr-2 h-4 w-4" />
              Register Machine
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Machines List */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Your Machines</h2>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : machines.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              No machines registered yet. Register your first machine to start receiving jobs.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {machines.map((machine) => (
              <Card key={machine.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center">
                      <Monitor className="mr-2 h-4 w-4" />
                      {machine.id.slice(0, 8)}...
                    </CardTitle>
                    <MachineStatusBadge lastHeartbeatAt={machine.lastHeartbeatAt} />
                  </div>
                  <CardDescription>
                    CPU: {machine.cpuTotal} • RAM: {machine.memoryTotal}MB • GPU: {machine.gpuTotal}
                    {machine.gpuTotal > 0 && machine.gpuVendor && (
                      <span> ({machine.gpuVendor}, {machine.gpuMemoryTotal}MB total)</span>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-sm">
                    <span className="font-medium">ID:</span> {machine.id.slice(0, 12)}...
                  </div>
                  {machine.gpuTotal > 0 && machine.gpuVendor && (
                    <div className="text-sm">
                      <span className="font-medium">GPU:</span> {machine.gpuTotal}× {machine.gpuVendor} ({machine.gpuMemoryTotal}MB total)
                    </div>
                  )}
                  {machine.lastHeartbeatAt && (
                    <div className="text-sm">
                      <span className="font-medium">Last heartbeat:</span>{" "}
                      {formatDistanceToNow(new Date(machine.lastHeartbeatAt), { addSuffix: true })}
                    </div>
                  )}
                  {/* Agent session token would be shown here after registration if we stored it; for security we don't persist */}
                </CardContent>
                <CardFooter className="flex justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => alert("Agent will send heartbeats automatically. Manual test not needed.")}
                  >
                    <Power className="mr-2 h-4 w-4" />
                    Heartbeat
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleReclaim(machine.id)}
                    disabled={reclaiming === machine.id}
                  >
                    {reclaiming === machine.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Reclaim
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
