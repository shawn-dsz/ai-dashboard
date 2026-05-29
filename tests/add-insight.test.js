import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG_PATH = path.join(ROOT, 'insights-log.json');
const SCRIPT = path.join(ROOT, 'add-insight.js');

const VALID_ENTRY = {
    weekOf: '2099-01-01',
    generatedAt: '2099-01-07',
    metrics: {
        sessions: 100,
        messages: 2000,
        tokens: 1000000,
        busiestHour: 14,
        busiestDay: '2099-01-05',
        delegationRatio: 0.5,
    },
    whatsWorking: ['Thing A worked well'],
    friction: ['Thing B was slow'],
    tips: ['Do X more often'],
    notes: 'Test note',
};

let originalLog;

beforeEach(() => {
    // Preserve the real log
    if (fs.existsSync(LOG_PATH)) {
        originalLog = fs.readFileSync(LOG_PATH, 'utf8');
    } else {
        originalLog = null;
    }
    // Start with an empty log for each test
    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
});

afterEach(() => {
    // Restore original log
    if (originalLog !== null) {
        fs.writeFileSync(LOG_PATH, originalLog, 'utf8');
    } else if (fs.existsSync(LOG_PATH)) {
        fs.unlinkSync(LOG_PATH);
    }
});

function runScript(args) {
    return execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
    });
}

function runScriptExpectFailure(args) {
    try {
        execFileSync(process.execPath, [SCRIPT, ...args], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        throw new Error('Expected script to exit with error but it succeeded');
    } catch (e) {
        if (e.message === 'Expected script to exit with error but it succeeded') throw e;
        return { stderr: e.stderr, status: e.status };
    }
}

function writeEntryFile(entry) {
    const tmpPath = path.join(ROOT, '_test-entry.json');
    fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf8');
    return tmpPath;
}

describe('add-insight.js', () => {
    it('appends a valid entry via --file', () => {
        const tmpFile = writeEntryFile(VALID_ENTRY);
        try {
            runScript(['--file', tmpFile]);
            const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
            expect(log).toHaveLength(1);
            expect(log[0].weekOf).toBe('2099-01-01');
            expect(log[0].metrics.sessions).toBe(100);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });

    it('prepends (newest first) when a second entry is added', () => {
        const entryA = { ...VALID_ENTRY, weekOf: '2099-01-01', generatedAt: '2099-01-07' };
        const entryB = { ...VALID_ENTRY, weekOf: '2099-01-08', generatedAt: '2099-01-14' };

        const tmpA = path.join(ROOT, '_test-entry-a.json');
        const tmpB = path.join(ROOT, '_test-entry-b.json');
        fs.writeFileSync(tmpA, JSON.stringify(entryA), 'utf8');
        fs.writeFileSync(tmpB, JSON.stringify(entryB), 'utf8');
        try {
            runScript(['--file', tmpA]);
            runScript(['--file', tmpB]);
            const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
            expect(log).toHaveLength(2);
            // Newest first
            expect(log[0].weekOf).toBe('2099-01-08');
            expect(log[1].weekOf).toBe('2099-01-01');
        } finally {
            [tmpA, tmpB].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        }
    });

    it('rejects duplicate weekOf', () => {
        const tmpFile = writeEntryFile(VALID_ENTRY);
        try {
            runScript(['--file', tmpFile]);
            const result = runScriptExpectFailure(['--file', tmpFile]);
            expect(result.stderr).toContain('2099-01-01');
            expect(result.status).toBe(1);
            // Log should still have only one entry
            const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
            expect(log).toHaveLength(1);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });

    it('rejects entry with invalid weekOf', () => {
        const bad = { ...VALID_ENTRY, weekOf: 'not-a-date' };
        const tmpFile = writeEntryFile(bad);
        try {
            const result = runScriptExpectFailure(['--file', tmpFile]);
            expect(result.stderr).toContain('weekOf');
            expect(result.status).toBe(1);
            const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
            expect(log).toHaveLength(0);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });

    it('rejects entry with non-number sessions', () => {
        const bad = {
            ...VALID_ENTRY,
            metrics: { ...VALID_ENTRY.metrics, sessions: 'many' },
        };
        const tmpFile = writeEntryFile(bad);
        try {
            const result = runScriptExpectFailure(['--file', tmpFile]);
            expect(result.stderr).toContain('sessions');
            expect(result.status).toBe(1);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });

    it('rejects entry with delegationRatio > 1', () => {
        const bad = {
            ...VALID_ENTRY,
            weekOf: '2099-02-01',
            metrics: { ...VALID_ENTRY.metrics, delegationRatio: 1.5 },
        };
        const tmpFile = writeEntryFile(bad);
        try {
            const result = runScriptExpectFailure(['--file', tmpFile]);
            expect(result.stderr).toContain('delegationRatio');
            expect(result.status).toBe(1);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });

    it('rejects missing --file path', () => {
        const result = runScriptExpectFailure(['--file']);
        expect(result.status).toBe(1);
    });

    it('adds generatedAt default when omitted', () => {
        const entry = { ...VALID_ENTRY };
        delete entry.generatedAt;
        const tmpFile = writeEntryFile(entry);
        try {
            runScript(['--file', tmpFile]);
            const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
            expect(log[0].generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });
});
