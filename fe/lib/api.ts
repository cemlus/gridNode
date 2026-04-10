import type {
  User,
  Job,
  Machine,
  Approval,
  JobLog,
  Artifact,
  ArtifactDownload,
  JobEvent,
  ApiResponse,
  MachineRegisterResponse,
  PaginatedLogs,
  CreateJobInput,
  RegisterMachineInput,
} from "@/types/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005";

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const config: RequestInit = {
    credentials: "include", // send cookies for session auth
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  };

  const res = await fetch(url, config);
  const data = await res.json();

  if (!res.ok) {
    const error = data?.error || "Request failed";
    throw new Error(error);
  }

  return data as T;
}

// Auth
export async function getCurrentUser(): Promise<User> {
  return fetchApi<User>("/api/check/me");
}

// Machines
export async function registerMachine(data: RegisterMachineInput): Promise<MachineRegisterResponse> {
  return fetchApi<MachineRegisterResponse>("/api/machines/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function heartbeatMachine(machineId: string, sessionToken: string): Promise<{ ok: boolean; lastHeartbeatAt: string }> {
  return fetchApi(`/api/machines/${machineId}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}

export async function reclaimMachine(machineId: string): Promise<{ ok: boolean; preemptedJobIds: string[] }> {
  return fetchApi(`/api/machines/${machineId}/reclaim`, {
    method: "POST",
  });
}

// Jobs
export async function getJobs(status?: string): Promise<Job[]> {
  const url = status ? `/api/jobs?status=${encodeURIComponent(status)}` : "/api/jobs";
  return fetchApi<Job[]>(url);
}

export async function getJob(id: string): Promise<Job> {
  return fetchApi<Job>(`/api/jobs/${id}`);
}

export async function createJob(data: CreateJobInput): Promise<Job> {
  return fetchApi<Job>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function stopJob(id: string): Promise<Job> {
  return fetchApi<Job>(`/api/jobs/${id}/stop`, {
    method: "POST",
  });
}

export async function getJobLogs(id: string, afterSequence = 0, limit = 100): Promise<PaginatedLogs> {
  return fetchApi<PaginatedLogs>(`/api/jobs/${id}/logs?afterSequence=${afterSequence}&limit=${limit}`);
}

export async function appendJobLogAgent(id: string, lines: { line: string; stream?: string }[], sessionToken: string): Promise<{ inserted: number; lines: JobLog[] }> {
  return fetchApi(`/api/jobs/${id}/logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ lines }),
  });
}

export async function getJobArtifacts(id: string): Promise<Artifact[]> {
  return fetchApi<Artifact[]>(`/api/jobs/${id}/artifacts`);
}

export async function getJobArtifactDownloadUrl(id: string, artifactId: string): Promise<ArtifactDownload> {
  return fetchApi<ArtifactDownload>(`/api/jobs/${id}/artifacts/${artifactId}/download`);
}

export async function registerArtifact(id: string, data: {
  filename: string;
  storagePath: string;
  mimeType?: string;
  sizeBytes?: number;
}, sessionToken: string): Promise<Artifact> {
  return fetchApi<Artifact>(`/api/jobs/${id}/artifacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(data),
  });
}

// Approvals
export async function getPendingApprovals(): Promise<Approval[]> {
  return fetchApi<Approval[]>("/api/approvals/pending");
}

export async function approveJob(approvalId: string): Promise<Job> {
  return fetchApi<Job>(`/api/approvals/${approvalId}/approve`, {
    method: "POST",
  });
}

export async function rejectJob(approvalId: string): Promise<Job> {
  return fetchApi<Job>(`/api/approvals/${approvalId}/reject`, {
    method: "POST",
  });
}
