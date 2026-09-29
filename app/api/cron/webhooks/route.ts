import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/security/cron-auth";
import { processQueuedWebhookEvents } from "@/lib/webhooks/late-events";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await processQueuedWebhookEvents());
  } catch {
    return NextResponse.json({ error: "Webhook queue processing failed" }, { status: 500 });
  }
}
