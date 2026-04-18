"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Monitor, Copy, Check, Power, Key } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { Machine } from "@/types/api";

interface MachineStatusBadgeProps {
  lastHeartbeatAt: string | null;
  status: string;
}

function MachineStatusBadge({ lastHeartbeatAt, status }: MachineStatusBadgeProps) {
  const isRecent = lastHeartbeatAt && new Date(lastHeartbeatAt) > new Date(Date.now() - 5 * 60 * 1000);
  
  if (!isRecent) {
    return (
      <Badge variant="destructive">
        Offline
      </Badge>
    );
  }

  if (status === "running") {
    return (
      <Badge className="bg-green-500 hover:bg-green-600 text-white">
        Running Job
      </Badge>
    );
  }

  return (
    <Badge variant="secondary">
      Idle
    </Badge>
  );
}

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [userKey, setUserKey] = useState<string | null>(null);
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

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:3005/api/check/me", {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setUserKey(data.userKey);
      }
    } catch (e) {
      console.error("Failed to fetch user", e);
    }
  }, []);

  useEffect(() => {
    fetchMachines();
    fetchUser();
  }, [fetchMachines, fetchUser]);

  const handleRegister = async () => {
    setRegistering(true);
    setError(null);
    try {
      const res = await fetch("http://localhost:3005/api/check/user-key", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to generate user key");
      const data = await res.json();
      setUserKey(data.userKey);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRegistering(false);
    }
  };

  const handleCopyToken = async () => {
    if (userKey) {
      await navigator.clipboard.writeText(userKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
        <p className="text-muted-foreground">Manage your compute resources and agent keys</p>
      </div>

      {/* Agent Key Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Key className="mr-2 h-5 w-5 text-primary" />
            Agent Registration Key
          </CardTitle>
          <CardDescription>
            Use this key to register and start your local compute agent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {userKey ? (
            <div className="p-4 bg-muted rounded-md space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Your Personal Agent Key:</span>
                <Button type="button" size="sm" variant="outline" onClick={handleCopyToken}>
                  {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                  {copied ? "Copied!" : "Copy Key"}
                </Button>
              </div>
              <code className="block text-xs break-all bg-background p-3 rounded border font-mono">
                {userKey}
              </code>
              <p className="text-xs text-muted-foreground">
                Run: <code className="bg-background px-1 py-0.5 rounded border">computeshare-agent start --token {userKey}</code>
              </p>
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground mb-4">You haven't generated an agent key yet.</p>
              <Button onClick={handleRegister} disabled={registering}>
                {registering && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Register to get Agent Key
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-destructive mt-2">{error}</p>}
        </CardContent>
        {userKey && (
          <CardFooter className="border-t bg-muted/50 py-3">
            <p className="text-xs text-muted-foreground">
              Wait, need a new key? <button onClick={handleRegister} className="underline hover:text-primary">Click here to regenerate</button>. Note: Old key will still work for existing machines.
            </p>
          </CardFooter>
        )}
      </Card>

      {/* Machines List */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Your Active Machines</h2>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : machines.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              No machines registered yet. Use your Agent Key to connect a machine.
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
                      {machine.id}
                    </CardTitle>
                    <MachineStatusBadge lastHeartbeatAt={machine.lastHeartbeatAt} status={machine.status} />
                  </div>
                  <CardDescription>
                    CPU: {machine.cpuTotal} • RAM: {Math.round(machine.memoryTotal / 1024)}GB • GPU: {machine.gpuTotal}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {machine.gpuTotal > 0 && machine.gpuVendor && (
                    <div className="text-sm">
                      <span className="font-medium">GPU:</span> {machine.gpuVendor} ({Math.round(machine.gpuMemoryTotal || 0 / 1024)}GB)
                    </div>
                  )}
                  {machine.lastHeartbeatAt && (
                    <div className="text-sm">
                      <span className="font-medium">Last seen:</span>{" "}
                      {formatDistanceToNow(new Date(machine.lastHeartbeatAt), { addSuffix: true })}
                    </div>
                  )}
                </CardContent>
                <CardFooter className="flex justify-end">
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
