const { createClient } = require('@supabase/supabase-js');

if (process.env.ALLOW_TEST_USER_CREATION !== 'true') {
  throw new Error('Set ALLOW_TEST_USER_CREATION=true to explicitly create a test account');
}

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEST_USER_EMAIL', 'TEST_USER_PASSWORD'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
if (process.env.TEST_USER_PASSWORD.length < 12) throw new Error('TEST_USER_PASSWORD must contain at least 12 characters');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data, error } = await supabase.auth.admin.createUser({
    email: process.env.TEST_USER_EMAIL,
    password: process.env.TEST_USER_PASSWORD,
    email_confirm: false,
  });
  if (error || !data.user) throw new Error('Test account could not be created');
  console.log(JSON.stringify({ created: true, userId: data.user.id }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Test account creation failed');
  process.exitCode = 1;
});
