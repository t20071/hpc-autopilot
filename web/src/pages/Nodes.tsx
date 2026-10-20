import { useState } from "react";
import { store, useCluster } from "../engine/store";
import { addNode, drainNode, removeNode, resumeNode, setFault } from "../engine/engine";
import { nodeView } from "../engine/queries";
import { Badge, Bar, Card, Callout, toast } from "../components/ui";
import { NodeRacks } from "../components/cluster";
import { Icon } from "../components/icons";
import type { Cluster, Fault } from "../engine/types";

const run = (fn: (c: Cluster) => string | void, ok?: string) => {
  try {
    const msg = store.act(fn);
    toast(msg || ok || "Done");
  } catch (e) {
    toast((e as Error).message, true);
  }
};

const DRILLS: [Fault, string, string][] = [
  ["gpu_overheat", "GPU overheating", "Temperature climbs past the limit; the health check drains the node and alerts the admin. Running jobs finish."],
  ["ecc_error", "GPU ECC error", "An uncorrectable memory error drains the node at once."],
  ["node_down", "Node failure", "The node stops responding. It is marked DOWN and its running jobs are requeued onto healthy nodes."],
];

export default function Nodes() {
  const c = useCluster();
  const [target, setTarget] = useState(c.nodes[0]?.name ?? "");
  const [reason, setReason] = useState("Planned maintenance: firmware update");
  const [spec, setSpec] = useState({ name: "gpu03", partition: "gpu", cpus: 32, memGb: 256, gpus: 4, gpuType: "NVIDIA H100" });
  const views = nodeView(c);
  const selected = c.nodes.some((n) => n.name === target) ? target : (c.nodes[0]?.name ?? "");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Nodes and health</h1>
          <p>Like `sinfo` and `scontrol`. Each node is checked on every pass: temperature, ECC errors and heartbeat. Faulty nodes are drained and resumed automatically.</p>
        </div>
      </div>

      <NodeRacks />

      <Card title="Node table" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Partition</th>
                <th>State</th>
                <th>GPUs</th>
                <th>CPUs</th>
                <th>Memory</th>
                <th className="num">Temp</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {views.map(({ node: n, usedGpus, usedCpus, usedMem, status }) => (
                <tr key={n.name}>
                  <td className="mono">{n.name}</td>
                  <td>{n.partition}</td>
                  <td>
                    <Badge value={status} />
                  </td>
                  <td style={{ minWidth: 110 }}>
                    {n.gpus ? (
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <Bar value={usedGpus / n.gpus} />
                        <span className="mono small">
                          {usedGpus}/{n.gpus}
                        </span>
                      </div>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td style={{ minWidth: 110 }}>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <Bar value={usedCpus / n.cpus} tone="var(--info)" />
                      <span className="mono small">
                        {usedCpus}/{n.cpus}
                      </span>
                    </div>
                  </td>
                  <td className="mono small">
                    {usedMem}/{n.memGb} GB
                  </td>
                  <td className="num">{n.temp.toFixed(0)}°C</td>
                  <td className="small">{n.reason || <span className="muted">-</span>}</td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      {n.state === "up" ? (
                        <button className="btn sm" onClick={() => run((c) => drainNode(c, n.name, reason))}>
                          Drain
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => run((c) => resumeNode(c, n.name))}>
                          Resume
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Failure drills" sub="prove the automation works">
          <div className="stack">
            <div className="row">
              <label className="small muted" htmlFor="drill-node">
                Node
              </label>
              <select id="drill-node" value={selected} onChange={(e) => setTarget(e.target.value)} style={{ width: 140 }}>
                {c.nodes.map((n) => (
                  <option key={n.name}>{n.name}</option>
                ))}
              </select>
              <button className="btn sm" onClick={() => run((c) => setFault(c, selected, ""))}>
                <Icon name="refresh" size={14} /> Clear fault
              </button>
            </div>
            {DRILLS.map(([fault, label, desc]) => (
              <div key={fault} className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <b>{label}</b>
                  <div className="small muted">{desc}</div>
                </div>
                <button className="btn sm danger" onClick={() => run((c) => setFault(c, selected, fault))}>
                  <Icon name="zap" size={14} /> Inject
                </button>
              </div>
            ))}
            <Callout tone="ok" icon="shield">
              After clearing a fault, the node resumes on its own once it passes the health check
              {c.settings.autoResume ? "" : " (auto-resume is off in Automation)"}.
            </Callout>
          </div>
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Planned maintenance">
            <div className="stack">
              <div className="field">
                <label htmlFor="drain-reason">Drain reason</label>
                <input id="drain-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="small muted">Draining lets running jobs finish but starts nothing new on the node: the safe way to patch drivers or firmware.</div>
            </div>
          </Card>
          <Card title="Scale the cluster">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="n-name">Name</label>
                <input id="n-name" type="text" value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="n-part">Partition</label>
                <select id="n-part" value={spec.partition} onChange={(e) => setSpec({ ...spec, partition: e.target.value, gpus: e.target.value === "cpu" ? 0 : 4 })}>
                  <option>gpu</option>
                  <option>cpu</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="n-cpu">CPUs</label>
                <input id="n-cpu" type="number" min={1} value={spec.cpus} onChange={(e) => setSpec({ ...spec, cpus: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="n-gpu">GPUs</label>
                <input id="n-gpu" type="number" min={0} max={8} value={spec.gpus} onChange={(e) => setSpec({ ...spec, gpus: Number(e.target.value) })} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary sm" onClick={() => run((c) => addNode(c, { ...spec, memGb: spec.memGb, gpuType: spec.gpus ? spec.gpuType : "" }), `${spec.name} added`)}>
                <Icon name="plus" size={14} /> Add node
              </button>
              <button className="btn danger sm" disabled={!selected} onClick={() => run((c) => removeNode(c, selected), `${selected} removed`)}>
                <Icon name="trash" size={14} /> Remove {selected}
              </button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
