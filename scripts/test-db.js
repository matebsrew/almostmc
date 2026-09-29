const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { error } = await supabase.from('workspaces').select('id').limit(1);
  if (error) throw new Error('Supabase read check failed');
  console.log('Supabase read check passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Supabase check failed');
  process.exitCode = 1;
});
