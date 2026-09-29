import { NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";
import { getWorkspaceSecrets } from "@/lib/security/workspace-secrets";
import { createZernioClient } from "@/lib/zernio-client";

/**
 * POST /api/v1/channels/sync
 *
 * Syncs all Zernio accounts as channels for the current workspace.
 * Creates new channels for accounts not yet in the DB.
 * Deactivates channels whose Zernio accounts no longer exist.
 */
export async function POST() {
  const resolution = await getApiWorkspace();
  if (!resolution.context) {
    return NextResponse.json(
      { error: resolution.error },
      { status: resolution.status }
    );
  }
  const { workspace, supabase, role } = resolution.context;
  if (role !== "owner" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { lateApiKey } = await getWorkspaceSecrets(workspace.id);
  if (!lateApiKey) {
    return NextResponse.json(
      { error: "Zernio API key not configured. Go to Settings first." },
      { status: 400 }
    );
  }

  const zernio = createZernioClient(lateApiKey);

  try {
    const res = await zernio.accounts.listAccounts();
    const lateAccounts = res.data?.accounts ?? [];

    // Get existing channels for this workspace
    const { data: existingChannels } = await supabase
      .from("channels")
      .select("id, late_account_id, username, display_name, profile_picture, is_active")
      .eq("workspace_id", workspace.id);

    const existingByZernioId = new Map(
      (existingChannels ?? []).map((c) => [c.late_account_id, c])
    );

    // The SDK type doesn't declare profilePicture but the API returns it
    const lateAccountIds = new Set(lateAccounts.map((a: { _id?: string }) => a._id).filter(Boolean));
    let created = 0;
    let updated = 0;

    for (const account of lateAccounts) {
      if (!account._id) continue;
      const acc = account as typeof account & { profilePicture?: string };
      const profilePic = acc.profilePicture || null;

      const existing = existingByZernioId.get(account._id);

      if (existing) {
        if (
          existing.username !== (account.username || null) ||
          existing.display_name !== (account.displayName || account.username || null) ||
          existing.profile_picture !== profilePic
        ) {
          await supabase
            .from("channels")
            .update({
              username: account.username || null,
              display_name: account.displayName || account.username || null,
              profile_picture: profilePic,
            })
            .eq("id", existing.id);
          updated++;
        }
      } else {
        await supabase.from("channels").insert({
          workspace_id: workspace.id,
          platform: account.platform as "facebook" | "instagram" | "linkedin" | "twitter" | "telegram" | "bluesky" | "reddit",
          late_account_id: account._id,
          username: account.username || null,
          display_name: account.displayName || account.username || null,
          profile_picture: profilePic,
          is_active: true,
        });
        created++;
      }
    }

    // Deactivate channels whose Zernio accounts no longer exist
    let deactivated = 0;
    for (const channel of existingChannels ?? []) {
      if (!lateAccountIds.has(channel.late_account_id) && channel.is_active) {
        await supabase
          .from("channels")
          .update({ is_active: false })
          .eq("id", channel.id);
        deactivated++;
      }
    }

    // Return updated channel list
    const { data: channels } = await supabase
      .from("channels")
      .select("id, workspace_id, platform, late_account_id, username, display_name, profile_picture, is_active, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false });

    return NextResponse.json({
      channels: channels ?? [],
      synced: { created, updated, deactivated },
    });
  } catch (error) {
    console.error("Failed to sync channels:", error);
    return NextResponse.json(
      { error: `Failed to sync channels: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
