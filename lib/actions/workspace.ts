"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE } from "@/lib/workspace";
import { saveWorkspaceSecrets } from "@/lib/security/workspace-secrets";

export async function switchWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  // Validate user has access to this workspace
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!membership) return { error: "No access to this workspace" };

  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });

  return { ok: true };
}

export async function selectWorkspace(workspaceId: string) {
  const result = await switchWorkspace(workspaceId);
  if ("error" in result) throw new Error(result.error);
  redirect("/dashboard");
}

export async function createWorkspace(name: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    return { error: "Workspace name must contain 1 to 100 characters" };
  }

  const { data: workspaceId, error } = await supabase.rpc(
    "create_workspace_for_user",
    { p_name: trimmed }
  );

  if (error || !workspaceId) return { error: error?.message || "Failed to create workspace" };

  // Switch to new workspace
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });

  return { ok: true, workspaceId };
}

export async function createWorkspaceFromForm(formData: FormData) {
  const name = formData.get("name");
  const result = await createWorkspace(typeof name === "string" ? name : "");
  if ("error" in result) throw new Error(result.error);
  redirect("/dashboard");
}

export async function saveWorkspaceSettings(input: {
  workspaceId: string;
  name: string;
  globalKeywords: string[];
  lateApiKey?: string;
  aiApiKey?: string;
  lateWebhookSecret?: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const name = input.name.trim();
  if (!name || name.length > 100) {
    return { error: "Workspace name must contain 1 to 100 characters" };
  }
  if (
    !Array.isArray(input.globalKeywords) ||
    input.globalKeywords.length > 100 ||
    input.globalKeywords.some((keyword) => typeof keyword !== "string" || keyword.length > 100)
  ) {
    return { error: "Global keywords are invalid" };
  }

  const { data: membership, error: membershipError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError || !membership || !["owner", "admin"].includes(membership.role)) {
    return { error: "Only workspace owners and admins can change settings" };
  }

  const keywords = [...new Set(input.globalKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
  const { error: updateError } = await supabase
    .from("workspaces")
    .update({ name, global_keywords: keywords })
    .eq("id", input.workspaceId);
  if (updateError) return { error: updateError.message };

  const apiKey = input.lateApiKey?.trim();
  const aiKey = input.aiApiKey?.trim();
  const webhookSecret = input.lateWebhookSecret?.trim();
  if ((apiKey && apiKey.length > 4096) || (aiKey && aiKey.length > 4096)) {
    return { error: "Configured API keys are too long" };
  }
  if (webhookSecret && (webhookSecret.length < 32 || webhookSecret.length > 4096)) {
    return { error: "Webhook secret must contain 32 to 4096 characters" };
  }
  if (apiKey || aiKey || webhookSecret) {
    try {
      await saveWorkspaceSecrets(input.workspaceId, {
        ...(apiKey ? { lateApiKey: apiKey } : {}),
        ...(aiKey ? { aiApiKey: aiKey } : {}),
        ...(webhookSecret ? { lateWebhookSecret: webhookSecret } : {}),
      });
    } catch {
      return { error: "Settings were saved, but secret storage failed" };
    }
  }

  return { ok: true };
}
