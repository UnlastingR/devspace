#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${REPO:-fyzure/devspace}"
APP="${APP:-/root/codex/devspace}"
STATE_DIR="${STATE_DIR:-/root/.local/share/devspace}"
STATE_DB="$STATE_DIR/devspace.sqlite"
SERVICE="${SERVICE:-devspace}"
HEALTH_URL="${HEALTH_URL:-}"

STAGE="$(mktemp -d /root/codex/.devspace-install.XXXXXX)"
BACKUP="$(mktemp -d /root/codex/.devspace-backup.XXXXXX)"

ART="$STAGE/devspace-linux-x64.tar.gz"
SUM="$STAGE/devspace-linux-x64.tar.gz.sha256"
UNPACK="$STAGE/unpacked"
DB_BACKUP="$BACKUP/devspace.sqlite"

BASE="https://github.com/$REPO/releases/latest/download"

DEPLOY_STARTED=0
DB_BACKED_UP=0

# Runtime files are replaced completely from the release bundle. Keep scripts/
# outside this list because older release bundles do not contain it; the updater
# must survive its own clean deployment.
RUNTIME_ITEMS=(
    dist
    node_modules
    package.json
    package-lock.json
    README.md
    docs
    skills
)

cleanup() {
    rm -rf "$STAGE"
}

rollback() {
    rc=$?
    trap - ERR

    echo
    echo "=== INSTALL FAILED ==="

    if [ "$DEPLOY_STARTED" = "1" ]; then
        echo "=== ROLLING BACK APPLICATION ==="

        systemctl stop "$SERVICE" 2>/dev/null || true

        for item in "${RUNTIME_ITEMS[@]}"; do
            rm -rf "$APP/$item"

            if [ -e "$BACKUP/runtime/$item" ]; then
                mv "$BACKUP/runtime/$item" "$APP/$item"
            fi
        done

        if [ "$DB_BACKED_UP" = "1" ] && [ -f "$DB_BACKUP" ]; then
            echo "=== ROLLING BACK SQLITE STATE ==="
            mkdir -p "$STATE_DIR"
            rm -f "$STATE_DB" "$STATE_DB-wal" "$STATE_DB-shm"
            cp -a "$DB_BACKUP" "$STATE_DB"
            chmod 600 "$STATE_DB"
        fi

        systemctl start "$SERVICE" 2>/dev/null || true
    fi

    rm -rf "$STAGE" "$BACKUP"
    exit "$rc"
}

trap rollback ERR
trap cleanup EXIT

echo "=== DevSpace clean reinstall ==="

echo
echo "=== Preflight ==="

command -v curl >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null
command -v node >/dev/null
command -v sqlite3 >/dev/null
command -v systemctl >/dev/null
command -v git >/dev/null

test -d "$APP"
test -d "$APP/.git"

mkdir -p "$BACKUP/runtime"

echo "Repository: $REPO"
echo "App:        $APP"
echo "State:      $STATE_DIR"
echo "Service:    $SERVICE"

echo
echo "=== Download latest DevSpace release ==="

curl \
    --fail \
    --location \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    "$BASE/devspace-linux-x64.tar.gz" \
    -o "$ART"

curl \
    --fail \
    --location \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    "$BASE/devspace-linux-x64.tar.gz.sha256" \
    -o "$SUM"

echo
echo "=== Verify SHA-256 ==="

cd "$STAGE"
sha256sum -c "$(basename "$SUM")"

echo
echo "=== Unpack release ==="

mkdir -p "$UNPACK"
tar -xzf "$ART" -C "$UNPACK"

echo
echo "=== Validate release structure ==="

test -f "$UNPACK/package.json"
test -f "$UNPACK/package-lock.json"
test -f "$UNPACK/dist/cli.js"
test -f "$UNPACK/dist/server.js"
test -d "$UNPACK/dist/ui"
test -d "$UNPACK/node_modules"
test -d "$UNPACK/docs"
test -d "$UNPACK/skills"

VERSION="$(node -e "console.log(require('$UNPACK/package.json').version)")"
RELEASE_TAG="v$VERSION"
echo "Latest release: v$VERSION"

echo
echo "=== Fetch release tag ==="

rm -f "$(git -C "$APP" rev-parse --git-path index.lock)"
git -C "$APP" fetch --force origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
git -C "$APP" rev-parse --verify "$RELEASE_TAG^{commit}" >/dev/null

echo
echo "=== Verify native runtime dependencies ==="

(
    cd "$UNPACK"

    node --input-type=module <<'NODE'
const pty = await import("node-pty");
if (typeof pty.spawn !== "function") {
    throw new Error("node-pty runtime verification failed");
}
console.log("node-pty: OK");
NODE

    node --input-type=module <<'NODE'
const { default: Database } = await import("better-sqlite3");
const db = new Database(":memory:");
db.exec("create table test (id integer)");
db.close();
console.log("better-sqlite3: OK");
NODE
)

echo
echo "=== Release validated before service interruption ==="

DEPLOY_STARTED=1

echo
echo "=== Stop DevSpace ==="

systemctl stop "$SERVICE"

for _ in $(seq 1 30); do
    if ! systemctl is-active --quiet "$SERVICE"; then
        break
    fi
    sleep 1
done

if systemctl is-active --quiet "$SERVICE"; then
    echo "DevSpace failed to stop cleanly."
    exit 1
fi

echo
echo "=== Back up persistent SQLite state ==="

mkdir -p "$STATE_DIR"

if [ -f "$STATE_DB" ]; then
    sqlite3 "$STATE_DB" 'PRAGMA wal_checkpoint(FULL);'
    sqlite3 "$STATE_DB" ".backup '$DB_BACKUP'"
    sqlite3 "$DB_BACKUP" 'PRAGMA integrity_check;' | grep -qx 'ok'
    DB_BACKED_UP=1
    echo "SQLite backup: OK"
else
    echo "No existing SQLite database."
fi

echo
echo "=== Remove obsolete deployment cache ==="

rm -rf "$STATE_DIR/deployments"

echo
echo "=== Back up current runtime ==="

for item in "${RUNTIME_ITEMS[@]}"; do
    if [ -e "$APP/$item" ]; then
        mv "$APP/$item" "$BACKUP/runtime/$item"
    fi
done

echo
echo "=== Ensure old runtime is completely gone ==="

for item in "${RUNTIME_ITEMS[@]}"; do
    rm -rf "$APP/$item"
done

echo
echo "=== Install fresh runtime ==="

for item in "${RUNTIME_ITEMS[@]}"; do
    test -e "$UNPACK/$item"
    mv "$UNPACK/$item" "$APP/$item"
done

echo
echo "=== Fix ownership ==="

for item in "${RUNTIME_ITEMS[@]}"; do
    chown -R root:root "$APP/$item"
done

echo
echo "=== Verify installed package ==="

INSTALLED_VERSION="$(node -e "console.log(require('$APP/package.json').version)")"

if [ "$INSTALLED_VERSION" != "$VERSION" ]; then
    echo "Version mismatch:"
    echo "  expected:  $VERSION"
    echo "  installed: $INSTALLED_VERSION"
    exit 1
fi

(
    cd "$APP"
    node --input-type=module -e \
        "const pty = await import('node-pty'); if (typeof pty.spawn !== 'function') process.exit(1)"
    node --input-type=module -e \
        "const { default: Database } = await import('better-sqlite3'); const db = new Database(':memory:'); db.close()"
)

echo
echo "=== Start DevSpace ==="

systemctl daemon-reload
systemctl start "$SERVICE"

echo
echo "=== Wait for service ==="

SERVICE_OK=0
for _ in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE"; then
        SERVICE_OK=1
        break
    fi
    sleep 1
done

if [ "$SERVICE_OK" != "1" ]; then
    echo "DevSpace failed to start."
    journalctl -u "$SERVICE" -n 100 --no-pager || true
    exit 1
fi

MAIN_PID="$(systemctl show "$SERVICE" --property=MainPID --value)"
test -n "$MAIN_PID"
test "$MAIN_PID" != "0"
kill -0 "$MAIN_PID"

echo
echo "=== Verify SQLite after migration ==="

if [ -f "$STATE_DB" ]; then
    sqlite3 "$STATE_DB" 'PRAGMA integrity_check;' | grep -qx 'ok'
    echo "SQLite integrity: OK"
fi

if [ -n "$HEALTH_URL" ]; then
    echo
    echo "=== HTTP health check ==="

    HEALTH_OK=0
    for _ in $(seq 1 30); do
        if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
            HEALTH_OK=1
            break
        fi
        sleep 1
    done

    if [ "$HEALTH_OK" != "1" ]; then
        echo "Health check failed: $HEALTH_URL"
        journalctl -u "$SERVICE" -n 100 --no-pager || true
        exit 1
    fi

    echo "Health check: OK"
fi

RUNNING_VERSION="$(node -e "console.log(require('$APP/package.json').version)")"

echo
echo "=== Sync Git checkout to installed release ==="

rm -f "$(git -C "$APP" rev-parse --git-path index.lock)"
git -C "$APP" reset --hard "$RELEASE_TAG"
git -C "$APP" clean -fd

if [ -n "$(git -C "$APP" status --porcelain --untracked-files=normal)" ]; then
    echo "Git checkout is still dirty after release sync."
    git -C "$APP" status --short
    exit 1
fi

echo "Git checkout: $RELEASE_TAG"
echo "Git status: clean"

echo
echo "=== Installation successful ==="
echo "Version: v$RUNNING_VERSION"
echo "Service: $(systemctl is-active "$SERVICE")"
echo "PID:     $MAIN_PID"

DEPLOY_STARTED=0

rm -rf "$BACKUP"
trap - ERR
trap - EXIT
rm -rf "$STAGE"

echo "=== DONE ==="
