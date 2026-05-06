import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { Bar } from "../_shared/Bar";
import { num, shortDate } from "../_shared/format";
import { fetchBillingOverview, fetchBillingUsageHistory } from "../_shared/billingApi";

export default function TabUsage() {
  const { user } = useAuth();
  const overviewQ = useQuery({
    queryKey: ["billing", "overview"], queryFn: fetchBillingOverview, enabled: !!user, staleTime: 30_000,
  });
  const histQ = useQuery({
    queryKey: ["billing", "usage-history"], queryFn: fetchBillingUsageHistory, enabled: !!user, staleTime: 60_000,
  });

  const o = overviewQ.data;
  const months = histQ.data?.months ?? [];
  const projects = histQ.data?.top_projects ?? [];

  const total = (o?.used_this_month ?? 0);
  const allowance = o?.monthly_allowance ?? 0;
  const usedPct = allowance > 0 ? Math.min(100, (total / allowance) * 100) : 0;
  const remaining = (o?.credits_balance ?? 0);
  const runwayDays = o?.runway_days ?? 0;
  const avgPerDay = o?.avg_per_day ?? 0;
  const peakMonth = months.reduce((peak, m) => m.total > (peak?.total ?? 0) ? m : peak, months[0]);

  // Donut breakdown
  const video = o?.video_used ?? 0;
  const voice = o?.voice_used ?? 0;
  const image = o?.image_used ?? 0;
  const other = o?.other_used ?? 0;
  const denom = Math.max(1, video + voice + image + other);
  const videoPct = (video / denom) * 100;
  const voicePct = (voice / denom) * 100;
  const imagePct = (image / denom) * 100;
  const otherPct = (other / denom) * 100;

  // Build SVG path data for the area chart
  const maxTotal = Math.max(1, ...months.map((m) => m.total));
  const W = 800; const H = 240;
  const stepX = months.length > 1 ? W / (months.length - 1) : W;
  const yFor = (v: number) => H - 20 - ((v / maxTotal) * (H - 60));
  const videoPath = months.map((m, i) => `${i === 0 ? "M" : "L"}${i * stepX},${yFor(m.video)}`).join(" ");
  const voicePath = months.map((m, i) => `${i === 0 ? "M" : "L"}${i * stepX},${yFor(m.voice)}`).join(" ");
  const imagePath = months.map((m, i) => `${i === 0 ? "M" : "L"}${i * stepX},${yFor(m.image)}`).join(" ");
  const videoArea = `${videoPath} L${(months.length - 1) * stepX},${H} L0,${H} Z`;

  const periodEnd = o?.period_end ?? null;

  return (
    <section className="bill-tab">
      <div className="card chart-card">
        <div className="h-row">
          <h3>This billing period</h3>
          <span className="lbl">{periodEnd ? `Resets ${shortDate(periodEnd).replace(/, \d{4}/, "")}` : "—"}</span>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink-dim)", marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
          <span><b style={{ color: "var(--ink)", fontWeight: 500 }}>{num(total)}</b> of {num(allowance)} credits used</span>
          <span><b style={{ color: "var(--cyan)" }}>{num(remaining)}</b> remaining · {runwayDays} days runway</span>
        </div>
        <Bar pct={usedPct} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginTop: 24 }}>
          <Cell label="Avg / day" value={num(Math.round(avgPerDay))} />
          <Cell label="Peak month" value={peakMonth ? peakMonth.month : "—"} sub={peakMonth ? `${num(peakMonth.total)} cr` : ""} />
          <Cell label="Top project" value={projects[0]?.title ?? "—"} sub={projects[0] ? shortDate(projects[0].updated_at) : ""} />
          <Cell label="Period end" value={periodEnd ? shortDate(periodEnd).replace(/, \d{4}/, "") : "—"} />
        </div>
      </div>

      <div className="card chart-card" style={{ marginTop: 18 }}>
        <div className="h-row">
          <h3>12-month history</h3>
          <span className="lbl">Credits per month</span>
        </div>
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="lgVid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#14C8CC" stopOpacity=".4" />
              <stop offset="100%" stopColor="#14C8CC" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g stroke="rgba(255,255,255,.05)" strokeWidth={1}>
            <line x1="0" y1="40" x2={W} y2="40" />
            <line x1="0" y1="100" x2={W} y2="100" />
            <line x1="0" y1="160" x2={W} y2="160" />
            <line x1="0" y1="220" x2={W} y2="220" />
          </g>
          {months.length > 0 ? (
            <>
              <path d={videoArea} fill="url(#lgVid)" />
              <path d={videoPath} fill="none" stroke="#14C8CC" strokeWidth={2} />
              <path d={voicePath} fill="none" stroke="#F5B049" strokeWidth={2} strokeDasharray="3 3" />
              <path d={imagePath} fill="none" stroke="rgba(245,176,73,.6)" strokeWidth={2} strokeDasharray="2 2" />
              <g fill="rgba(255,255,255,.4)" fontFamily="JetBrains Mono" fontSize="9" textAnchor="middle">
                {months.map((m, i) => (
                  <text key={i} x={i * stepX} y={H - 4}>{m.month}</text>
                ))}
              </g>
            </>
          ) : (
            <text x={W / 2} y={H / 2} fill="rgba(255,255,255,.3)" fontFamily="JetBrains Mono" fontSize="12" textAnchor="middle">
              No usage data yet
            </text>
          )}
        </svg>
        <div className="chart-legend">
          <span className="lg"><span className="sw" style={{ background: "#14C8CC" }} />Video</span>
          <span className="lg"><span className="sw" style={{ background: "#F5B049" }} />Voice</span>
          <span className="lg"><span className="sw" style={{ background: "rgba(245,176,73,.5)" }} />Images</span>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <div className="card chart-card">
          <h3>Breakdown by feature</h3>
          <div className="donut-row">
            <DonutSvg pcts={{ video: videoPct, voice: voicePct, image: imagePct, other: otherPct }} totalLabel={num(video + voice + image + other)} />
            <ul className="donut-legend">
              <li><span className="sw" style={{ background: "#14C8CC" }} /><span>Video render</span><span className="v">{num(video)}</span><span className="pct">{Math.round(videoPct)}%</span></li>
              <li><span className="sw" style={{ background: "#F5B049" }} /><span>Voice / TTS</span><span className="v">{num(voice)}</span><span className="pct">{Math.round(voicePct)}%</span></li>
              <li><span className="sw" style={{ background: "rgba(245,176,73,.5)" }} /><span>Images</span><span className="v">{num(image)}</span><span className="pct">{Math.round(imagePct)}%</span></li>
              <li><span className="sw" style={{ background: "rgba(255,255,255,.2)" }} /><span>Other</span><span className="v">{num(other)}</span><span className="pct">{Math.round(otherPct)}%</span></li>
            </ul>
          </div>
        </div>

        <div className="card chart-card">
          <h3>Top projects this month</h3>
          {projects.length === 0 ? (
            <div className="muted" style={{ padding: "30px 0", textAlign: "center" }}>No project activity yet.</div>
          ) : (
            <table className="tbl" style={{ margin: "-4px -14px -4px" }}>
              <thead><tr><th>Project</th><th className="right">Updated</th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td className="strong">{p.title || "Untitled project"}</td>
                    <td className="right mono muted">{shortDate(p.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 500, lineHeight: 1.2, marginTop: 4 }}>{value}</div>
      {sub ? <div className="tiny muted" style={{ marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}

function DonutSvg({
  pcts, totalLabel,
}: {
  pcts: { video: number; voice: number; image: number; other: number };
  totalLabel: string;
}) {
  // Each slice draws around r=15.9155 (so circumference is 100 ≈ pct).
  // dashoffset chains the slices.
  let offset = 25;
  const slice = (pct: number, color: string) => {
    const out = (
      <circle
        key={color + pct}
        cx="21" cy="21" r="15.9155" fill="transparent"
        stroke={color} strokeWidth={3}
        strokeDasharray={`${pct} ${100 - pct}`}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    );
    offset -= pct;
    return out;
  };
  return (
    <svg width={200} height={200} viewBox="0 0 42 42">
      <circle cx="21" cy="21" r="15.9155" fill="transparent" stroke="rgba(255,255,255,.05)" strokeWidth={3} />
      {slice(pcts.video, "#14C8CC")}
      {slice(pcts.voice, "#F5B049")}
      {slice(pcts.image, "rgba(245,176,73,.5)")}
      {slice(pcts.other, "rgba(255,255,255,.2)")}
      <text x="21" y="20" textAnchor="middle" fill="#fff" fontFamily="Fraunces, Georgia, serif" fontSize="6" fontWeight="500">{totalLabel}</text>
      <text x="21" y="26" textAnchor="middle" fill="rgba(255,255,255,.5)" fontFamily="JetBrains Mono" fontSize="2.5" letterSpacing=".15">CREDITS</text>
    </svg>
  );
}
