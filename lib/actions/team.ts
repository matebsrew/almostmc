"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";

export async function inviteTeamMember(
  workspaceId: string,
  email: string,
  requestedRole: string
) {
  const { workspace, user, supabase, role: currentRole } = await getWorkspace();

  if (workspace.id !== workspaceId) {
    return { error: "Workspace mismatch" };
  }

  if (currentRole !== "owner" && currentRole !== "admin") return { error: "Only workspace owners and admins can invite members" };

  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedEmail || !trimmedEmail.includes("@")) {
    return { error: "A valid email address is required" };
  }

  const role = requestedRole === "admin"
    ? "admin"
    : requestedRole === "agent"
      ? "agent"
      : null;
  if (!role) {
    return { error: "Invalid role. Must be agent or admin." };
  }

  // Check if this email is already a member
  const { data: existingMembers } = await supabase
    .from("workspace_members")
    .select("user_id, workspaces!inner(id)")
    .eq("workspace_id", workspaceId);

  if (existingMembers && existingMembers.length > 0) {
    // We need to check auth.users for the email, but RLS won't let us.
    // Instead, check if there's already a pending invite for this email.
    const { data: existingInvite } = await supabase
      .from("workspace_invites")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("email", trimmedEmail)
      .eq("status", "pending")
      .single();

    if (existingInvite) {
      return { error: "An invite for this email is already pending" };
    }
  }

  const { data: invite, error: insertError } = await supabase
    .from("workspace_invites")
    .insert({
      workspace_id: workspaceId,
      email: trimmedEmail,
      role,
      invited_by: user.id,
      status: "pending",
    })
    .select("*")
    .single();

  if (insertError) {
    return { error: insertError.message };
  }

  return { ok: true, invite };
}

export async function removeTeamMember(
  workspaceId: string,
  userId: string
) {
  const { workspace, user, supabase, role: currentRole } = await getWorkspace();

  if (workspace.id !== workspaceId) {
    return { error: "Workspace mismatch" };
  }
  if (currentRole !== "owner" && currentRole !== "admin") return { error: "Only workspace owners and admins can remove members" };

  const serviceClient = await createServiceClient();
  const { data: targetMembership } = await serviceClient
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!targetMembership) return { error: "Member not found" };
  if (currentRole === "admin" && targetMembership.role === "owner") return { error: "Only an owner can remove another owner" };

  // Can't remove yourself
  if (userId === user.id) {
    return { error: "You cannot remove yourself from the workspace" };
  }

  const { error: deleteError } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  if (deleteError) {
    return { error: deleteError.message };
  }

  return { ok: true };
}

export async function acceptInvite(inviteId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  const serviceClient = await createServiceClient();
  const { data: workspaceId, error } = await serviceClient.rpc("accept_workspace_invite", {
    p_invite_id: inviteId,
    p_user_id: user.id,
  });
  if (error || !workspaceId) return { error: "Invite is invalid, expired, or belongs to another email" };
  return { ok: true, workspaceId };
}

export async function revokeInvite(inviteId: string) {
  const { workspace, role, supabase } = await getWorkspace();
  if (role !== "owner" && role !== "admin") return { error: "Only workspace owners and admins can revoke invites" };

  const { error: deleteError } = await supabase
    .from("workspace_invites")
    .delete()
    .eq("id", inviteId)
    .eq("workspace_id", workspace.id);

  if (deleteError) {
    return { error: deleteError.message };
  }

  return { ok: true };
}
