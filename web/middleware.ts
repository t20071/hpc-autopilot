// Vercel Routing Middleware: optional sign-in for the whole deployment (pages and /api/*).
// Set DASHBOARD_PASSWORD (and optionally DASHBOARD_USER, default "admin") in Vercel to turn it on.
// Without it the site stays public. For production, put the app behind your institute's SSO instead.

export const config = { matcher: "/:path*" };

const CONTINUE = () => new Response(null, { headers: { "x-middleware-next": "1" } });

/** Compare without leaking how many leading characters matched. */
function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export default function middleware(request: Request): Response {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return CONTINUE();
  const user = process.env.DASHBOARD_USER || "admin";
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    try {
      const [u, ...rest] = atob(auth.slice(6)).split(":");
      if (same(u, user) && same(rest.join(":"), password)) return CONTINUE();
    } catch {
      /* malformed header: ask again */
    }
  }
  return new Response("Sign in to HPC Autopilot.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="HPC Autopilot", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}
