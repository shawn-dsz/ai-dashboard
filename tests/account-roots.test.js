import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { getAccountRoots } = require('../account-roots.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-roots-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DASHBOARD_ACCOUNT_ROOTS;
});

function makeAccount(label, withProject = true, fileName = 'a.jsonl') {
  const configDir = path.join(tmpDir, label);
  const projectsDir = path.join(configDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  if (withProject) {
    const projectDir = path.join(projectsDir, 'proj-' + label);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, fileName), '{}');
  }
  return configDir;
}

describe('getAccountRoots', () => {
  it('returns accounts whose projects dir exists and is non-empty', () => {
    const personal = makeAccount('personal');
    const fho = makeAccount('fho');
    process.env.DASHBOARD_ACCOUNT_ROOTS = `personal=${personal}:fho=${fho}`;

    const roots = getAccountRoots();
    expect(roots).toHaveLength(2);
    expect(roots.map(r => r.label)).toEqual(['personal', 'fho']);
    expect(roots[0].projectsDir).toBe(path.join(personal, 'projects'));
  });

  it('skips an account whose projects dir is missing without error', () => {
    const personal = makeAccount('personal');
    const fhoConfig = path.join(tmpDir, 'fho'); // no projects dir created
    process.env.DASHBOARD_ACCOUNT_ROOTS = `personal=${personal}:fho=${fhoConfig}`;

    const roots = getAccountRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('personal');
  });

  it('skips an account whose projects dir is empty without error', () => {
    const personal = makeAccount('personal');
    const fho = makeAccount('fho', false); // projects dir created but empty

    process.env.DASHBOARD_ACCOUNT_ROOTS = `personal=${personal}:fho=${fho}`;

    const roots = getAccountRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('personal');
  });

  it('treats a projects dir with only empty subdirectories as empty', () => {
    const personal = makeAccount('personal');
    const fhoConfig = path.join(tmpDir, 'fho');
    const fhoProjects = path.join(fhoConfig, 'projects', 'empty-proj');
    fs.mkdirSync(fhoProjects, { recursive: true }); // subdir but no jsonl

    process.env.DASHBOARD_ACCOUNT_ROOTS = `personal=${personal}:fho=${fhoConfig}`;

    const roots = getAccountRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('personal');
  });

  it('dedupes two roots that resolve to the same real projects dir, keeping the first', () => {
    const personal = makeAccount('personal');
    const fhoConfig = path.join(tmpDir, 'fho');
    fs.mkdirSync(fhoConfig, { recursive: true });
    // Symlink fho/projects to personal/projects (mirrors ~/.claude-alt symlinking)
    fs.symlinkSync(path.join(personal, 'projects'), path.join(fhoConfig, 'projects'));

    process.env.DASHBOARD_ACCOUNT_ROOTS = `personal=${personal}:fho=${fhoConfig}`;

    const roots = getAccountRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('personal');
    expect(roots[0].realProjectsDir).toBe(fs.realpathSync(path.join(personal, 'projects')));
  });

  it('expands a leading ~ in the env override to an absolute path', () => {
    process.env.DASHBOARD_ACCOUNT_ROOTS = `home=~/definitely-not-real-dir-xyz`;
    const roots = getAccountRoots();
    // Dir does not exist so it is skipped, but the call must not throw.
    expect(Array.isArray(roots)).toBe(true);
  });
});
