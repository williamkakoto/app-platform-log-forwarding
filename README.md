# log-test-app

A minimal Express/TypeScript app, plus a full guide to the Vector relay it
proves out: a way to forward DigitalOcean App Platform logs to **Beatrice**
(an internal logging platform) even though App Platform's native log
forwarding doesn't support arbitrary HTTPS endpoints — only a fixed list of
providers (OpenSearch, Datadog, Better Stack).

This document assumes no prior context. If you're rebuilding this from
scratch on a new droplet, or re-pointing an existing setup at a different
app, everything you need is below.

## What is Vector, and why is it here?

[Vector](https://vector.dev) is an open-source tool for moving observability
data (logs, metrics, traces) from one place to another, reshaping it along
the way. You describe a pipeline in a YAML config file as three kinds of
components:

- a **source** — where data comes in from (a port Vector listens on, a file
  it tails, a message queue it subscribes to, etc.)
- a **transform** — code that reshapes, filters, or enriches each event as
  it passes through (Vector's own small scripting language for this is
  called VRL — Vector Remap Language)
- a **sink** — where the (possibly reshaped) data goes out to (another
  HTTP endpoint, a database, a file, etc.)

Vector runs as a single long-lived process (we run it as a systemd service)
that wires these together and keeps moving data through the pipeline for as
long as it's up.

**Why we need it here:** App Platform's log forwarding will only *speak* to
a handful of named providers — it doesn't have a "send to any URL" option.
But one of those providers, Datadog, accepts a configurable `endpoint` URL
and an `api_key`. So the trick is: configure App Platform to forward to
"Datadog," but actually point its `endpoint` at our own server. Vector then
sits there pretending to be a Datadog intake endpoint, accepts the payload,
reshapes it into whatever Beatrice's real API expects, and forwards it on.
App Platform never knows Datadog isn't on the other end.

## Architecture overview

```
App Platform  --(Datadog-shaped HTTP POST, over HTTPS)-->
  Nginx (TLS termination + shared-secret check)
  --> Vector `http_server` source (parses the JSON array)
  --> Vector `remap` transform (reshapes to Beatrice's schema)
  --> Vector `http` sink --> Beatrice's POST /api/v1/logs/create
```

Everything from Nginx onward lives on the **Beatrice droplet** — a single
Linux server also running Beatrice's own frontend and backend. This is
shared infrastructure: one droplet, one Nginx, one Vector process, capable
of receiving logs from multiple App Platform apps at once (more on that in
the re-pointing section below).

## Building this from scratch: step by step

These steps assume you already have a droplet reachable at some domain —
for example `beatrice.btfa.xyz` — with Nginx and a TLS certificate already
set up for a site on that droplet, since Vector will slot into the same
Nginx config as a new route rather than its own server block.

### Step 1: Decide on a shared secret

This secret is what authenticates App Platform to your droplet — there's no
other mechanism (dedicated egress IPs don't apply to log forwarding, so you
can't allowlist by IP). Generate one:

```bash
openssl rand -hex 32
```

Save the output. You'll paste it into three places over the next steps:
Nginx's config, Vector's config, and later, App Platform's own settings.

### Step 2: Install Vector

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://sh.vector.dev | bash
source ~/.profile
vector --version
```

This installs the binary under `~/.vector/bin`. Copy it somewhere on your
`PATH` so systemd (run as root, with its own environment) can find it
later:

```bash
cp ~/.vector/bin/vector /usr/local/bin/vector
chmod +x /usr/local/bin/vector
```

### Step 3: Create the Vector config directory

```bash
mkdir -p /etc/vector
```

### Step 4: Write the Vector config

Create `/etc/vector/vector.yaml`:

```yaml
sources:
  do_apps:
    type: http_server
    address: 127.0.0.1:8282
    path: /api/v2/logs
    decoding:
      codec: json

transforms:
  to_beatrice_shape:
    type: remap
    inputs: [do_apps]
    source: |
      severity = "info"
      if exists(.status) {
        s = downcase(to_string!(.status))
        if includes(["info", "error", "warning", "debug"], s) {
          severity = s
        } else if s == "warn" {
          severity = "warning"
        }
      }

      payload = {
        "message": .message,
        "service": .service,
        "hostname": .hostname,
        "source": .ddsource,
        "raw": .
      }

      . = {
        "tags": [severity],
        "data": encode_json(payload),
        "logFormat": "json"
      }

sinks:
  beatrice:
    type: http
    inputs: [to_beatrice_shape]
    uri: http://127.0.0.1:3000/api/v1/logs/create
    method: post
    request:
      headers:
        x-auth-key: "YOUR_BEATRICE_PROJECT_AUTH_KEY"
        content-type: "application/json"
    encoding:
      codec: json
    framing:
      method: newline_delimited
    batch:
      max_events: 1
      timeout_secs: 1
    buffer:
      type: disk
      max_size: 536870912
      when_full: block
```

What each part is doing, and why it looks the way it does:

- **`sources.do_apps` (`http_server`, not `datadog_agent`).** Vector ships a
  source built specifically for Datadog's protocol (`datadog_agent`), which
  seems like the obvious choice since App Platform is pretending to talk to
  Datadog. But that source enforces Datadog's exact schema and rejects any
  field it doesn't recognize — and real App Platform payloads include an
  extra `date` field that schema doesn't allow. The plain `http_server`
  source just parses whatever JSON array shows up, with no schema
  enforcement, which is what we actually want here.

- **`transforms.to_beatrice_shape` (`remap`, written in VRL).** Beatrice's
  ingest API expects exactly three fields: `tags` (an array containing one
  of `info`/`error`/`warning`/`debug`), `data` (a JSON-encoded *string*, not
  a nested object — Beatrice's validator rejects a raw object here), and
  `logFormat` (just the literal string `"json"`). The transform derives a
  severity from whatever status field App Platform sent, packs everything
  else into a `payload` object, and crucially uses `. = { ... }` (replacing
  the whole event) rather than `.tags = ...` (which would only *add*
  fields) — VRL field assignment never removes existing fields, so without
  this the original event's fields would still be present alongside the
  new ones, and Beatrice's validator rejects unrecognized extra fields.

- **`sinks.beatrice` (`http`).** Sends each reshaped event on to Beatrice's
  real endpoint. Three details matter here:
  - `x-auth-key` is the project-specific key from Beatrice's UI (Auth Key
    button on the project page) — not the same secret as App Platform's
    `DD-API-KEY`. These are two separate secrets for two separate hops.
  - `framing: newline_delimited` with `batch.max_events: 1` makes each
    request body a single bare JSON object. Without this, Vector's `http`
    sink wraps every batch — even a batch of one — in a JSON array (`[{...}]`),
    which Beatrice's endpoint doesn't accept.
  - Setting `newline_delimited` framing also changes Vector's default
    `Content-Type` header to `application/x-ndjson`, which silently causes
    Beatrice's JSON body-parser to skip parsing entirely (not an error — an
    empty body). The explicit `content-type: "application/json"` override
    fixes this.
  - The disk-backed `buffer` means a brief Beatrice outage doesn't drop
    logs — Vector queues to disk and retries delivery.

### Step 5: Lock down the config file

The auth key sits in plaintext in this file, so restrict who can read it:

```bash
chmod 600 /etc/vector/vector.yaml
chown root:root /etc/vector/vector.yaml
```

### Step 6: Add the Nginx route

In the same Nginx server block that already handles TLS for your domain
(alongside whatever other routes it proxies), add:

```nginx
location /api/v2/logs {
    if ($http_dd_api_key != "YOUR_SHARED_SECRET_FROM_STEP_1") {
        return 401;
    }
    client_max_body_size 10m;
    proxy_pass http://127.0.0.1:8282;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Test and reload:

```bash
nginx -t
systemctl reload nginx
```

### Step 7: Create a systemd service for Vector

```bash
cat > /etc/systemd/system/vector.service << 'EOF'
[Unit]
Description=Vector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vector --config /etc/vector/vector.yaml
Restart=on-failure
RestartSec=5
User=root
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vector
systemctl start vector
systemctl status vector
```

Confirm it shows `active (running)` with no errors.

### Step 8: Deploy a test app with log forwarding configured

Push this repo's app to GitHub, then either through the console or
`doctl apps create --spec app-spec.yaml`, deploy it with a `log_destinations`
block:

```yaml
log_destinations:
  - name: beatrice
    datadog:
      endpoint: https://your-domain.example.com/api/v2/logs
      api_key: YOUR_SHARED_SECRET_FROM_STEP_1
```

If you'd rather configure this after the app is already deployed — or edit
an existing destination's endpoint or key later — do it from the console
instead:

1. Open the app in the [DigitalOcean Apps
   console](https://cloud.digitalocean.com/apps) and go to its **Settings**
   tab.
2. Find the **Log Forwarding** section and click **Edit**.
3. If no destination exists yet, choose **Datadog** under "Third-party
   providers." If one already exists (e.g. named `beatrice`), click it to
   edit its fields directly — same form either way.
4. Fill in or update:
   - **Destination name** — a label of your choosing (e.g. `beatrice`).
   - **Endpoint** — `https://your-domain.example.com/api/v2/logs` (Beatrice's
     relay URL from Step 6, not a real Datadog URL).
   - **API Key** — the shared secret from Step 1 (not a real Datadog key —
     this is what Nginx checks against in its `location` block).
5. Under the destination, confirm which **compute components** are
   selected to forward from — by default this may be none, so explicitly
   check the component(s) you want logs from (for this test app, there's
   only one component to pick).
6. Click **Save**. This takes effect immediately — no redeploy needed,
   since log forwarding is a platform-level setting, not something baked
   into the build.

Editing an existing destination this way (steps 3–6) is also how you
rotate the shared secret later: update the **API Key** field here, update
the matching value in Nginx's `location` block, save, reload Nginx — no
app redeploy required on either side.

### Step 9: Generate test traffic and confirm it arrives

```bash
curl https://<your-app>.ondigitalocean.app/health
curl "https://<your-app>.ondigitalocean.app/log?message=hello-beatrice"
curl https://<your-app>.ondigitalocean.app/log-error
```

The app also emits a `[HEARTBEAT]` line every 30 seconds on its own, so
there's a steady stream even without manually hitting it.

Watch the relay process it live:

```bash
journalctl -u vector -f
```

Then check Beatrice's UI for the new entries. If something doesn't show up,
`journalctl -u vector -f` while sending a request is the single most useful
diagnostic step — it shows you exactly what Vector sent and what Beatrice's
response was, rather than guessing from the outside.

## Re-pointing this at a different App Platform app

Everything in Steps 1–7 above lives on the Beatrice droplet, not in any App
Platform app's own repo — it's shared infrastructure that can serve
multiple apps. What you do next depends on whether you want those apps'
logs kept separate inside Beatrice.

### Simplest option: point another app at the same relay, same Beatrice project

If you don't need to distinguish which app a log came from, just repeat
Step 8 for the new app — same endpoint, same shared secret, no changes to
the droplet at all:

```yaml
log_destinations:
  - name: beatrice
    datadog:
      endpoint: https://your-domain.example.com/api/v2/logs
      api_key: YOUR_SHARED_SECRET_FROM_STEP_1
```

Nginx and Vector don't currently distinguish which app a request came from
— every request that passes the shared-secret check gets relayed to the
same Beatrice project. Fine for quick testing; not ideal if you want to
tell two apps' logs apart later.

### To keep each app's logs in its own Beatrice project

This needs changes on the relay side, since the current Nginx check and
Vector config are both single-project. Two ways to do it, in order of how
much restructuring they need:

**Option A — a new Vector process per app (simplest to reason about):**

1. In Beatrice's UI, create a new project for the new app and copy its
   `Auth Key`.
2. Copy `/etc/vector/vector.yaml` to a new file, e.g.
   `/etc/vector/vector-appname.yaml`, and change two things in the copy:
   the `source.address` port (e.g. `127.0.0.1:8283` instead of `8282`, so it
   doesn't collide with the first instance), and the sink's `x-auth-key` to
   the new project's key.
3. Add a second Nginx `location` block with its own path and its own shared
   secret check, proxying to the new port:
   ```nginx
   location /api/v2/logs-appname {
       if ($http_dd_api_key != "A_DIFFERENT_SHARED_SECRET") {
           return 401;
       }
       client_max_body_size 10m;
       proxy_pass http://127.0.0.1:8283;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
   }
   ```
4. Create a second systemd unit (copy `/etc/systemd/system/vector.service`
   to `vector-appname.service`, change its `ExecStart` to point at the new
   config file), then `systemctl daemon-reload && systemctl enable --now
   vector-appname`.
5. Point the new app's `log_destinations` at
   `https://your-domain.example.com/api/v2/logs-appname` with the new
   shared secret.

Trade-off: simple to understand and isolate, but every additional app means
another Vector process, another systemd unit, another Nginx block — more
moving pieces as the number of apps grows.

**Option B — one Vector process, multiple routes (more scalable):**

Keep a single Vector instance, but have Nginx inject something that
identifies which app a request came from (for example, a custom header set
per `location` block), and have the `remap` transform branch on that header
to pick the right `x-auth-key` before the event reaches the sink, or route
to different sinks entirely based on it. This avoids duplicating the whole
Vector process per app, at the cost of a more complex single config file to
maintain. Worth doing once you have more than a handful of apps forwarding
through this relay; not worth the complexity for just one or two.

### What never changes, regardless of which option you pick

The TLS certificate, the droplet itself, and Beatrice's `/api/v1/logs/create`
schema (`tags` / `data` / `logFormat`) stay exactly the same no matter how
many App Platform apps end up forwarding through this relay — only the
per-app secret and (optionally) the per-app route change.