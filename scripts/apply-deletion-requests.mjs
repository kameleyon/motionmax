const TOKEN = "sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45";
const URL = "https://api.supabase.com/v1/projects/ayjbvcikuwknqdrpsdmj/database/query";

async function run(query) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  const parsed = JSON.parse(text);
  if (parsed.message) console.error("Error:", parsed.message);
  else console.log("OK:", JSON.stringify(parsed));
}

await run(`
  CREATE TABLE IF NOT EXISTS deletion_requests (
    id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email        TEXT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    scheduled_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
    status       TEXT        DEFAULT 'pending'
                   CHECK (status IN ('pending','cancelled','completed')),
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`);

await run("ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY");

await run(`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'deletion_requests' AND policyname = 'users_insert_own'
    ) THEN
      CREATE POLICY users_insert_own ON deletion_requests
        FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
  END $$
`);

await run(`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'deletion_requests' AND policyname = 'users_select_own'
    ) THEN
      CREATE POLICY users_select_own ON deletion_requests
        FOR SELECT USING (auth.uid() = user_id);
    END IF;
  END $$
`);

console.log("deletion_requests table ready.");
