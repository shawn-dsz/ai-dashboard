#!/usr/bin/env node
/**
 * Rebuild data.json from SQLite cache
 *
 * Generates a fresh data.json by querying the session cache DB.
 * Merges with existing stats-cache.json for model-specific fields
 * that cannot be derived from the DB alone (modelUsage, dailyModelTokens).
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const { getAccountRoots } = require('./account-roots');

const CACHE_DB = process.argv[2] || path.join(__dirname, '.cache', 'sessions.db');
const STATS_CACHE = process.env.DASHBOARD_STATS_CACHE
    || path.join(process.env.HOME, '.claude', 'stats-cache.json');
const ALT_STATS_CACHE = process.env.DASHBOARD_ALT_STATS_CACHE
    || path.join(process.env.HOME, '.claude-alt', 'stats-cache.json');
const OUTPUT = process.env.DASHBOARD_DATA_OUTPUT
    || path.join(__dirname, 'data.json');

/**
 * Merge two stats-cache.json structures into one.
 *
 * Used to fold the FHO (~/.claude-alt) historical cache into the personal
 * (~/.claude) cache so dailyActivity, hourCounts and model data span both
 * accounts. dailyActivity is summed per date; hourCounts and modelUsage are
 * summed per key; scalar totals are added; the earliest firstSessionDate
 * wins. Only the historical merge matters here, because live sessions come
 * from the SQLite cache downstream.
 */
function mergeStatsCaches(base, extra) {
    const merged = Object.assign({}, base);

    // dailyActivity: sum counts per date.
    const dailyByDate = new Map();
    for (const d of base.dailyActivity || []) {
        dailyByDate.set(d.date, Object.assign({}, d));
    }
    for (const d of extra.dailyActivity || []) {
        const cur = dailyByDate.get(d.date);
        if (cur) {
            cur.messageCount = (cur.messageCount || 0) + (d.messageCount || 0);
            cur.sessionCount = (cur.sessionCount || 0) + (d.sessionCount || 0);
            cur.toolCallCount = (cur.toolCallCount || 0) + (d.toolCallCount || 0);
            cur.totalTokens = (cur.totalTokens || 0) + (d.totalTokens || 0);
        } else {
            dailyByDate.set(d.date, Object.assign({}, d));
        }
    }
    merged.dailyActivity = Array.from(dailyByDate.values())
        .sort((a, b) => a.date.localeCompare(b.date));

    // hourCounts: sum per hour.
    merged.hourCounts = Object.assign({}, base.hourCounts || {});
    for (const [hour, count] of Object.entries(extra.hourCounts || {})) {
        merged.hourCounts[hour] = (merged.hourCounts[hour] || 0) + count;
    }

    // modelUsage: sum per model.
    merged.modelUsage = Object.assign({}, base.modelUsage || {});
    for (const [model, count] of Object.entries(extra.modelUsage || {})) {
        merged.modelUsage[model] = (merged.modelUsage[model] || 0) + count;
    }

    // dailyModelTokens: concatenate (kept as-is for downstream consumers).
    merged.dailyModelTokens = [
        ...(base.dailyModelTokens || []),
        ...(extra.dailyModelTokens || []),
    ];

    // Scalars.
    merged.totalSpeculationTimeSavedMs =
        (base.totalSpeculationTimeSavedMs || 0) + (extra.totalSpeculationTimeSavedMs || 0);

    // Earliest first-session date wins.
    if (extra.firstSessionDate) {
        merged.firstSessionDate = base.firstSessionDate
            ? (extra.firstSessionDate < base.firstSessionDate ? extra.firstSessionDate : base.firstSessionDate)
            : extra.firstSessionDate;
    }

    return merged;
}

async function main() {
    if (!fs.existsSync(CACHE_DB)) {
        console.error('❌ Cache DB not found:', CACHE_DB);
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const dbBuffer = fs.readFileSync(CACHE_DB);
    const db = new SQL.Database(dbBuffer);

    // Load existing stats-cache for model-specific data we cannot derive.
    // The personal cache (~/.claude) is the base; the FHO cache
    // (~/.claude-alt) is merged on top when present. FHO has no cache
    // today, so the missing case is handled gracefully (no error).
    let existing = {};
    if (fs.existsSync(STATS_CACHE)) {
        try {
            existing = JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8'));
        } catch (e) {
            console.warn('⚠️  Could not parse existing stats-cache.json, starting fresh');
        }
    }

    if (fs.existsSync(ALT_STATS_CACHE)) {
        try {
            const altExisting = JSON.parse(fs.readFileSync(ALT_STATS_CACHE, 'utf8'));
            existing = mergeStatsCaches(existing, altExisting);
            console.log('   🔀 Merged FHO stats-cache.json');
        } catch (e) {
            console.warn('⚠️  Could not parse FHO stats-cache.json, skipping');
        }
    }

    // Daily activity from DB
    const dailyRows = db.exec(`
        SELECT date, message_count, session_count, tool_call_count, total_tokens
        FROM daily_stats
        ORDER BY date ASC
    `);

    const dailyActivity = [];
    if (dailyRows.length > 0) {
        for (const row of dailyRows[0].values) {
            dailyActivity.push({
                date: row[0],
                messageCount: row[1],
                sessionCount: row[2],
                toolCallCount: row[3],
                totalTokens: row[4]
            });
        }
    }

    // Totals
    const totalsResult = db.exec(`
        SELECT
            COUNT(*) as totalSessions,
            COALESCE(SUM(message_count), 0) as totalMessages
        FROM sessions
    `);
    const totalSessions = totalsResult[0]?.values[0]?.[0] || 0;
    const totalMessages = totalsResult[0]?.values[0]?.[1] || 0;

    // Per-account totals from the DB, keyed by account label. Every known
    // account is represented (zero-filled) so the dashboard can render a
    // stable personal/FHO filter even before FHO has any sessions.
    const accountAgg = db.exec(`
        SELECT
            COALESCE(account, 'personal') as account,
            COUNT(*) as totalSessions,
            COALESCE(SUM(message_count), 0) as totalMessages,
            COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_write_tokens), 0) as totalTokens,
            COALESCE(SUM(tool_call_count), 0) as totalToolCalls
        FROM sessions
        GROUP BY COALESCE(account, 'personal')
    `);

    const byAccount = {};
    for (const acct of getAccountRoots()) {
        byAccount[acct.label] = { totalSessions: 0, totalMessages: 0, totalTokens: 0, totalToolCalls: 0 };
    }
    if (accountAgg.length > 0) {
        for (const row of accountAgg[0].values) {
            byAccount[row[0]] = {
                totalSessions: row[1],
                totalMessages: row[2],
                totalTokens: row[3],
                totalToolCalls: row[4],
            };
        }
    }

    // Hour counts from session start times
    const hourRows = db.exec(`
        SELECT
            CAST(strftime('%H', start_timestamp, 'unixepoch', 'localtime') AS INTEGER) as hour,
            COUNT(*) as count
        FROM sessions
        WHERE start_timestamp IS NOT NULL
        GROUP BY hour
        ORDER BY hour
    `);

    const hourCounts = {};
    if (hourRows.length > 0) {
        for (const row of hourRows[0].values) {
            hourCounts[String(row[0])] = row[1];
        }
    }

    // Longest session
    const longestResult = db.exec(`
        SELECT session_id, end_timestamp - start_timestamp as duration, message_count, start_timestamp
        FROM sessions
        WHERE start_timestamp IS NOT NULL AND end_timestamp IS NOT NULL
        ORDER BY duration DESC
        LIMIT 1
    `);

    let longestSession = existing.longestSession || {};
    if (longestResult.length > 0) {
        const row = longestResult[0].values[0];
        const durationMs = (row[1] || 0) * 1000;
        longestSession = {
            sessionId: row[0],
            duration: durationMs,
            messageCount: row[2],
            timestamp: new Date((row[3] || 0) * 1000).toISOString()
        };
    }

    // First session date
    const firstResult = db.exec(`
        SELECT MIN(start_timestamp) FROM sessions WHERE start_timestamp IS NOT NULL
    `);
    const firstTimestamp = firstResult[0]?.values[0]?.[0];
    const firstSessionDate = firstTimestamp
        ? new Date(firstTimestamp * 1000).toISOString()
        : existing.firstSessionDate || null;

    // Merge historical dailyActivity from stats-cache for dates not in the DB
    // This preserves data from older sessions whose JSONL files are no longer on disk
    const dbDates = new Set(dailyActivity.map(d => d.date));
    const historicalDays = (existing.dailyActivity || []).filter(d => !dbDates.has(d.date));
    const mergedDailyActivity = [...historicalDays, ...dailyActivity]
        .sort((a, b) => a.date.localeCompare(b.date));

    // Merge totals: add historical sessions/messages for dates not covered by DB
    const historicalSessions = historicalDays.reduce((s, d) => s + (d.sessionCount || 0), 0);
    const historicalMessages = historicalDays.reduce((s, d) => s + (d.messageCount || 0), 0);
    const mergedTotalSessions = totalSessions + historicalSessions;
    const mergedTotalMessages = totalMessages + historicalMessages;

    // Merge hourCounts with historical hour counts
    const mergedHourCounts = Object.assign({}, hourCounts);
    if (existing.hourCounts) {
        Object.entries(existing.hourCounts).forEach(([hour, count]) => {
            mergedHourCounts[hour] = (mergedHourCounts[hour] || 0) + count;
        });
    }

    // Last computed date
    const lastDate = mergedDailyActivity.length > 0
        ? mergedDailyActivity[mergedDailyActivity.length - 1].date
        : existing.lastComputedDate || null;

    // First session date: use earliest from DB or existing cache
    const mergedFirstSessionDate = firstSessionDate && existing.firstSessionDate
        ? (firstSessionDate < existing.firstSessionDate ? firstSessionDate : existing.firstSessionDate)
        : firstSessionDate || existing.firstSessionDate || null;

    // Build output, keeping model-specific data from existing cache
    const output = {
        version: 2,
        lastComputedDate: lastDate,
        dailyActivity: mergedDailyActivity,
        dailyModelTokens: existing.dailyModelTokens || [],
        modelUsage: existing.modelUsage || {},
        totalSessions: mergedTotalSessions,
        totalMessages: mergedTotalMessages,
        byAccount,
        longestSession,
        firstSessionDate: mergedFirstSessionDate,
        hourCounts: mergedHourCounts,
        totalSpeculationTimeSavedMs: existing.totalSpeculationTimeSavedMs || 0
    };

    // Remove symlink if it exists, then write a real file
    try {
        const stat = fs.lstatSync(OUTPUT);
        if (stat.isSymbolicLink()) {
            fs.unlinkSync(OUTPUT);
        }
    } catch (e) {
        // File does not exist, that is fine
    }

    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

    console.log('✅ data.json rebuilt');
    console.log('   📅 ' + mergedDailyActivity.length + ' days (' + (mergedFirstSessionDate ? mergedFirstSessionDate.split('T')[0] : '?') + ' to ' + (lastDate || '?') + ')');
    console.log('   📊 ' + mergedTotalSessions + ' sessions, ' + mergedTotalMessages + ' messages');
    console.log('   ⏰ ' + Object.keys(mergedHourCounts).length + ' active hours tracked');

    db.close();
}

main().catch(function(err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
