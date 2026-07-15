#!/bin/bash
# Claude Code Dashboard Server
# Usage: ./serve.sh [port]

PORT="${1:-8081}"
HOST="ai-dashboard"
URL="http://localhost:${PORT}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting AI Dashboard..."
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

# Optional hosts entries (legacy names still fine)
for h in "ai-dashboard" "claude-dashboard" "claude-agents"; do
    if ! grep -q "$h" /etc/hosts 2>/dev/null; then
        echo "Note: no /etc/hosts entry for $h (optional)."
        echo "  sudo sh -c 'echo \"127.0.0.1 $h\" >> /etc/hosts'"
    fi
done

echo "Directory: $DIR"
echo "AI usage:  http://localhost:${PORT}/"
echo "Claude UI: http://localhost:${PORT}/claude-activity.html"
echo "Agents:    http://localhost:${PORT}/home.html"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

cd "$DIR"

node "$DIR/server.js" "$PORT" &
SERVER_PID=$!

sleep 0.5
open "http://localhost:${PORT}/" 2>/dev/null || true

wait $SERVER_PID
