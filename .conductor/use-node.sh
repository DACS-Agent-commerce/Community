#!/usr/bin/env bash

# Conductor scripts run in non-interactive shells, where nvm is not normally loaded.
# Prefer the existing Node when compatible; otherwise load the repository's Node 22
# toolchain from nvm when it is available.
node_is_compatible() {
  command -v node >/dev/null 2>&1 && node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
  '
}

if ! node_is_compatible; then
  nvm_home="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_home/nvm.sh" ]; then
    export NVM_DIR="$nvm_home"
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    nvm use --silent 22 >/dev/null 2>&1 || nvm install 22
  fi
fi

if ! node_is_compatible; then
  echo "DACS Directory requires Node.js 22.12 or newer; install Node 22 and retry." >&2
  exit 1
fi
