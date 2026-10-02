import "server-only";

import { executeFlow } from "@/lib/flow-engine/engine";
import { matchCommentTrigger, matchTrigger } from "@/lib/flow-engine/trigger-matcher";
import { createServiceClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/types/database";
import { createZernioClient } from "@/lib/zernio-client";
import { getWorkspaceSecrets } from "@/lib/security/workspace-secrets";

interface WebhookAccount {
  id?: string;
  accountId?: string;
  platform?: string;
  username?: string;
  displayName?: string;
}

interface WebhookMessagePayload {
  id: string;
  event: "message.received";
  message: {
    id: string;
    conversationId: string;
    platform: string;
    platformMessageId: string;
    direction: string;
    text: string | null;
    attachments: Array<{ type: string; url: string; payload?: unknown }>;
    sender: {
      id: string;
      name?: string;
      username?: string | null;
      picture?: string | null;
    };
    sentAt: string;
    isRead: boolean;
  };
  conversation: {
    id: string;
    platformConversationId: string | null;
    participantId: string;
    participantName?: string;
    participantUsername?: string | null;
    participantPicture?: string | null;
    status: string;
  };
  account: WebhookAccount;
  metadata?: {
    quickReplyPayload?: string;
    callbackData?: string;
    postbackPayload?: string;
    postbackTitle?: string;
  };
  timestamp: string;
}

interface WebhookCommentPayload {
  id: string;
  event: "comment.received";
  comment: {
    id: string;
    postId: string | null;
    platformPostId: string;
    platform: string;
    text: string;
    author: {
      id: string;
      username?: string | null;
      name?: string | null;
      picture?: string | null;
      isOwnAccount?: boolean;
    };
    createdAt: string;
    isReply: boolean;
    parentCommentId: string | null;
  };
  post: {
    id: string | null;
    platformPostId: string;
  };
  account: WebhookAccount;
  timestamp: string;
}

type WebhookPayload = WebhookMessagePayload | WebhookCommentPayload;

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>;
type WebhookEvent = Database["public"]["Tables"]["webhook_events"]["Row"];

export async function processQueuedWebhookEvents(limit = 5) {
  const supabase = await createServiceClient();
  const { data: events, error } = await supabase.rpc("claim_due_webhook_events", {
    p_limit: limit,
  });

  if (error || !events) {
    throw new Error("Webhook queue could not be claimed");
  }

  let processed = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await processWebhookEvent(supabase, event);
      processed++;
    } catch (error) {
      failed++;
      const attemptsExhausted = event.attempts >= 5;
      const delayMs = Math.min(2 ** event.attempts * 1_000, 300_000);
      await supabase
        .from("webhook_events")
        .update({
          status: attemptsExhausted ? "failed" : "pending",
          available_at: new Date(Date.now() + delayMs).toISOString(),
          locked_at: null,
          last_error: error instanceof Error ? error.name.slice(0, 80) : "Error",
        })
        .eq("channel_id", event.channel_id)
        .eq("event_id", event.event_id)
        .eq("status", "processing");
    }
  }

  return { processed, failed, total: events.length };
}

async function processWebhookEvent(supabase: ServiceClient, event: WebhookEvent) {
  const { data: channel, error: channelError } = await supabase
    .from("channels")
    .select("id, workspace_id, platform, late_account_id")
    .eq("id", event.channel_id)
    .eq("is_active", true)
    .maybeSingle();
  if (channelError) throw channelError;
  if (!channel) {
    await markWebhookEventCompleted(supabase, event);
    return;
  }

  const payload = event.payload as unknown as WebhookPayload;

  if (payload.event === "comment.received") {
    await processCommentWebhookEvent(supabase, event, channel, payload);
    return;
  }

  if (payload.event !== "message.received") {
    await markWebhookEventCompleted(supabase, event);
    return;
  }

  const { message: msg, conversation: conv, account, metadata } = payload;

  if (msg.sender.username) {
    const { data: senderChannel, error } = await supabase
      .from("channels")
      .select("id")
      .eq("workspace_id", channel.workspace_id)
      .eq("username", msg.sender.username)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (senderChannel) {
      await markWebhookEventCompleted(supabase, event);
      return;
    }
  }

  const senderId = msg.sender.id;
  const senderName = msg.sender.name || msg.sender.username || senderId;
  let contactId: string;
  const { data: existingContactChannel, error: contactChannelError } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", channel.id)
    .eq("platform_sender_id", senderId)
    .maybeSingle();
  if (contactChannelError) throw contactChannelError;

  if (existingContactChannel) {
    contactId = existingContactChannel.contact_id;
    const { error } = await supabase
      .from("contacts")
      .update({ last_interaction_at: new Date().toISOString() })
      .eq("id", contactId)
      .eq("workspace_id", channel.workspace_id);
    if (error) throw error;
  } else {
    const { data: newContact, error: createContactError } = await supabase
      .from("contacts")
      .insert({
        workspace_id: channel.workspace_id,
        display_name: senderName,
        avatar_url: msg.sender.picture || null,
        last_interaction_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (createContactError || !newContact) throw createContactError ?? new Error("Contact insert failed");

    contactId = newContact.id;
    const { error: linkError } = await supabase.from("contact_channels").insert({
      contact_id: contactId,
      channel_id: channel.id,
      platform_sender_id: senderId,
      platform_username: msg.sender.username || null,
    });
    if (linkError) throw linkError;

    await supabase.from("analytics_events").insert({
      workspace_id: channel.workspace_id,
      contact_id: contactId,
      event_type: "contact_created",
    });
  }

  const messagePreview = (msg.text || "").slice(0, 100);
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        late_conversation_id: conv.id,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_message_preview: messagePreview,
      },
      { onConflict: "channel_id,contact_id" }
    )
    .select("id, is_automation_paused")
    .single();
  if (conversationError || !conversation) {
    throw conversationError ?? new Error("Conversation upsert failed");
  }

  const { error: inboxUpdateError } = await supabase.rpc("apply_webhook_inbox_update", {
    p_channel_id: channel.id,
    p_event_id: event.event_id,
    p_conversation_id: conversation.id,
    p_preview: messagePreview,
  });
  if (inboxUpdateError) throw inboxUpdateError;

  if (!conversation.is_automation_paused) {
    const incomingMessage = {
      text: msg.text || undefined,
      postbackPayload: metadata?.postbackPayload || undefined,
      quickReplyPayload: metadata?.quickReplyPayload || undefined,
      callbackData: metadata?.callbackData || undefined,
      sender: {
        id: msg.sender.id,
        name: msg.sender.name,
        username: msg.sender.username || undefined,
      },
    };

    const handled = await handleGlobalKeywords(
      supabase,
      channel.workspace_id,
      contactId,
      msg.text || undefined
    );
    if (!handled) {
      const trigger = await matchTrigger(supabase, channel.id, conversation.id, incomingMessage);
      if (trigger) {
        await markWebhookEventCompleted(supabase, event);
        try {
          await executeFlow(supabase, {
            triggerId: trigger.id,
            flowId: trigger.flow_id,
            channelId: channel.id,
            contactId,
            conversationId: conversation.id,
            workspaceId: channel.workspace_id,
            incomingMessage,
            lateConversationId: conv.id,
            lateAccountId: account.accountId ?? account.id ?? channel.late_account_id,
          });
        } catch (error) {
          console.error(
            "Flow execution failed for webhook event:",
            event.event_id,
            error instanceof Error ? error.name : "Error"
          );
        }
        return;
      }
    }
  }

  await markWebhookEventCompleted(supabase, event);
}

async function processCommentWebhookEvent(
  supabase: ServiceClient,
  event: WebhookEvent,
  channel: {
    id: string;
    workspace_id: string;
    platform: Database["public"]["Tables"]["channels"]["Row"]["platform"];
    late_account_id: string;
  },
  payload: WebhookCommentPayload
) {
  const { comment } = payload;

  // Meta can echo our own public replies back as comment.received. Missing
  // isOwnAccount is intentionally not treated as false.
  if (comment.author.isOwnAccount === true) {
    await markWebhookEventCompleted(supabase, event);
    return;
  }

  const postIds = [
    comment.postId,
    comment.platformPostId,
    payload.post?.id,
    payload.post?.platformPostId,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const apiPostId = comment.postId || comment.platformPostId;

  let { data: commentLog, error: commentLogError } = await supabase
    .from("comment_logs")
    .select("id, matched_trigger_id, dm_sent, reply_sent")
    .eq("channel_id", channel.id)
    .eq("platform_comment_id", comment.id)
    .maybeSingle();

  if (commentLogError) throw commentLogError;

  if (!commentLog) {
    const inserted = await supabase
      .from("comment_logs")
      .insert({
        channel_id: channel.id,
        workspace_id: channel.workspace_id,
        post_id: apiPostId,
        platform_comment_id: comment.id,
        author_id: comment.author.id,
        author_name: comment.author.name || null,
        author_username: comment.author.username || null,
        comment_text: comment.text,
      })
      .select("id, matched_trigger_id, dm_sent, reply_sent")
      .single();

    if (inserted.error || !inserted.data) {
      throw inserted.error ?? new Error("Comment log insert failed");
    }
    commentLog = inserted.data;
  }

  const trigger = await matchCommentTrigger(
    supabase,
    channel.id,
    channel.workspace_id,
    {
      text: comment.text,
      postIds,
    }
  );

  if (!trigger) {
    await markWebhookEventCompleted(supabase, event);
    return;
  }

  if (commentLog.matched_trigger_id !== trigger.id) {
    const { error } = await supabase
      .from("comment_logs")
      .update({ matched_trigger_id: trigger.id })
      .eq("id", commentLog.id)
      .eq("workspace_id", channel.workspace_id);
    if (error) throw error;
  }

  const triggerConfig = trigger.config as {
    replyText?: string;
  };

  if (triggerConfig.replyText?.trim() && !commentLog.reply_sent) {
    try {
      const { lateApiKey } = await getWorkspaceSecrets(channel.workspace_id);
      if (!lateApiKey) throw new Error("Zernio API key is not configured");

      const zernio = createZernioClient(lateApiKey);
      await zernio.comments.replyToInboxPost({
        path: { postId: apiPostId },
        body: {
          accountId: channel.late_account_id,
          message: triggerConfig.replyText.trim(),
          commentId: comment.id,
        },
      });

      await supabase
        .from("comment_logs")
        .update({ reply_sent: true })
        .eq("id", commentLog.id)
        .eq("workspace_id", channel.workspace_id);
    } catch (error) {
      console.error(
        "Public comment reply failed:",
        error instanceof Error ? error.name : "Error"
      );
      await supabase
        .from("comment_logs")
        .update({ error: "Public reply failed" })
        .eq("id", commentLog.id)
        .eq("workspace_id", channel.workspace_id);
    }
  }

  const senderId = comment.author.id;
  const senderName =
    comment.author.name || comment.author.username || comment.author.id;

  let contactId: string;
  const { data: existingContactChannel, error: contactChannelError } =
    await supabase
      .from("contact_channels")
      .select("contact_id")
      .eq("channel_id", channel.id)
      .eq("platform_sender_id", senderId)
      .maybeSingle();

  if (contactChannelError) throw contactChannelError;

  if (existingContactChannel) {
    contactId = existingContactChannel.contact_id;
    const { error } = await supabase
      .from("contacts")
      .update({ last_interaction_at: new Date().toISOString() })
      .eq("id", contactId)
      .eq("workspace_id", channel.workspace_id);
    if (error) throw error;
  } else {
    const { data: newContact, error: createContactError } = await supabase
      .from("contacts")
      .insert({
        workspace_id: channel.workspace_id,
        display_name: senderName,
        avatar_url: comment.author.picture || null,
        last_interaction_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (createContactError || !newContact) {
      throw createContactError ?? new Error("Contact insert failed");
    }

    contactId = newContact.id;
    const { error: linkError } = await supabase
      .from("contact_channels")
      .insert({
        contact_id: contactId,
        channel_id: channel.id,
        platform_sender_id: senderId,
        platform_username: comment.author.username || null,
      });
    if (linkError) throw linkError;

    await supabase.from("analytics_events").insert({
      workspace_id: channel.workspace_id,
      contact_id: contactId,
      event_type: "contact_created",
    });
  }

  let conversationId: string;
  const { data: existingConversation, error: conversationReadError } =
    await supabase
      .from("conversations")
      .select("id")
      .eq("channel_id", channel.id)
      .eq("contact_id", contactId)
      .maybeSingle();

  if (conversationReadError) throw conversationReadError;

  if (existingConversation) {
    conversationId = existingConversation.id;
  } else {
    const { data: conversation, error: conversationCreateError } = await supabase
      .from("conversations")
      .insert({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        status: "open",
      })
      .select("id")
      .single();

    if (conversationCreateError || !conversation) {
      throw (
        conversationCreateError ?? new Error("Comment conversation insert failed")
      );
    }
    conversationId = conversation.id;
  }

  // Match the existing message path's at-most-once behavior: durable state is
  // committed before outbound flow side effects begin.
  await markWebhookEventCompleted(supabase, event);

  try {
    await executeFlow(supabase, {
      triggerId: trigger.id,
      flowId: trigger.flow_id,
      channelId: channel.id,
      contactId,
      conversationId,
      workspaceId: channel.workspace_id,
      incomingMessage: {
        text: comment.text,
        sender: {
          id: comment.author.id,
          name: comment.author.name || undefined,
          username: comment.author.username || undefined,
        },
      },
      lateAccountId: channel.late_account_id,
      variables: {
        comment_id: comment.id,
        post_id: apiPostId,
        platform_post_id: comment.platformPostId,
        comment_text: comment.text,
        comment_author_id: comment.author.id,
        comment_author_name: comment.author.name || "",
        comment_author_username: comment.author.username || "",
        comment_log_id: commentLog.id,
      },
    });
  } catch (error) {
    console.error(
      "Comment flow execution failed:",
      event.event_id,
      error instanceof Error ? error.name : "Error"
    );
    await supabase
      .from("comment_logs")
      .update({ error: "Flow execution failed" })
      .eq("id", commentLog.id)
      .eq("workspace_id", channel.workspace_id);
  }
}

async function markWebhookEventCompleted(supabase: ServiceClient, event: WebhookEvent) {
  const { error } = await supabase
    .from("webhook_events")
    .update({ status: "completed", completed_at: new Date().toISOString(), locked_at: null })
    .eq("channel_id", event.channel_id)
    .eq("event_id", event.event_id)
    .eq("status", "processing");
  if (error) throw error;
}

async function handleGlobalKeywords(
  supabase: ServiceClient,
  workspaceId: string,
  contactId: string,
  text: string | undefined
): Promise<boolean> {
  if (!text) return false;

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("global_keywords")
    .eq("id", workspaceId)
    .single();
  if (error) throw error;
  if (!workspace?.global_keywords) return false;

  const keywords = workspace.global_keywords as Array<{
    keyword: string;
    action?: string;
    flowId?: string;
  }>;

  const normalizedText = text.toLowerCase().trim();
  for (const keyword of keywords) {
    if (normalizedText !== keyword.keyword.toLowerCase()) continue;
    if (keyword.action === "unsubscribe" || keyword.action === "subscribe") {
      const { error: updateError } = await supabase
        .from("contacts")
        .update({ is_subscribed: keyword.action === "subscribe" })
        .eq("id", contactId)
        .eq("workspace_id", workspaceId);
      if (updateError) throw updateError;
      return true;
    }
    return false;
  }

  return false;
}
