const { createClient } = require('@supabase/supabase-js');
const Zernio = require('@zernio/node').default || require('@zernio/node');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ZERNIO_API_KEY', 'WORKSPACE_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const workspaceId = process.env.WORKSPACE_ID;
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace) throw new Error('Workspace does not exist or is unavailable');

  const zernio = new Zernio({ apiKey: process.env.ZERNIO_API_KEY });
  const result = await zernio.accounts.listAccounts();
  const accounts = result.data?.accounts ?? [];

  const { error: secretError } = await supabase.from('workspace_secrets').upsert({
    workspace_id: workspaceId,
    late_api_key: process.env.ZERNIO_API_KEY,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id' });
  if (secretError) throw new Error('Zernio credential could not be stored');

  let created = 0;
  let updated = 0;
  const platforms = new Set(['facebook', 'instagram', 'linkedin', 'twitter', 'telegram', 'bluesky', 'reddit']);
  for (const account of accounts) {
    if (!account._id || !platforms.has(account.platform)) continue;
    const { data: existing, error: lookupError } = await supabase
      .from('channels')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('late_account_id', account._id)
      .maybeSingle();
    if (lookupError) throw new Error('Existing channels could not be loaded');

    const values = {
      workspace_id: workspaceId,
      platform: account.platform,
      late_account_id: account._id,
      username: account.username || null,
      display_name: account.displayName || account.username || null,
      profile_picture: account.profilePicture || null,
      is_active: true,
    };
    const query = existing
      ? supabase.from('channels').update(values).eq('id', existing.id)
      : supabase.from('channels').insert(values);
    const { error } = await query;
    if (error) throw new Error('A Zernio channel could not be synchronized');
    if (existing) updated++;
    else created++;
  }

  console.log(JSON.stringify({ synchronized: true, created, updated }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Provisioning failed');
  process.exitCode = 1;
});
