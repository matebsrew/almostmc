# Setup guide (for a human or an AI coding agent)

Goal: run this app for **one company with one Instagram account**, so the Instagram
account answers DMs/comments automatically (keywords, fixed replies, or GPT replies).

This repository contains **no working credentials**. Everything below must be created
by the person who will own the deployment. Never commit real keys; `.env` is git-ignored.

## 0. What you need (all created by the owner)

| Item | Cost | Used for |
|------|------|----------|
| Supabase project | Free tier available | Database + login |
| Zernio account + API key | Check current plan/limits at https://zernio.com | Connects Instagram, sends/receives messages |
| Vercel account (or any Node host) | Free tier works, see cron note | Hosts the app |
| AI provider key (optional) | **Paid per use** | Only for the "AI Response" node (GPT replies) |

Without an AI key, keyword / fixed-reply flows still work.

## 1. Supabase

1. Create a project at https://supabase.com.
2. SQL editor: paste and run `supabase/migrations/ALL_MIGRATIONS.sql` (all 11 migrations in order).
   Migration 00011 stops with an error on inconsistent legacy rows; a fresh database has none.
3. Copy from Project Settings > API: project URL, anon key, service_role key.
   The service_role key is a server secret. Never expose it in the browser.
4. Authentication > Providers: keep Email enabled. For quick testing you may disable
   "Confirm email"; for production keep it on.

## 2. Environment

```bash
cp .env.example .env
```

Fill `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_APP_URL` (the public URL of the deployment), and `CRON_SECRET`
(generate with `openssl rand -hex 32`).

## 3. Run

```bash
npm ci
npm test && npm run lint && npm run typecheck && npm run build
npm run dev          # http://localhost:3000
```

Register a user at `/register`, then create/select a workspace.

## 4. Connect Zernio + Instagram

1. In Zernio, create an API key and paste it in the app under **Settings**.
2. In **Channels**, connect the Instagram account through the Zernio OAuth flow.
3. Register the webhook in Zernio pointing to `<APP_URL>/api/webhooks/late`.
   The app **rejects unsigned webhooks**, so set the webhook secret in the app
   channel/workspace settings to the same value configured in Zernio.
4. Create a flow with a keyword trigger and a "Send Message" node, and test with a DM.

## 5. GPT replies (optional, paid)

Add an "AI Response" node to a flow. Provide a provider key in **Settings**
(OpenAI, Anthropic or Google) or set `AI_GATEWAY_API_KEY`. The "commands page" idea
maps to: one trigger per command keyword, each routing to an AI Response node with
its own system prompt.

## 6. Deploy on Vercel

1. Import the repository, set the same env vars.
2. `vercel.json` schedules the three cron endpoints **once per day** so it deploys on the
   Hobby plan. Webhook events, delays and sequences are processed only when these
   endpoints run, so daily is too slow for real use. Either:
   - upgrade to Vercel Pro and change the schedules to `* * * * *`, or
   - keep Hobby and call each endpoint every minute from a free external scheduler
     (e.g. cron-job.org) with header `Authorization: Bearer <CRON_SECRET>`:
     `/api/cron/webhooks`, `/api/cron/jobs`, `/api/cron/sequences`.

## Known limits

- Multi-company use is supported by the schema, but the security model was only
  validated statically and with a local Postgres emulator. Run a real two-workspace
  test in Supabase before onboarding a second company.
- If the worker crashes mid-run, a flow execution can be lost (see docs/ARCHITECTURE_AUDIT.md).
- Git history of the original clone contained demo credentials. Do not reuse any key
  found in history; treat them as public and invalid.
