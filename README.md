# log-test-app

Minimal Express/TypeScript app for proving out DigitalOcean App Platform log
forwarding to Beatrice, before wiring it into a real production service.

## 1. Push to GitHub

```bash
cd log-test-app
git init
git add .
git commit -m "log forwarding test app"
git branch -M main
git remote add origin https://github.com/your-github-username/log-test-app.git
git push -u origin main
```

## 2. Deploy to App Platform

Either:

**Console:** Apps → Create App → pick the GitHub repo → App Platform will
detect it as a Node app automatically (buildpack, not Dockerfile) → deploy.

**doctl:**

```bash
doctl apps create --spec app-spec.yaml
```

`app-spec.yaml` already includes a `log_destinations` block. Edit it first:
- `github.repo` → your actual repo
- `datadog.endpoint` → your Vector relay's public URL
- `datadog.api_key` → the shared secret you configured in Nginx/Vector

If you'd rather wire up log forwarding after the fact through the control
panel (Settings → Log Forwarding → Edit → Datadog), just deploy without that
block and add it there instead — same effect.

## 3. Confirm it's live

```bash
curl https://<your-app>.ondigitalocean.app/health
```

## 4. Generate test log lines

```bash
# A one-off log line with a custom message
curl "https://<your-app>.ondigitalocean.app/log?message=hello-beatrice"

# An error-level log line (stderr)
curl https://<your-app>.ondigitalocean.app/log-error
```

The app also emits a `[HEARTBEAT]` line every 30 seconds on its own, so you
have a steady stream even without hitting it manually — useful for
confirming forwarding is working continuously, not just on request.

## 5. Confirm receipt in Beatrice

Check whatever your Beatrice ingest endpoint does with received logs
(dashboard, database table, log file). If the relay is running with the
`debug_console` sink from the Vector setup, you can also just tail it live:

```bash
ssh your-vector-droplet
sudo journalctl -u vector -f
```

You should see `[MANUAL] hello-beatrice`, `[ERROR] simulated error`, and the
periodic `[HEARTBEAT]` lines flow through within seconds of App Platform
capturing them.

## Notes

- App Platform's own runtime logs (build output, health check pings) get
  forwarded too — that's normal and expected in production, but worth
  knowing so you're not surprised by extra volume.
- Once this round-trip works, the only thing that changes for a real
  production service is pointing the same `log_destinations` block at that
  service instead of this test app.
