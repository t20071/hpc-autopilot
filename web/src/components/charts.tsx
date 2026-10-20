// Dependency-free SVG charts.
import { useId } from "react";

export function Sparkline({ data, color = "var(--primary)", max }: { data: number[]; color?: string; max?: number }) {
  const id = useId();
  const w = 200;
  const h = 30;
  const hi = max ?? Math.max(1, ...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 2 - (v / hi) * (h - 4)]);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: h }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface Series {
  name: string;
  color: string;
  values: number[];
}

export function LineChart({ series, labels, max, height = 200, unit = "", label }: { series: Series[]; labels: string[]; max?: number; height?: number; unit?: string; label: string }) {
  const id = useId();
  const w = 600;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const n = Math.max(2, labels.length);
  const hi = max ?? Math.max(1, ...series.flatMap((s) => s.values)) * 1.15;
  const x = (i: number) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / hi) * (height - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * hi);
  const every = Math.max(1, Math.floor(n / 5));
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label} preserveAspectRatio="none" style={{ height }}>
        <defs>
          {series.map((s, k) => (
            <linearGradient key={k} id={`${id}-${k}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.22" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end">
              {Math.round(t)}
              {unit}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % every === 0 ? (
            <text key={i} x={x(i)} y={height - 6} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s, k) => {
          if (s.values.length < 2) return null;
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          return (
            <g key={s.name}>
              <polygon points={`${x(0)},${y(0)} ${pts} ${x(s.values.length - 1)},${y(0)}`} fill={`url(#${id}-${k})`} />
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      <figcaption className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function Donut({ parts, label, center }: { parts: { name: string; value: number; color: string }[]; label: string; center: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="row" style={{ gap: 18, flexWrap: "nowrap" }}>
      <svg viewBox="0 0 110 110" width="120" height="120" role="img" aria-label={label} style={{ flex: "none" }}>
        <circle cx="55" cy="55" r={r} fill="none" stroke="var(--line)" strokeWidth="13" />
        {total > 0 &&
          parts.map((p) => {
            const len = (p.value / total) * c;
            const el = (
              <circle key={p.name} cx="55" cy="55" r={r} fill="none" stroke={p.color} strokeWidth="13" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 55 55)" />
            );
            offset += len;
            return el;
          })}
        <text x="55" y="53" textAnchor="middle" style={{ fill: "var(--text)", font: "600 18px var(--mono)" }}>
          {center}
        </text>
        <text x="55" y="69" textAnchor="middle" style={{ fill: "var(--muted)", font: "10px var(--sans)" }}>
          jobs
        </text>
      </svg>
      <div className="stack" style={{ gap: 6 }}>
        {parts.map((p) => (
          <div key={p.name} className="legend" style={{ justifyContent: "space-between", minWidth: 150 }}>
            <span>
              <i style={{ background: p.color }} />
              {p.name}
            </span>
            <b className="mono" style={{ color: "var(--text)" }}>
              {p.value}
            </b>
          </div>
        ))}
      </div>
    </div>
  );
}
