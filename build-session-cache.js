#!/usr/bin/env node
/**
 * Claude Code Session Cache Builder
 * Builds a SQLite cache from session files in ~/.claude/projects/
 * Uses sql.js (pure JavaScript SQLite - no native compilation required)
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAccountRoots } = require('./account-roots');

const CACHE_PATH = process.argv[2] || path.join(__dirname, '.cache', 'sessions.db');

// Statistics
const stats = {
    totalFiles: 0,
    newFiles: 0,
    modifiedFiles: 0,
    skippedFiles: 0,
    errorFiles: 0,
    totalSessions: 0,
    processedSessions: 0
};

let db = null;

/**
 * Initialize database schema
 */
function initDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT UNIQUE NOT NULL,
            project_path TEXT NOT NULL,
            mtime REAL NOT NULL,
            size INTEGER NOT NULL,
            checksum TEXT,
            processed_at REAL NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            agent_id TEXT,
            start_timestamp REAL,
            end_timestamp REAL,
            message_count INTEGER DEFAULT 0,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            total_cache_read_tokens INTEGER DEFAULT 0,
            total_cache_write_tokens INTEGER DEFAULT 0,
            tool_call_count INTEGER DEFAULT 0,
            git_branch TEXT,
            account TEXT DEFAULT 'personal',
            FOREIGN KEY (file_id) REFERENCES files(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS daily_stats (
            date TEXT PRIMARY KEY,
            message_count INTEGER DEFAULT 0,
            session_count INTEGER DEFAULT 0,
            tool_call_count INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            updated_at REAL NOT NULL
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_files_path ON files(file_path)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_path)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_file_id ON sessions(file_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(start_timestamp)`);

    // Migrate pre-existing caches that predate the account column.
    migrateSchema();
}

/**
 * Add columns to existing caches that predate newer schema versions.
 * Idempotent: only adds the account column when it is missing.
 */
function migrateSchema() {
    const cols = db.exec('PRAGMA table_info(sessions)');
    const names = cols.length > 0 ? cols[0].values.map(row => row[1]) : [];
    if (!names.includes('account')) {
        db.run(`ALTER TABLE sessions ADD COLUMN account TEXT DEFAULT 'personal'`);
    }
}

/**
 * Save database to file
 */
function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(CACHE_PATH, buffer);
}

/**
 * Load existing database from file
 */
function loadDatabase(SQL) {
    if (fs.existsSync(CACHE_PATH)) {
        const buffer = fs.readFileSync(CACHE_PATH);
        return new SQL.Database(buffer);
    }
    return new SQL.Database();
}

/**
 * Get file stats (mtime, size)
 */
function getFileStats(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return {
            mtime: stat.mtimeMs / 1000, // Convert to seconds
            size: stat.size
        };
    } catch (err) {
        return null;
    }
}

/**
 * Calculate SHA256 checksum of file
 */
function calculateChecksum(filePath) {
    try {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    } catch (err) {
        return null;
    }
}

/**
 * Check if file needs processing
 */
function shouldProcessFile(filePath, currentStats) {
    const stmt = db.prepare('SELECT mtime, checksum FROM files WHERE file_path = :path');
    const cached = stmt.getAsObject({':path': filePath});

    if (!cached || Object.keys(cached).length === 0) {
        return { needed: true, reason: 'new' };
    }

    if (cached.mtime !== currentStats.mtime) {
        return { needed: true, reason: 'modified' };
    }

    return { needed: false, reason: 'unchanged' };
}

/**
 * Parse JSONL session file and extract metadata
 */
function parseSessionFile(filePath, account = 'personal') {
    const sessions = new Map();
    let lineCount = 0;
    let errors = 0;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());

        for (const line of lines) {
            lineCount++;
            try {
                const entry = JSON.parse(line);

                // Skip non-message entries
                if (entry.type !== 'user' && entry.type !== 'assistant') {
                    continue;
                }

                // Determine session ID
                const sessionId = entry.sessionId || entry.uuid || 'unknown';
                const agentId = entry.agentId || null;

                if (!sessions.has(sessionId)) {
                    sessions.set(sessionId, {
                        session_id: sessionId,
                        agent_id: agentId,
                        account: account,
                        message_count: 0,
                        total_input_tokens: 0,
                        total_output_tokens: 0,
                        total_cache_read_tokens: 0,
                        total_cache_write_tokens: 0,
                        tool_call_count: 0,
                        git_branch: null,
                        timestamps: []
                    });
                }

                const session = sessions.get(sessionId);

                // Update message count
                session.message_count++;

                // Extract token usage
                if (entry.message?.usage) {
                    const usage = entry.message.usage;
                    session.total_input_tokens += usage.input_tokens || 0;
                    session.total_output_tokens += usage.output_tokens || 0;
                    session.total_cache_read_tokens += usage.cache_read_input_tokens || 0;
                    session.total_cache_write_tokens += usage.cache_creation_input_tokens || 0;
                }

                // Count tool calls (content blocks with type === 'tool_use')
                if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
                    session.tool_call_count += entry.message.content.filter(b => b.type === 'tool_use').length;
                }

                // Extract git branch if available
                if (entry.gitBranch && !session.git_branch) {
                    session.git_branch = entry.gitBranch;
                }

                // Track timestamps
                if (entry.timestamp) {
                    const ts = new Date(entry.timestamp).getTime() / 1000;
                    session.timestamps.push(ts);
                }

            } catch (parseErr) {
                errors++;
            }
        }

        // Compute start/end timestamps
        for (const session of sessions.values()) {
            if (session.timestamps.length > 0) {
                session.start_timestamp = Math.min(...session.timestamps);
                session.end_timestamp = Math.max(...session.timestamps);
            }
            delete session.timestamps;
        }

        return { success: true, sessions: Array.from(sessions.values()), lineCount, errors };

    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Process a single session file
 */
function processFile(filePath, projectPath, account = 'personal') {
    const fileStats = getFileStats(filePath);
    if (!fileStats) {
        stats.errorFiles++;
        return;
    }

    stats.totalFiles++;

    const check = shouldProcessFile(filePath, fileStats);

    if (!check.needed) {
        stats.skippedFiles++;
        return;
    }

    // Parse the file
    const result = parseSessionFile(filePath, account);

    if (!result.success) {
        console.error(`  ❌ Error parsing ${filePath}: ${result.error}`);
        stats.errorFiles++;
        return;
    }

    // Calculate checksum
    const checksum = calculateChecksum(filePath);

    const now = Date.now() / 1000;

    // Insert/update file record
    const insertFile = db.prepare(`
        INSERT OR REPLACE INTO files (file_path, project_path, mtime, size, checksum, processed_at)
        VALUES (:path, :project, :mtime, :size, :checksum, :processed)
    `);

    insertFile.run({
        ':path': filePath,
        ':project': projectPath,
        ':mtime': fileStats.mtime,
        ':size': fileStats.size,
        ':checksum': checksum,
        ':processed': now
    });

    // Get the file_id
    const fileIdStmt = db.prepare('SELECT id FROM files WHERE file_path = :path');
    const fileIdResult = fileIdStmt.getAsObject({':path': filePath});
    const fileId = fileIdResult.id;

    // Delete old sessions for this file
    db.prepare('DELETE FROM sessions WHERE file_id = :id').run({':id': fileId});

    // Insert new sessions
    const insertSession = db.prepare(`
        INSERT INTO sessions (
            file_id, session_id, agent_id, start_timestamp, end_timestamp,
            message_count, total_input_tokens, total_output_tokens,
            total_cache_read_tokens, total_cache_write_tokens, tool_call_count, git_branch, account
        ) VALUES (
            :file_id, :session_id, :agent_id, :start_ts, :end_ts,
            :msg_count, :in_tokens, :out_tokens,
            :cache_read, :cache_write, :tool_count, :git_branch, :account
        )
    `);

    for (const session of result.sessions) {
        insertSession.run({
            ':file_id': fileId,
            ':session_id': session.session_id,
            ':agent_id': session.agent_id,
            ':start_ts': session.start_timestamp,
            ':end_ts': session.end_timestamp,
            ':msg_count': session.message_count,
            ':in_tokens': session.total_input_tokens,
            ':out_tokens': session.total_output_tokens,
            ':cache_read': session.total_cache_read_tokens,
            ':cache_write': session.total_cache_write_tokens,
            ':tool_count': session.tool_call_count,
            ':git_branch': session.git_branch,
            ':account': session.account || account
        });
        stats.processedSessions++;
    }

    if (check.reason === 'new') {
        stats.newFiles++;
    } else {
        stats.modifiedFiles++;
    }

    stats.totalSessions += result.sessions.length;
}

/**
 * Scan and process all project directories across every account root.
 * Each account (personal, fho) is scanned in turn and its sessions are
 * tagged with the account label. Accounts whose projects dir is missing or
 * empty are skipped by the account-roots helper, so this never errors when
 * an account (e.g. FHO) has no transcripts yet.
 */
function scanProjects() {
    const accounts = getAccountRoots();

    if (accounts.length === 0) {
        console.error('❌ No account projects directories found to scan');
        process.exit(1);
    }

    console.log(`👤 Scanning ${accounts.length} account(s): ${accounts.map(a => a.label).join(', ')}`);
    console.log('');

    for (const account of accounts) {
        const projectsDir = account.projectsDir;
        const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        console.log(`📁 [${account.label}] Found ${projectDirs.length} project directories`);

        for (const projectName of projectDirs) {
            const projectPath = path.join(projectsDir, projectName);
            const sessionFiles = fs.readdirSync(projectPath)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => path.join(projectPath, f));

            if (sessionFiles.length === 0) continue;

            console.log(`  📂 ${projectName} (${sessionFiles.length} files)`);

            for (const filePath of sessionFiles) {
                processFile(filePath, projectName, account.label);
            }
        }
        console.log('');
    }
}

/**
 * Rebuild daily stats aggregate table
 */
function rebuildDailyStats() {
    console.log('');
    console.log('📊 Building daily aggregates...');

    db.run('DELETE FROM daily_stats');

    const stmt = db.prepare(`
        SELECT
            date(start_timestamp, 'unixepoch', 'localtime') as date,
            SUM(message_count) as message_count,
            COUNT(*) as session_count,
            SUM(tool_call_count) as tool_call_count,
            SUM(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_write_tokens) as total_tokens
        FROM sessions
        WHERE start_timestamp IS NOT NULL
        GROUP BY date(start_timestamp, 'unixepoch', 'localtime')
        ORDER BY date
    `);

    // Collect all rows
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();

    const insertDaily = db.prepare(`
        INSERT OR REPLACE INTO daily_stats (date, message_count, session_count, tool_call_count, total_tokens, updated_at)
        VALUES (:date, :msg_count, :sess_count, :tool_count, :tokens, :updated)
    `);

    const now = Date.now() / 1000;
    for (const row of rows) {
        insertDaily.run({
            ':date': row.date,
            ':msg_count': row.message_count,
            ':sess_count': row.session_count,
            ':tool_count': row.tool_call_count,
            ':tokens': row.total_tokens,
            ':updated': now
        });
    }

    console.log(`  ✅ Generated ${rows.length} daily stats`);
}

/**
 * Main execution
 */
async function main() {
    console.log('🗄️  Building Claude Code session cache...');
    console.log(`📁 Cache: ${CACHE_PATH}`);
    console.log(`📁 Source: ${getAccountRoots().map(a => `${a.label} → ${a.projectsDir}`).join(', ') || '(none)'}`);
    console.log('');

    // Ensure cache directory exists
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load or create database
    db = loadDatabase(SQL);

    try {
        // Initialize schema
        initDatabase();

        // Scan and process files
        const startTime = Date.now();
        scanProjects();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Rebuild aggregates
        rebuildDailyStats();

        // Save database
        saveDatabase();

        // Print summary
        console.log('');
        console.log('✅ Cache build complete!');
        console.log('');
        console.log('📊 Summary:');
        console.log(`  Total files scanned: ${stats.totalFiles}`);
        console.log(`  New files: ${stats.newFiles}`);
        console.log(`  Modified files: ${stats.modifiedFiles}`);
        console.log(`  Skipped (unchanged): ${stats.skippedFiles}`);
        console.log(`  Errors: ${stats.errorFiles}`);
        console.log(`  Total sessions: ${stats.totalSessions}`);
        console.log(`  Sessions processed: ${stats.processedSessions}`);
        console.log(`  Time: ${elapsed}s`);

    } finally {
        db.close();
    }
}

// Export for testing
if (require.main === module) {
    main();
}

module.exports = { parseSessionFile };
