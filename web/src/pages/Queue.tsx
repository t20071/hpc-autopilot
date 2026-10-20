import { useState } from "react";
import { useCluster } from "../engine/store";
import { TERMINAL } from "../engine/types";
import { REASON_HELP } from "../engine/policy";
import { Card, Seg, download } from "../components/ui";
import { JobTable } from "../components/cluster";
import { Icon } from "../components/icons";
import { toCsv } from "../engine/queries";

const VIEWS = ["Active", "Pending", "Running", "Finished", "All"] as const;

export default function Queue() {
  const c = useCluster();
  const [view, setView] = useState<(typeof VIEWS)[number]>("Active");
  const [q, setQ] = useState("");
  const counts = {
    Active: c.jobs.filter((j) => !TERMINAL.includes(j.state)).length,
    Pending: c.jobs.filter((j) => j.state === "PENDING").length,
    Running: c.jobs.filter((j) => j.state === "RUNNING").length,
    Finished: c.jobs.filter((j) => TERMINAL.includes(j.state)).length,
    All: c.jobs.length,
  };
  let jobs = c.jobs.filter((j) =>
    view === "All" ? true : view === "Active" ? !TERMINAL.includes(j.state) : view === "Finished" ? TERMINAL.includes(j.state) : j.state === view.toUpperCase(),
  );
  if (q.trim()) {
    const needle = q.trim().toLowerCase();
    jobs = jobs.filter((j) => [j.id, j.name, j.user, j.account, j.node, j.state, j.role].join(" ").toLowerCase().includes(needle));
  }
  jobs = [...jobs].sort((a, b) => {
    const rank = (s: string) => (s === "RUNNING" ? 0 : s === "PENDING" ? 1 : 2);
    return rank(a.state) - rank(b.state) || (a.state === "PENDING" ? b.priority - a.priority : b.id - a.id);
  });
  const reasons = Object.entries(
    c.jobs.filter((j) => j.state === "PENDING").reduce<Record<string, number>>((acc, j) => ({ ...acc, [j.reason]: (acc[j.reason] ?? 0) + 1 }), {}),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Queue</h1>
          <p>Like `squeue`. Pending jobs are listed in the order the scheduler will consider them. Click a job for its priority breakdown, output and batch script.</p>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={() =>
              download(
                "jobs.csv",
                toCsv(c.jobs.map(({ log, factors, ...j }) => ({ ...j, gpuIds: j.gpuIds?.join(" ") ?? "" }))),
              )
            }
          >
            <Icon name="download" /> Export jobs (CSV)
          </button>
        </div>
      </div>

      {reasons.length > 0 && (
        <div className="grid g3">
          {reasons.map(([reason, n]) => (
            <div key={reason} className="callout warn">
              <Icon name="clock" />
              <div>
                <b>
                  {n} job{n > 1 ? "s" : ""} waiting: {reason}
                </b>
                <div className="small muted">{REASON_HELP[reason] ?? ""}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Card
        title="Jobs"
        flush
        right={
          <>
            <input type="text" placeholder="Filter by user, name, node…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 210 }} aria-label="Filter jobs" />
            <Seg label="View" options={VIEWS} value={view} onChange={setView} format={(v) => `${v} ${counts[v]}`} />
          </>
        }
      >
        <JobTable jobs={jobs} now={c.now} empty="No jobs in this view." />
      </Card>
    </>
  );
}
