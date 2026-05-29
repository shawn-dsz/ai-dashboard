#!/usr/bin/env node
/**
 * Account roots helper.
 *
 * Returns the list of Claude Code accounts whose transcripts should be
 * scanned. Each account has a label (e.g. 'personal', 'fho'), a config
 * directory, and a projects directory beneath it.
 *
 * Behaviour:
 *  - Defaults to the two known accounts: personal (~/.claude) and fho
 *    (~/.claude-alt).
 *  - An account is SKIPPED if its projects dir is missing or contains no
 *    .jsonl transcripts (so an empty/absent FHO root contributes nothing
 *    and never errors).
 *  - Because ~/.claude-alt heavily symlinks back to ~/.claude, each
 *    projects dir is resolved to its real path. If two accounts resolve to
 *    the SAME real projects dir, only the first (primary) one is kept, to
 *    avoid double-counting.
 *  - The default can be overridden via the DASHBOARD_ACCOUNT_ROOTS env var,
 *    a colon-separated list of `label=configDir` pairs, for portability and
 *    testing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Expand a leading ~ to the user's home directory and resolve to absolute.
 */
function expandPath(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * Parse the DASHBOARD_ACCOUNT_ROOTS env override.
 * Format: "label=dir:label=dir". Returns null when unset/empty.
 */
function parseEnvOverride(raw) {
  if (!raw || !raw.trim()) return null;
  const pairs = [];
  for (const part of raw.split(':')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const label = trimmed.slice(0, idx).trim();
    const dir = trimmed.slice(idx + 1).trim();
    if (label && dir) pairs.push({ label, configDir: dir });
  }
  return pairs.length > 0 ? pairs : null;
}

/**
 * Default account list (personal first so it wins any dedup tie).
 */
function defaultAccounts() {
  return [
    { label: 'personal', configDir: path.join(os.homedir(), '.claude') },
    { label: 'fho', configDir: path.join(os.homedir(), '.claude-alt') },
  ];
}

/**
 * Decide whether a projects dir holds any .jsonl transcripts.
 * Treats a missing dir, an empty dir, or a dir of empty subdirs as "no data".
 */
function hasTranscripts(projectsDir) {
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return false; // missing or unreadable
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const projectPath = path.join(projectsDir, entry.name);
      let files;
      try {
        files = fs.readdirSync(projectPath);
      } catch {
        continue;
      }
      if (files.some(f => f.endsWith('.jsonl'))) return true;
    } else if (entry.name.endsWith('.jsonl')) {
      return true;
    }
  }
  return false;
}

/**
 * Build the list of accounts to scan.
 *
 * @returns {Array<{label, configDir, projectsDir, realProjectsDir}>}
 */
function getAccountRoots() {
  const configured = parseEnvOverride(process.env.DASHBOARD_ACCOUNT_ROOTS) || defaultAccounts();

  const roots = [];
  const seenRealDirs = new Set();

  for (const acct of configured) {
    const configDir = expandPath(acct.configDir);
    const projectsDir = path.join(configDir, 'projects');

    // Skip accounts with no transcripts (missing or empty projects dir).
    if (!hasTranscripts(projectsDir)) continue;

    // Resolve to real path to dedupe symlinked roots.
    let realProjectsDir;
    try {
      realProjectsDir = fs.realpathSync(projectsDir);
    } catch {
      realProjectsDir = projectsDir;
    }

    if (seenRealDirs.has(realProjectsDir)) continue; // already scanned via primary
    seenRealDirs.add(realProjectsDir);

    roots.push({
      label: acct.label,
      configDir,
      projectsDir,
      realProjectsDir,
    });
  }

  return roots;
}

module.exports = { getAccountRoots, expandPath, hasTranscripts };
