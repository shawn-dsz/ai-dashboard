import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { parseSessionFile } = require('../build-session-cache.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSessionFile(lines) {
  const filePath = path.join(tmpDir, 'test.jsonl');
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'));
  return filePath;
}

describe('parseSessionFile', () => {
  it('returns empty sessions for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');
    const result = parseSessionFile(filePath);
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
  });

  it('parses user and assistant messages', () => {
    const filePath = writeSessionFile([
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'assistant', sessionId: 's1', timestamp: '2025-01-01T10:01:00Z', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);

    const result = parseSessionFile(filePath);
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].session_id).toBe('s1');
    expect(result.sessions[0].message_count).toBe(2);
  });

  it('extracts token usage', () => {
    const filePath = writeSessionFile([
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2025-01-01T10:00:00Z',
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 30,
          },
          content: [],
        },
      },
    ]);

    const result = parseSessionFile(filePath);
    const session = result.sessions[0];
    expect(session.total_input_tokens).toBe(100);
    expect(session.total_output_tokens).toBe(50);
    expect(session.total_cache_read_tokens).toBe(200);
    expect(session.total_cache_write_tokens).toBe(30);
  });

  it('counts tool calls', () => {
    const filePath = writeSessionFile([
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2025-01-01T10:00:00Z',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file' },
            { type: 'text', text: 'reading...' },
            { type: 'tool_use', name: 'write_file' },
          ],
        },
      },
    ]);

    const result = parseSessionFile(filePath);
    expect(result.sessions[0].tool_call_count).toBe(2);
  });

  it('groups messages by sessionId', () => {
    const filePath = writeSessionFile([
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'user', sessionId: 's2', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'assistant', sessionId: 's1', timestamp: '2025-01-01T10:01:00Z', message: { content: [] } },
    ]);

    const result = parseSessionFile(filePath);
    expect(result.sessions).toHaveLength(2);

    const s1 = result.sessions.find(s => s.session_id === 's1');
    const s2 = result.sessions.find(s => s.session_id === 's2');
    expect(s1.message_count).toBe(2);
    expect(s2.message_count).toBe(1);
  });

  it('computes start and end timestamps', () => {
    const filePath = writeSessionFile([
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T12:00:00Z' },
    ]);

    const result = parseSessionFile(filePath);
    const session = result.sessions[0];
    expect(session.start_timestamp).toBeLessThan(session.end_timestamp);
  });

  it('extracts git branch', () => {
    const filePath = writeSessionFile([
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z', gitBranch: 'feature/cool' },
    ]);

    const result = parseSessionFile(filePath);
    expect(result.sessions[0].git_branch).toBe('feature/cool');
  });

  it('tags each session with the supplied account label', () => {
    const filePath = writeSessionFile([
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'user', sessionId: 's2', timestamp: '2025-01-01T10:00:00Z' },
    ]);

    const result = parseSessionFile(filePath, 'fho');
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.every(s => s.account === 'fho')).toBe(true);
  });

  it('defaults the account tag to personal when none is supplied', () => {
    const filePath = writeSessionFile([
      { type: 'user', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z' },
    ]);

    const result = parseSessionFile(filePath);
    expect(result.sessions[0].account).toBe('personal');
  });

  it('skips non-message entry types', () => {
    const filePath = writeSessionFile([
      { type: 'system', sessionId: 's1', timestamp: '2025-01-01T10:00:00Z' },
      { type: 'tool_result', sessionId: 's1', timestamp: '2025-01-01T10:01:00Z' },
    ]);

    const result = parseSessionFile(filePath);
    expect(result.sessions).toHaveLength(0);
  });

  it('handles malformed JSON lines gracefully', () => {
    const filePath = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(filePath, '{"type":"user","sessionId":"s1","timestamp":"2025-01-01T10:00:00Z"}\nNOT JSON\n{"type":"user","sessionId":"s1","timestamp":"2025-01-01T10:01:00Z"}\n');

    const result = parseSessionFile(filePath);
    expect(result.success).toBe(true);
    expect(result.errors).toBe(1);
    expect(result.sessions[0].message_count).toBe(2);
  });

  it('returns failure for non-existent file', () => {
    const result = parseSessionFile('/nonexistent/file.jsonl');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
