"use client";

import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Loader2 } from "lucide-react";
import { JobType, Machine, CpuTier, MemoryTier, GpuMemoryTier, GpuVendor, DurationTier } from "@/types/api";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}

export default function JobCreateModal({
  open,
  onOpenChange,
  onSuccess,
}: Props) {
  const [type, setType] = useState<JobType>("notebook");
  const [repoUrl, setRepoUrl] = useState("");
  const [command, setCommand] = useState("");

  const [kaggleDatasetUrl, setKaggleDatasetUrl] = useState("");

  // Resource tiers (required)
  const [cpuTier, setCpuTier] = useState<CpuTier>("medium");
  const [memoryTier, setMemoryTier] = useState<MemoryTier>("gb16");

  // GPU (optional)
  const [gpuMemoryTier, setGpuMemoryTier] = useState<GpuMemoryTier | null>(null);
  const [gpuVendor, setGpuVendor] = useState<GpuVendor | null>(null);

  // Duration estimate (optional)
  const [estimatedDuration, setEstimatedDuration] = useState<DurationTier | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setType("notebook");
    setRepoUrl("");
    setCommand("");
    setKaggleDatasetUrl("");

    setCpuTier("medium");
    setMemoryTier("gb16");
    setGpuMemoryTier(null);
    setGpuVendor(null);
    setEstimatedDuration(null);

    setError(null);
  };


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (!repoUrl.trim()) throw new Error("Repository URL is required");

      const body = {
        type,
        repoUrl: repoUrl.trim(),

        // Required resource tiers
        cpuTier,
        memoryTier,

        // Optional fields
        gpuMemoryTier: gpuMemoryTier || null,
        gpuVendor: gpuVendor || null,
        estimatedDuration: estimatedDuration || null,
        kaggleDatasetUrl: kaggleDatasetUrl.trim() || null,

        // Command depends on type
        ...(type === "notebook"
          ? { command: command.trim() }
          : { command: command.trim() }), // Both use command field
      };

      if (!body.command) {
        throw new Error(type === "notebook" ? "Command is required for notebook jobs" : "Command is required for video jobs");
      }

      const res = await fetch("http://localhost:3005/api/jobs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create job");
      }

      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create Job</DialogTitle>
          <DialogDescription>
            Submit your ML or video job with resource requirements.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Job Type */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Job Type</label>
            <Select value={type} onValueChange={(v) => setType(v as JobType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notebook">Notebook (ML)</SelectItem>
                <SelectItem value="video">Video (FFmpeg)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Repository URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Repository URL</label>
            <Input
              placeholder="https://github.com/user/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
            />
          </div>

          {/* Resource Requirements */}
          <div className="border p-4 rounded-lg space-y-4">
            <p className="text-sm font-medium">Resource Requirements</p>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm">CPU Tier</label>
                <Select value={cpuTier} onValueChange={(v) => setCpuTier(v as CpuTier)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light (2-4 cores)</SelectItem>
                    <SelectItem value="medium">Medium (4-8 cores)</SelectItem>
                    <SelectItem value="heavy">Heavy (8+ cores)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm">Memory (RAM)</label>
                <Select value={memoryTier} onValueChange={(v) => setMemoryTier(v as MemoryTier)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gb8">8 GB</SelectItem>
                    <SelectItem value="gb16">16 GB</SelectItem>
                    <SelectItem value="gb32">32 GB</SelectItem>
                    <SelectItem value="gb64">64 GB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* GPU Requirements */}
            <div className="space-y-2">
              <label className="text-sm">GPU (optional)</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={gpuMemoryTier === null}
                    onChange={() => {
                      setGpuMemoryTier(null);
                      setGpuVendor(null);
                    }}
                  />
                  <span className="text-sm">No GPU needed</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={gpuMemoryTier !== null}
                    onChange={() => setGpuMemoryTier("gb16")}
                  />
                  <span className="text-sm">Requires GPU</span>
                </label>
              </div>

              {gpuMemoryTier && (
                <div className="grid grid-cols-2 gap-4 mt-3">
                  <div>
                    <label className="text-sm text-muted-foreground">GPU Memory</label>
                    <Select value={gpuMemoryTier} onValueChange={(v) => setGpuMemoryTier(v as GpuMemoryTier)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gb8">8 GB</SelectItem>
                        <SelectItem value="gb12">12 GB</SelectItem>
                        <SelectItem value="gb16">16 GB</SelectItem>
                        <SelectItem value="gb24">24 GB</SelectItem>
                        <SelectItem value="gb32">32 GB</SelectItem>
                        <SelectItem value="gb48">48 GB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm text-muted-foreground">GPU Vendor (optional)</label>
                    <Select value={gpuVendor || undefined} onValueChange={(v) => setGpuVendor(v as GpuVendor | null)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Any vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="nvidia">NVIDIA</SelectItem>
                        <SelectItem value="amd">AMD</SelectItem>
                        <SelectItem value="intel">Intel</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Estimated Duration */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Estimated Duration (optional)</label>
            <Select value={estimatedDuration || undefined} onValueChange={(v) => setEstimatedDuration(v as DurationTier | null)}>
              <SelectTrigger>
                <SelectValue placeholder="Select expected runtime" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lt1h">&lt; 1 hour</SelectItem>
                <SelectItem value="h1_6">1-6 hours</SelectItem>
                <SelectItem value="h6_12">6-12 hours</SelectItem>
                <SelectItem value="h12_24">12-24 hours</SelectItem>
                <SelectItem value="gt24h">24+ hours</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Helps with scheduling and timeout configuration.
            </p>
          </div>

          {/* Command / Notebook Path */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {type === "notebook" ? "Notebook Command" : "Execution Command"}
            </label>
            {type === "notebook" ? (
              <Input
                placeholder="e.g., jupyter nbconvert --to notebook execute.ipynb"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                required
              />
            ) : (
              <Textarea
                placeholder="e.g., ffmpeg -i input.mp4 output.mp4"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                required
              />
            )}
            <p className="text-xs text-muted-foreground">
              {type === "notebook"
                ? "Command to execute within the notebook repository"
                : "Full command to run for video processing"}
            </p>
          </div>

          {/* Kaggle Dataset */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Kaggle Dataset URL (optional)</label>
            <Input
              placeholder="https://www.kaggle.com/..."
              value={kaggleDatasetUrl}
              onChange={(e) => setKaggleDatasetUrl(e.target.value)}
            />
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && (
                <Loader2 className="animate-spin mr-2 h-4 w-4" />
              )}
              Create Job
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
