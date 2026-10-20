import { useCluster } from "../engine/store";
import { outcomes, toCsv, usageByAccount, usageByUser } from "../engine/queries";
import { Bar, Card, download } from "../components/ui";
import { Donut } from "../components/charts";
import { Icon } from "../components/icons";

const OUTCOME_COLOR: Record<string, string> = { COMPLETED: "var(--primary)", FAILED: "var(--danger)", TIMEOUT: "var(--accent)", CANCELLED: "var(--muted)" };

export default function Accounting() {
  const c = useCluster();
  const accounts = usageByAccount(c);
  const users = usageByUser(c);
  const outs = outcomes(c);
  const maxGpu = Math.max(0.0001, ...users.map((u) => u.gpuHours));
  const finished = outs.reduce((a, o) => a + o.count, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounting and fair-share</h1>
          <p>
            Like `sreport` and `sshare`. GPU hours are charged at {c.settings.gpuBillingWeight}× a CPU core. Accounts that used more than their share recently drop in priority;
            usage halves every {c.settings.halflifeH} hours.
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => download("usage_by_user.csv", toCsv(users))}>
            <Icon name="download" /> Usage by user (CSV)
          </button>
          <button className="btn" onClick={() => download("usage_by_account.csv", toCsv(accounts))}>
            <Icon name="download" /> Usage by account (CSV)
          </button>
        </div>
      </div>

      <div className="grid g3">
        {accounts.map((a) => (
          <Card key={a.account} title={a.account} sub={`${a.jobs} jobs`}>
            <div className="stack">
              <div className="hbar">
                <span className="small">Target share</span>
                <Bar value={a.targetShare} tone="var(--muted)" />
                <span className="mono small">{(a.targetShare * 100).toFixed(0)}%</span>
              </div>
              <div className="hbar">
                <span className="small">Recent usage</span>
                <Bar value={a.recentUsage} tone={a.recentUsage > a.targetShare ? "var(--accent)" : "var(--primary)"} />
                <span className="mono small">{(a.recentUsage * 100).toFixed(0)}%</span>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="small muted">Fair-share factor</span>
                <b className="mono" style={{ fontSize: 20, color: a.fairshare < 0.5 ? "var(--accent)" : "var(--primary)" }}>
                  {a.fairshare.toFixed(2)}
                </b>
              </div>
              <div className="small muted mono">
                {a.gpuHours.toFixed(2)} GPU-h · {a.cpuHours.toFixed(1)} CPU-h
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid g-2-1">
        <Card title="Users" sub="sorted by GPU hours" flush>
          {users.length ? (
            <div className="table-wrap scroll">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Account</th>
                    <th className="num">Jobs</th>
                    <th className="num">Done</th>
                    <th className="num">Failed</th>
                    <th>GPU hours</th>
                    <th className="num">CPU h</th>
                    <th className="num">Avg wait</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.user}>
                      <td className="mono">{u.user}</td>
                      <td>{u.role}</td>
                      <td>{u.account}</td>
                      <td className="num">{u.jobs}</td>
                      <td className="num">{u.completed}</td>
                      <td className="num">{u.failed}</td>
                      <td style={{ minWidth: 140 }}>
                        <div className="row" style={{ flexWrap: "nowrap" }}>
                          <Bar value={u.gpuHours / maxGpu} />
                          <span className="mono small">{u.gpuHours.toFixed(2)}</span>
                        </div>
                      </td>
                      <td className="num">{u.cpuHours.toFixed(1)}</td>
                      <td className="num">{u.avgWaitMin.toFixed(1)}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">No usage yet.</div>
          )}
        </Card>
        <Card title="Job outcomes">
          <Donut label="Finished jobs by final state" center={String(finished)} parts={outs.map((o) => ({ name: o.state, value: o.count, color: OUTCOME_COLOR[o.state] }))} />
        </Card>
      </div>
    </>
  );
}
