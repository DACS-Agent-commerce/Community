/** Owner and group only, matching StateDirectoryMode in the systemd units; every code path that creates the data folder uses it. */
export const DATA_DIR_MODE = 0o750;
