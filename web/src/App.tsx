import { useCallback, useEffect, useState } from "react";
import { store, useCluster } from "./engine/store";
import { Icon, Logo, type IconName } from "./components/icons";
import { Toasts } from "./components/ui";
import { JobContext, JobDrawer } from "./components/cluster";
import Overview from "./pages/Overview";
import Submit from "./pages/Submit";
import Queue from "./pages/Queue";
import Nodes from "./pages/Nodes";
import Accounting from "./pages/Accounting";
import Mail from "./pages/Mail";
import Automation from "./pages/Automation";
import Console from "./pages/Console";
import Guide from "./pages/Guide";
import Assistant from "./pages/Assistant";

type PageId = "overview" | "submit" | "queue" | "nodes" | "accounting" | "mail" | "automation" | "console" | "assistant" | "guide";

const NAV: { group: string; items: [PageId, string, IconName][] }[] = [
  { group: "Operate", items: [["overview", "Overview", "dashboard"], ["submit", "Submit job", "send"], ["queue", "Queue", "list"], ["nodes", "Nodes & health", "server"]] },
  { group: "Govern", items: [["accounting", "Accounting", "chart"], ["mail", "Notifications", "mail"], ["automation", "Automation", "zap"]] },
  { group: "Tools", items: [["assistant", "AI assistant", "bot"], ["console", "Console", "terminal"], ["guide", "How it works", "book"]] },
];
const SPEEDS = [1, 5, 20, 60, 240];

const pageFromHash = (): PageId => {
  const id = location.hash.replace(/^#\/?/, "") as PageId;
  return NAV.some((g) => g.items.some(([p]) => p === id)) ? id : "overview";
};

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return (localStorage.getItem("hpc-theme") as "dark" | "light") || "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("hpc-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export default function App() {
  const c = useCluster();
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [jobId, setJobId] = useState<number | null>(null);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    store.start();
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.title = `${NAV.flatMap((g) => g.items).find(([p]) => p === page)?.[1]} · HPC Autopilot`;
    window.scrollTo(0, 0);
  }, [page]);

  const go = useCallback((p: string) => {
    location.hash = `/${p}`;
  }, []);
  const closeJob = useCallback(() => setJobId(null), []);

  const counts: Partial<Record<PageId, number>> = {
    queue: c.jobs.filter((j) => j.state === "PENDING" || j.state === "RUNNING").length,
    mail: c.emails.filter((e) => !e.read).length,
    nodes: c.nodes.filter((n) => n.state !== "up").length || undefined,
  };
  const autopilotOn = c.settings.automations.scheduler && !c.paused;

  const navItems = (mobile = false) =>
    NAV.map((g) => (
      <div key={g.group} style={mobile ? { display: "contents" } : undefined}>
        {!mobile && <div className="nav-group">{g.group}</div>}
        {g.items.map(([id, label, icon]) => (
          <button key={id} className="nav-item" aria-current={page === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon name={icon} />
            {label}
            {!mobile && counts[id] ? <span className="nav-count">{counts[id]}</span> : null}
          </button>
        ))}
      </div>
    ));

  return (
    <JobContext.Provider value={setJobId}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href="#/overview" style={{ color: "inherit", textDecoration: "none" }}>
            <Logo />
            <div>
              <div className="brand-name">HPC Autopilot</div>
              <div className="brand-sub">AI Centre of Excellence · GPU cluster</div>
            </div>
          </a>
          <div className="topbar-spacer" />
          <div className="autopilot" title={autopilotOn ? "Scheduling automatically" : "Paused"}>
            <span className={`pulse ${autopilotOn ? "" : "off"}`} />
            <span className="autopilot-label">{autopilotOn ? "Autopilot on" : "Paused"}</span>
          </div>
          <div className="clock" aria-label="Simulated cluster time">
            <b>{new Date(c.now * 1000).toLocaleTimeString("en-GB", { hour12: false })}</b>
            <span>simulated · {c.speed}×</span>
          </div>
          <div className="speed" role="group" aria-label="Simulation speed" {...(store.role === "follower" ? { inert: "" } : {})}>
            <button aria-pressed={c.paused} onClick={() => store.act((c) => void (c.paused = !c.paused))} aria-label={c.paused ? "Resume simulation" : "Pause simulation"}>
              <Icon name={c.paused ? "play" : "pause"} size={13} />
            </button>
            {SPEEDS.map((s) => (
              <button key={s} aria-pressed={!c.paused && c.speed === s} onClick={() => store.act((c) => ((c.speed = s), (c.paused = false)))}>
                {s}×
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle colour theme">
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </header>

        <nav className="mobile-nav" aria-label="Sections">
          {navItems(true)}
        </nav>
        <nav className="sidebar" aria-label="Sections">
          {navItems()}
          <div className="side-foot">
            Simulated cluster: {c.nodes.length} nodes, {c.nodes.reduce((a, n) => a + n.gpus, 0)} GPUs. Runs in your browser; state is saved locally.
          </div>
        </nav>

        <main className="main">
          {store.role === "follower" && (
            <div className="callout warn" role="status">
              <Icon name="alert" />
              <div style={{ flex: 1 }}>
                <b>Read-only view.</b> The cluster is running in another tab of this browser; this tab mirrors it live. Only one tab runs the simulation, so two tabs never overwrite each
                other.
              </div>
              <button className="btn sm primary" onClick={() => store.takeOver()}>
                Run it here
              </button>
            </div>
          )}
          <div className="page-body" {...(store.role === "follower" ? { inert: "" } : {})}>
          {page === "overview" && <Overview go={go} />}
          {page === "submit" && <Submit />}
          {page === "queue" && <Queue />}
          {page === "nodes" && <Nodes />}
          {page === "accounting" && <Accounting />}
          {page === "mail" && <Mail />}
          {page === "automation" && <Automation />}
          {page === "console" && <Console />}
          {page === "assistant" && <Assistant />}
          {page === "guide" && <Guide />}
          </div>
          <footer className="footer">
            <span>HPC Autopilot: an independent demonstration of automated HPC operations. Not affiliated with or endorsed by IIM Udaipur.</span>
            <span>Simulated workloads and hardware. No real jobs are run.</span>
          </footer>
        </main>
      </div>
      {jobId !== null && <JobDrawer id={jobId} onClose={closeJob} />}
      <Toasts />
    </JobContext.Provider>
  );
}
