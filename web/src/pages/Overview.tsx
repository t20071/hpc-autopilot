import { useCluster } from "../engine/store";
import { nodeView, summary } from "../engine/queries";
import { fmtDuration } from "../engine/engine";
import { Card, Metric, clockTime } from "../components/ui";
import { LineChart } from "../components/charts";
import { EventFeed, JobTable, NodeRacks, jobColor } from "../components/cluster";
import { Icon, type IconName } from "../components/icons";

export default function Overview({ go }: { go: (page: string) => void }) {
  const c = useCluster();
  const s = summary(c);
  const snaps = c.snapshots.slice(-90);
  const trend = (k: "gpuPct" | "cpuPct" | "running" | "pending" | "nodesUp") => snaps.slice(-40).map((x) => x[k]);
  const labels = snaps.map((x) => clockTime(x.t).slice(0, 5));
  const active = c.jobs.filter((j) => j.state === "RUNNING" || j.state === "PENDING").sort((a, b) => (a.state === b.state ? b.priority - a.priority : a.state === "RUNNING" ? -1 : 1));

  const stages: [IconName, string, number, boolean][] = [
    ["send", "Submitted", c.jobs.length, true],
    ["list", "In queue", s.pending, s.pending > 0],
    ["zap", "Scheduled", c.jobs.filter((j) => j.startTime !== undefined).length, c.settings.automations.scheduler],
    ["cpu", "Running", s.running, s.running > 0],
    ["check", "Finished", c.jobs.filter((j) => j.endTime !== undefined).length, true],
    ["mail", "Emailed", c.emails.filter((e) => e.kind === "user").length, c.settings.automations.notify],
  ];

  return (
    <>
      <section className="card hero">
        <div className="hero-text">
          <span className="eyebrow">AI Centre of Excellence · Research computing</span>
          <h1>
            The cluster runs itself.
            <br />
            <span className="hero-accent">You watch the dashboard.</span>
          </h1>
          <p className="muted">
            Students, PhD scholars, faculty and startups submit jobs. The autopilot queues them, starts each one the moment a node is free, and emails
            the owner when it is done. Health checks, backups and reports run on their own.
          </p>
          <ul className="hero-steps" aria-label="Job workflow">
            {["Submit", "Queue", "Schedule", "Run", "Email"].map((t, i) => (
              <li key={t}>
                <span>{i + 1}</span>
                {t}
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 4 }}>
            <button className="btn primary" onClick={() => go("submit")}>
              <Icon name="send" /> Submit a job
            </button>
            <button className="btn" onClick={() => go("assistant")}>
              <Icon name="bot" /> Ask the AI assistant
            </button>
            <button className="btn ghost" onClick={() => go("guide")}>
              <Icon name="book" /> How it works
            </button>
          </div>
        </div>
        <div className="hero-art">
          <div className="hero-live">
            <span className={`pulse ${c.settings.automations.scheduler && !c.paused ? "" : "off"}`} />
            {c.paused ? "Paused" : "Live"} · {s.gpusUsed}/{s.gpusTotal} GPUs busy · {s.pending} queued
          </div>
          <HeroArt />
          <div className="hero-legend">
            <span>
              <i style={{ background: "#8fd16f" }} />
              healthy
            </span>
            <span>
              <i style={{ background: "#f2b84b" }} />
              drained
            </span>
            <span>
              <i style={{ background: "#ff5d6c" }} />
              down
            </span>
            <span>Colour = job on that GPU</span>
          </div>
        </div>
      </section>

      <div className="metrics">
        <Metric label="Running jobs" value={s.running} icon="cpu" trend={trend("running")} tone="var(--info)" />
        <Metric label="Waiting in queue" value={s.pending} icon="list" trend={trend("pending")} tone="var(--warn)" />
        <Metric label="GPUs in use" value={`${s.gpusUsed}/${s.gpusTotal}`} icon="gpu" trend={trend("gpuPct")} max={100} />
        <Metric label="CPU cores in use" value={`${s.cpusUsed}/${s.cpusTotal}`} icon="cpu" trend={trend("cpuPct")} max={100} tone="var(--accent)" />
        <Metric label="Nodes accepting jobs" value={`${s.nodesUp}/${s.nodesTotal}`} icon="server" trend={trend("nodesUp")} tone="var(--primary)" />
        <Metric label="Average queue wait" value={fmtDuration(s.avgWaitS)} icon="clock" tone="var(--info)" />
      </div>

      <Card title="Job pipeline" sub="Every stage after Submitted is automatic">
        <div className="pipeline">
          <div className="flow-line" />
          {stages.map(([icon, t, n, live]) => (
            <div key={t} className={`stage ${live ? "live" : ""}`}>
              <div className="dot">
                <Icon name={icon} size={18} />
              </div>
              <div className="n">{n}</div>
              <div className="t">{t}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Allocation" sub="share of healthy capacity">
          <LineChart
            label="GPU and CPU allocation over time"
            labels={labels}
            max={100}
            unit="%"
            series={[
              { name: "GPU %", color: "var(--primary)", values: snaps.map((x) => x.gpuPct) },
              { name: "CPU %", color: "var(--accent)", values: snaps.map((x) => x.cpuPct) },
            ]}
          />
        </Card>
        <Card title="Queue depth" sub="running vs waiting jobs">
          <LineChart
            label="Running and pending jobs over time"
            labels={labels}
            series={[
              { name: "Running", color: "var(--info)", values: snaps.map((x) => x.running) },
              { name: "Pending", color: "var(--warn)", values: snaps.map((x) => x.pending) },
            ]}
          />
        </Card>
      </div>

      <Card title="Cluster" sub="click a busy GPU to open its job" right={<button className="btn sm ghost" onClick={() => go("nodes")}>Manage nodes</button>}>
        <NodeRacks compact />
      </Card>

      <div className="grid g-2-1">
        <Card title="Active jobs" sub={`${active.length} running or queued`} flush right={<button className="btn sm ghost" onClick={() => go("queue")}>Full queue</button>}>
          <JobTable jobs={active.slice(0, 12)} now={c.now} empty="The queue is empty. Submit a job or turn on synthetic traffic in Automation." />
        </Card>
        <Card title="Autopilot activity" flush right={<button className="btn sm ghost" onClick={() => go("automation")}>Audit log</button>}>
          <EventFeed events={c.events} limit={14} />
        </Card>
      </div>
    </>
  );
}

const LED: Record<string, string> = { up: "#8fd16f", drain: "#f2b84b", down: "#ff5d6c" };

/** Live miniature of the machine room: one rack per node, one slot per GPU (or CPU block). */
function HeroArt() {
  const c = useCluster();
  const racks = nodeView(c).slice(0, 6);
  const W = 92;
  const gap = 18;
  const width = racks.length * W + (racks.length - 1) * gap + 40;
  const slots = 6;
  return (
    <svg viewBox={`0 0 ${width} 236`} preserveAspectRatio="xMidYMid meet" className="hero-svg" role="img" aria-label="Live view of the cluster racks">
      <defs>
        <linearGradient id="rackFace" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1d2733" />
          <stop offset="1" stopColor="#111821" />
        </linearGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* data bus linking the racks */}
      <line x1="20" x2={width - 20} y1="222" y2="222" stroke="rgba(143,209,111,0.35)" strokeWidth="2" strokeDasharray="6 6">
        <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="1.2s" repeatCount="indefinite" />
      </line>
      {racks.map(({ node: n, gpuOwner, usedCpus, status }, r) => {
        const x = 20 + r * (W + gap);
        const cells = n.gpus
          ? gpuOwner.map((j) => (j ? jobColor(j.id) : null))
          : Array.from({ length: slots }, (_, i) => (i < Math.round((usedCpus / n.cpus) * slots) ? "#4cc2ff" : null));
        const rows = n.gpus ? n.gpus : slots;
        const slotH = (150 - (rows - 1) * 6) / rows;
        return (
          <g key={n.name} transform={`translate(${x} 14)`} opacity={n.state === "down" ? 0.55 : 1}>
            <rect width={W} height="200" rx="8" fill="url(#rackFace)" stroke={n.state === "up" ? "rgba(255,255,255,0.14)" : LED[n.state]} strokeWidth={n.state === "up" ? 1 : 1.6} />
            <text x="10" y="19" fill="#e7edf2" style={{ font: "600 11px var(--mono)" }}>
              {n.name}
            </text>
            <circle cx={W - 13} cy="15" r="4" fill={LED[n.state]} filter="url(#glow)">
              {n.state !== "up" && <animate attributeName="opacity" values="1;0.25;1" dur="0.9s" repeatCount="indefinite" />}
            </circle>
            {cells.slice(0, rows).map((color, i) => (
              <g key={i} transform={`translate(8 ${28 + i * (slotH + 6)})`}>
                <rect width={W - 16} height={slotH} rx="3" fill={color ?? "rgba(255,255,255,0.06)"} stroke={color ? "none" : "rgba(255,255,255,0.08)"} filter={color ? "url(#glow)" : undefined}>
                  {color && <animate attributeName="opacity" values="1;0.72;1" dur={`${1.4 + ((i + r) % 3) * 0.4}s`} repeatCount="indefinite" />}
                </rect>
                {/* drive-bay LEDs */}
                <circle cx={W - 24} cy={slotH / 2} r="1.8" fill={color ? "#ffffff" : "rgba(143,209,111,0.55)"} />
                <text x="7" y={slotH / 2 + 3.5} fill={color ? "#0c1117" : "rgba(231,237,242,0.45)"} style={{ font: "600 9px var(--mono)" }}>
                  {n.gpus ? `GPU${i}` : `CPU${i}`}
                </text>
              </g>
            ))}
            <text x="10" y="192" fill="rgba(231,237,242,0.7)" style={{ font: "10px var(--mono)" }}>
              {status} · {n.temp.toFixed(0)}°C
            </text>
          </g>
        );
      })}
    </svg>
  );
}
