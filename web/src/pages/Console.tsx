import { useEffect, useRef, useState } from "react";
import { store, useCluster } from "../engine/store";
import { cancelJob, drainNode, fmtDuration, resumeNode, submitJob } from "../engine/engine";
import { submitDemoBatch } from "../engine/demo";
import { nodeView, usageByAccount } from "../engine/queries";
import { WORKLOADS, scriptPath } from "../engine/workloads";
import { clockTime } from "../components/ui";
import type { Cluster, Role } from "../engine/types";

type Line = { kind: "cmd" | "out" | "err"; text: string };

const HELP = `Slurm-style commands (run against the simulated cluster):
  sbatch [options] <workload> [args]   submit a job, e.g.
      sbatch -J bert -u rahul --qos=phd -A research -p gpu --gres=gpu:2 -c 8 --mem=64G -t 30 --mail-user=rahul@phd.example.edu llm_finetune --steps 300
  squeue [-u user]                     list pending and running jobs
  sinfo                                node states
  scancel <jobid>                      cancel a job
  scontrol show job <jobid>            job details
  scontrol update nodename=<n> state=drain reason="..."  |  state=resume
  sacct                                finished jobs
  sshare                               fair-share by account
  sprio                                priority factors of pending jobs
  workloads                            list allowed workloads
  demo                                 submit the 10-job demo batch
  clear                                clear the screen`;

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const rpad = (s: string | number, n: number) => String(s).padStart(n).slice(-n);

function tokenize(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

function run(c: Cluster, line: string): string {
  const [cmd, ...rest] = tokenize(line);
  switch (cmd) {
    case "help":
      return HELP;
    case "workloads":
      return WORKLOADS.map((w) => `${pad(w.id, 16)} ${pad(w.partition, 4)} ${w.defaultArgs.padEnd(38)} ${w.label}`).join("\n");
    case "demo":
      return `Submitted batch jobs ${submitDemoBatch(c).join(", ")}`;
    case "sbatch": {
      const o: Record<string, string> = {};
      let i = 0;
      const take = (k: string) => (o[k] = rest[++i] ?? "");
      for (; i < rest.length; i++) {
        const t = rest[i];
        if (!t.startsWith("-")) break;
        const [flag, val] = t.split("=", 2);
        const key = { "-J": "job-name", "-u": "user", "-A": "account", "-p": "partition", "-c": "cpus-per-task", "-t": "time", "-q": "qos" }[flag] ?? flag.replace(/^--/, "");
        if (val !== undefined) o[key] = val;
        else take(key);
      }
      const workload = rest[i];
      if (!workload) throw new Error("sbatch: missing workload name (see `workloads`)");
      if (!WORKLOADS.some((w) => w.id === workload)) throw new Error(`sbatch: workload "${workload}" is not on the allow-list`);
      const role = (o.qos ?? "student") as Role;
      const user = o.user ?? "asha";
      const id = submitJob(c, {
        name: o["job-name"] ?? workload,
        user,
        email: o["mail-user"] ?? `${user}@example.edu`,
        role,
        account: o.account ?? (role === "startup" ? "startups" : role === "student" ? "teaching" : "research"),
        partition: o.partition ?? WORKLOADS.find((w) => w.id === workload)!.partition,
        cpus: Number(o["cpus-per-task"] ?? 4),
        memGb: Number((o.mem ?? "16G").replace(/G$/i, "")),
        gpus: Number((o.gres ?? "gpu:0").split(":").pop()),
        timeLimitMin: Number(o.time ?? 15),
        workload,
        args: rest.slice(i + 1).join(" "),
        mail: o["mail-type"] !== "NONE",
      });
      return `Submitted batch job ${id}`;
    }
    case "squeue": {
      const u = rest[0] === "-u" ? rest[1] : undefined;
      const jobs = c.jobs.filter((j) => (j.state === "PENDING" || j.state === "RUNNING") && (!u || j.user === u));
      const head = `${rpad("JOBID", 6)} ${pad("PARTITION", 9)} ${pad("NAME", 22)} ${pad("USER", 11)} ST ${rpad("TIME", 8)} NODELIST(REASON)`;
      return [
        head,
        ...jobs.map(
          (j) =>
            `${rpad(j.id, 6)} ${pad(j.partition, 9)} ${pad(j.name, 22)} ${pad(j.user, 11)} ${j.state === "RUNNING" ? "R " : "PD"} ${rpad(j.startTime ? fmtDuration(c.now - j.startTime) : "0s", 8)} ${j.state === "RUNNING" ? j.node : `(${j.reason})`}`,
        ),
      ].join("\n");
    }
    case "sinfo":
      return [
        `${pad("NODELIST", 9)} ${pad("PARTITION", 9)} ${pad("STATE", 10)} ${pad("CPUS(A/T)", 10)} ${pad("GRES(A/T)", 10)} ${pad("TEMP", 6)} REASON`,
        ...nodeView(c).map(
          ({ node: n, usedCpus, usedGpus, status }) =>
            `${pad(n.name, 9)} ${pad(n.partition, 9)} ${pad(status, 10)} ${pad(`${usedCpus}/${n.cpus}`, 10)} ${pad(n.gpus ? `${usedGpus}/${n.gpus}` : "-", 10)} ${pad(`${n.temp.toFixed(0)}C`, 6)} ${n.reason}`,
        ),
      ].join("\n");
    case "scancel":
      if (!rest[0]) throw new Error("scancel: give a job id");
      return cancelJob(c, Number(rest[0]), "console");
    case "scontrol": {
      if (rest[0] === "show" && rest[1] === "job") {
        const j = c.jobs.find((x) => x.id === Number(rest[2]));
        if (!j) throw new Error(`scontrol: job ${rest[2]} not found`);
        return Object.entries({
          JobId: j.id, JobName: j.name, UserId: j.user, Account: j.account, QOS: j.role, JobState: j.state, Reason: j.reason || "None",
          Priority: j.priority, Partition: j.partition, NodeList: j.node ?? "(null)", NumCPUs: j.cpus, MinMemory: `${j.memGb}G`,
          Gres: j.gpus ? `gpu:${j.gpus}` : "(null)", TimeLimit: `${j.timeLimitMin}:00`, SubmitTime: clockTime(j.submitTime),
          StartTime: j.startTime ? clockTime(j.startTime) : "Unknown", EndTime: j.endTime ? clockTime(j.endTime) : "Unknown",
          ExitCode: j.exitCode ?? "-", Restarts: j.attempt - 1, MailUser: j.email, Command: `${scriptPath(j.workload)} ${j.args}`,
        })
          .map(([k, v]) => `   ${k}=${v}`)
          .join("\n");
      }
      if (rest[0] === "update") {
        const kv = Object.fromEntries(rest.slice(1).map((t) => t.split("=", 2).map((x, i) => (i ? x : x.toLowerCase()))));
        if (!kv.nodename) throw new Error("scontrol update: nodename= is required");
        const st = (kv.state ?? "").toLowerCase();
        if (st === "drain") return drainNode(c, kv.nodename, kv.reason ?? "Maintenance", "console");
        if (st === "resume" || st === "idle") return resumeNode(c, kv.nodename, "console");
        throw new Error("scontrol update: state must be drain or resume");
      }
      throw new Error("scontrol: supported: show job <id>, update nodename=<n> state=drain|resume");
    }
    case "sacct": {
      const done = c.jobs.filter((j) => j.endTime !== undefined).slice(-25);
      return [
        `${rpad("JobID", 6)} ${pad("JobName", 22)} ${pad("User", 11)} ${pad("State", 10)} ${rpad("Elapsed", 8)} ExitCode`,
        ...done.map((j) => `${rpad(j.id, 6)} ${pad(j.name, 22)} ${pad(j.user, 11)} ${pad(j.state, 10)} ${rpad(fmtDuration((j.endTime ?? 0) - (j.startTime ?? j.endTime ?? 0)), 8)} ${j.exitCode ?? "-"}:0`),
      ].join("\n");
    }
    case "sshare":
      return [
        `${pad("Account", 10)} ${rpad("RawShares", 9)} ${rpad("NormShares", 10)} ${rpad("EffUsage", 9)} ${rpad("FairShare", 9)}`,
        ...usageByAccount(c).map((a) => `${pad(a.account, 10)} ${rpad(c.settings.shares[a.account], 9)} ${rpad(a.targetShare.toFixed(3), 10)} ${rpad(a.recentUsage.toFixed(3), 9)} ${rpad(a.fairshare.toFixed(3), 9)}`),
      ].join("\n");
    case "sprio": {
      const p = c.jobs.filter((j) => j.state === "PENDING" && j.factors).sort((a, b) => b.priority - a.priority);
      return [
        `${rpad("JOBID", 6)} ${pad("USER", 11)} ${rpad("PRIORITY", 8)} ${rpad("FAIRSHARE", 9)} ${rpad("AGE", 6)} ${rpad("QOS", 6)}`,
        ...p.map((j) => `${rpad(j.id, 6)} ${pad(j.user, 11)} ${rpad(j.priority, 8)} ${rpad(Math.round(j.factors!.fairshare), 9)} ${rpad(Math.round(j.factors!.age), 6)} ${rpad(Math.round(j.factors!.qos), 6)}`),
      ].join("\n");
    }
    default:
      throw new Error(`${cmd}: command not found. Type help.`);
  }
}

export default function Console() {
  useCluster();
  const [lines, setLines] = useState<Line[]>([{ kind: "out", text: "HPC Autopilot console. Type help for commands. Try: squeue, sinfo, sprio, demo" }]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [h, setH] = useState(-1);
  const out = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    out.current?.scrollTo(0, out.current.scrollHeight);
  }, [lines]);

  const exec = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    setHistory((x) => [line, ...x].slice(0, 50));
    setH(-1);
    if (line === "clear") return setLines([]);
    let res: Line;
    try {
      res = { kind: "out", text: store.act((c) => run(c, line)) };
    } catch (e) {
      res = { kind: "err", text: (e as Error).message };
    }
    setLines((x): Line[] => [...x, { kind: "cmd" as const, text: line }, res].slice(-300));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Console</h1>
          <p>The same cluster through Slurm-style commands, the way users and admins work on a real login node.</p>
        </div>
      </div>
      <div className="term" onClick={() => inp.current?.focus()}>
        <div className="term-bar">
          <i style={{ background: "#ff5f57" }} />
          <i style={{ background: "#febc2e" }} />
          <i style={{ background: "#28c840" }} />
          <span style={{ marginLeft: 8 }}>admin@login01: ~</span>
        </div>
        <div className="term-out" ref={out}>
          {lines.map((l, i) => (
            <div key={i} className={l.kind}>
              {l.kind === "cmd" ? `$ ${l.text}` : l.text}
            </div>
          ))}
        </div>
        <form
          className="term-in"
          onSubmit={(e) => {
            e.preventDefault();
            exec(input);
            setInput("");
          }}
        >
          <span>admin@login01:~$</span>
          <input
            ref={inp}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Command"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const n = Math.min(history.length - 1, h + 1);
                setH(n);
                setInput(history[n]);
              } else if (e.key === "ArrowDown" && h >= 0) {
                e.preventDefault();
                const n = h - 1;
                setH(Math.max(-1, n));
                setInput(n >= 0 ? history[n] : "");
              }
            }}
          />
        </form>
      </div>
      <div className="row">
        {["squeue", "sinfo", "sprio", "sshare", "sacct", "workloads", "help"].map((cmd) => (
          <button key={cmd} className="btn sm mono" onClick={() => exec(cmd)}>
            {cmd}
          </button>
        ))}
      </div>
    </>
  );
}
