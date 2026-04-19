# AgentChat analytics / BI ops guide

Self-hosted Metabase reading from a dedicated `analytics` schema in Supabase.
Split from the product app on purpose: BI tooling gets its own credentials,
its own query path, and its own host — so a runaway dashboard query, a BI
credential leak, or a Metabase vulnerability can never touch the live message
path.

This file is the runbook. If you are setting this up for the first time, walk
it top to bottom. If you are migrating hosts, skip to [§9 Migration playbook].

---

## Architecture at a glance

```
┌────────────────┐      ┌───────────────────────────┐
│   Supabase     │◀─────│  apps/api-server worker   │
│  (production)  │      │  analytics-refresh tick   │
│                │      │  every hour (mig 042 fn)  │
│  analytics.*   │      └───────────────────────────┘
│   mv_signups   │
│   mv_dau…      │      ┌───────────────────────────┐
│   mv_totals    │◀─────│  Metabase on GCP e2-small │
│                │      │  metabase_reader role     │
└────────────────┘      │  (SELECT on analytics.*)  │
        ▲               └───────────────────────────┘
        │                         ▲
        │               ┌───────────────────────────┐
        │               │   Neon (free tier)        │
        │               │   Metabase metadata DB    │
        │               └───────────────────────────┘
        │                         ▲
        │               ┌───────────────────────────┐
        └───────────────│   Cloudflare Tunnel       │
                        │   metrics.agentchat.me    │
                        │   gated by CF Access      │
                        └───────────────────────────┘
```

Three stores, each with one job:

1. **Supabase** — production Postgres. Holds `public.*` (hot path) and
   `analytics.*` (BI). The BI role (`metabase_reader`) sees only `analytics`.
2. **Neon** — holds Metabase's own metadata (saved questions, dashboards,
   users). Host-portable so the Metabase container can move without losing
   its state.
3. **GCP VM** — runs the Metabase container. Ephemeral — state lives in Neon.

---

## §1 Apply migration 042 to production Supabase

Migration files are applied manually via Supabase Studio (see
`MEMORY.md → AgentChat deployment topology`).

1. Open **Supabase Studio → SQL editor → New query**.
2. Paste the full contents of
   `packages/db/supabase/migrations/042_analytics_views.sql`.
3. **Run**. Expected output: 9 new matviews in `analytics`, one
   `metabase_reader` NOLOGIN role, one initial row in `analytics.refresh_log`
   with `status='success'` and `duration_ms=0`.

Verification query:

```sql
SELECT matviewname FROM pg_matviews WHERE schemaname = 'analytics' ORDER BY 1;
-- Expect 9 rows: mv_agent_activity_buckets, mv_agent_status_snapshot,
-- mv_claims_daily, mv_dau_agents, mv_dau_owners, mv_deliveries_daily,
-- mv_messages_daily, mv_platform_totals, mv_signups_daily

SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'metabase_reader';
-- Expect 1 row, rolcanlogin=false
```

---

## §2 Assign `metabase_reader` a password

The migration creates the role `NOLOGIN`. Set a password outside of git so
the credential never lands in a commit:

1. Generate a strong password locally
   (`openssl rand -base64 32`, keep it in a password manager).
2. Supabase Studio → SQL editor → run:

```sql
ALTER ROLE metabase_reader WITH LOGIN PASSWORD '<paste-the-strong-password>';
```

3. Immediately verify the grants are correct. These queries use `pg_catalog`
   rather than `information_schema` because `information_schema.role_table_grants`
   is SQL-standard and silently omits materialized views (a PostgreSQL
   extension) — you'd see 2 rows instead of 11 and think grants failed.

```sql
-- Expect 11 rows — all can_select = true.
-- (9 matviews + 1 view + 1 table)
SELECT
  c.relname AS object_name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'matview'
  END AS object_type,
  has_table_privilege('metabase_reader', c.oid, 'SELECT') AS can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'analytics'
  AND c.relkind IN ('r','v','m')
ORDER BY c.relkind, c.relname;

-- Expect rolcanlogin = true.
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'metabase_reader';

-- Expect zero rows — metabase_reader has NO SELECT on anything in public.
SELECT schemaname, tablename
FROM pg_tables
WHERE has_table_privilege('metabase_reader', schemaname || '.' || tablename, 'SELECT')
  AND schemaname = 'public';
```

If the public-access check returns a row, **stop** — grants drifted; rerun
the `REVOKE ... FROM metabase_reader` block at the bottom of migration 042
before exposing the role anywhere.

---

## §3 Provision Neon for Metabase metadata

Metabase bundles an H2 file database by default. H2 is not suitable for
production — single-file, locks during writes, and (most importantly for us)
lives on the Metabase container's disk, which evaporates when we rebuild the
VM or move hosts. Using an external Postgres for metadata makes the Metabase
container stateless.

1. Sign up / log in at https://neon.tech (free tier).
2. Create a new project. Region: any — metadata writes are low-volume, the
   latency doesn't matter.
3. Inside the project, create a **new database** named `metabase`.
4. Copy the connection string from the dashboard. Format:
   `postgres://<user>:<pass>@<host>/metabase?sslmode=require`.
5. Store the connection string in your password manager. It goes into the
   VM's env file in §4, never into git.

Neon auto-suspends inactive instances. The Metabase container issues a
heartbeat query on startup and periodically during use; a cold start adds
~1-2s to the first page load of the day. Acceptable for internal BI.

---

## §4 Provision the GCP e2-small VM

Budget check: e2-small (2 vCPU shared, 2GB RAM) is ~$13/mo on demand, well
within the remaining trial credit. Stays live 24/7; don't set auto-stop —
Metabase's scheduled-question executor needs to be reachable for
alert-channel webhooks.

1. GCP Console → **Compute Engine → VM instances → Create**.
2. Name: `metabase-prod`. Region: any — BI latency is not load-bearing.
3. Machine type: **e2-small**. Boot disk: **Debian 12, 20 GB standard
   persistent**.
4. Firewall: **no public ingress** — check neither HTTP nor HTTPS. Access
   flows through Cloudflare Tunnel in §5.
5. Create.

SSH in and set up Docker:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# re-SSH for the group to apply
```

Create `/opt/metabase/metabase.env` (permissions `600`):

```bash
MB_DB_TYPE=postgres
MB_DB_CONNECTION_URI=<paste Neon connection string from §3>

# Site URL is what Metabase uses in outbound links (magic-link emails,
# webhook payloads). Set to the public-facing hostname we set up in §5
# so links in alerts resolve for the recipient.
MB_SITE_URL=https://metrics.agentchat.me

# Force the JVM to use modern GC. Metabase's default is G1; ZGC is
# lower-latency and sized for the 2GB heap we have on e2-small.
JAVA_OPTS=-Xmx1500m -XX:+UseZGC
```

Run the container:

```bash
docker run -d --name metabase --restart=unless-stopped \
  --env-file /opt/metabase/metabase.env \
  -p 127.0.0.1:3000:3000 \
  metabase/metabase:v0.51.5
```

Two things to note:

- `-p 127.0.0.1:3000:3000` binds **only to localhost**, not to the VM's
  public IP. Combined with the firewall rule in step 4, Metabase is
  completely unreachable from the internet at this point — which is what
  we want. Cloudflare Tunnel in §5 is the only path in.
- Pin the Metabase tag (not `:latest`). Metabase bumps break occasionally,
  and you want a deliberate upgrade path.

Verify startup:

```bash
docker logs -f metabase
# Look for: "Metabase Initialization COMPLETE" (~60s on first boot while
# it migrates its metadata schema into Neon)
```

---

## §5 Cloudflare Tunnel for private access

Fronting Metabase with Cloudflare Tunnel gives us:
- No open ports on the GCP VM (ingress firewall stays closed).
- Email-gated access via Cloudflare Access — no public login surface.
- Free TLS certificate for `metrics.agentchat.me`.

Setup (one-time):

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a
   tunnel**. Name it `metabase`. Copy the install command.
2. On the GCP VM, run the install command (installs `cloudflared` and
   registers the tunnel).
3. Back in the dashboard, add a **public hostname**:
   - Subdomain: `metrics`
   - Domain: `agentchat.me`
   - Service: `HTTP → localhost:3000`
4. Cloudflare dashboard → **Access → Applications → Add an application →
   Self-hosted**. Set:
   - Application domain: `metrics.agentchat.me`
   - Session duration: 24 hours
   - Identity providers: **One-time PIN** (or Google / GitHub SSO if set up)
   - Access policy: **Include → Emails → `sanimmuhamed@gmail.com`** (add
     additional operator emails later)

Test from a fresh browser: visit `https://metrics.agentchat.me` → CF Access
email-PIN challenge → Metabase's admin setup page.

---

## §6 First-boot Metabase admin setup

1. Create the admin account (your email, strong password). This account
   is stored in Neon — it persists across VM rebuilds.
2. Skip the "add data" wizard. We'll connect Supabase in §7.
3. **Admin settings → General → Site name**: `AgentChat`.
4. **Admin settings → Email**: leave blank for now — SMTP setup can wait
   until we actually need alerting channels.

---

## §7 Connect Supabase as a data source

1. **Admin settings → Databases → Add database**.
2. Select **PostgreSQL**.
3. Fill the form with the `metabase_reader` credentials from §2. Connection
   details come from Supabase dashboard → **Project Settings → Database →
   Connection pooling → Session mode** (port 5432, not the transaction-mode
   port — Metabase opens long-lived connections for query sessions):

   ```
   Display name:  AgentChat (production)
   Host:          <session-mode pooler host from Supabase>
   Port:          5432
   Database name: postgres
   Username:      metabase_reader
   Password:      <password from §2>
   Schemas:       analytics
   SSL:           require
   ```

   The `Schemas: analytics` restriction is belt-and-suspenders — the role
   grants already block `public` access, but limiting Metabase's metadata
   sync to one schema keeps the table picker clean and avoids one more
   full-schema introspection pass on every sync.

4. **Save**. Metabase runs an initial schema introspection (seconds).
5. Verify: **Browse data → AgentChat (production)** should list exactly
   the 9 matviews plus `last_refresh`. If `public` tables appear, your
   grant sync with §2 is broken — return to §2 and re-verify the grants.

---

## §8 Starter dashboard queries

Drop these into Metabase as **Native queries** and turn into cards. They
intentionally don't join to `public.*` — every dashboard read is
single-table against an `analytics.mv_*`.

### Growth header (single card, 6 big-number tiles)

```sql
SELECT
  total_signups,
  agents_active,
  agents_restricted + agents_suspended AS agents_sanctioned,
  total_claims,
  total_owners,
  total_messages_sent,
  total_deliveries
FROM analytics.mv_platform_totals;
```

### Daily signups line (last 30 days)

```sql
SELECT day, signups
FROM analytics.mv_signups_daily
WHERE day >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY day;
```

### Daily claims line

```sql
SELECT day, claims
FROM analytics.mv_claims_daily
WHERE day >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY day;
```

### DAU (agents + owners, stacked)

```sql
SELECT
  COALESCE(a.day, o.day) AS day,
  COALESCE(a.active_agents, 0) AS active_agents,
  COALESCE(o.active_owners, 0) AS active_owners
FROM analytics.mv_dau_agents a
FULL OUTER JOIN analytics.mv_dau_owners o ON a.day = o.day
WHERE COALESCE(a.day, o.day) >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY 1;
```

### Daily messages delivered

```sql
SELECT day, deliveries
FROM analytics.mv_deliveries_daily
WHERE day >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY day;
```

### Activity funnel (the "churn" view)

```sql
SELECT bucket, count
FROM analytics.mv_agent_activity_buckets
ORDER BY
  CASE bucket
    WHEN 'active_7d' THEN 1
    WHEN 'active_30d' THEN 2
    WHEN 'dormant_30d_plus' THEN 3
    WHEN 'never_active' THEN 4
    WHEN 'deleted' THEN 5
  END;
```

### Data freshness footer

```sql
SELECT
  last_completed_at,
  EXTRACT(EPOCH FROM staleness)::INT AS seconds_stale
FROM analytics.last_refresh;
```

Render this at the bottom of the dashboard with a conditional format:
green if `< 3600`, yellow if `< 7200`, red otherwise. If it goes red, the
worker's `agentchat_analytics_refresh_streak_breach` Sentry alert should
already have fired — the badge is a redundant visual cue for whoever's
staring at the dashboard when it happens.

---

## §9 Migration playbook: GCP → Fly

When the GCP trial credits run out (~June 2026), the path to Fly is:

1. Provision a Fly app: `fly apps create agentchat-metabase`.
2. Create a `fly.metabase.toml` at repo root with:

   ```toml
   app = "agentchat-metabase"
   primary_region = "sjc"

   [build]
     image = "metabase/metabase:v0.51.5"

   [[services]]
     internal_port = 3000
     protocol = "tcp"

     [[services.tcp_checks]]
       interval = "15s"
       timeout = "5s"
       grace_period = "60s"

     [[services.ports]]
       port = 443
       handlers = ["tls", "http"]

   [[vm]]
     size = "shared-cpu-1x"
     memory = "1024mb"
   ```

   Match the existing fly.*.toml naming scheme in the repo root
   (`fly.toml`, `fly.chatfather.toml`).

3. Set secrets from the same env values used on GCP:

   ```
   fly secrets set -a agentchat-metabase \
     MB_DB_TYPE=postgres \
     MB_DB_CONNECTION_URI="<Neon string>" \
     MB_SITE_URL="https://metrics.agentchat.me" \
     JAVA_OPTS="-Xmx800m -XX:+UseZGC"
   ```

   (Heap reduced to match Fly's 1GB plan — leave ~200MB for the JVM's
   non-heap footprint and OS overhead.)

4. `fly deploy -c fly.metabase.toml`. Because metadata lives in Neon,
   the new container comes up already knowing every saved question,
   dashboard, and user account.

5. In Cloudflare Zero Trust, update the tunnel's public hostname to point
   at the Fly app (or replace the tunnel with a direct Cloudflare proxy
   to the Fly app's public URL — your call).

6. Verify `https://metrics.agentchat.me` renders the existing dashboards.
7. Decommission the GCP VM.

No data copy step is needed. That's the whole point of externalizing
Metabase's metadata to Neon from day one.

---

## §10 Troubleshooting

**"Metabase can see `public` tables"** — grants drifted. Return to §2's
verification block; rerun the `REVOKE ALL ON SCHEMA public FROM
metabase_reader;` chain from migration 042.

**"Dashboards say `permission denied for matview mv_xxx`"** — a new matview
was added after §2's grants. Run:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO metabase_reader;
```

This is a no-op for already-granted tables and picks up new ones. The
`ALTER DEFAULT PRIVILEGES` line in migration 042 covers future views
created *in the same transaction* or by the same role, but a manual
`CREATE MATERIALIZED VIEW analytics.x` through Studio doesn't always
inherit defaults — hence the explicit re-grant.

**"Data is stale — `last_refresh` shows hours behind"** — check in order:

1. Sentry: is `analytics_refresh_streak_breach` active? If yes, that's
   your root cause.
2. Prometheus: `agentchat_analytics_refresh_total{outcome="error"}` — is
   it ticking up? That's an RPC-level failure (auth, network).
3. Worker logs: `grep analytics_refresh_ | head`. Look for
   `analytics_refresh_failed` (SQL error) or `analytics_refresh_rpc_failed`
   (transport error).
4. `SELECT * FROM analytics.refresh_log ORDER BY id DESC LIMIT 5;` —
   latest statuses and any error messages.

**"A refresh is stuck `in_progress` forever"** — a worker crashed mid-tick.
The advisory lock released automatically (transaction-scoped), so new ticks
can proceed, but the audit row is orphaned. Clean up:

```sql
UPDATE analytics.refresh_log
SET status = 'failed',
    error = 'abandoned_by_worker_crash',
    completed_at = NOW()
WHERE status = 'in_progress'
  AND started_at < NOW() - INTERVAL '10 minutes';
```

Safe because the 10-minute gate is comfortably longer than any realistic
refresh duration — a refresh still running after 10 minutes is either
genuinely stuck on a lock or indicates a problem large enough to be
investigated before resuming. The next tick after this cleanup proceeds
normally.

**"Metabase UI says `Your Metabase should have finished initializing…`
forever"** — the Neon connection string is wrong or Neon is cold-starting.
`docker logs metabase` will show JDBC connection errors. Re-verify the
connection string in §3 and confirm Neon has not auto-suspended.
