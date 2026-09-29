import { NextRequest, NextResponse } from "next/server";
import { processSequenceSteps } from "@/lib/sequence-processor";
import { isAuthorizedCronRequest } from "@/lib/security/cron-auth";

/**
 * Cron job handler that processes sequence enrollments.
 * Call via Vercel Pro or external cron at least once per minute.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processSequenceSteps();
    return NextResponse.json(result);
  } catch (err) {
    console.error("Sequence cron failed:", err);
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 }
    );
  }
}
