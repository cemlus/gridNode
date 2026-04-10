export type JobType = "ml_notebook" | "video_render" | "server_run" | "data_processing";
export type JobStatus = "draft" | "pending_approval" | "approved" | "rejected" | "queued" | "assigned" | "running" | "completed" | "failed" | "preempted" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected";

// Resource tier enums (matching backend)
export type CpuTier = "light" | "medium" | "heavy";
export type MemoryTier = "gb8" | "gb16" | "gb32" | "gb64";
export type GpuMemoryTier = "gb8" | "gb12" | "gb16" | "gb24" | "gb32" | "gb48";
export type DurationTier = "lt1h" | "h1_6" | "h6_12" | "h12_24" | "gt24h";
export type GpuVendor = "nvidia" | "amd" | "intel";

export interface User {
  id: string;
  name: string;
  email: string;
  image?: string;
  machineCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Machine {
  id: string;
  ownerId: string;
  userKey: string | null;
  cpuTotal: number;
  memoryTotal: number;
  gpuTotal: number;
  gpuMemoryTotal: number | null;
  gpuVendor: GpuVendor | null;
  status: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  jobId: string;
  status: ApprovalStatus;
  decidedById: string | null;
  decidedAt: string | null;
  createdAt: string;
  job: Job;
}

export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  payload: Record<string, unknown> | null;
  actorId: string | null;
  createdAt: string;
}

export interface JobLog {
  id: string;
  jobId: string;
  sequence: number;
  line: string;
  stream: "stdout" | "stderr" | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  jobId: string;
  filename: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface ArtifactDownload {
  downloadUrl: string;
  filename: string;
}

export interface Job {
  id: string;
  type: JobType;
  repoUrl: string;
  command: string | null;
  kaggleDatasetUrl: string | null;

  // Resource requirements (tiers)
  cpuTier: CpuTier;
  memoryTier: MemoryTier;
  gpuMemoryTier: GpuMemoryTier | null;
  estimatedDuration: DurationTier | null;
  gpuVendor: GpuVendor | null;

  status: JobStatus;
  requesterId: string;
  requester?: User; // Included when query includes requester details
  ownerId: string | null;
  machineId: string | null;
  createdAt: string;
  updatedAt: string;

  approval: Approval | null;
  machine: Machine | null;
  logsCount: number;
  artifactsCount: number;
  events?: JobEvent[];
}

export interface PaginatedLogs {
  logs: JobLog[];
  nextAfterSequence: number;
}

export interface MachineRegisterResponse extends Machine {
  userKey: string;
}

// Input types for API calls
export interface CreateJobInput {
  type: JobType;
  repoUrl: string;
  command: string;
  kaggleDatasetUrl?: string | null;

  cpuTier: CpuTier;
  memoryTier: MemoryTier;
  gpuMemoryTier?: GpuMemoryTier | null;
  gpuVendor?: GpuVendor | null;
  estimatedDuration?: DurationTier | null;

  machineId?: string | null;
}

export interface RegisterMachineInput {
  cpuTotal: number;
  memoryTotal: number;
  gpuTotal: number;
  gpuVendor?: GpuVendor;
  gpuMemoryTotal?: number;
}

// API Response wrapper
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}
