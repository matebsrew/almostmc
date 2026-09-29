import { NextRequest, NextResponse } from "next/server";
import { getApiWorkspace } from "@/lib/workspace";
import { saveWorkspaceSecrets } from "@/lib/security/workspace-secrets";
import { createZernioClient } from "@/lib/zernio-client";

export async function POST(request: NextRequest) {
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

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 16_384) {
      return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey =
    body && typeof body === "object" && "apiKey" in body &&
    typeof (body as { apiKey?: unknown }).apiKey === "string"
      ? (body as { apiKey: string }).apiKey.trim()
      : "";
  if (apiKey.length < 8 || apiKey.length > 4096) {
    return NextResponse.json({ error: "apiKey must contain 8 to 4096 characters" }, { status: 400 });
  }

  let accounts: Array<{
    _id?: string;
    platform?: string;
    username?: string;
    displayName?: string;
    profilePicture?: string;
  }>;
  try {
    const zernio = createZernioClient(apiKey);
    const result = await zernio.accounts.listAccounts();
    accounts = (result.data?.accounts ?? []) as typeof accounts;
  } catch {
    return NextResponse.json({ error: "Invalid API key or connection error" }, { status: 400 });
  }

  try {
    await saveWorkspaceSecrets(workspace.id, { lateApiKey: apiKey });
  } catch {
    return NextResponse.json({ error: "Key is valid but could not be saved" }, { status: 500 });
  }

  const { data: existingChannels, error: channelReadError } = await supabase
    .from("channels")
    .select("late_account_id")
    .eq("workspace_id", workspace.id);
  if (channelReadError) {
    return NextResponse.json({ error: "Key saved, but channels could not be loaded" }, { status: 500 });
  }
  const existingIds = new Set((existingChannels ?? []).map((channel) => channel.late_account_id));
  const supported = new Set(["facebook", "instagram", "linkedin", "twitter", "telegram", "bluesky", "reddit"]);

  for (const account of accounts) {
    if (!account._id || !account.platform || !supported.has(account.platform) || existingIds.has(account._id)) continue;
    const { error } = await supabase.from("channels").insert({
      workspace_id: workspace.id,
      platform: account.platform as "facebook" | "instagram" | "linkedin" | "twitter" | "telegram" | "bluesky" | "reddit",
      late_account_id: account._id,
      username: account.username || null,
      display_name: account.displayName || account.username || null,
      profile_picture: account.profilePicture || null,
      is_active: true,
    });
    if (error) {
      return NextResponse.json({ error: "Key saved, but a channel could not be synced" }, { status: 500 });
    }
    existingIds.add(account._id);
  }

  return NextResponse.json({ accounts: accounts.length });
}
