export interface Workload {
  id: string;
  label: string;
  description: string;
  defaultArgs: string;
  partition: "gpu" | "cpu";
  gpus: number;
  /** Simulated runtime and, optionally, when the job crashes. */
  plan(args: Record<string, string>): { runtimeS: number; failAtS: number | null; steps: number };
  line(step: number, steps: number, args: Record<string, string>): string;
}

export function parseArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) continue;
    const [key, inline] = t.slice(2).split("=", 2);
    if (inline !== undefined) out[key] = inline;
    else if (tokens[i + 1] && !tokens[i + 1].startsWith("--")) out[key] = tokens[++i];
    else out[key] = "true";
  }
  return out;
}

const num = (args: Record<string, string>, key: string, fallback: number) => {
  const v = Number(args[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const WORKLOADS: Workload[] = [
  {
    id: "train_model",
    label: "Train a deep-learning model",
    description: "PyTorch-style training loop; logs loss and accuracy each epoch.",
    defaultArgs: "--epochs 8 --minutes-per-epoch 1",
    partition: "gpu",
    gpus: 1,
    plan(a) {
      const epochs = Math.round(num(a, "epochs", 8));
      const mpe = num(a, "minutes-per-epoch", 1);
      const failAt = a["fail-at"] ? num(a, "fail-at", 0) : 0;
      return { runtimeS: epochs * mpe * 60, failAtS: failAt ? (failAt - 0.5) * mpe * 60 : null, steps: epochs };
    },
    line(step, steps) {
      const loss = 2.3 * Math.exp(-0.32 * step) + 0.06 + Math.random() * 0.02;
      const acc = Math.min(0.99, 0.35 + 0.6 * (1 - Math.exp(-0.3 * step)));
      return `epoch ${step}/${steps}  loss=${loss.toFixed(4)}  val_acc=${acc.toFixed(3)}  checkpoint saved`;
    },
  },
  {
    id: "llm_finetune",
    label: "Fine-tune a language model (LoRA)",
    description: "LoRA fine-tuning on a domain corpus; logs tokens/s and loss.",
    defaultArgs: "--steps 600 --seconds-per-step 1",
    partition: "gpu",
    gpus: 2,
    plan(a) {
      const steps = num(a, "steps", 600);
      return { runtimeS: steps * num(a, "seconds-per-step", 1), failAtS: null, steps: 10 };
    },
    line(step, steps, a) {
      const total = num(a, "steps", 600);
      const loss = 1.9 * Math.exp(-0.18 * step) + 0.4;
      return `step ${Math.round((step / steps) * total)}/${total}  loss=${loss.toFixed(3)}  tokens/s=${(2900 + Math.random() * 300).toFixed(0)}`;
    },
  },
  {
    id: "monte_carlo_pi",
    label: "Monte Carlo estimate of pi",
    description: "Embarrassingly parallel CPU job; logs the running estimate.",
    defaultArgs: "--samples 40000000",
    partition: "cpu",
    gpus: 0,
    plan(a) {
      return { runtimeS: (num(a, "samples", 4e7) / 1e6) * 6, failAtS: null, steps: 8 };
    },
    line(step, steps, a) {
      const n = Math.round((num(a, "samples", 4e7) * step) / steps);
      const err = (Math.random() - 0.5) / Math.sqrt(n);
      return `samples=${n.toLocaleString("en-US")}  pi~${(Math.PI + err * 4).toFixed(6)}`;
    },
  },
  {
    id: "data_prep",
    label: "Clean and summarise survey data",
    description: "pandas ETL on a large survey file; writes summary statistics.",
    defaultArgs: "--rows 2000000",
    partition: "cpu",
    gpus: 0,
    plan(a) {
      return { runtimeS: (num(a, "rows", 2e6) / 1e5) * 9, failAtS: null, steps: 6 };
    },
    line(step, steps, a) {
      const stages = ["read csv", "drop duplicates", "impute missing", "encode categories", "aggregate", "write parquet"];
      const rows = Math.round((num(a, "rows", 2e6) * step) / steps);
      return `[${stages[(step - 1) % stages.length]}] ${rows.toLocaleString("en-US")} rows processed`;
    },
  },
  {
    id: "cfd_solver",
    label: "CFD flow simulation (MPI)",
    description: "Iterative solver; logs residuals until convergence.",
    defaultArgs: "--iterations 400",
    partition: "cpu",
    gpus: 0,
    plan(a) {
      return { runtimeS: num(a, "iterations", 400) * 1.5, failAtS: null, steps: 10 };
    },
    line(step, steps, a) {
      const it = Math.round((num(a, "iterations", 400) * step) / steps);
      return `iter ${it}  residual=${(1e-1 * Math.exp(-0.9 * step)).toExponential(3)}  CFL=0.82`;
    },
  },
];

export const UPLOAD_PREFIX = "upload:";
export const uploadId = (user: string, name: string) => `${UPLOAD_PREFIX}${user}/${name}`;
export const isUpload = (id: string) => id.startsWith(UPLOAD_PREFIX);

/** The path a job's script would have on the cluster. */
export const scriptPath = (workload: string) => (isUpload(workload) ? `jobs/uploads/${workload.slice(UPLOAD_PREFIX.length)}` : `jobs/${workload}.py`);

/** Simulated stand-in for an uploaded script: run time grows with its length (1-10 minutes). */
function uploadWorkload(id: string): Workload {
  const path = id.slice(UPLOAD_PREFIX.length);
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const runtimeS = 60 + (hash % 540);
  return {
    id,
    label: `Your script: ${path}`,
    description: "Your uploaded script. In this web demo its run is simulated; the local Python version runs it for real.",
    defaultArgs: "",
    partition: "gpu",
    gpus: 1,
    plan: () => ({ runtimeS, failAtS: null, steps: 8 }),
    line: (step, steps) => `[${path}] progress ${Math.round((step / steps) * 100)}% (simulated)`,
  };
}

export const workloadById = (id: string) => (isUpload(id) ? uploadWorkload(id) : (WORKLOADS.find((w) => w.id === id) ?? WORKLOADS[0]));
