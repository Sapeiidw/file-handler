#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v nginx >/dev/null
command -v uv >/dev/null
uv venv --python 3.12 --allow-existing .venv
uv pip sync requirements.txt
npm ci
npm run build
.venv/bin/python scripts/download_models.py
mkdir -p data/nginx-tmp data/nginx-proxy "$HOME/.config/systemd/user"
chmod 700 data
sed "s|__ROOT__|$ROOT|g" deploy/nginx.conf.template > deploy/nginx.conf
nginx -t -c "$ROOT/deploy/nginx.conf" -p "$ROOT/"
cat > "$HOME/.config/systemd/user/file-handler.service" <<EOF
[Unit]
Description=File Handler image processing API
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PYTHONUNBUFFERED=1
Environment=AI_THREADS=4
Environment=OMP_NUM_THREADS=4
Environment=OPENBLAS_NUM_THREADS=1
ExecStart=$ROOT/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8788 --workers 1 --no-server-header --limit-concurrency 64 --backlog 128
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
MemoryMax=8G
TasksMax=96

[Install]
WantedBy=default.target
EOF
cat > "$HOME/.config/systemd/user/file-handler-nginx.service" <<EOF
[Unit]
Description=File Handler local Nginx
After=file-handler.service
Wants=file-handler.service

[Service]
Type=simple
ExecStart=/usr/sbin/nginx -c $ROOT/deploy/nginx.conf -p $ROOT/ -g 'daemon off;'
ExecReload=/usr/sbin/nginx -t -c $ROOT/deploy/nginx.conf -p $ROOT/
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable file-handler.service file-handler-nginx.service
systemctl --user restart file-handler.service file-handler-nginx.service
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:8088/api/health; then
        printf '\nFile Handler ready: http://localhost:8088\n'
        exit 0
    fi
    sleep 1
done
systemctl --user status file-handler.service file-handler-nginx.service --no-pager
exit 1
