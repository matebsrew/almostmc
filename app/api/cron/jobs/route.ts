import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeFlow } from "@/lib/flow-engine/engine";
import type { Json } from "@/lib/types/database";
import { isAuthorizedCronRequest } from "@/lib/security/cron-auth";
import { getWorkspaceSecrets } from "@/lib/security/workspace-secrets";

/**
 * Cron job handler that processes scheduled jobs.
 * Call via Vercel Pro or external cron at least once per minute.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServiceClient();
  const staleLeaseBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await supabase
    .from("scheduled_jobs")
    .update({ status: "pending", locked_at: null })
    .eq("status", "processing")
    .or(`locked_at.is.null,locked_at.lt.${staleLeaseBefore}`);

  // Pick up pending jobs that are due
  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(20);

  if (error || !jobs) {
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    // Mark as processing
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("scheduled_jobs")
      .update({ status: "processing", attempts: job.attempts + 1, locked_at: claimedAt })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError || !claimed) continue;

    try {
      await processJob(supabase, job);
      await supabase
        .from("scheduled_jobs")
        .update({ status: "completed", locked_at: null })
        .eq("id", job.id);
      processed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.name : "Error";
      const maxAttempts = 3;

      if (job.attempts + 1 >= maxAttempts) {
        await supabase
          .from("scheduled_jobs")
          .update({ status: "failed", last_error: errorMessage, locked_at: null })
          .eq("id", job.id);
      } else {
        // Retry with backoff
        const backoffMs = Math.pow(2, job.attempts + 1) * 5000;
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: retryAt,
            last_error: errorMessage,
            locked_at: null,
          })
          .eq("id", job.id);
      }
      failed++;
    }
  }

  return NextResponse.json({ processed, failed, total: jobs.length });
}

async function processJob(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  job: { type: string; payload: Json }
) {
  switch (job.type) {
    case "resume_flow": {
      const payload = readJobPayload(job.payload, [
        "sessionId", "flowId", "channelId", "contactId", "conversationId", "workspaceId", "nodeId",
      ]);

      // Check if session is still active
      const { data: session } = await supabase
        .from("flow_sessions")
        .select("id, flow_id, channel_id, contact_id, status")
        .eq("id", payload.sessionId!)
        .eq("flow_id", payload.flowId!)
        .eq("channel_id", payload.channelId!)
        .eq("contact_id", payload.contactId!)
        .eq("status", "active")
        .maybeSingle();

      if (!session) return; // Session was cancelled/completed

      const [flowResult, channelResult, contactResult, conversationResult] = await Promise.all([
        supabase.from("flows").select("id, workspace_id").eq("id", payload.flowId!).maybeSingle(),
        supabase.from("channels").select("id, workspace_id, late_account_id").eq("id", payload.channelId!).maybeSingle(),
        supabase.from("contacts").select("id, workspace_id").eq("id", payload.contactId!).maybeSingle(),
        supabase.from("conversations").select("id, workspace_id, channel_id, contact_id, late_conversation_id")
          .eq("id", payload.conversationId!).maybeSingle(),
      ]);
      const flow = flowResult.data;
      const channel = channelResult.data;
      const contact = contactResult.data;
      const conversation = conversationResult.data;
      if (
        !flow || !channel || !contact || !conversation ||
        flow.workspace_id !== payload.workspaceId ||
        channel.workspace_id !== payload.workspaceId ||
        contact.workspace_id !== payload.workspaceId ||
        conversation.workspace_id !== payload.workspaceId ||
        conversation.channel_id !== channel.id || conversation.contact_id !== contact.id
      ) return;

      await executeFlow(supabase, {
        triggerId: "",
        flowId: payload.flowId!,
        channelId: payload.channelId!,
        contactId: payload.contactId!,
        conversationId: payload.conversationId!,
        workspaceId: payload.workspaceId!,
        lateConversationId: conversation.late_conversation_id || undefined,
        lateAccountId: channel.late_account_id || undefined,
        incomingMessage: {},
      });
      break;
    }

    case "send_broadcast": {
      const payload = readJobPayload(job.payload, ["broadcastId", "recipientId"]);

      const { data: recipient } = await supabase
        .from("broadcast_recipients")
        .select("id, broadcast_id, contact_id, channel_id, status")
        .eq("id", payload.recipientId!)
        .maybeSingle();

      if (!recipient || recipient.status !== "pending" || recipient.broadcast_id !== payload.broadcastId) return;

      const [broadcastResult, contactResult, channelResult] = await Promise.all([
        supabase.from("broadcasts").select("id, workspace_id, message_content").eq("id", payload.broadcastId!).maybeSingle(),
        supabase.from("contacts").select("id, workspace_id").eq("id", recipient.contact_id).maybeSingle(),
        supabase.from("channels").select("id, workspace_id, late_account_id").eq("id", recipient.channel_id).maybeSingle(),
      ]);
      const broadcast = broadcastResult.data;
      const contact = contactResult.data;
      const channel = channelResult.data;
      if (!broadcast || !contact || !channel ||
        broadcast.workspace_id !== contact.workspace_id ||
        broadcast.workspace_id !== channel.workspace_id) return;

      const { lateApiKey } = await getWorkspaceSecrets(broadcast.workspace_id);
      if (!lateApiKey) return;

      const { createZernioClient } = await import("@/lib/zernio-client");
      const zernio = createZernioClient(lateApiKey);
      if (!channel.late_account_id) return;

      // Get the conversation for this contact+channel (need late_conversation_id)
      const { data: conv } = await supabase
        .from("conversations")
        .select("late_conversation_id")
        .eq("contact_id", recipient.contact_id)
        .eq("channel_id", recipient.channel_id)
        .eq("workspace_id", broadcast.workspace_id)
        .single();

      if (!conv?.late_conversation_id) return;

      const messageContent = broadcast.message_content as { text?: string } | null;
      const outgoingText = messageContent?.text?.trim();
      if (!outgoingText || outgoingText.length > 5000) {
        await supabase
          .from("broadcast_recipients")
          .update({ status: "failed", error_message: "Broadcast message content is invalid" })
          .eq("id", payload.recipientId);
        await supabase.rpc("increment_broadcast_failed", { b_id: payload.broadcastId });
        return;
      }

      try {
        await zernio.messages.sendInboxMessage({
          path: { conversationId: conv.late_conversation_id },
          body: { accountId: channel.late_account_id, message: outgoingText },
        });

        await supabase
          .from("broadcast_recipients")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", payload.recipientId);

        // Increment broadcast sent count
        await supabase.rpc("increment_broadcast_sent", {
          b_id: payload.broadcastId,
        });
      } catch (err) {
        await supabase
          .from("broadcast_recipients")
          .update({
            status: "failed",
            error_message: "Zernio message delivery failed",
          })
          .eq("id", payload.recipientId);

        await supabase.rpc("increment_broadcast_failed", {
          b_id: payload.broadcastId,
        });
      }

      // Check if all recipients are done (no more "pending")
      const { count } = await supabase
        .from("broadcast_recipients")
        .select("id", { count: "exact", head: true })
        .eq("broadcast_id", payload.broadcastId)
        .eq("status", "pending");

      if (count === 0) {
        await supabase
          .from("broadcasts")
          .update({ status: "completed" })
          .eq("id", payload.broadcastId)
          .eq("status", "sending");
      }
      break;
    }

    default:
      throw new Error(`Unsupported scheduled job type: ${job.type}`);
  }
}

function readJobPayload(payload: Json, required: string[]): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Scheduled job payload must be an object");
  }
  const record = payload as Record<string, Json>;
  const output: Record<string, string> = {};
  for (const key of required) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 255) {
      throw new Error(`Scheduled job field is invalid: ${key}`);
    }
    output[key] = value;
  }
  return output;
}
