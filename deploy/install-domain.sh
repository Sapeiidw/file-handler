#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    printf 'Perlu akses administrator untuk /etc/hosts dan Nginx sistem. Jalankan: sudo bash %s\n' "$0" >&2
    exit 1
fi

project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
domain='file-handler.local'
available="/etc/nginx/sites-available/${domain}.conf"
enabled="/etc/nginx/sites-enabled/${domain}.conf"

if [ -e "$enabled" ] || [ -L "$enabled" ]; then
    if [ ! -L "$enabled" ] || [ "$(readlink "$enabled")" != "$available" ]; then
        printf 'Konfigurasi %s yang berbeda sudah ada; tidak ditimpa.\n' "$domain" >&2
        exit 1
    fi
fi

backup_dir="$(mktemp -d "/var/tmp/${domain}.XXXXXXXX")"
cp -p /etc/hosts "$backup_dir/hosts"
had_config=0
had_link=0
if [ -e "$available" ]; then
    cp -p "$available" "$backup_dir/site.conf"
    had_config=1
fi
if [ -L "$enabled" ]; then
    had_link=1
fi

rollback() {
    result=$?
    if [ "$result" -ne 0 ]; then
        cat "$backup_dir/hosts" > /etc/hosts
        if [ "$had_config" -eq 1 ]; then
            cp -p "$backup_dir/site.conf" "$available"
        else
            rm -f "$available"
        fi
        if [ "$had_link" -eq 0 ]; then
            rm -f "$enabled"
        fi
        /usr/sbin/nginx -t && systemctl reload nginx || true
        printf 'Pemasangan gagal; konfigurasi sebelumnya dipulihkan. Backup: %s\n' "$backup_dir" >&2
    fi
}
trap rollback EXIT

install -m 644 "$project/deploy/${domain}.conf" "$available"
if [ "$had_link" -eq 0 ]; then
    ln -s "$available" "$enabled"
fi

DOMAIN="$domain" python3 - <<'PY'
import os
from pathlib import Path

domain = os.environ['DOMAIN']
hosts = Path('/etc/hosts')
lines = []
for line in hosts.read_text().splitlines():
    content, marker, comment = line.partition('#')
    parts = content.split()
    if len(parts) > 1 and domain in parts[1:]:
        parts = [parts[0]] + [name for name in parts[1:] if name != domain]
        if len(parts) > 1:
            lines.append(' '.join(parts) + (' #' + comment if marker else ''))
        elif marker:
            lines.append('#' + comment)
    else:
        lines.append(line)
lines.append(f'127.0.0.1 {domain}')
hosts.write_text('\n'.join(lines) + '\n')
PY

/usr/sbin/nginx -t
systemctl reload nginx
curl --noproxy '*' --retry 5 --retry-all-errors --retry-delay 1 -fsS "http://${domain}/api/health"
printf '\nFile Handler aktif: http://%s\nBackup konfigurasi: %s\n' "$domain" "$backup_dir"
