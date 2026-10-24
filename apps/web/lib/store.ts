"use client";

import type { Finding, LedgerEntry, PlanDefinition, Project, RemediationTask } from "@shield/shared";
import { create } from "zustand";

/**
 * Client state for the dashboard (PLAN_V2 §5: Zustand for client state;
 * canonical business state always lives on the backend — this store only
 * mirrors API responses).
 */

export interface MeResponse {
  user: { id: string; email: string };
  plan: PlanDefinition;
  balance: number;
  history: LedgerEntry[];
  integrations: Record<string, boolean>;
}

interface DashboardState {
  me: MeResponse | null;
  projects: Project[];
  findings: Finding[];
  tasks: RemediationTask[];
  selectedProjectId: string | null;
  needsAuth: boolean;
  loading: boolean;
  error: string | null;
  loadMe: () => Promise<void>;
  loadProjects: () => Promise<void>;
  selectProject: (projectId: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  localSignIn: (email: string) => Promise<void>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const useDashboard = create<DashboardState>((set, get) => ({
  me: null,
  projects: [],
  findings: [],
  tasks: [],
  selectedProjectId: null,
  needsAuth: false,
  loading: false,
  error: null,

  loadMe: async () => {
    set({ loading: true, error: null });
    try {
      const me = await api<MeResponse>("/api/me");
      set({ me, needsAuth: false, loading: false });
      await get().loadProjects();
    } catch (err) {
      set({
        loading: false,
        needsAuth: err instanceof Error && err.message.includes("authentication"),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadProjects: async () => {
    const data = await api<{ projects: Project[] }>("/api/projects");
    set({ projects: data.projects });
    const first = data.projects[0];
    if (first && !get().selectedProjectId) await get().selectProject(first.id);
  },

  selectProject: async (projectId) => {
    set({ selectedProjectId: projectId });
    const data = await api<{ findings: Finding[]; tasks: RemediationTask[] }>(
      `/api/findings?projectId=${encodeURIComponent(projectId)}`,
    );
    set({ findings: data.findings, tasks: data.tasks });
  },

  createProject: async (name) => {
    const project = await api<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    set({ projects: [...get().projects, project] });
    await get().selectProject(project.id);
    await get().loadMe();
  },

  localSignIn: async (email) => {
    await api("/api/auth/local", { method: "POST", body: JSON.stringify({ email }) });
    await get().loadMe();
  },
}));
