import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Sparkline } from "./charts";
import type { JobState } from "../engine/types";

export function Card({ title, sub, right, children, flush, className }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {title && (
        <header className="card-head">
          <h2>{title}</h2>
          {sub && <span className="sub">{sub}</span>}
          {right && <div className="right">{right}</div>}
        </header>
      )}
      <div className={`card-body ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}

export function Metric({ label, value, unit, icon, trend, tone = "var(--primary)", max }: { label: string; value: ReactNode; unit?: string; icon?: IconName; trend?: number[]; tone?: string; max?: number }) {
  return (
    <div className="card metric" style={{ ["--tone" as string]: tone }}>
      <div className="label">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div className="value">
        {value}
        {unit && <small> {unit}</small>}
      </div>
      <div className="spark">{trend && trend.length > 1 ? <Sparkline data={trend} color={tone} max={max} /> : null}</div>
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  PENDING: "t-warn",
  RUNNING: "t-info",
  COMPLETED: "t-ok",
  FAILED: "t-bad",
  TIMEOUT: "t-accent",
  CANCELLED: "t-mute",
  idle: "t-ok",
  mixed: "t-info",
  allocated: "t-accent",
  draining: "t-warn",
  drained: "t-warn",
  down: "t-bad",
  info: "t-info",
  warning: "t-warn",
  error: "t-bad",
  outbox: "t-mute",
  queued: "t-warn",
  sending: "t-info",
  sent: "t-ok",
  failed: "t-bad",
};

export function Badge({ value, plain, tone }: { value: string; plain?: boolean; tone?: string }) {
  return <span className={`badge ${tone ?? STATE_TONE[value] ?? "t-mute"} ${plain ? "plain" : ""}`}>{value}</span>;
}

export const StateBadge = ({ state }: { state: JobState }) => <Badge value={state} />;

export function Bar({ value, tone }: { value: number; tone?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="bar" style={{ ["--tone" as string]: tone }} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Seg<T extends string>({ options, value, onChange, label, format }: { options: readonly T[]; value: T; onChange: (v: T) => void; label: string; format?: (v: T) => string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o} aria-pressed={o === value} onClick={() => onChange(o)}>
          {format ? format(o) : o}
        </button>
      ))}
    </div>
  );
}

export function Callout({ tone = "", icon = "alert", children }: { tone?: "" | "ok" | "warn" | "bad"; icon?: IconName; children: ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

// ---- toasts
type Toast = { id: number; text: string; bad?: boolean };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};
export const toast = (text: string, bad = false) => pushToast({ text, bad });

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let id = 0;
    pushToast = (t) => {
      const item = { ...t, id: ++id };
      setItems((xs) => [...xs, item].slice(-4));
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== item.id)), 4200);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function download(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

export const clockTime = (t: number) => new Date(t * 1000).toLocaleTimeString("en-GB", { hour12: false });

export function ago(now: number, t: number | undefined) {
  if (!t) return "never";
  const s = Math.max(0, now - t);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}
