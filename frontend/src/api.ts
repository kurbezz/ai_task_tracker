import type { AttentionItem, Project, Status, Tag, Task, TaskLog } from "./types";
import { getApiKey } from "./apiKey";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("API key is not configured. Add the key printed by the backend in Access key settings.");
  }

  const headers = new Headers(init.headers);
  headers.set("X-Api-Key", apiKey);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error ?? "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export const listProjects = () => request<Project[]>("/projects");
export const createProject = (project: { name: string; description?: string }) =>
  request<Project>("/projects", json("POST", project));
export const listProjectTasks = (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks`);
export const createTask = (task: {
  project_id: string;
  title: string;
  description?: string;
  agent?: string;
}) => request<Task>("/tasks", json("POST", task));
export const getTask = (taskId: string) => request<Task>(`/tasks/${taskId}`);
export const updateTask = (
  taskId: string,
  changes: Partial<Pick<Task, "title" | "description" | "agent" | "result_summary">>,
) => request<Task>(`/tasks/${taskId}`, json("PATCH", changes));
export const transitionTask = (taskId: string, status: Status) =>
  request<Task>(`/tasks/${taskId}/status`, json("POST", { status }));
export const listLogs = (taskId: string) => request<TaskLog[]>(`/tasks/${taskId}/logs`);
export const addLog = (taskId: string, log: { author: string; message: string }) =>
  request<TaskLog>(`/tasks/${taskId}/logs`, json("POST", log));
export const addTag = (taskId: string, name: string) =>
  request<Task>(`/tasks/${taskId}/tags`, json("POST", { name }));
export const removeTag = (taskId: string, tagId: string) =>
  request<void>(`/tasks/${taskId}/tags/${tagId}`, { method: "DELETE" });
export const listAttention = () => request<AttentionItem[]>("/tasks/needs-attention");
