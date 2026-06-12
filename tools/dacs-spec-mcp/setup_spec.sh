#!/usr/bin/env bash
# setup_spec.sh — clone DACS-Standard at the commit recorded in SPEC_PIN.
#
# Run from this directory:
#   ./setup_spec.sh
#
# On success: vendor/DACS-Standard/ contains the spec at the pinned commit
# and the indexer reads it from there by default. Exits nonzero on any
# failure so CI can rely on the exit code.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="${HERE}/vendor/DACS-Standard"
PIN_FILE="${HERE}/SPEC_PIN"
UPSTREAM_URL="https://github.com/DACS-Agent-commerce/DACS-Standard"

if [ ! -f "${PIN_FILE}" ]; then
  echo "setup_spec: SPEC_PIN file not found at ${PIN_FILE}" >&2
  exit 1
fi

# SPEC_PIN format: a comment line beginning with '#' is allowed; the first
# 40-hex-digit token is the commit. Reject anything else.
PIN_COMMIT="$(grep -Eo '^[0-9a-f]{40}$' "${PIN_FILE}" | head -n 1 || true)"
if [ -z "${PIN_COMMIT}" ]; then
  echo "setup_spec: SPEC_PIN does not contain a 40-char commit hash" >&2
  exit 1
fi

echo "setup_spec: target commit ${PIN_COMMIT}"

if [ -d "${VENDOR_DIR}/.git" ]; then
  echo "setup_spec: existing checkout at ${VENDOR_DIR} — fetching + checking out pin"
  git -C "${VENDOR_DIR}" fetch --tags origin || {
    echo "setup_spec: git fetch failed" >&2
    exit 1
  }
else
  mkdir -p "${HERE}/vendor"
  echo "setup_spec: cloning ${UPSTREAM_URL} into ${VENDOR_DIR}"
  git clone "${UPSTREAM_URL}" "${VENDOR_DIR}" || {
    echo "setup_spec: git clone failed" >&2
    exit 1
  }
fi

git -C "${VENDOR_DIR}" checkout -q "${PIN_COMMIT}" || {
  echo "setup_spec: checkout ${PIN_COMMIT} failed — is the pin reachable on origin?" >&2
  exit 1
}

ACTUAL="$(git -C "${VENDOR_DIR}" rev-parse HEAD)"
if [ "${ACTUAL}" != "${PIN_COMMIT}" ]; then
  echo "setup_spec: HEAD ${ACTUAL} does not match pin ${PIN_COMMIT}" >&2
  exit 1
fi

echo "setup_spec: OK — ${VENDOR_DIR} at ${PIN_COMMIT}"
