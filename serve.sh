#!/bin/bash
# Claude Code Dashboard Server
# Usage: ./serve.sh [port]

PORT="${1:-8081}"
HOST="claude-dashboard"
URL="http://${HOST}:${PORT}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Starting Claude Code Dashboard..."
echo ""

# Build session cache and aggregate data
if [ -f "$DIR/aggregate-data.sh" ]; then
    echo "📊 Aggregating data..."
    bash "$DIR/aggregate-data.sh"
    echo ""
fi

# Rebuild data.json from SQLite cache
if [ -f "$DIR/rebuild-stats.js" ]; then
    echo "📈 Rebuilding stats..."
    node "$DIR/rebuild-stats.js"
    echo ""
fi

# Ensure hosts entries exist
for h in "$HOST" "claude-agents"; do
    if ! grep -q "$h" /etc/hosts 2>/dev/null; then
        echo "⚠️  No /etc/hosts entry for $h."
        echo "   Run: sudo sh -c 'echo \"127.0.0.1 $h\" >> /etc/hosts'"
        echo ""
    fi
done

echo "📁 Directory: $DIR"
echo "🌐 Activity:  http://${HOST}:${PORT}/index.html"
echo "🖥️  Agents:    http://claude-agents:${PORT}/"
echo ""
echo "Theme toggle is available in the app (🌙/☀️ button)"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Change to the project directory
cd "$DIR"

# Start the Node server (static files + API proxy to claude-peers broker)
node "$DIR/server.js" "$PORT" &
SERVER_PID=$!

# Wait a moment for server to start
sleep 0.5

# Open browser to agents homepage
open "http://claude-agents:${PORT}/"

# Wait for the server process
wait $SERVER_PID
