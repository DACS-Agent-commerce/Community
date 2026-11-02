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
- `DEMOS_CHAIN_IDENTITY` is set to anything but a reviewed testnet identity
  (`TESTNET_CHAIN_IDENTITIES` in `src/catalog/testnetDeployment.ts`);
- the configured node serves another chain, or cannot be read within 30 seconds.

The node reports its own chain, so this check catches a wrong network; it does
not authenticate the node. Accepting a rebuilt testnet takes a reviewed source
change to `TESTNET_CHAIN_IDENTITIES`, not a setting.

## Install

Node 22.23.3 (`.nvmrc`) must be installed system-wide, since the units find `node`
and `npm` on systemd's default `PATH`. As root:

1. Create the service user: `useradd --system --home-dir /var/lib/dacs-directory --shell /usr/sbin/nologin dacs-directory`.
2. Check out a reviewed commit of this repository at `/opt/dacs-directory`, owned by
   `dacs-directory` (the server writes its Next cache there).
3. Copy `directory.env.example` to `/etc/dacs-directory/directory.env` (owner root, group
   `dacs-directory`, mode `0640`), replace every `example.org` value and set
   `DACS_ADMIN_TOKEN` to a long random value generated on the server.
4. As `dacs-directory`, in `/opt/dacs-directory/reference-implementations/dacs-directory`,
   install and build with the settings loaded (`NEXT_PUBLIC_*` values are built into the pages):
   `set -a; . /etc/dacs-directory/directory.env; set +a; bash scripts/setup-sdk.sh && npm run check:testnet && npm run build`.
   Rebuild after changing the RPC settings; the startup check reads the compiled
   manifest, including the public RPC fixed at build time.
5. Copy the three unit files to `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now dacs-directory.service dacs-directory-index.timer`.
6. Add the site from `Caddyfile.example` to the Caddy configuration and reload Caddy.

## Check

- `systemctl list-timers dacs-directory-index.timer` shows the next pass within five minutes.
- `journalctl -u dacs-directory-index.service` shows each pass, or the startup refusal.
- `https://directory.example.org/api/dacs/status` reports the latest scan run.

The catalog lives in `/var/lib/dacs-directory`. Do not copy `data/registrations.example.json`
there: the testnet catalog starts empty and fills from registrations and the chain scan.
A pass that is still running when the timer fires is not started twice; the next tick runs it.
