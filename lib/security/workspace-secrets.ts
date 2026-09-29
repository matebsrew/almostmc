import "server-only";

import { createServiceClient } from "@/lib/supabase/server";

export interface WorkspaceSecretValues {
  lateApiKey: string | null;
  aiApiKey: string | null;
  lateWebhookSecret: string | null;
}

export async function getWorkspaceSecrets(workspaceId: string): Promise<WorkspaceSecretValues> {
  const service = await createServiceClient();
  const { data, error } = await service
    .from("workspace_secrets")
    .select("late_api_key, ai_api_key, late_webhook_secret")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw new Error("Workspace secrets could not be loaded");

  return {
    lateApiKey: data?.late_api_key ?? null,
    aiApiKey: data?.ai_api_key ?? null,
    lateWebhookSecret: data?.late_webhook_secret ?? null,
  };
}

export async function saveWorkspaceSecrets(
  workspaceId: string,
  updates: Partial<WorkspaceSecretValues>
): Promise<void> {
  const service = await createServiceClient();
  const { error } = await service.rpc("save_workspace_secrets", {
    p_workspace_id: workspaceId,
    p_set_late_api_key: updates.lateApiKey !== undefined,
    p_late_api_key: updates.lateApiKey ?? null,
    p_set_ai_api_key: updates.aiApiKey !== undefined,
    p_ai_api_key: updates.aiApiKey ?? null,
    p_set_late_webhook_secret: updates.lateWebhookSecret !== undefined,
    p_late_webhook_secret: updates.lateWebhookSecret ?? null,
  });
  if (error) throw new Error("Workspace secrets could not be saved");
}

export async function getChannelWebhookSecret(
  channelId: string,
  workspaceId: string
): Promise<string | null> {
  const service = await createServiceClient();
  const { data, error } = await service
    .from("channel_secrets")
    .select("webhook_secret")
    .eq("channel_id", channelId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw new Error("Channel webhook secret could not be loaded");
  return data?.webhook_secret ?? null;
}

export async function getWebhookSecret(
  channelId: string,
  workspaceId: string
): Promise<string | null> {
  const service = await createServiceClient();
  const [channelResult, workspaceResult] = await Promise.all([
    service
      .from("channel_secrets")
      .select("webhook_secret")
      .eq("channel_id", channelId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    service
      .from("workspace_secrets")
      .select("late_webhook_secret")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);
  if (channelResult.error) throw new Error("Channel webhook secret could not be loaded");
  if (workspaceResult.error) throw new Error("Workspace webhook secret could not be loaded");
  return channelResult.data?.webhook_secret ?? workspaceResult.data?.late_webhook_secret ?? null;
}

export async function saveChannelWebhookSecret(
  channelId: string,
  workspaceId: string,
  webhookSecret: string
): Promise<void> {
  const service = await createServiceClient();
  const { error } = await service.from("channel_secrets").upsert({
    channel_id: channelId,
    workspace_id: workspaceId,
    webhook_secret: webhookSecret,
    updated_at: new Date().toISOString(),
  });

  if (error) throw new Error("Channel webhook secret could not be saved");
}
