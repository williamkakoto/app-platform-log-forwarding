/**
 * Minimal log-forwarding test app.
 *
 * Deploy this to App Platform, configure log forwarding on it (Datadog
 * destination pointed at your Vector relay in front of Beatrice), and use
 * the routes below to generate log lines on demand — then watch them land
 * in Beatrice.
 *
 * App Platform captures whatever your process writes to stdout/stderr, so
 * every console.log / console.error call here is a "log line" as far as
 * log forwarding is concerned. No special logging library is needed for
 * this test.
 */

import express, { Request, Response } from "express";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

app.use(express.json());

// Basic request logging so every hit produces a log line automatically.
app.use((req: Request, _res: Response, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

app.get("/", (_req: Request, res: Response) => {
  console.log("[INFO] root route hit");
  res.send("log-test-app is running");
});

// App Platform's health check should hit this — keep it quiet-ish so it
// doesn't flood your log volume, but still visible so you can confirm
// health checks are themselves being forwarded.
app.get("/health", (_req: Request, res: Response) => {
  console.log("[HEALTH] ok");
  res.status(200).send("ok");
});

// Hit this manually (curl, browser) to fire a single log line on demand,
// useful for confirming a specific event reaches Beatrice within seconds.
app.get("/log", (req: Request, res: Response) => {
  const message = typeof req.query.message === "string" ? req.query.message : "manual test log";
  console.log(`[MANUAL] ${message} — sent at ${new Date().toISOString()}`);
  res.json({ logged: message });
});

// Hit this to fire a log at error level (stderr), so you can confirm your
// pipeline forwards both stdout and stderr, and that severity is preserved
// if Beatrice cares about log level.
app.get("/log-error", (_req: Request, res: Response) => {
  console.error(`[ERROR] simulated error at ${new Date().toISOString()}`);
  res.status(500).json({ logged: "simulated error" });
});

app.listen(PORT, () => {
  console.log(`[STARTUP] log-test-app listening on port ${PORT}`);
});

// Emit a heartbeat log every 30 seconds so you have a steady stream to
// confirm forwarding without needing to hit the app manually.
setInterval(() => {
  console.log(`[HEARTBEAT] still alive at ${new Date().toISOString()}`);
}, 30_000);
