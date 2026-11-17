#!/bin/sh
# Validate only bundled examples. No live .env, deployed secret, listener or network.
set -eu
case "${1:-}" in
  ""|--engines) ;;
  *) printf 'Usage: sh validate.sh [--engines]\n' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || exit 2
cd "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
python3 - "$@" <<'PY'
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib

root = Path.cwd()
for name in ('frps.toml', 'snippets/frps.toml', 'snippets/frpc.toml'):
    config = tomllib.loads((root / name).read_text())
    assert config['auth']['method'] == 'token', name
    assert 'token' not in config['auth'], f'{name}: sample must not embed a token'
    assert config['auth']['tokenSource']['type'] == 'file', name
server = tomllib.loads((root / 'frps.toml').read_text())
assert server['allowPorts'] == [{'single': 7300}]
assert server['transport']['tls']['force'] is True
assert 'webServer' not in server
native = tomllib.loads((root / 'snippets/frps.toml').read_text())
assert native['proxyBindAddr'] == '127.0.0.1'
client = tomllib.loads((root / 'snippets/frpc.toml').read_text())
assert client['transport']['tls']['enable'] is True
assert client['transport']['tls']['trustedCaFile']
assert client['transport']['tls']['serverName']
assert client['proxies'][0]['localPort'] == 3100
assert client['proxies'][0]['remotePort'] == 7300
assert client['proxies'][0]['type'] == 'tcp'
# This is a sample invariant check, NOT a YAML/Compose engine qualification.
compose = (root / 'compose.yaml').read_text()
assert 'ghcr.io/fatedier/frps:v0.65.0' in compose
assert 'caddy:2.10.2-alpine' in compose
assert ':7300' not in compose, 'the application mapping must never be published'
assert 'network_mode:' not in compose
for path in ('Caddyfile', 'snippets/Caddyfile'):
    content = (root / path).read_text()
    assert 'flush_interval -1' in content
    assert 'exclude http.log.error http.log.access' in content
    assert 'header Sec-Fetch-Mode navigate' in content
    assert 'header Sec-Fetch-Dest document' in content
    assert 'not path /api /api/* /auth /auth/* /health /health/*' in content
print('PASS: bundled TOML parsing and sample invariants (not runtime qualification)')

# Verify with existing binaries only. The dummy token never comes from a user file.
with tempfile.TemporaryDirectory(prefix='varin-kit-verify-') as directory:
    temporary = Path(directory)
    token = temporary / 'dummy-token'
    token.write_text('LOCAL-VALIDATION-ONLY-NOT-A-DEPLOYMENT-TOKEN\n')
    token.chmod(0o600)
    for variable, sample, program in (
        ('FRPS_BIN', 'frps.toml', 'frps'),
        ('FRPS_BIN', 'snippets/frps.toml', 'frps'),
        ('FRPC_BIN', 'snippets/frpc.toml', 'frpc'),
    ):
        binary = os.environ.get(variable) or shutil.which(program)
        if not binary:
            print(f'NOT RUN: {sample} engine verification ({program} unavailable)')
            continue
        version = subprocess.check_output([binary, '--version'], text=True).strip()
        if version != '0.65.0':
            raise SystemExit(f'{program}: expected 0.65.0, got {version!r}')
        contents = (root / sample).read_text()
        original = tomllib.loads(contents)['auth']['tokenSource']['file']['path']
        contents = contents.replace(original, str(token))
        config = temporary / (sample.replace('/', '-') + '.toml')
        config.write_text(contents)
        subprocess.run([binary, 'verify', '-c', str(config)], check=True)
        print(f'PASS: {sample} frp v0.65.0 config verification (no listener/TLS handshake)')

# Explicit operator mode uses installed engines only, never downloads or starts services.
# Materialize only sample files, not real .env or deployment secrets.
engines = sys.argv[1:] == ['--engines']
if engines:
    missing = []
    with tempfile.TemporaryDirectory(prefix='varin-kit-engines-') as directory:
        temporary = Path(directory)
        for sample in ('compose.yaml', '.env.example', 'frps.toml', 'Caddyfile',
                       'snippets/Caddyfile', 'offline/index.html'):
            target = temporary / sample
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / sample, target)
        private = temporary / 'secrets'
        private.mkdir(mode=0o700)
        for name in ('frp-token', 'frps.crt', 'frps.key'):
            (private / name).write_text('DUMMY-ENGINE-CONFIG-VALIDATION-ONLY\n')
        # Do not inherit secret-bearing provider/proxy environment variables.
        env = {key: value for key, value in os.environ.items()
               if key in ('PATH', 'LANG', 'LC_ALL', 'TZ')}
        env.update(HOME=str(temporary), XDG_CONFIG_HOME=str(temporary / 'config'),
                   XDG_DATA_HOME=str(temporary / 'data'), VARIN_DOMAIN='varin.example.com')
        docker = shutil.which('docker')
        if docker:
            subprocess.run([docker, 'compose', '--project-directory', str(temporary),
                            '--file', str(temporary / 'compose.yaml'),
                            '--env-file', str(temporary / '.env.example'),
                            'config', '--quiet'], env=env, check=True)
            print('PASS: Docker Compose config (temporary sample tree, no daemon start)')
        else:
            missing.append('Docker Compose')
        caddy = shutil.which('caddy')
        if caddy:
            version = subprocess.check_output([caddy, 'version'], text=True, env=env).split()[0]
            if version != 'v2.10.2':
                raise SystemExit(f'Caddy: expected v2.10.2, got {version!r}')
            for sample in ('Caddyfile', 'snippets/Caddyfile'):
                config = str(temporary / sample)
                subprocess.run([caddy, 'adapt', '--config', config, '--adapter', 'caddyfile'],
                               env=env, stdout=subprocess.DEVNULL, check=True)
                subprocess.run([caddy, 'validate', '--config', config, '--adapter', 'caddyfile'],
                               env=env, check=True)
                print(f'PASS: {sample} genuine Caddy adapt + validate (no server start)')
        else:
            missing.append('Caddy')
        if missing:
            print('NOT RUN: requested engines unavailable: ' + ', '.join(missing))
            raise SystemExit(2)
else:
    print('NOT RUN: Compose/Caddy engine checks (request explicitly with --engines)')
print('NOT RUN: live Compose, Nginx, HTTPS, certificate renewal and cross-device acceptance')
print('Follow README.md acceptance checklist in an isolated authorized deployment.')
PY
