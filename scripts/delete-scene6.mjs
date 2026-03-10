const r = await fetch("https://api.supabase.com/v1/projects/ayjbvcikuwknqdrpsdmj/database/query", {
  method: "POST",
  headers: { Authorization: "Bearer sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45", "Content-Type": "application/json" },
  body: JSON.stringify({
    query: `UPDATE generations
            SET scenes = (
              SELECT jsonb_agg(elem)
              FROM jsonb_array_elements(scenes) AS elem
              WHERE (elem->>'number')::int != 6
            )
            WHERE id = '75b556e2-d479-4fde-a4b4-aed52e1b84cc'`
  }),
});
const d = await r.json();
console.log("Result:", JSON.stringify(d));
// Verify
const v = await fetch("https://api.supabase.com/v1/projects/ayjbvcikuwknqdrpsdmj/database/query", {
  method: "POST",
  headers: { Authorization: "Bearer sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45", "Content-Type": "application/json" },
  body: JSON.stringify({ query: "SELECT jsonb_array_length(scenes) as scene_count FROM generations WHERE id = '75b556e2-d479-4fde-a4b4-aed52e1b84cc'" }),
});
const vd = await v.json();
console.log("Scene count after:", JSON.stringify(vd));
