# AI Dashboard

Local multi-provider **token usage** dashboard for Shawn’s machine.

| Tab | Source | Metric |
|-----|--------|--------|
| **Claude** | Claude Code `data.json` / `~/.claude/stats-cache.json` | Real model tokens (in/out/cache) |
| **Grok** | `~/.grok/sessions` via `~/proj/grok-usage` | Peak context intensity + model id |
| **OpenAI** | Codex rollout JSONL under `~/.codex` | Real `total_token_usage` |
| **Kimi** | `kimi-dashboard/kimi_stats.json` or `~/.kimi/kimi-stats.py` | Session tokens |
| **GLM** | Claude Code modelUsage keys matching `glm*` | Real tokens (routed via Claude Code) |

Light theme by default; toggle to dark. Not vendor invoices.

## Quick start

```bash
cd ~/proj/ai-dashboard
./serve.sh                        # default port 8081
# open http://localhost:8081/
```

API:

```bash
curl -s 'http://localhost:8081/api/ai-usage?days=30' | head
```

Collectors live in `lib/ai-usage/` (Python). The Node server shells out to:

```bash
PYTHONPATH=lib/ai-usage:~/proj/grok-usage python3 lib/ai-usage/app.py scan --days 30
```

## Pages

| URL | What |
|-----|------|
| `/` or `/index.html` | **AI Dashboard** (5 tabs + charts) |
| `/claude-activity.html` | Legacy Claude “year in review” UI |
| `/home.html` | Agents home (peers) |

## Update Claude aggregates

```bash
./update.sh
# or
./aggregate-data.sh && node rebuild-stats.js
```

## Kimi stats

```bash
~/proj/kimi-dashboard/update-dashboard.sh
# writes kimi_stats.json used by the Kimi tab
```

## Theme

- Default: **light**
- Button **Dark** / **Light** persists in `localStorage` (`ai-dashboard-theme`)

## Related projects

- `~/proj/grok-usage` — Grok session scanner (imported by collectors)
- `~/proj/kimi-dashboard` — Kimi stats refresh scripts
