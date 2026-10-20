import { useEffect, useRef, useState } from "react";
import { store, useCluster } from "../engine/store";
import { nodeView, summary, usageByAccount } from "../engine/queries";
import { REASON_HELP } from "../engine/policy";
import { fmtDuration } from "../engine/engine";
import { Card, Callout, clockTime, toast } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { Icon } from "../components/icons";
import type { Cluster } from "../engine/types";

const SUGGESTIONS = [
  "Why are jobs waiting right now, and is anything stuck?",
  "Which nodes need my attention, and what has the autopilot already done?",
  "Write a three-line status update on the cluster for the Director.",
  "Which account is using more than its fair share?",
  "Summarise failed and timed-out jobs and suggest what the users should change.",
];

/** A compact, text snapshot of the cluster for the model (no personal data beyond usernames). */
export function clusterContext(c: Cluster): string {
  const s = summary(c);
  const lines = [
    `Time ${clockTime(c.now)}. Running ${s.running}, pending ${s.pending}, completed ${s.completed}, failed/timeout ${s.failed}.`,
    `GPUs in use ${s.gpusUsed}/${s.gpusTotal}, CPUs ${s.cpusUsed}/${s.cpusTotal}, nodes up ${s.nodesUp}/${s.nodesTotal}, average wait ${fmtDuration(s.avgWaitS)}.`,
    `Automations: ${Object.entries(c.settings.automations).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}; backfill=${c.settings.backfill}.`,
    "NODES:",
    ...nodeView(c).map(({ node: n, usedGpus, usedCpus, status }) => `- ${n.name} (${n.partition}) ${status}, GPU ${usedGpus}/${n.gpus}, CPU ${usedCpus}/${n.cpus}, ${n.temp.toFixed(0)}C${n.reason ? `, reason: ${n.reason}` : ""}${n.fault ? `, fault: ${n.fault}` : ""}`),
    "ROLE LIMITS:",
    ...Object.entries(c.settings.qos).map(([r, q]) => `- ${r}: max ${q.maxGpusPerUser} GPU, ${q.maxRunningJobs} jobs, ${q.maxTimeMin} min`),
    "ACCOUNTS:",
    ...usageByAccount(c).map((a) => `- ${a.account}: share ${(a.targetShare * 100).toFixed(0)}%, recent usage ${(a.recentUsage * 100).toFixed(0)}%, fair-share ${a.fairshare.toFixed(2)}`),
    "ACTIVE JOBS:",
    ...c.jobs
      .filter((j) => j.state === "PENDING" || j.state === "RUNNING")
      .slice(0, 40)
      .map((j) => `- ${j.id} ${j.name} user=${j.user} role=${j.role} ${j.state}${j.state === "PENDING" ? ` reason=${j.reason} priority=${j.priority} waited=${fmtDuration(c.now - j.submitTime)}` : ` node=${j.node} ran=${fmtDuration(c.now - (j.startTime ?? c.now))}/${j.timeLimitMin}m`} req=${j.cpus}cpu/${j.gpus}gpu`),
    `FAILED OR TIMED-OUT JOBS (${c.jobs.filter((j) => j.state === "FAILED" || j.state === "TIMEOUT").length}):`,
    ...c.jobs
      .filter((j) => j.state === "FAILED" || j.state === "TIMEOUT")
      .slice(-15)
      .map((j) => `- ${j.id} ${j.name} user=${j.user} role=${j.role} ${j.state} exit=${j.exitCode ?? "-"} limit=${j.timeLimitMin}m ran=${fmtDuration((j.endTime ?? 0) - (j.startTime ?? j.endTime ?? 0))} needs~${fmtDuration(j.runtimeS)} reason="${j.reason}"`),
    "RECENT FINISHED JOBS:",
    ...c.jobs
      .filter((j) => j.endTime !== undefined)
      .slice(-15)
      .map((j) => `- ${j.id} ${j.name} user=${j.user} ${j.state}${j.exitCode !== undefined ? ` exit=${j.exitCode}` : ""} limit=${j.timeLimitMin}m last="${(j.log[j.log.length - 1] ?? "").slice(0, 90)}"`),
    "RECENT EVENTS:",
    ...c.events.slice(0, 25).map((e) => `- ${clockTime(e.time)} [${e.level}] ${e.message}`),
  ];
  return lines.join("\n");
}

/** Offline answer used when the AI endpoint is not configured. */
function localAnswer(c: Cluster): string {
  const s = summary(c);
  const pending = c.jobs.filter((j) => j.state === "PENDING");
  const reasons = pending.reduce<Record<string, number>>((a, j) => ({ ...a, [j.reason]: (a[j.reason] ?? 0) + 1 }), {});
  const bad = c.nodes.filter((n) => n.state !== "up");
  const failed = c.jobs.filter((j) => j.state === "FAILED" || j.state === "TIMEOUT").slice(-5);
  return [
    `Cluster: ${s.running} running, ${s.pending} waiting, GPUs ${s.gpusUsed}/${s.gpusTotal} in use, ${s.nodesUp}/${s.nodesTotal} nodes accepting jobs.`,
    pending.length ? `Waiting jobs by reason:\n${Object.entries(reasons).map(([r, n]) => `• ${n} × ${r}: ${REASON_HELP[r] ?? ""}`).join("\n")}` : "No jobs are waiting.",
    bad.length ? `Nodes needing attention:\n${bad.map((n) => `• ${n.name}: ${n.state}, ${n.reason}${n.fault ? ` (fault ${n.fault})` : ""}`).join("\n")}` : "All nodes are healthy.",
    failed.length ? `Recent failures:\n${failed.map((j) => `• ${j.id} ${j.name} (${j.user}): ${j.state}${j.state === "TIMEOUT" ? ", ask for a longer time limit or checkpoint" : ", check the traceback in its log"}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type Turn = { id: number; q: string; a?: string; source?: string; ai?: boolean };

export default function Assistant() {
  const c = useCluster();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const busy = turns.some((t) => t.a === undefined);
  const end = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    const id = nextId.current++;
    setQ("");
    setTurns((t) => [...t, { id, q: question.trim() }].slice(-20)); // the question shows at once; its answer fills in below it
    let done: Partial<Turn>;
    try {
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, context: clusterContext(store.state) }),
      });
      const data = (await r.json().catch(() => ({}))) as { answer?: string; model?: string; error?: string };
      if (!r.ok || !data.answer) throw new Error(data.error ?? `HTTP ${r.status}`);
      done = { a: data.answer, source: `Groq · ${data.model ?? "LLM"}`, ai: true };
    } catch (e) {
      done = { a: localAnswer(store.state), source: `Built-in summary · AI unavailable (${(e as Error).message})`, ai: false };
    }
    setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...done } : x)));
  };

  const pending = c.jobs.filter((j) => j.state === "PENDING").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI assistant</h1>
          <p>Ask about the live cluster in plain English. The assistant sees a snapshot of queue, nodes, usage and recent events, and answers like an experienced HPC admin.</p>
        </div>
        {turns.length > 0 && (
          <div className="actions">
            <button className="btn" onClick={() => setTurns([])} disabled={busy}>
              <Icon name="refresh" /> New conversation
            </button>
          </div>
        )}
      </div>

      <div className="grid g-2-1">
        <section className="card chat" aria-label="Conversation with the assistant">
          <div className="chat-thread" aria-live="polite">
            {turns.length === 0 && (
              <div className="chat-empty">
                <div className="chat-avatar big">
                  <Icon name="bot" size={22} />
                </div>
                <h2>What would you like to know about the cluster?</h2>
                <p className="muted small">Pick a question or type your own. Answers appear right under each question.</p>
                <div className="chat-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="chat-suggestion" onClick={() => void ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t) => (
              <div key={t.id} className="chat-turn">
                <div className="chat-q">
                  <span>{t.q}</span>
                </div>
                <div className="chat-a">
                  <div className="chat-avatar">
                    <Icon name="bot" size={16} />
                  </div>
                  <div className="chat-bubble">
                    {t.a === undefined ? (
                      <div className="typing" aria-label="The assistant is thinking">
                        <i />
                        <i />
                        <i />
                      </div>
                    ) : (
                      <>
                        <Markdown text={t.a} />
                        <div className="chat-meta">
                          <span className={`badge plain ${t.ai ? "t-ok" : "t-warn"}`}>{t.source}</span>
                          <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(t.a ?? "").then(() => toast("Answer copied"))}>
                            Copy
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={end} />
          </div>

          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(q);
            }}
          >
            {turns.length > 0 && (
              <div className="chat-chips">
                {SUGGESTIONS.slice(0, 3).map((s) => (
                  <button key={s} type="button" className="btn sm ghost" onClick={() => void ask(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <div className="chat-input">
              <textarea
                rows={2}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void ask(q);
                  }
                }}
                placeholder="e.g. Why is job 1003 still pending?  (Enter to send, Shift+Enter for a new line)"
                maxLength={1000}
                aria-label="Question"
              />
              <button className="btn primary" type="submit" disabled={busy || !q.trim()}>
                <Icon name="send" /> {busy ? "Thinking…" : "Ask"}
              </button>
            </div>
            <span className="small muted">
              Context: {plural(pending, "pending job")}, {plural(c.nodes.length, "node")}, {plural(Math.min(25, c.events.length), "recent event")}
            </span>
          </form>
        </section>

        <div className="stack" style={{ gap: 16 }}>
          <Callout icon="shield">
            The API key lives only on the server (<code>GROQ_API_KEY</code> in Vercel or in <code>.env</code> for local dev). The browser sends the question and a text
            snapshot of the simulated cluster: no passwords or real personal data.
          </Callout>
          <Card title="What the assistant sees">
            <pre className="code" style={{ maxHeight: 460, whiteSpace: "pre-wrap" }}>
              {clusterContext(c)}
            </pre>
          </Card>
        </div>
      </div>
    </>
  );
}
