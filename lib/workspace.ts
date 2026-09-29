import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/types/database";

export const WORKSPACE_COOKIE = "zernflow_workspace_id";

export type WorkspaceRole = "owner" | "admin" | "agent";
type WorkspaceRow = Database["public"]["Tables"]["workspaces"]["Row"];

export interface WorkspaceContext {
  user: User;
  workspace: WorkspaceRow;
  role: WorkspaceRole;
  supabase: Awaited<ReturnType<typeof createClient>>;
}

export type ApiWorkspaceResolution =
  | { context: WorkspaceContext }
  | { context: null; status: 401 | 409; error: string };

async function resolveWorkspaceContext(): Promise<ApiWorkspaceResolution> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { context: null, status: 401, error: "Unauthorized" };

  const cookieStore = await cookies();
  const selectedId = cookieStore.get(WORKSPACE_COOKIE)?.value;
  let query = supabase
    .from("workspace_members")
    .select("workspace_id, role, workspaces(id, name, slug, ai_provider, global_keywords, created_at, updated_at)")
    .eq("user_id", user.id);

  if (selectedId) query = query.eq("workspace_id", selectedId);
  const { data: memberships, error } = await query.limit(selectedId ? 1 : 2);

  if (error) {
    return { context: null, status: 409, error: "Workspace access could not be resolved" };
  }

  if (!memberships || memberships.length === 0) {
    return {
      context: null,
      status: 409,
      error: selectedId ? "Selected workspace is not available" : "No workspace is available",
    };
  }

  if (!selectedId && memberships.length > 1) {
    return {
      context: null,
      status: 409,
      error: "Select a workspace before continuing",
    };
  }

  const membership = memberships[0];
  const workspace = membership.workspaces as WorkspaceContext["workspace"] | null;
  if (!workspace || !["owner", "admin", "agent"].includes(membership.role)) {
    return { context: null, status: 409, error: "Workspace membership is invalid" };
  }

  return {
    context: {
      user,
      workspace,
      role: membership.role as WorkspaceRole,
      supabase,
    },
  };
}

export const getWorkspace = cache(async (): Promise<WorkspaceContext> => {
  const result = await resolveWorkspaceContext();
  if (result.context) return result.context;

  if (result.status === 401) redirect("/login");
  redirect("/select-workspace");
});

export async function getApiWorkspace(): Promise<ApiWorkspaceResolution> {
  return resolveWorkspaceContext();
}

export async function requireWorkspaceRole(
  allowedRoles: readonly WorkspaceRole[]
): Promise<WorkspaceContext> {
  const context = await getWorkspace();
  if (!allowedRoles.includes(context.role)) {
    redirect("/dashboard/settings");
  }
  return context;
}
