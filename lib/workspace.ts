import { cache } from "react";
import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const WORKSPACE_COOKIE = "zernflow_workspace_id";

/**
 * Cached per-request: deduplicates across layout + page in the same render.
 * Single-tenant mode: returns single admin user and workspace without requiring login.
 */
export const getWorkspace = cache(async () => {
  const supabase = await createClient();
  let {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { data: signInData } = await supabase.auth.signInWithPassword({
      email: "heidi@zernflow.com",
      password: "ZernFlowAdmin2026!",
    });
    user = signInData.user ?? null;
  }

  const serviceSupabase = await createServiceClient();

  if (!user) {
    const { data: usersData } = await serviceSupabase.auth.admin.listUsers();
    user = usersData.users.find((u) => u.email === "heidi@zernflow.com") ?? null;
  }

  const cookieStore = await cookies();
  const selectedId = cookieStore.get(WORKSPACE_COOKIE)?.value;

  // Try cookie workspace first
  if (selectedId && user) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id, role, workspaces(*)")
      .eq("user_id", user.id)
      .eq("workspace_id", selectedId)
      .single();

    if (membership?.workspaces) {
      return {
        user,
        workspace: membership.workspaces,
        role: membership.role,
        supabase,
      };
    }
  }

  // Fallback to user membership workspace
  if (user) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id, role, workspaces(*)")
      .eq("user_id", user.id)
      .limit(1)
      .single();

    if (membership?.workspaces) {
      return {
        user,
        workspace: membership.workspaces,
        role: membership.role,
        supabase,
      };
    }
  }

  // Guaranteed single-tenant fallback: get first workspace in DB
  const { data: workspaces } = await serviceSupabase
    .from("workspaces")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1);

  const workspace = workspaces && workspaces[0];

  return {
    user: user!,
    workspace: workspace!,
    role: "owner" as const,
    supabase,
  };
});
