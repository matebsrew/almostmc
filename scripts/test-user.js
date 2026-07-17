const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://zknxctxmgwvrhotwolxl.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InprbnhjdHhtZ3d2cmhvdHdvbHhsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDE1NjQwNSwiZXhwIjoyMDk5NzMyNDA1fQ.QLPf1_pmlEc4O9a2Y6rQV2eeTPxMAVAOF9zbYfirTSE';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  const { data: listData } = await supabase.auth.admin.listUsers();
  console.log('Existing users in auth:', listData.users);

  const { data, error } = await supabase.auth.admin.createUser({
    email: 'admin-' + Date.now() + '@zernflow.local',
    password: 'ZernFlowAdminPassword2026!',
    email_confirm: true
  });

  console.log('New User Result:', data);
  console.log('New User Error:', error);
}

main().catch(console.error);
