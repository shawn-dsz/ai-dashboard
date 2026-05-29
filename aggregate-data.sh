#!/bin/bash
# Claude Code Dashboard Data Aggregation Script
# Generates projects.json and sessions.json from SQLite cache

set -e

# Default projects dir for the primary (personal) account. Account roots
# are resolved inside build-session-cache.js via account-roots.js, which
# also handles the FHO account and any DASHBOARD_ACCOUNT_ROOTS override.
PROJECTS_DIR="$HOME/.claude/projects"
DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DB="$DEST_DIR/.cache/sessions.db"
CACHE_SCRIPT="$DEST_DIR/build-session-cache.js"

echo "📊 Aggregating Claude Code data..."
echo ""

# Sanity check: the primary account projects directory should exist unless a
# custom DASHBOARD_ACCOUNT_ROOTS override is in use.
if [ -z "$DASHBOARD_ACCOUNT_ROOTS" ] && [ ! -d "$PROJECTS_DIR" ]; then
    echo "❌ Error: $PROJECTS_DIR not found"
    echo "   Make sure you've used Claude Code at least once."
    exit 1
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js not found"
    echo "   Install with: brew install node"
    exit 1
fi

# Build/update the session cache
echo "🗄️  Building session cache..."
node "$CACHE_SCRIPT" "$CACHE_DB"
echo ""

# Check if cache was created
if [ ! -f "$CACHE_DB" ]; then
    echo "❌ Error: Cache database not found at $CACHE_DB"
    exit 1
fi

# Generate projects.json from cache
echo "📁 Generating projects.json..."
PROJECTS_OUTPUT="$DEST_DIR/projects.json"

# Query cache for project stats
sqlite3 -json "$CACHE_DB" "
    SELECT
        project_path as path,
        COUNT(*) as sessionCount,
        MAX(sessions.end_timestamp) as lastTimestamp
    FROM files
    LEFT JOIN sessions ON files.id = sessions.file_id
    GROUP BY project_path
    ORDER BY path
" > "$PROJECTS_OUTPUT.tmp"

# Convert SQLite JSON array to proper format (add brackets and handle empty)
if [ -s "$PROJECTS_OUTPUT.tmp" ]; then
    # File has content, use it as-is
    mv "$PROJECTS_OUTPUT.tmp" "$PROJECTS_OUTPUT"
else
    # Empty result
    echo "[]" > "$PROJECTS_OUTPUT"
    rm -f "$PROJECTS_OUTPUT.tmp"
fi

echo "✅ projects.json generated"

# Generate sessions.json from cache (recent 100 sessions)
echo ""
echo "📝 Generating sessions.json..."
SESSIONS_OUTPUT="$DEST_DIR/sessions.json"

sqlite3 -json "$CACHE_DB" "
    SELECT
        s.session_id as sessionId,
        f.project_path as project,
        s.start_timestamp as startTime,
        s.end_timestamp as endTime,
        s.message_count as messageCount,
        s.total_input_tokens + s.total_output_tokens + s.total_cache_read_tokens + s.total_cache_write_tokens as totalTokens,
        s.git_branch as gitBranch,
        COALESCE(s.account, 'personal') as account
    FROM sessions s
    JOIN files f ON s.file_id = f.id
    WHERE s.start_timestamp IS NOT NULL
    ORDER BY s.start_timestamp DESC
    LIMIT 100
" > "$SESSIONS_OUTPUT.tmp"

# Handle empty result
if [ -s "$SESSIONS_OUTPUT.tmp" ]; then
    mv "$SESSIONS_OUTPUT.tmp" "$SESSIONS_OUTPUT"
else
    echo "[]" > "$SESSIONS_OUTPUT"
    rm -f "$SESSIONS_OUTPUT.tmp"
fi

echo "✅ sessions.json generated"

# Print summary
echo ""
echo "🎉 Data aggregation complete!"
echo "   📁 $PROJECTS_OUTPUT"
echo "   📁 $SESSIONS_OUTPUT"

# Show cache stats
TOTAL_SESSIONS=$(sqlite3 "$CACHE_DB" "SELECT COUNT(*) FROM sessions" 2>/dev/null || echo "0")
TOTAL_PROJECTS=$(sqlite3 "$CACHE_DB" "SELECT COUNT(DISTINCT project_path) FROM files" 2>/dev/null || echo "0")
echo "   📊 Cache: $TOTAL_SESSIONS sessions across $TOTAL_PROJECTS projects"
