#!/usr/bin/env bash
# One-time bootstrap for the deployment server.
#
# Usage (run as the deploy user with sudo for docker install if needed):
#   curl -fsSL <raw-url>/server-setup.sh | bash -s -- <git-repo-url> [target-dir]
# Or copy this file to the server and run:
#   bash server-setup.sh <git-repo-url> [target-dir]
#
# After this finishes, edit SecureConnect/.env.production with real values
# and re-run:  docker compose up -d --build

set -euo pipefail

REPO_URL="${1:-}"
TARGET_DIR="${2:-DatabaseManager}"

log() { printf '\n==> %s\n' "$1"; }

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: $0 <git-repo-url> [target-dir]" >&2
  exit 1
fi

# --- 1. Install Docker if missing ---
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
  sudo systemctl enable --now docker || true
  if [[ -n "${SUDO_USER:-}" ]]; then
    sudo usermod -aG docker "$SUDO_USER" || true
    echo "  (Added $SUDO_USER to docker group — log out and back in for it to take effect.)"
  fi
else
  log "Docker already installed: $(docker --version)"
fi

# --- 2. Ensure docker compose v2 ---
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 plugin not found. Install via:" >&2
  echo "  sudo apt-get install -y docker-compose-plugin   (Debian/Ubuntu)" >&2
  exit 1
fi

# --- 3. Install git if missing ---
if ! command -v git >/dev/null 2>&1; then
  log "Installing git"
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y git
  elif command -v yum >/dev/null 2>&1; then sudo yum install -y git
  else echo "Install git manually." >&2; exit 1; fi
fi

# --- 4. Clone repo ---
if [[ -d "$TARGET_DIR/.git" ]]; then
  log "Repo already exists at $TARGET_DIR, pulling latest"
  cd "$TARGET_DIR"
  git pull
else
  log "Cloning $REPO_URL into $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
fi

# --- 5. Create .env.production from example if missing ---
ENV_FILE="SecureConnect/.env.production"
EXAMPLE="SecureConnect/.env.example"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ ! -f "$EXAMPLE" ]]; then
    echo "Missing $EXAMPLE — did the clone succeed?" >&2
    exit 1
  fi
  cp "$EXAMPLE" "$ENV_FILE"
  log "Created $ENV_FILE (template). EDIT IT NOW:"
  echo "  - AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET  (Google Cloud Console > OAuth 2.0)"
  echo "  - AUTH_SECRET                          (openssl rand -base64 32)"
  echo "  - AUTH_URL                             (public HTTPS URL, e.g. https://db.example.com)"
  echo "  - AUTH_TRUST_HOST=true                 (already set)"
  echo
  echo "Then run:  docker compose up -d --build"
  exit 0
fi

# --- 6. First build + start ---
log "Building + starting containers"
docker compose up -d --build

log "Containers"
docker compose ps

cat <<'EOF'

Server bootstrap complete.

Next steps:
  - Confirm health:   curl -fsS http://localhost:3000/api/crypto/public-key
  - View logs:        docker compose logs -f app
  - For HTTPS: enable the `caddy` service in docker-compose.yml, set DOMAIN + EMAIL,
    point your DNS A record at this server, then `docker compose up -d`.

Subsequent deploys are driven from your local machine via deploy.ps1.
EOF
