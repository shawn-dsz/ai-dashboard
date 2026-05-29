import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

let tmpDir;
let cachePath;
let dataOutput;
const buildScript = path.join(__dirname, '..', 'build-session-cache.js');
const rebuildScript = path.join(__dirname, '..', 'rebuild-stats.js');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-stats-test-'));
  cachePath = path.join(tmpDir, 'sessions.db');
  dataOutput = path.join(tmpDir, 'data.json');
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

function run(env) {
  execFileSync('node', [buildScript, cachePath], { env: { ...process.env, ...env }, stdio: 'pipe' });
  execFileSync('node', [rebuildScript, cachePath], {
    env: { ...process.env, ...env, DASHBOARD_DATA_OUTPUT: dataOutput },
    stdio: 'pipe',
  });
  return JSON.parse(fs.readFileSync(dataOutput, 'utf8'));
}

describe('rebuild-stats byAccount and FHO merge', () => {
  it('emits a byAccount object split across personal and fho', () => {
    const personal = path.join(tmpDir, 'personal');
    const fho = path.join(tmpDir, 'fho');
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'assistant', sessionId: 'sp', timestamp: '2025-01-01T10:01:00Z', message: { content: [] } },
    ]);
    writeTranscript(fho, 'projB', 's-f.jsonl', [
      { type: 'user', sessionId: 'sf', timestamp: '2025-01-02T10:00:00Z' },
    ]);

    const data = run({
      DASHBOARD_ACCOUNT_ROOTS: `personal=${personal}:fho=${fho}`,
      DASHBOARD_STATS_CACHE: path.join(tmpDir, 'no-personal-cache.json'),
      DASHBOARD_ALT_STATS_CACHE: path.join(tmpDir, 'no-fho-cache.json'),
    });

    expect(data.byAccount).toBeDefined();
    expect(data.byAccount.personal.totalSessions).toBe(1);
    expect(data.byAccount.personal.totalMessages).toBe(2);
    expect(data.byAccount.fho.totalSessions).toBe(1);
    expect(data.byAccount.fho.totalMessages).toBe(1);
  });

  it('keeps merged top-level totals equal to the sum of accounts', () => {
    const personal = path.join(tmpDir, 'personal');
    const fho = path.join(tmpDir, 'fho');
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    writeTranscript(fho, 'projB', 's-f.jsonl', [
      { type: 'user', sessionId: 'sf', timestamp: '2025-01-02T10:00:00Z' },
    ]);

    const data = run({
      DASHBOARD_ACCOUNT_ROOTS: `personal=${personal}:fho=${fho}`,
      DASHBOARD_STATS_CACHE: path.join(tmpDir, 'no-personal-cache.json'),
      DASHBOARD_ALT_STATS_CACHE: path.join(tmpDir, 'no-fho-cache.json'),
    });

    const sum = data.byAccount.personal.totalSessions + data.byAccount.fho.totalSessions;
    expect(data.totalSessions).toBe(sum);
  });

  it('does not error when the FHO stats-cache is missing', () => {
    const personal = path.join(tmpDir, 'personal');
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-01T10:00:00Z' },
    ]);

    const data = run({
      DASHBOARD_ACCOUNT_ROOTS: `personal=${personal}`,
      DASHBOARD_STATS_CACHE: path.join(tmpDir, 'no-personal-cache.json'),
      DASHBOARD_ALT_STATS_CACHE: path.join(tmpDir, 'definitely-missing.json'),
    });

    expect(data.byAccount.personal.totalSessions).toBe(1);
    // FHO has no root and no cache, so it is simply absent (not an error).
    expect(data.byAccount.fho).toBeUndefined();
  });

  it('folds the FHO historical stats-cache into dailyActivity', () => {
    const personal = path.join(tmpDir, 'personal');
    writeTranscript(personal, 'projA', 's-p.jsonl', [
      { type: 'user', sessionId: 'sp', timestamp: '2025-01-05T10:00:00Z' },
    ]);

    const personalCache = path.join(tmpDir, 'personal-cache.json');
    const fhoCache = path.join(tmpDir, 'fho-cache.json');
    fs.writeFileSync(personalCache, JSON.stringify({
      dailyActivity: [{ date: '2024-12-01', messageCount: 10, sessionCount: 2 }],
      firstSessionDate: '2024-12-01T00:00:00Z',
    }));
    fs.writeFileSync(fhoCache, JSON.stringify({
      dailyActivity: [
        { date: '2024-12-01', messageCount: 5, sessionCount: 1 },
        { date: '2024-11-01', messageCount: 3, sessionCount: 1 },
      ],
      firstSessionDate: '2024-11-01T00:00:00Z',
    }));

    const data = run({
      DASHBOARD_ACCOUNT_ROOTS: `personal=${personal}`,
      DASHBOARD_STATS_CACHE: personalCache,
      DASHBOARD_ALT_STATS_CACHE: fhoCache,
    });

    const dec1 = data.dailyActivity.find(d => d.date === '2024-12-01');
    expect(dec1.messageCount).toBe(15); // 10 personal + 5 fho
    expect(data.dailyActivity.some(d => d.date === '2024-11-01')).toBe(true);
    expect(data.firstSessionDate).toBe('2024-11-01T00:00:00Z');
  });
});
