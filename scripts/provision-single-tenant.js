const { createClient } = require('@supabase/supabase-js');
const Zernio = require('@zernio/node').default || require('@zernio/node');

const SUPABASE_URL = 'https://zknxctxmgwvrhotwolxl.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InprbnhjdHhtZ3d2cmhvdHdvbHhsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDE1NjQwNSwiZXhwIjoyMDk5NzMyNDA1fQ.QLPf1_pmlEc4O9a2Y6rQV2eeTPxMAVAOF9zbYfirTSE';
const ZERNIO_KEY = 'sk_7de679672e531b898dd0217176e2aba02272f6b0ad363b751db15d165ff275a6';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  console.log('--- Provisioning Single-Tenant Admin & Workspace ---');

  // Check if admin user exists
  const { data: usersData } = await supabase.auth.admin.listUsers();
  let user = usersData.users.find(u => u.email === 'heidi@zernflow.com');

  if (!user) {
    const { data: newUser, error: userErr } = await supabase.auth.signUp({
      email: 'heidi@zernflow.com',
      password: 'ZernFlowAdmin2026!',
      options: {
        data: { full_name: 'Heidi Skinner' }
      }
    });
    if (userErr) {
      console.error('Failed to create user:', userErr);
      return;
    }
    user = newUser.user;
    console.log('✅ Created admin user:', user.id);
  } else {
    console.log('✅ Found existing admin user:', user.id);
  }

  // Check if workspace exists
  const { data: existingWorkspaces } = await supabase.from('workspaces').select('*');
  let workspace = existingWorkspaces && existingWorkspaces[0];

  if (!workspace) {
    const { data: newWs, error: wsErr } = await supabase
      .from('workspaces')
      .insert({
        name: "Heidi's Workspace",
        slug: 'heidi-workspace',
        late_api_key_encrypted: ZERNIO_KEY
      })
      .select()
      .single();

    if (wsErr) {
      console.error('Failed to create workspace:', wsErr);
      return;
    }
    workspace = newWs;
    console.log('✅ Created workspace:', workspace.id);
  } else {
    // Update Zernio API key if needed
    await supabase
      .from('workspaces')
      .update({ late_api_key_encrypted: ZERNIO_KEY })
      .eq('id', workspace.id);
    console.log('✅ Updated workspace with Zernio API key:', workspace.id);
  }

  // Ensure workspace membership
  const { data: membership } = await supabase
    .from('workspace_members')
    .select('*')
    .eq('workspace_id', workspace.id)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    await supabase.from('workspace_members').insert({
      workspace_id: workspace.id,
      user_id: user.id,
      role: 'owner'
    });
    console.log('✅ Added user as workspace owner');
  }

  // Sync Zernio Accounts into channels table
  console.log('--- Syncing Zernio Connected Channels ---');
  const zernio = new Zernio({ apiKey: ZERNIO_KEY });
  const accountsRes = await zernio.accounts.listAccounts();
  const lateAccounts = accountsRes.data?.accounts ?? [];

  console.log(`Found ${lateAccounts.length} accounts in Zernio`);

  for (const acc of lateAccounts) {
    if (!acc._id) continue;
    const profilePic = acc.profilePicture || null;

    const { data: existingChannel } = await supabase
      .from('channels')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('late_account_id', acc._id)
      .single();

    if (existingChannel) {
      await supabase
        .from('channels')
        .update({
          username: acc.username || null,
          display_name: acc.displayName || acc.username || null,
          profile_picture: profilePic,
          is_active: true
        })
        .eq('id', existingChannel.id);
      console.log(`✅ Updated channel: ${acc.platform} (${acc.displayName || acc.username})`);
    } else {
      await supabase.from('channels').insert({
        workspace_id: workspace.id,
        platform: acc.platform,
        late_account_id: acc._id,
        username: acc.username || null,
        display_name: acc.displayName || acc.username || null,
        profile_picture: profilePic,
        is_active: true
      });
      console.log(`✅ Inserted channel: ${acc.platform} (${acc.displayName || acc.username})`);
    }
  }

  console.log('🎉 Provisioning complete!');
}

main().catch(console.error);
