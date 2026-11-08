# Deploying the Directory on the Demos testnet

These files run the Directory on one server with systemd and Caddy:

| File | Role |
|---|---|
| `dacs-directory.service` | The web server on `127.0.0.1:$PORT` |
| `dacs-directory-index.service` | One catalog index pass (`npm run index`) |
| `dacs-directory-index.timer` | Starts an index pass every five minutes (`OnCalendar=*:0/5`) |
| `directory.env.example` | Settings for both units (placeholders only) |
| `Caddyfile.example` | TLS and reverse proxy to the web server |

## Testnet only

Both units run `npm run check:testnet -- --built` before they start
(`scripts/check-testnet-deployment.ts`). It refuses to start when:

- `DACS_DIRECTORY_NETWORK` is not exactly `testnet` (`mainnet` included);
- `DEMOS_RPC` or `NEXT_PUBLIC_DEMOS_RPC` is missing, is not a credential-free
  `https` URL, or has a host label containing `mainnet`;
- the two RPC settings name different endpoints (this profile requires one
  endpoint for the server and public readers);
- the compiled manifest advertises an RPC different from those settings;
- `DEMOS_CHAIN_IDENTITY` is set to anything but an accepted chain identity
  (`TESTNET_CHAIN_IDENTITIES` in `src/catalog/testnetDeployment.ts`);
- the configured node serves another chain, or cannot be read within 30 seconds.

The node reports its own chain, so this check catches a wrong network; it does
not authenticate the node. Accepting a rebuilt testnet takes a reviewed source
change to `TESTNET_CHAIN_IDENTITIES`, not a setting.

## Install

Node 22.23.3 (`.nvmrc`) must be installed system-wide, since the units find `node`
and `npm` on systemd's default `PATH`. The release must match exactly: both units run
`scripts/check-node-runtime.mjs` before starting, and it refuses any other release,
including another 22.x. If the server keeps a different Node, install 22.23.3 for
these units or remove that `ExecStartPre` line and accept the unpinned runtime. As root:

1. Create the service user and its data folder (the build in step 4 opens the store there):
   `useradd --system --home-dir /var/lib/dacs-directory --shell /usr/sbin/nologin dacs-directory && install -d -o dacs-directory -g dacs-directory -m 0750 /var/lib/dacs-directory`.
2. Check out a reviewed commit of this repository at `/opt/dacs-directory`, owned by
   `dacs-directory` (the server writes its Next cache there).
3. Copy `directory.env.example` to `/etc/dacs-directory/directory.env` (owner root, group
   `dacs-directory`, mode `0640`), replace every `example.org` value and set
   `DACS_ADMIN_TOKEN` to a long random value generated on the server.
4. As `dacs-directory`, in `/opt/dacs-directory/reference-implementations/dacs-directory`,
   install and build with the settings loaded (`NEXT_PUBLIC_*` values are built into the pages):
   `set -a; . /etc/dacs-directory/directory.env; set +a; bash scripts/setup-sdk.sh && npm run check:deploy-config && npm run check:testnet && npm run build`.
   `check:deploy-config` refuses a placeholder or non-public `NEXT_PUBLIC_DIRECTORY_URL`,
   which the compiled manifest gives to every machine client.
   Rebuild after changing the RPC settings; the startup check reads the compiled
   manifest, including the public RPC fixed at build time.
5. Copy the three unit files to `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now dacs-directory.service dacs-directory-index.timer`.
6. Add the site from `Caddyfile.example` to the Caddy configuration and reload Caddy.
   Its `reverse_proxy` port must match `PORT` in the settings file (3400 in the example).

## Check

- `systemctl list-timers dacs-directory-index.timer` shows the next pass within five minutes.
- `journalctl -u dacs-directory-index.service` shows each pass, or the startup refusal.
- `https://directory.example.org/api/dacs/status` reports the latest scan run.

The catalog lives in `/var/lib/dacs-directory`. Do not copy `data/registrations.example.json`
there: the testnet catalog starts empty and fills from registrations and the chain scan.
A pass that is still running when the timer fires is not started twice; the next tick runs it.

## First full scan or long replay

The scheduled index unit has a 15-minute startup timeout. The scan cursor is
committed with the completed catalog, so killing a longer first scan or replay
can make each attempt repeat the same work. For that case, use the supplied
`index-bootstrap.conf` as a temporary drop-in for the same unit. It removes the
startup timeout for this pass; a hung pass then needs an explicit stop.

After install/build and before enabling the timer (or when recovering a timed-out
scan), run the following as root from
`/opt/dacs-directory/reference-implementations/dacs-directory`:

```sh
set -eu
# Stop scheduling first; stop any existing pass before changing its timeout.
systemctl stop dacs-directory-index.timer
systemctl stop dacs-directory-index.service
install -d -m 0755 /etc/systemd/system/dacs-directory-index.service.d
# This filename must be unused; do not overwrite an existing local override.
test ! -e '/etc/systemd/system/dacs-directory-index.service.d/90-bootstrap.conf'
install -m 0644 'deploy/testnet/index-bootstrap.conf' '/etc/systemd/system/dacs-directory-index.service.d/90-bootstrap.conf'
systemctl daemon-reload
# Refuse to start if a conflicting local override leaves a finite timeout.
test "$(systemctl show dacs-directory-index.service -p TimeoutStartUSec --value)" = infinity
systemctl start --no-block dacs-directory-index.service
journalctl -fu dacs-directory-index.service
```

The same unit still runs as `dacs-directory`, loads `directory.env`, and runs its
runtime and testnet preflight checks. The timer stays stopped during bootstrap.
Interrupting `journalctl` only stops watching logs. Inspect `systemctl status dacs-directory-index.service` and the journal for successful completion (exit
status 0 and `catalog written`); check `/api/dacs/status` for scan progress.
Do not restart scheduling after a failed or still-running pass. To abort a hung
pass, use `systemctl stop dacs-directory-index.service`, inspect the failure and
retry with the timer stopped.

After a successful pass, remove only the temporary drop-in and restore scheduling:

```sh
set -eu
rm '/etc/systemd/system/dacs-directory-index.service.d/90-bootstrap.conf'
systemctl daemon-reload
# Refuse to resume scheduling unless the shipped 15-minute limit is restored.
test "$(systemctl show dacs-directory-index.service -p TimeoutStartUSec --value)" = 15min
systemctl enable --now dacs-directory-index.timer
```

This changes the service time budget only. If the scan reports `DACS_SCAN_MAX_TXS`
exhaustion or an RPC failure, resolve that separately; disabling the startup
timeout cannot make an incomplete scan commit its cursor. For later long replays,
repeat this temporary procedure.
