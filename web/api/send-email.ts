// Optional Vercel serverless function: delivers HPC Autopilot notifications through Resend.
// Disabled unless RESEND_API_KEY and ALLOWED_EMAIL_DOMAINS are set. Only same-site requests to
// allow-listed domains are accepted, and sends are rate limited, so the endpoint is not an open relay.

type Req = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void };

// Plain addresses only: no display names, commas, quotes or angle brackets.
const EMAIL = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;
const SUBJECT = /^\[HPC(?: alert)?\] [^\r\n]{1,180}$/;

const header = (req: Req, name: string) => {
  const v = req.headers?.[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

function sameOrigin(req: Req): boolean {
  const site = header(req, "sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const host = header(req, "x-forwarded-host") || header(req, "host");
  try {
    return Boolean(host) && new URL(header(req, "origin")).host === host;
  } catch {
    return false;
  }
}

// Best-effort limiter per warm function instance. For hard limits use Vercel Firewall rate-limit rules.
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}

export default async function handler(req: Req, res: Res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const key = process.env.RESEND_API_KEY;
    const allowed = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (!key || !allowed.length) return res.status(503).json({ error: "Email delivery is not configured on this deployment." });
    if (!sameOrigin(req)) return res.status(403).json({ error: "Requests must come from this site." });
    const ip = header(req, "x-forwarded-for").split(",")[0].trim() || "local";
    if (limited(`mail:${ip}`, 20, 60_000) || limited("mail:all", 300, 3_600_000)) return res.status(429).json({ error: "Too many emails; try again later." });

    let body: { to?: unknown; subject?: unknown; text?: unknown } = {};
    try {
      body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as typeof body;
    } catch {
      return res.status(400).json({ error: "Invalid JSON." });
    }
    const to = String(body.to ?? "").trim();
    const subject = String(body.subject ?? "");
    const text = String(body.text ?? "").slice(0, 4000);
    const domain = EMAIL.exec(to)?.[1]?.toLowerCase();
    if (!domain || !text) return res.status(400).json({ error: "A plain recipient address and a message body are required." });
    if (!SUBJECT.test(subject)) return res.status(400).json({ error: "Only HPC Autopilot notifications are sent." });
    if (!allowed.some((d) => domain === d || domain.endsWith(`.${d}`))) return res.status(403).json({ error: `Recipient domain ${domain} is not allowed.` });

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        from: process.env.MAIL_FROM ?? "HPC Autopilot <onboarding@resend.dev>",
        to: [to],
        subject,
        text: `${text}\n\n--\nSent by HPC Autopilot. If you did not expect this message, ignore it.`,
      }),
    });
    if (!r.ok) return res.status(502).json({ error: `Mail provider returned ${r.status}` });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: `Email unavailable: ${(err as Error).name}` });
  }
}
