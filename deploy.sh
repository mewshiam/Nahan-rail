#!/usr/bin/env bash
# =============================================================================
# Nahan on Railway — one-command deploy
# -----------------------------------------------------------------------------
# Provisions EVERYTHING on Railway from this repository:
#
#   1. the Railway CLI (installed globally via npm if missing)
#   2. authentication   (`railway login`, skipped when RAILWAY_TOKEN is set)
#   3. a project        (created & linked, or linked to an existing one)
#   4. the service      via Infrastructure as Code (.railway/railway.ts):
#                         • service "nahan"   — built from the Dockerfile
#                         • volume "nahan-data" — 512 MB mounted at /data
#                         • env vars          — NODE_ENV, DATA_DIR
#                         • healthcheck       — GET /_health
#                         • PORT              — injected by Railway, the app
#                                               binds 0.0.0.0:$PORT by itself
#   5. a public domain  (free https://<name>.up.railway.app, or a custom one)
#   6. the deployment   (from the GitHub source, or `railway up` with --up)
#
# Usage:
#   bash deploy.sh                     # full interactive setup
#   bash deploy.sh --up                # deploy local code via `railway up`
#                                      # (use when Railway's GitHub App has no
#                                      #  access to this private repo yet)
#   bash deploy.sh --project myproj    # link an existing project by name
#   bash deploy.sh --domain nahan.example.com   # custom domain instead of the
#                                      # generated *.up.railway.app one
#   RAILWAY_TOKEN=… bash deploy.sh --project <id>   # CI (project token)
#
# The script is idempotent — re-running it only fixes what is missing.
# =============================================================================
set -euo pipefail

SERVICE_NAME="nahan"          # must match `service("nahan", …)` in .railway/railway.ts
PROJECT_NAME="${PROJECT_NAME:-nahan}"

UP_MODE=0
CUSTOM_PROJECT=""
CUSTOM_DOMAIN=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --up)       UP_MODE=1; shift ;;
        --project)  CUSTOM_PROJECT="${2:?--project needs a name}"; shift 2 ;;
        --domain)   CUSTOM_DOMAIN="${2:?--domain needs a domain}"; shift 2 ;;
        -h|--help)  sed -n '2,30p' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)" >&2; exit 64 ;;
    esac
done

c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_off=$'\033[0m'
step()  { printf '\n%s▸ %s%s\n' "$c_bold" "$*" "$c_off"; }
info()  { printf '  %s\n' "$*"; }
warn()  { printf '%s  ⚠ %s%s\n' "$c_yellow" "$*" "$c_off"; }
die()   { printf '%s  ✖ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# ── 0. Sanity checks ────────────────────────────────────────────────────────
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "Node.js 20+ is required (https://nodejs.org)"
[[ -f .railway/railway.ts ]] || die "run this from the repository root (.railway/railway.ts not found)"

# ── 1. Railway CLI ──────────────────────────────────────────────────────────
step "Railway CLI"
if command -v railway >/dev/null 2>&1; then
    info "found: $(railway --version 2>/dev/null || echo railway)"
else
    info "installing @railway/cli globally (npm)…"
    npm install -g @railway/cli || die "could not install the Railway CLI — see https://docs.railway.com/cli"
fi

# The `railway` npm SDK (dev dependency) is what evaluates .railway/railway.ts.
if [[ ! -d node_modules/railway ]]; then
    step "Installing dependencies (incl. the railway IaC SDK)"
    npm ci --include=dev || npm install
fi

# ── 2. Authentication ───────────────────────────────────────────────────────
step "Authentication"
if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    info "RAILWAY_TOKEN is set — using it (project/environment scoped)"
elif railway whoami >/dev/null 2>&1; then
    info "already signed in as $(railway whoami 2>/dev/null || '?')"
else
    info "signing in (a browser window / device code will open)…"
    railway login || die "railway login failed"
fi

# ── 3. Project ──────────────────────────────────────────────────────────────
step "Project"
if [[ -n "$CUSTOM_PROJECT" ]]; then
    railway link --project "$CUSTOM_PROJECT" || die "could not link project '$CUSTOM_PROJECT'"
elif [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    info "using the project the RAILWAY_TOKEN is scoped to"
elif railway status >/dev/null 2>&1; then
    info "linked to an existing project — keeping it"
else
    info "creating a new project '$PROJECT_NAME'…"
    railway init --name "$PROJECT_NAME" || die "could not create the project"
fi

# ── 4. Service + volume + env + healthcheck (Infrastructure as Code) ────────
step "Applying .railway/railway.ts (service, volume, env, healthcheck)"
railway config apply --yes || die "config apply failed — run 'railway config plan' to inspect"

# ── 5. Public domain ────────────────────────────────────────────────────────
step "Public domain"
if [[ -n "$CUSTOM_DOMAIN" ]]; then
    railway domain "$CUSTOM_DOMAIN" || warn "custom domain command failed (already added?) — configure DNS as printed above"
else
    railway domain --service "$SERVICE_NAME" || warn "domain generation returned non-zero (one probably exists already)"
fi
railway domain list --service "$SERVICE_NAME" 2>/dev/null || true

# ── 6. Deployment ───────────────────────────────────────────────────────────
step "Deployment"
if [[ "$UP_MODE" -eq 1 ]]; then
    info "deploying the local directory with railway up…"
    railway up --service "$SERVICE_NAME"
else
    railway service status --service "$SERVICE_NAME" 2>/dev/null || true
    cat <<EOF

  The service deploys automatically from GitHub (see 'source' in
  .railway/railway.ts). If the build is NOT running:
    • this repo is private → grant Railway's GitHub App access once:
      Railway → Account Settings → Integrations → GitHub → Edit Scope
    • or push this directory instead:   bash deploy.sh --up
  Watch the logs with:                   railway logs --service $SERVICE_NAME
EOF
fi

# ── 7. Summary ──────────────────────────────────────────────────────────────
step "Done 🚂"
cat <<EOF

  What was provisioned
  ─────────────────────
  • service   $SERVICE_NAME (Dockerfile build, healthcheck /_health)
  • volume    nahan-data → /data  (SQLite persists across redeploys)
  • port      \$PORT injected by Railway — bound automatically
  • domain    see 'railway domain list --service $SERVICE_NAME'
  • next deploys: git push (or re-run this script — it is idempotent)

  First run
  ─────────
  1. open  https://<your-app>.up.railway.app/sync/dash
  2. log in with the default master key: admin
  3. immediately change the master key + API route in System → Update Config
EOF
