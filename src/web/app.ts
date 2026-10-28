import express, { type NextFunction, type Request, type Response } from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { one } from "../db/pool.js";
import { html, layout } from "./html.js";
import { reviewRoutes } from "./routes/review.js";
import { leadRoutes } from "./routes/leads.js";
import { reportRoutes } from "./routes/reports.js";
import { adminRoutes } from "./routes/admin.js";
import { publicRoutes } from "./routes/public.js";

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: "admin" | "outreach";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export function flash(req: Request, kind: "info" | "error", text: string): void {
  if (req.session) req.session.flash = { kind, text };
}

export function takeFlash(req: Request): { kind: string; text: string } | null {
  const f = req.session?.flash ?? null;
  if (req.session) req.session.flash = null;
  return f;
}

export function page(req: Request, res: Response, title: string, active: string, body: ReturnType<typeof html>, status = 200): void {
  res.status(status).type("html").send(layout({ title, user: req.user, active, flash: takeFlash(req), body }));
}

function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).send("Admins only");
  next();
}

// Session cookies are SameSite=Lax; also refuse cross-site form posts.
function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  const origin = req.get("origin");
  if (origin && origin !== config.appBaseUrl && new URL(origin).host !== req.get("host")) {
    return res.status(403).send("Cross-site request refused");
  }
  next();
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Public endpoints (opt-out and the check-up form webhook) come first and
  // need no login.
  app.use(publicRoutes());

  app.use(express.urlencoded({ extended: false, limit: "200kb" }));
  app.use(
    cookieSession({
      name: "leadz",
      keys: [config.sessionSecret],
      maxAge: 14 * 86_400_000,
      sameSite: "lax",
      httpOnly: true,
      secure: config.cookieSecure,
    }),
  );
  app.use(async (req, _res, next) => {
    const id = req.session?.userId;
    if (id) req.user = await one<SessionUser>("SELECT id, email, name, role FROM users WHERE id = $1", [id]);
    next();
  });
  app.use(sameOrigin);

  app.get("/login", (req, res) => {
    page(req, res, "Sign in", "", html`<div class="card" style="max-width:380px;margin:60px auto">
      <h1>Sign in</h1>
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${String(req.query.next ?? "/queue")}">
        <label>Email</label><input type="email" name="email" required autofocus>
        <label>Password</label><input type="password" name="password" required>
        <p><button class="primary">Sign in</button></p>
      </form></div>`);
  });

  app.post("/login", async (req, res) => {
    const user = await one<{ id: number; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE email = lower($1)",
      [String(req.body.email ?? "")],
    );
    if (!user || !(await bcrypt.compare(String(req.body.password ?? ""), user.password_hash))) {
      flash(req, "error", "Email or password is wrong");
      return res.redirect("/login");
    }
    req.session!.userId = user.id;
    const next = String(req.body.next ?? "/queue");
    res.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/queue");
  });

  app.post("/logout", (req, res) => {
    req.session = null;
    res.redirect("/login");
  });

  app.use(requireLogin);
  app.get("/", (_req, res) => res.redirect("/queue"));
  app.use(reviewRoutes());
  app.use(leadRoutes());
  app.use(reportRoutes());
  app.use("/admin", requireAdmin, adminRoutes());

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).type("html").send(layout({ title: "Error", user: req.user, body: html`<div class="card"><h1>Something went wrong</h1><p class="err">${err.message}</p></div>` }));
  });
  return app;
}
