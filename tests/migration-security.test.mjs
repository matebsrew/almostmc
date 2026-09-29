import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("numbered migrations enforce workspace isolation and webhook idempotency in Postgres", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        email text UNIQUE,
        email_confirmed_at timestamptz,
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      CREATE FUNCTION public.uuid_generate_v4()
      RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);

    const migrationDir = resolve(root, "supabase/migrations");
    const migrations = (await readdir(migrationDir))
      .filter((name) => /^\d{5}_.+\.sql$/.test(name))
      .sort();
    assert.equal(migrations.length, 11);

    for (const migration of migrations) {
      let sql = await readFile(resolve(migrationDir, migration), "utf8");
      // Supabase-managed extension and Realtime publication are stubbed by this local fixture.
      sql = sql
        .replace(/^\s*create extension if not exists "uuid-ossp";\s*$/gim, "")
        .replace(/^\s*alter publication supabase_realtime add table [^;]+;\s*$/gim, "");
      await db.exec(sql);
    }

    await db.query(`
      INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      VALUES
        ('00000000-0000-4000-8000-000000000001', 'a@example.test', now(), '{"name":"A"}'),
        ('00000000-0000-4000-8000-000000000002', 'b@example.test', now(), '{"name":"B"}')
    `);

    const memberships = await db.query(`
      SELECT user_id, workspace_id, role
      FROM public.workspace_members
      ORDER BY user_id
    `);
    assert.equal(memberships.rows.length, 2);
    assert.deepEqual(memberships.rows.map((row) => row.role), ["owner", "owner"]);

    const [workspaceA, workspaceB] = memberships.rows.map((row) => row.workspace_id);
    const [userA, userB] = memberships.rows.map((row) => row.user_id);
    const userC = "00000000-0000-4000-8000-000000000003";
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'c@example.test', '{"name":"C"}')`,
      [userC]
    );
    const { rows: channelRows } = await db.query(`
      INSERT INTO public.channels (workspace_id, platform, late_account_id)
      VALUES ($1, 'instagram', 'account-a'), ($2, 'instagram', 'account-b')
      RETURNING id
    `, [workspaceA, workspaceB]);
    const { rows: contactRows } = await db.query(`
      INSERT INTO public.contacts (workspace_id, display_name)
      VALUES ($1, 'A'), ($2, 'B') RETURNING id
    `, [workspaceA, workspaceB]);
    const [channelA, channelB] = channelRows.map((row) => row.id);
    const [contactA, contactB] = contactRows.map((row) => row.id);

    await db.query(`
      INSERT INTO public.workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, 'agent')
    `, [workspaceA, userB]);

    await db.exec(`
      SELECT set_config('request.jwt.claim.sub', '${userA}', false);
      SET ROLE authenticated;
    `);
    const visibleWorkspaces = await db.query("SELECT id FROM public.workspaces");
    assert.deepEqual(visibleWorkspaces.rows.map((row) => row.id), [workspaceA]);
    await assert.rejects(
      db.query("INSERT INTO public.scheduled_jobs (type, run_at) VALUES ('probe', now())")
    );
    await db.exec("RESET ROLE");

    await db.exec(`
      SELECT set_config('request.jwt.claim.sub', '${userB}', false);
      SET ROLE authenticated;
    `);
    await assert.rejects(
      db.query(`
        INSERT INTO public.channels (workspace_id, platform, late_account_id)
        VALUES ($1, 'instagram', 'agent-probe')
      `, [workspaceA])
    );
    await assert.rejects(
      db.query(`
        INSERT INTO public.workspace_invites (workspace_id, email, role, invited_by, expires_at)
        VALUES ($1, 'c@example.test', 'owner', $2, now() + interval '1 day')
      `, [workspaceA, userB])
    );
    await db.exec("RESET ROLE");

    await assert.rejects(
      db.query(`
        INSERT INTO public.conversations (
          workspace_id, channel_id, contact_id, platform, late_conversation_id
        ) VALUES ($1, $2, $3, 'instagram', 'cross-tenant-probe')
      `, [workspaceA, channelB, contactB])
    );

    const { rows: inviteRows } = await db.query(`
      INSERT INTO public.workspace_invites (workspace_id, email, role, invited_by, expires_at)
      VALUES ($1, 'c@example.test', 'agent', $2, now() + interval '1 day')
      RETURNING id
    `, [workspaceA, userA]);
    const inviteId = inviteRows[0].id;

    await db.exec("SET ROLE authenticated");
    await assert.rejects(db.query(
      "SELECT public.claim_webhook_event($1, 'unauthorized', '{}'::jsonb)",
      [channelA]
    ));
    await db.exec("RESET ROLE; SET ROLE service_role");
    await assert.rejects(db.query(
      "SELECT public.accept_workspace_invite($1, $2)",
      [inviteId, userC]
    ));
    const { rows: unconfirmedMemberships } = await db.query(
      "SELECT user_id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceA, userC]
    );
    assert.equal(unconfirmedMemberships.length, 0);

    const { rows: enqueueRows } = await db.query(`
      SELECT public.claim_webhook_event(
        $1, 'event-a', '{"id":"event-a","event":"message.received"}'::jsonb
      ) AS inserted
    `, [channelA]);
    assert.equal(enqueueRows[0].inserted, true);
    const { rows: duplicateRows } = await db.query(`
      SELECT public.claim_webhook_event($1, 'event-a', '{"id":"event-a"}'::jsonb) AS inserted
    `, [channelA]);
    assert.equal(duplicateRows[0].inserted, false);

    const { rows: claimedRows } = await db.query("SELECT * FROM public.claim_due_webhook_events(5)");
    assert.equal(claimedRows.length, 1);
    assert.equal(claimedRows[0].attempts, 1);

    const { rows: conversationRows } = await db.query(`
      INSERT INTO public.conversations (
        workspace_id, channel_id, contact_id, platform, late_conversation_id
      ) VALUES ($1, $2, $3, 'instagram', 'conversation-a') RETURNING id
    `, [workspaceA, channelA, contactA]);
    const conversationId = conversationRows[0].id;
    const { rows: firstApply } = await db.query(`
      SELECT public.apply_webhook_inbox_update($1, 'event-a', $2, 'preview') AS applied
    `, [channelA, conversationId]);
    const { rows: repeatedApply } = await db.query(`
      SELECT public.apply_webhook_inbox_update($1, 'event-a', $2, 'preview') AS applied
    `, [channelA, conversationId]);
    const { rows: unreadRows } = await db.query(
      "SELECT unread_count FROM public.conversations WHERE id = $1",
      [conversationId]
    );
    assert.equal(firstApply[0].applied, true);
    assert.equal(repeatedApply[0].applied, false);
    assert.equal(unreadRows[0].unread_count, 1);
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
