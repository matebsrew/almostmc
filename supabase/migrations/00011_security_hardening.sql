-- Security hardening for authenticated multi-workspace deployments.
-- Apply after 00010_flow_versions.sql. A failed preflight is intentional: fix
-- the reported legacy rows before retrying so this migration cannot hide them.

-- Normalize the only legacy role name. Unknown role values stop the migration.
UPDATE public.workspace_members SET role = 'agent' WHERE role = 'member';
UPDATE public.workspace_invites SET role = 'agent' WHERE role = 'member';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'agent')
  ) THEN
    RAISE EXCEPTION 'workspace_members has unsupported roles; map them before applying 00011';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_invites
    WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'agent')
  ) THEN
    RAISE EXCEPTION 'workspace_invites has unsupported roles; map them before applying 00011';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_invites
    WHERE status = 'pending' AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'pending owner invitations must be revoked or converted before applying 00011';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_invites
    WHERE status = 'pending'
    GROUP BY workspace_id, lower(email)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate pending invitations must be resolved before applying 00011';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspaces w
    WHERE NOT EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = w.id AND wm.role = 'owner'
    )
  ) THEN
    RAISE EXCEPTION 'every workspace must have an owner before applying 00011';
  END IF;
END;
$$;

ALTER TABLE public.workspace_members
  ALTER COLUMN role SET NOT NULL;
ALTER TABLE public.workspace_members
  DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE public.workspace_members
  ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'admin', 'agent'));
ALTER TABLE public.workspace_invites
  ALTER COLUMN role SET NOT NULL;
ALTER TABLE public.workspace_invites
  ALTER COLUMN role SET DEFAULT 'agent';
ALTER TABLE public.workspace_invites
  DROP CONSTRAINT IF EXISTS workspace_invites_role_check;
ALTER TABLE public.workspace_invites
  ADD CONSTRAINT workspace_invites_role_check CHECK (role IN ('owner', 'admin', 'agent'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_one_pending_email
  ON public.workspace_invites (workspace_id, lower(email))
  WHERE status = 'pending';

ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_processing_lease
  ON public.scheduled_jobs(locked_at) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS public.sequence_processing_locks (
  enrollment_id uuid PRIMARY KEY REFERENCES public.sequence_enrollments(id) ON DELETE CASCADE,
  locked_until timestamptz NOT NULL
);
ALTER TABLE public.sequence_processing_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sequence_processing_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sequence_processing_locks TO service_role;

-- Move secrets out of rows readable by workspace members before dropping the
-- old columns. The secret tables have no client policies or client grants.
CREATE TABLE IF NOT EXISTS public.workspace_secrets (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  late_api_key text,
  ai_api_key text,
  late_webhook_secret text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.save_workspace_secrets(
  p_workspace_id uuid,
  p_set_late_api_key boolean,
  p_late_api_key text,
  p_set_ai_api_key boolean,
  p_ai_api_key text,
  p_set_late_webhook_secret boolean,
  p_late_webhook_secret text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.workspace_secrets (
    workspace_id, late_api_key, ai_api_key, late_webhook_secret
  ) VALUES (
    p_workspace_id,
    CASE WHEN p_set_late_api_key THEN p_late_api_key END,
    CASE WHEN p_set_ai_api_key THEN p_ai_api_key END,
    CASE WHEN p_set_late_webhook_secret THEN p_late_webhook_secret END
  )
  ON CONFLICT (workspace_id) DO UPDATE SET
    late_api_key = CASE WHEN p_set_late_api_key THEN p_late_api_key ELSE public.workspace_secrets.late_api_key END,
    ai_api_key = CASE WHEN p_set_ai_api_key THEN p_ai_api_key ELSE public.workspace_secrets.ai_api_key END,
    late_webhook_secret = CASE WHEN p_set_late_webhook_secret THEN p_late_webhook_secret ELSE public.workspace_secrets.late_webhook_secret END,
    updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.save_workspace_secrets(uuid, boolean, text, boolean, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_workspace_secrets(uuid, boolean, text, boolean, text, boolean, text)
  TO service_role;

INSERT INTO public.workspace_secrets (workspace_id, late_api_key, ai_api_key)
SELECT id, late_api_key_encrypted, ai_api_key
FROM public.workspaces
WHERE late_api_key_encrypted IS NOT NULL OR ai_api_key IS NOT NULL
ON CONFLICT (workspace_id) DO UPDATE
SET late_api_key = COALESCE(EXCLUDED.late_api_key, public.workspace_secrets.late_api_key),
    ai_api_key = COALESCE(EXCLUDED.ai_api_key, public.workspace_secrets.ai_api_key),
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.channel_secrets (
  channel_id uuid PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  webhook_secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.channel_secrets (channel_id, workspace_id, webhook_secret)
SELECT id, workspace_id, webhook_secret
FROM public.channels
WHERE webhook_secret IS NOT NULL AND length(webhook_secret) > 0
ON CONFLICT (channel_id) DO UPDATE
SET workspace_id = EXCLUDED.workspace_id,
    webhook_secret = EXCLUDED.webhook_secret,
    updated_at = now();

ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS late_api_key_encrypted,
  DROP COLUMN IF EXISTS ai_api_key;
ALTER TABLE public.channels DROP COLUMN IF EXISTS webhook_secret;

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  inbox_applied_at timestamptz,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (channel_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_due
  ON public.webhook_events(status, available_at, claimed_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processing_lease
  ON public.webhook_events(locked_at) WHERE status = 'processing';

ALTER TABLE public.workspace_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_secrets, public.channel_secrets, public.webhook_events
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.workspace_secrets, public.channel_secrets, public.webhook_events
  TO service_role;

-- SECURITY DEFINER helpers always use an empty search_path and qualified names.
CREATE OR REPLACE FUNCTION public.is_workspace_member(ws_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members AS wm
    WHERE wm.workspace_id = ws_id
      AND wm.user_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.has_workspace_role(p_workspace_id uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members AS wm
    WHERE wm.workspace_id = p_workspace_id
      AND wm.user_id = (SELECT auth.uid())
      AND wm.role = ANY (p_roles)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_contact_member(p_contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts AS c
    WHERE c.id = p_contact_id AND public.is_workspace_member(c.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_channel_member(p_channel_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.channels AS c
    WHERE c.id = p_channel_id AND public.is_workspace_member(c.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tag_member(p_tag_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tags AS t
    WHERE t.id = p_tag_id AND public.is_workspace_member(t.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_custom_field_member(p_field_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.custom_field_definitions AS d
    WHERE d.id = p_field_id AND public.is_workspace_member(d.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_flow_member(p_flow_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.flows AS f
    WHERE f.id = p_flow_id AND public.is_workspace_member(f.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_conversation_member(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations AS c
    WHERE c.id = p_conversation_id AND public.is_workspace_member(c.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_broadcast_member(p_broadcast_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.broadcasts AS b
    WHERE b.id = p_broadcast_id AND public.is_workspace_member(b.workspace_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_sequence_member(p_sequence_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sequences AS s
    WHERE s.id = p_sequence_id AND public.is_workspace_member(s.workspace_id)
  );
$$;

REVOKE ALL ON FUNCTION public.is_workspace_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_workspace_role(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_contact_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_channel_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_tag_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_custom_field_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_flow_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_conversation_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_broadcast_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_sequence_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid),
  public.has_workspace_role(uuid, text[]),
  public.is_contact_member(uuid),
  public.is_channel_member(uuid),
  public.is_tag_member(uuid),
  public.is_custom_field_member(uuid),
  public.is_flow_member(uuid),
  public.is_conversation_member(uuid),
  public.is_broadcast_member(uuid),
  public.is_sequence_member(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_workspace_for_user(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_slug text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'workspace name must contain 1 to 100 characters';
  END IF;

  v_slug := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  IF v_slug = '' THEN v_slug := 'workspace'; END IF;
  v_slug := left(v_slug, 42) || '-' || left(gen_random_uuid()::text, 8);

  INSERT INTO public.workspaces (name, slug)
  VALUES (trim(p_name), v_slug)
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, v_user_id, 'owner');

  RETURN v_workspace_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_workspace_for_user(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace_for_user(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_workspace_invite(p_invite_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invite public.workspace_invites%ROWTYPE;
  v_email text;
BEGIN
  SELECT lower(u.email) INTO v_email
  FROM auth.users u
  WHERE u.id = p_user_id
    AND u.email_confirmed_at IS NOT NULL;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'user email is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invite
  FROM public.workspace_invites
  WHERE id = p_invite_id
  FOR UPDATE;
  IF NOT FOUND OR v_invite.status <> 'pending' OR v_invite.expires_at <= now()
    OR lower(v_invite.email) <> v_email OR v_invite.role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'invite is invalid or expired' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_invite.workspace_id, p_user_id, v_invite.role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  UPDATE public.workspace_invites
  SET status = 'accepted'
  WHERE id = p_invite_id AND status = 'pending';

  RETURN v_invite.workspace_id;
END;
$$;
REVOKE ALL ON FUNCTION public.accept_workspace_invite(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_workspace_invite(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  p_channel_id uuid,
  p_event_id text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH inserted AS (
    INSERT INTO public.webhook_events (channel_id, event_id, payload)
    VALUES (p_channel_id, p_event_id, p_payload)
    ON CONFLICT (channel_id, event_id) DO NOTHING
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM inserted);
$$;
REVOKE ALL ON FUNCTION public.claim_webhook_event(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_due_webhook_events(p_limit integer DEFAULT 5)
RETURNS SETOF public.webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.webhook_events
  SET status = 'failed', locked_at = NULL, last_error = 'Processing lease expired'
  WHERE status = 'processing'
    AND locked_at < now() - interval '10 minutes'
    AND attempts >= 5;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.webhook_events
    WHERE (status = 'pending' AND available_at <= now())
       OR (status = 'processing' AND locked_at < now() - interval '10 minutes' AND attempts < 5)
    ORDER BY available_at, claimed_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 5)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.webhook_events AS events
  SET status = 'processing', locked_at = now(), attempts = events.attempts + 1
  FROM candidates
  WHERE events.id = candidates.id
  RETURNING events.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_due_webhook_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_webhook_events(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_webhook_inbox_update(
  p_channel_id uuid,
  p_event_id text,
  p_conversation_id uuid,
  p_preview text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.webhook_events
  SET inbox_applied_at = now()
  WHERE channel_id = p_channel_id
    AND event_id = p_event_id
    AND status = 'processing'
    AND inbox_applied_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.conversations
  SET unread_count = unread_count + 1,
      last_message_at = now(),
      last_message_preview = left(COALESCE(p_preview, ''), 100)
  WHERE id = p_conversation_id AND channel_id = p_channel_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook conversation does not belong to its channel';
  END IF;

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_webhook_inbox_update(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_webhook_inbox_update(uuid, text, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_due_sequence_enrollments(p_limit integer DEFAULT 50)
RETURNS SETOF public.sequence_enrollments
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH candidates AS (
    SELECT e.id
    FROM public.sequence_enrollments e
    JOIN public.sequences s ON s.id = e.sequence_id AND s.status = 'active'
    LEFT JOIN public.sequence_processing_locks l ON l.enrollment_id = e.id
    WHERE e.status = 'active'
      AND e.next_step_at <= now()
      AND (l.enrollment_id IS NULL OR l.locked_until < now())
    ORDER BY e.next_step_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50)
    FOR UPDATE OF e SKIP LOCKED
  ), claimed AS (
    INSERT INTO public.sequence_processing_locks (enrollment_id, locked_until)
    SELECT id, now() + interval '15 minutes' FROM candidates
    ON CONFLICT (enrollment_id) DO UPDATE
      SET locked_until = EXCLUDED.locked_until
      WHERE public.sequence_processing_locks.locked_until < now()
    RETURNING enrollment_id
  )
  SELECT e.*
  FROM public.sequence_enrollments e
  JOIN claimed c ON c.enrollment_id = e.id;
$$;
REVOKE ALL ON FUNCTION public.claim_due_sequence_enrollments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_sequence_enrollments(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.release_sequence_enrollment_lock(p_enrollment_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.sequence_processing_locks WHERE enrollment_id = p_enrollment_id;
$$;
REVOKE ALL ON FUNCTION public.release_sequence_enrollment_lock(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_sequence_enrollment_lock(uuid) TO service_role;

-- Reject inconsistent tenant references even when a privileged worker bypasses RLS.
CREATE OR REPLACE FUNCTION public.assert_related_rows_share_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_primary uuid;
  v_related uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'contact_channels' THEN
      SELECT workspace_id INTO v_primary FROM public.contacts WHERE id = NEW.contact_id;
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'contact and channel must belong to the same workspace';
      END IF;
    WHEN 'contact_tags' THEN
      SELECT workspace_id INTO v_primary FROM public.contacts WHERE id = NEW.contact_id;
      SELECT workspace_id INTO v_related FROM public.tags WHERE id = NEW.tag_id;
      IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'contact and tag must belong to the same workspace';
      END IF;
    WHEN 'contact_custom_fields' THEN
      SELECT workspace_id INTO v_primary FROM public.contacts WHERE id = NEW.contact_id;
      SELECT workspace_id INTO v_related FROM public.custom_field_definitions WHERE id = NEW.field_id;
      IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'contact and custom field must belong to the same workspace';
      END IF;
    WHEN 'triggers' THEN
      SELECT workspace_id INTO v_primary FROM public.flows WHERE id = NEW.flow_id;
      IF NEW.channel_id IS NOT NULL THEN
        SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
        IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
          RAISE EXCEPTION 'trigger flow and channel must belong to the same workspace';
        END IF;
      END IF;
    WHEN 'flow_sessions' THEN
      SELECT workspace_id INTO v_primary FROM public.flows WHERE id = NEW.flow_id;
      SELECT workspace_id INTO v_related FROM public.contacts WHERE id = NEW.contact_id;
      IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'flow session flow and contact must belong to the same workspace';
      END IF;
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'flow session flow and channel must belong to the same workspace';
      END IF;
    WHEN 'conversations' THEN
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF NEW.workspace_id IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'conversation channel must belong to its workspace';
      END IF;
      SELECT workspace_id INTO v_related FROM public.contacts WHERE id = NEW.contact_id;
      IF NEW.workspace_id IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'conversation contact must belong to its workspace';
      END IF;
      IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.workspace_members wm
        WHERE wm.workspace_id = NEW.workspace_id AND wm.user_id = NEW.assigned_to
      ) THEN
        RAISE EXCEPTION 'conversation assignee must be a workspace member';
      END IF;
    WHEN 'messages' THEN
      SELECT workspace_id INTO v_primary FROM public.conversations WHERE id = NEW.conversation_id;
      IF v_primary IS NULL THEN
        RAISE EXCEPTION 'message conversation does not exist';
      END IF;
      IF NEW.sent_by_flow_id IS NOT NULL THEN
        SELECT workspace_id INTO v_related FROM public.flows WHERE id = NEW.sent_by_flow_id;
        IF v_primary IS DISTINCT FROM v_related THEN
          RAISE EXCEPTION 'message flow and conversation must belong to the same workspace';
        END IF;
      END IF;
    WHEN 'broadcast_recipients' THEN
      SELECT workspace_id INTO v_primary FROM public.broadcasts WHERE id = NEW.broadcast_id;
      SELECT workspace_id INTO v_related FROM public.contacts WHERE id = NEW.contact_id;
      IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'broadcast and contact must belong to the same workspace';
      END IF;
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'broadcast and channel must belong to the same workspace';
      END IF;
    WHEN 'sequence_enrollments' THEN
      SELECT workspace_id INTO v_primary FROM public.sequences WHERE id = NEW.sequence_id;
      SELECT workspace_id INTO v_related FROM public.contacts WHERE id = NEW.contact_id;
      IF v_primary IS NULL OR v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'sequence and contact must belong to the same workspace';
      END IF;
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF v_primary IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'sequence and channel must belong to the same workspace';
      END IF;
    WHEN 'analytics_events' THEN
      IF NEW.flow_id IS NOT NULL THEN
        SELECT workspace_id INTO v_related FROM public.flows WHERE id = NEW.flow_id;
        IF NEW.workspace_id IS DISTINCT FROM v_related THEN
          RAISE EXCEPTION 'analytics flow must belong to its workspace';
        END IF;
      END IF;
      IF NEW.contact_id IS NOT NULL THEN
        SELECT workspace_id INTO v_related FROM public.contacts WHERE id = NEW.contact_id;
        IF NEW.workspace_id IS DISTINCT FROM v_related THEN
          RAISE EXCEPTION 'analytics contact must belong to its workspace';
        END IF;
      END IF;
    WHEN 'comment_logs' THEN
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF NEW.workspace_id IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'comment log channel must belong to its workspace';
      END IF;
      IF NEW.matched_trigger_id IS NOT NULL THEN
        SELECT f.workspace_id INTO v_related
        FROM public.triggers t JOIN public.flows f ON f.id = t.flow_id
        WHERE t.id = NEW.matched_trigger_id;
        IF NEW.workspace_id IS DISTINCT FROM v_related THEN
          RAISE EXCEPTION 'comment trigger must belong to its workspace';
        END IF;
      END IF;
    WHEN 'channel_secrets' THEN
      SELECT workspace_id INTO v_related FROM public.channels WHERE id = NEW.channel_id;
      IF NEW.workspace_id IS DISTINCT FROM v_related THEN
        RAISE EXCEPTION 'channel secret must match the channel workspace';
      END IF;
    WHEN 'workspace_invites' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.workspace_members wm
        WHERE wm.workspace_id = NEW.workspace_id AND wm.user_id = NEW.invited_by
      ) THEN
        RAISE EXCEPTION 'invite creator must be a workspace member';
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported relation table: %', TG_TABLE_NAME;
  END CASE;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_last_workspace_owner_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = OLD.workspace_id FOR UPDATE;
  IF OLD.role = 'owner' AND (
    TG_OP = 'DELETE'
    OR (TG_OP = 'UPDATE' AND (NEW.role <> 'owner' OR NEW.workspace_id <> OLD.workspace_id))
  )
    AND NOT EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = OLD.workspace_id
        AND wm.user_id <> OLD.user_id
        AND wm.role = 'owner'
    ) THEN
    RAISE EXCEPTION 'a workspace must retain at least one owner';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_last_workspace_owner ON public.workspace_members;
CREATE TRIGGER protect_last_workspace_owner
  BEFORE UPDATE OF role, workspace_id OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.prevent_last_workspace_owner_removal();

-- Do not install the new policies over known cross-workspace relationships.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.contact_channels cc
    JOIN public.contacts c ON c.id = cc.contact_id
    JOIN public.channels ch ON ch.id = cc.channel_id
    WHERE c.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace contact_channels rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.contact_tags ct
    JOIN public.contacts c ON c.id = ct.contact_id
    JOIN public.tags t ON t.id = ct.tag_id
    WHERE c.workspace_id <> t.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace contact_tags rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.contact_custom_fields cf
    JOIN public.contacts c ON c.id = cf.contact_id
    JOIN public.custom_field_definitions d ON d.id = cf.field_id
    WHERE c.workspace_id <> d.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace contact_custom_fields rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.triggers t
    JOIN public.flows f ON f.id = t.flow_id
    JOIN public.channels ch ON ch.id = t.channel_id
    WHERE f.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace trigger rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.flow_sessions fs
    JOIN public.flows f ON f.id = fs.flow_id
    JOIN public.contacts c ON c.id = fs.contact_id
    JOIN public.channels ch ON ch.id = fs.channel_id
    WHERE f.workspace_id <> c.workspace_id OR f.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace flow_sessions rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.channels ch ON ch.id = c.channel_id
    JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.workspace_id <> ch.workspace_id OR c.workspace_id <> ct.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace conversations rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    LEFT JOIN public.workspace_members wm
      ON wm.workspace_id = c.workspace_id AND wm.user_id = c.assigned_to
    WHERE c.assigned_to IS NOT NULL AND wm.user_id IS NULL
  ) THEN RAISE EXCEPTION 'conversation assignees outside their workspace must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    JOIN public.flows f ON f.id = m.sent_by_flow_id
    WHERE c.workspace_id <> f.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace messages rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.broadcast_recipients r
    JOIN public.broadcasts b ON b.id = r.broadcast_id
    JOIN public.contacts c ON c.id = r.contact_id
    JOIN public.channels ch ON ch.id = r.channel_id
    WHERE b.workspace_id <> c.workspace_id OR b.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace broadcast_recipients rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.sequence_enrollments e
    JOIN public.sequences s ON s.id = e.sequence_id
    JOIN public.contacts c ON c.id = e.contact_id
    JOIN public.channels ch ON ch.id = e.channel_id
    WHERE s.workspace_id <> c.workspace_id OR s.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace sequence_enrollments rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.analytics_events a
    LEFT JOIN public.flows f ON f.id = a.flow_id
    LEFT JOIN public.contacts c ON c.id = a.contact_id
    WHERE (a.flow_id IS NOT NULL AND a.workspace_id <> f.workspace_id)
       OR (a.contact_id IS NOT NULL AND a.workspace_id <> c.workspace_id)
  ) THEN RAISE EXCEPTION 'cross-workspace analytics_events rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.comment_logs l
    JOIN public.channels ch ON ch.id = l.channel_id
    WHERE l.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace comment_logs rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.comment_logs l
    JOIN public.triggers t ON t.id = l.matched_trigger_id
    JOIN public.flows f ON f.id = t.flow_id
    WHERE l.workspace_id <> f.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace comment trigger rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.channel_secrets s
    JOIN public.channels ch ON ch.id = s.channel_id
    WHERE s.workspace_id <> ch.workspace_id
  ) THEN RAISE EXCEPTION 'cross-workspace channel_secrets rows must be repaired before 00011'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_invites i
    LEFT JOIN public.workspace_members wm
      ON wm.workspace_id = i.workspace_id AND wm.user_id = i.invited_by
    WHERE wm.user_id IS NULL
  ) THEN RAISE EXCEPTION 'workspace invitations from non-members must be repaired before 00011'; END IF;
END;
$$;

DO $$
DECLARE
  relation_table text;
BEGIN
  FOREACH relation_table IN ARRAY ARRAY[
    'contact_channels', 'contact_tags', 'contact_custom_fields', 'triggers',
    'flow_sessions', 'conversations', 'messages', 'broadcast_recipients',
    'sequence_enrollments', 'analytics_events', 'comment_logs', 'channel_secrets',
    'workspace_invites'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS enforce_workspace_relations ON public.%I', relation_table);
    EXECUTE format(
      'CREATE TRIGGER enforce_workspace_relations BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.assert_related_rows_share_workspace()',
      relation_table
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_workspace_id_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'workspace_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  relation_table text;
BEGIN
  FOREACH relation_table IN ARRAY ARRAY[
    'workspace_members', 'channels', 'contacts', 'tags', 'custom_field_definitions',
    'flows', 'conversations', 'broadcasts', 'analytics_events', 'comment_logs',
    'sequences', 'workspace_invites'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS prevent_workspace_id_change ON public.%I', relation_table);
    EXECUTE format(
      'CREATE TRIGGER prevent_workspace_id_change BEFORE UPDATE OF workspace_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_workspace_id_change()',
      relation_table
    );
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_workspace_id_change() FROM PUBLIC, anon, authenticated;

-- Keep only workspace-scoped, role-aware client policies. Jobs, secrets and
-- webhook idempotency are exclusively written by service_role workers.
DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'workspaces', 'workspace_members', 'channels', 'contacts', 'contact_channels',
        'tags', 'contact_tags', 'custom_field_definitions', 'contact_custom_fields',
        'flows', 'triggers', 'flow_sessions', 'conversations', 'messages', 'broadcasts',
        'broadcast_recipients', 'scheduled_jobs', 'analytics_events', 'comment_logs',
        'sequences', 'sequence_enrollments', 'workspace_invites', 'flow_versions',
        'workspace_secrets', 'channel_secrets', 'webhook_events'
      ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  END LOOP;
END;
$$;

CREATE POLICY workspaces_select_member ON public.workspaces
  FOR SELECT USING (public.is_workspace_member(id));
CREATE POLICY workspaces_update_admin ON public.workspaces
  FOR UPDATE USING (public.has_workspace_role(id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(id, ARRAY['owner', 'admin']));

CREATE POLICY workspace_members_select_member ON public.workspace_members
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
    AND public.is_workspace_member(workspace_id)
  );
CREATE POLICY workspace_members_delete_admin ON public.workspace_members
  FOR DELETE USING (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin'])
    AND (role <> 'owner' OR public.has_workspace_role(workspace_id, ARRAY['owner']))
  );

CREATE POLICY channels_select_member ON public.channels
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY channels_insert_admin ON public.channels
  FOR INSERT WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY channels_update_admin ON public.channels
  FOR UPDATE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY channels_delete_admin ON public.channels
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY contacts_select_member ON public.contacts
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY contacts_insert_member ON public.contacts
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY contacts_update_member ON public.contacts
  FOR UPDATE USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY contacts_delete_member ON public.contacts
  FOR DELETE USING (public.is_workspace_member(workspace_id));

CREATE POLICY contact_channels_select_member ON public.contact_channels
  FOR SELECT USING (public.is_contact_member(contact_id) AND public.is_channel_member(channel_id));
CREATE POLICY contact_channels_insert_member ON public.contact_channels
  FOR INSERT WITH CHECK (public.is_contact_member(contact_id) AND public.is_channel_member(channel_id));
CREATE POLICY contact_channels_update_member ON public.contact_channels
  FOR UPDATE USING (public.is_contact_member(contact_id) AND public.is_channel_member(channel_id))
  WITH CHECK (public.is_contact_member(contact_id) AND public.is_channel_member(channel_id));
CREATE POLICY contact_channels_delete_member ON public.contact_channels
  FOR DELETE USING (public.is_contact_member(contact_id) AND public.is_channel_member(channel_id));

CREATE POLICY tags_select_member ON public.tags
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY tags_insert_admin ON public.tags
  FOR INSERT WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY tags_update_admin ON public.tags
  FOR UPDATE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY tags_delete_admin ON public.tags
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY contact_tags_select_member ON public.contact_tags
  FOR SELECT USING (public.is_contact_member(contact_id) AND public.is_tag_member(tag_id));
CREATE POLICY contact_tags_insert_member ON public.contact_tags
  FOR INSERT WITH CHECK (public.is_contact_member(contact_id) AND public.is_tag_member(tag_id));
CREATE POLICY contact_tags_update_member ON public.contact_tags
  FOR UPDATE USING (public.is_contact_member(contact_id) AND public.is_tag_member(tag_id))
  WITH CHECK (public.is_contact_member(contact_id) AND public.is_tag_member(tag_id));
CREATE POLICY contact_tags_delete_member ON public.contact_tags
  FOR DELETE USING (public.is_contact_member(contact_id) AND public.is_tag_member(tag_id));

CREATE POLICY custom_fields_select_member ON public.custom_field_definitions
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY custom_fields_insert_admin ON public.custom_field_definitions
  FOR INSERT WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY custom_fields_update_admin ON public.custom_field_definitions
  FOR UPDATE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY custom_fields_delete_admin ON public.custom_field_definitions
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY contact_fields_select_member ON public.contact_custom_fields
  FOR SELECT USING (public.is_contact_member(contact_id) AND public.is_custom_field_member(field_id));
CREATE POLICY contact_fields_insert_member ON public.contact_custom_fields
  FOR INSERT WITH CHECK (public.is_contact_member(contact_id) AND public.is_custom_field_member(field_id));
CREATE POLICY contact_fields_update_member ON public.contact_custom_fields
  FOR UPDATE USING (public.is_contact_member(contact_id) AND public.is_custom_field_member(field_id))
  WITH CHECK (public.is_contact_member(contact_id) AND public.is_custom_field_member(field_id));
CREATE POLICY contact_fields_delete_member ON public.contact_custom_fields
  FOR DELETE USING (public.is_contact_member(contact_id) AND public.is_custom_field_member(field_id));

CREATE POLICY flows_select_member ON public.flows
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY flows_insert_admin ON public.flows
  FOR INSERT WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY flows_update_admin ON public.flows
  FOR UPDATE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY flows_delete_admin ON public.flows
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY triggers_select_member ON public.triggers
  FOR SELECT USING (public.is_flow_member(flow_id));
CREATE POLICY triggers_insert_admin ON public.triggers
  FOR INSERT WITH CHECK (public.has_workspace_role(
    (SELECT workspace_id FROM public.flows WHERE id = flow_id), ARRAY['owner', 'admin']));
CREATE POLICY triggers_update_admin ON public.triggers
  FOR UPDATE USING (public.has_workspace_role(
    (SELECT workspace_id FROM public.flows WHERE id = flow_id), ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(
    (SELECT workspace_id FROM public.flows WHERE id = flow_id), ARRAY['owner', 'admin']));
CREATE POLICY triggers_delete_admin ON public.triggers
  FOR DELETE USING (public.has_workspace_role(
    (SELECT workspace_id FROM public.flows WHERE id = flow_id), ARRAY['owner', 'admin']));

CREATE POLICY flow_sessions_select_member ON public.flow_sessions
  FOR SELECT USING (public.is_flow_member(flow_id));

CREATE POLICY conversations_select_member ON public.conversations
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY conversations_insert_member ON public.conversations
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY conversations_update_member ON public.conversations
  FOR UPDATE USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));
CREATE POLICY conversations_delete_admin ON public.conversations
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY messages_select_member ON public.messages
  FOR SELECT USING (public.is_conversation_member(conversation_id));
CREATE POLICY messages_insert_member ON public.messages
  FOR INSERT WITH CHECK (public.is_conversation_member(conversation_id));

CREATE POLICY broadcasts_select_member ON public.broadcasts
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY broadcasts_insert_admin ON public.broadcasts
  FOR INSERT WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY broadcasts_update_admin ON public.broadcasts
  FOR UPDATE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY broadcasts_delete_admin ON public.broadcasts
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY broadcast_recipients_select_member ON public.broadcast_recipients
  FOR SELECT USING (public.is_broadcast_member(broadcast_id));

CREATE POLICY analytics_select_member ON public.analytics_events
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY comment_logs_select_member ON public.comment_logs
  FOR SELECT USING (public.is_workspace_member(workspace_id));

CREATE POLICY sequences_select_member ON public.sequences
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY sequences_insert_admin ON public.sequences
  FOR INSERT WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY sequences_update_admin ON public.sequences
  FOR UPDATE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY sequences_delete_admin ON public.sequences
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY enrollments_select_member ON public.sequence_enrollments
  FOR SELECT USING (public.is_sequence_member(sequence_id));
CREATE POLICY enrollments_insert_member ON public.sequence_enrollments
  FOR INSERT WITH CHECK (
    public.is_sequence_member(sequence_id)
    AND public.is_contact_member(contact_id)
    AND public.is_channel_member(channel_id)
  );
CREATE POLICY enrollments_update_member ON public.sequence_enrollments
  FOR UPDATE USING (public.is_sequence_member(sequence_id))
  WITH CHECK (
    public.is_sequence_member(sequence_id)
    AND public.is_contact_member(contact_id)
    AND public.is_channel_member(channel_id)
  );
CREATE POLICY enrollments_delete_admin ON public.sequence_enrollments
  FOR DELETE USING (public.has_workspace_role(
    (SELECT workspace_id FROM public.sequences WHERE id = sequence_id), ARRAY['owner', 'admin']));

CREATE POLICY invites_select_admin ON public.workspace_invites
  FOR SELECT USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
CREATE POLICY invites_insert_admin ON public.workspace_invites
  FOR INSERT WITH CHECK (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin'])
    AND invited_by = (SELECT auth.uid())
    AND role IN ('admin', 'agent')
  );
CREATE POLICY invites_delete_admin ON public.workspace_invites
  FOR DELETE USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY flow_versions_select_member ON public.flow_versions
  FOR SELECT USING (public.is_flow_member(flow_id));
CREATE POLICY flow_versions_insert_admin ON public.flow_versions
  FOR INSERT WITH CHECK (public.has_workspace_role(
    (SELECT workspace_id FROM public.flows WHERE id = flow_id), ARRAY['owner', 'admin']));

-- No authenticated client can enumerate, insert, update, or delete global jobs.
REVOKE ALL ON TABLE public.scheduled_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.scheduled_jobs TO service_role;
REVOKE INSERT, UPDATE ON TABLE public.workspace_members FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON TABLE public.workspace_invites FROM PUBLIC, anon, authenticated;

-- The counter RPCs are internal worker operations, not public APIs.
CREATE OR REPLACE FUNCTION public.increment_unread(conv_id uuid, preview text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.conversations
  SET unread_count = unread_count + 1,
      last_message_at = now(),
      last_message_preview = preview,
      status = 'open'
  WHERE id = conv_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.increment_broadcast_sent(b_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.broadcasts SET sent = sent + 1, delivered = delivered + 1 WHERE id = b_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.increment_broadcast_failed(b_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.broadcasts SET failed = failed + 1 WHERE id = b_id;
END;
$$;
REVOKE ALL ON FUNCTION public.increment_unread(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_broadcast_sent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_broadcast_failed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_unread(uuid, text),
  public.increment_broadcast_sent(uuid),
  public.increment_broadcast_failed(uuid)
  TO service_role;
