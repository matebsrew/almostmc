import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path) {
  return readFile(resolve(root, path), "utf8");
}

test("unauthenticated visitors are never signed in as a shared admin", async () => {
  const [middleware, proxy, workspace] = await Promise.all([
    source("lib/supabase/middleware.ts"),
    source("proxy.ts"),
    source("lib/workspace.ts"),
  ]);

  assert.equal(/signInWithPassword|auth\.admin\.listUsers/.test(middleware + proxy + workspace), false);
  assert.equal(/export async function proxy\(/.test(proxy), true);
});

test("workspace resolution fails closed and respects the selected workspace", async () => {
  const workspace = await source("lib/workspace.ts");

  assert.equal(/createServiceClient|\.limit\(1\)/.test(workspace), false);
  assert.equal(/WORKSPACE_COOKIE/.test(workspace), true);
  assert.equal(/redirect\(["']\/login/.test(workspace), true);
  assert.equal(/redirect\(["']\/select-workspace/.test(workspace), true);
});

test("workspace creation and role checks stay server-authorized", async () => {
  const [action, access] = await Promise.all([
    source("lib/actions/workspace.ts"),
    source("lib/workspace.ts"),
  ]);

  assert.equal(/\.rpc\(\s*["']create_workspace_for_user/.test(action), true);
  assert.equal(/requireWorkspaceRole/.test(access), true);
});

test("the security migration closes global queue access and enforces tenant roles", async () => {
  const sql = await source("supabase/migrations/00011_security_hardening.sql");

  assert.equal(/REVOKE ALL ON TABLE public\.scheduled_jobs FROM PUBLIC, anon, authenticated/i.test(sql), true);
  assert.equal(/role IN \('owner', 'admin', 'agent'\)/i.test(sql), true);
  assert.equal(/SET search_path\s*=\s*''/i.test(sql), true);
  assert.equal(/CREATE OR REPLACE FUNCTION public\.is_workspace_member\(ws_id uuid\)/i.test(sql), true);
  assert.equal(/assert_related_rows_share_workspace/i.test(sql), true);
  assert.equal(/REVOKE UPDATE ON TABLE public\.workspace_invites FROM PUBLIC, anon, authenticated/i.test(sql), true);
  assert.equal(/accept_workspace_invite/i.test(sql), true);
  assert.equal(/prevent_last_workspace_owner_removal/i.test(sql), true);
});

test("API secrets and webhook signatures are no longer exposed through tenant rows", async () => {
  const [sql, channels, growthPage, webhook] = await Promise.all([
    source("supabase/migrations/00011_security_hardening.sql"),
    source("app/api/v1/channels/route.ts"),
    source("app/(dashboard)/dashboard/growth/page.tsx"),
    source("app/api/webhooks/late/route.ts"),
  ]);

  assert.equal(/CREATE TABLE IF NOT EXISTS public\.workspace_secrets/i.test(sql), true);
  assert.equal(/CREATE TABLE IF NOT EXISTS public\.channel_secrets/i.test(sql), true);
  assert.equal(/DROP COLUMN IF EXISTS (late_api_key_encrypted|ai_api_key)/i.test(sql), true);
  assert.equal(/DROP COLUMN IF EXISTS webhook_secret/i.test(sql), true);
  assert.equal(/\.select\("\*"\)/.test(channels), false);
  assert.equal(/from\("channels"\)[\s\S]{0,140}\.select\("\*"\)/.test(growthPage), false);
  assert.equal(/getWebhookSecret/.test(webhook), true);
  assert.equal(/claim_webhook_event/.test(webhook), true);
  assert.equal(/x-zernio-signature/.test(webhook), true);
  assert.equal(/timingSafeEqual/.test(webhook), true);
  assert.equal(/select\("\*"\)/.test(webhook), false);
  assert.equal(/executeFlow/.test(webhook), false);
  assert.equal(/p_payload:\s*payload/.test(webhook), true);
  assert.equal(/status:\s*202/.test(webhook), true);
  assert.equal(/payload jsonb NOT NULL/i.test(sql), true);
  assert.equal(/claim_due_webhook_events/.test(sql), true);
  assert.equal(/inbox_applied_at/.test(sql), true);
  assert.equal(/apply_webhook_inbox_update/.test(sql), true);
});

test("webhook queue processing has an immediate path and an authenticated retry path", async () => {
  const [route, worker, cron, middleware, config] = await Promise.all([
    source("app/api/webhooks/late/route.ts"),
    source("lib/webhooks/late-events.ts"),
    source("app/api/cron/webhooks/route.ts"),
    source("lib/supabase/middleware.ts"),
    source("vercel.json"),
  ]);

  assert.equal(/isAuthorizedCronRequest/.test(cron), true);
  assert.equal(/claim_due_webhook_events/.test(worker), true);
  assert.equal(/processQueuedWebhookEvents\(1\)/.test(route), true);
  assert.equal(/\bafter\s*\(/.test(route), true);
  assert.equal(/\/api\/cron\/webhooks/.test(config), true);
  assert.equal(/\/api\/cron\/webhooks/.test(middleware), true);
  assert.equal(/executeFlow/.test(route), false);
});

test("Zernio message and comment webhooks reach the automation engine", async () => {
  const [route, worker, matcher, engine] = await Promise.all([
    source("app/api/webhooks/late/route.ts"),
    source("lib/webhooks/late-events.ts"),
    source("lib/flow-engine/trigger-matcher.ts"),
    source("lib/flow-engine/engine.ts"),
  ]);

  assert.equal(/comment\.received/.test(route), true);
  assert.equal(/\["incoming", "outgoing", "inbound", "outbound"\]/.test(route), true);
  assert.equal(/isOwnAccount/.test(route + worker), true);
  assert.equal(/processCommentWebhookEvent/.test(worker), true);
  assert.equal(/from\("comment_logs"\)/.test(worker), true);
  assert.equal(/matchCommentTrigger/.test(worker + matcher), true);
  assert.equal(/comment_log_id/.test(worker + engine), true);
  assert.equal(/dm_sent:\s*true/.test(engine), true);
  assert.equal(/reply_sent:\s*true/.test(engine), true);
});

test("cron endpoints require a bearer secret and lease claimed work", async () => {
  const [auth, jobs, sequences] = await Promise.all([
    source("lib/security/cron-auth.ts"),
    source("app/api/cron/jobs/route.ts"),
    source("app/api/cron/sequences/route.ts"),
  ]);

  assert.equal(/timingSafeEqual/.test(auth), true);
  assert.equal(/searchParams\.get\(["']key/.test(jobs + sequences), false);
  assert.equal(/locked_at/.test(jobs), true);
  assert.equal(/claim_due_sequence_enrollments/.test(await source("supabase/migrations/00011_security_hardening.sql")), true);
});

test("API and server actions resolve the selected workspace and enforce privileged roles", async () => {
  const [channels, testKey, team] = await Promise.all([
    source("app/api/v1/channels/route.ts"),
    source("app/api/v1/channels/test-key/route.ts"),
    source("lib/actions/team.ts"),
  ]);

  assert.equal(/getApiWorkspace/.test(channels + testKey), true);
  assert.equal(/workspaceId/.test(testKey), false);
  assert.equal(/role !== "owner" && role !== "admin"/.test(testKey), true);
  assert.equal(/accept_workspace_invite/.test(team), true);
});

test("the flow HTTP node uses the SSRF-safe client", async () => {
  const engine = await source("lib/flow-engine/engine.ts");

  assert.equal(/executeSafeHttpRequest/.test(engine), true);
  assert.equal(/await fetch\(url/.test(engine), false);
});

test("SSRF address classification blocks private and reserved ranges", async () => {
  const { isPublicAddress } = await import("../lib/security/safe-http-request.mjs");
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "3fff::1",
    "64:ff9b::1",
    "100::1",
    "5f00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false, "private or reserved address was accepted");
  }

  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("HTTP flow URLs reject non-web protocols, credentials, and nonstandard ports", async () => {
  const { parseSafeHttpUrl } = await import("../lib/security/safe-http-request.mjs");
  for (const target of [
    "file:///etc/passwd",
    "http://localhost/",
    "http://user:pass@example.com/",
    "https://example.com:8443/",
  ]) {
    assert.throws(() => parseSafeHttpUrl(target));
  }

  assert.equal(parseSafeHttpUrl("https://example.com/path").hostname, "example.com");
});

test("service credentials and test account data are environment-only", async () => {
  const paths = [
    "scripts/provision-single-tenant.js",
    "scripts/test-db.js",
    "scripts/test-user.js",
  ];
  const scripts = await Promise.all(paths.map(source));
  const combined = scripts.join("\n");

  assert.equal(/(?:SERVICE_ROLE_KEY|ZERNIO_KEY|ADMIN_PASSWORD|TEST_PASSWORD)\s*=\s*["'`]/i.test(combined), false);
  assert.equal(/process\.env\.(?:SUPABASE_SERVICE_ROLE_KEY|ZERNIO_API_KEY|ADMIN_PASSWORD|TEST_PASSWORD)/.test(combined), true);
});
