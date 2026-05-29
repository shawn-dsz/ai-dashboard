import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const initSqlJs = require('sql.js');

let tmpDir;
let cachePath;
const scriptPath = path.join(__dirname, '..', 'build-session-cache.js');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cache-test-'));
  cachePath = path.join(tmpDir, 'sessions.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTranscript(configDir, projectName, fileName, lines) {
  const projectDir = path.join(configDir, 'projects', projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, fileName),
    lines.map(l => JSON.stringify(l)).join('\n')
  );
}

function buildCache(accountRootsEnv) {
  execFileSync('node', [scriptPath, cachePath], {
    env: { ...process.env, DASHBOARD_ACCOUNT_ROOTS: accountRootsEnv },
    stdio: 'pipe',
  });
}

async function querySessions() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(cachePath));
  const rows = db.exec('SELECT session_id, account FROM sessions ORDER BY session_id');
  db.close();
  if (rows.length === 0) return [];
  return rows[0].values.map(([session_id, account]) => ({ session_id, account }));
}

describe('build-session-cache multi-account scan', () => {
  it('tags sessions with the account they came from', async () => {
    const personal = path.join(tmpDir, 'personal');
    const fho = path.join(tmpDir, 'fho');
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    writeTranscript(fho, 'projB', 's-f.jsonl', [
      { type: 'user', sessionId: 'sf', timestamp: '2025-01-02T10:00:00Z' },
    ]);

    buildCache(`personal=${personal}:fho=${fho}`);

    const sessions = await querySessions();
    const byId = Object.fromEntries(sessions.map(s => [s.session_id, s.account]));
    expect(byId['sp']).toBe('personal');
    expect(byId['sf']).toBe('fho');
  });

  it('skips a missing/empty FHO root without error and still records personal', async () => {
    const personal = path.join(tmpDir, 'personal');
    const fho = path.join(tmpDir, 'fho'); // no projects dir created
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-01T10:00:00Z' },
    ]);

    // Must not throw.
    buildCache(`personal=${personal}:fho=${fho}`);

    const sessions = await querySessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].account).toBe('personal');
  });

  it('scans a symlinked duplicate root only once (dedup)', async () => {
    const personal = path.join(tmpDir, 'personal');
    const fho = path.join(tmpDir, 'fho');
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    fs.mkdirSync(fho, { recursive: true });
    fs.symlinkSync(path.join(personal, 'projects'), path.join(fho, 'projects'));

    buildCache(`personal=${personal}:fho=${fho}`);

    const sessions = await querySessions();
    // The single transcript is counted once, attributed to personal.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].account).toBe('personal');
  });
});
