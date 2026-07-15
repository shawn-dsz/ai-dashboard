"""Collect local usage signals for Grok, Claude Code, and OpenAI/Codex."""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Australia/Melbourne")

# Reuse grok-usage scanner if present
_GROK_USAGE = Path.home() / "proj" / "grok-usage"
if _GROK_USAGE.is_dir() and str(_GROK_USAGE) not in sys.path:
    sys.path.insert(0, str(_GROK_USAGE))

try:
    from scan import scan_prompt_usage, summarise as grok_summarise  # type: ignore
except Exception:  # pragma: no cover
    scan_prompt_usage = None  # type: ignore
    grok_summarise = None  # type: ignore


def expand_home(path: str | Path) -> Path:
    return Path(os.path.expanduser(str(path))).resolve()


def _day_from_iso(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(TZ)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return "unknown"


def _filter_days(by_day: dict[str, dict], days: int | None) -> dict[str, dict]:
    if not days:
        return dict(sorted(by_day.items()))
    now = datetime.now(tz=TZ)
    cutoff = now.timestamp() - days * 86400
    out = {}
    for day, row in by_day.items():
        try:
            ts = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ).timestamp()
        except ValueError:
            continue
        if ts >= cutoff:
            out[day] = row
    return dict(sorted(out.items()))


# ─── Grok (Grok Build local client) ─────────────────────────────────────────


def collect_grok(days: int | None = 30) -> dict[str, Any]:
    """
    Local Grok Build / Grok CLI sessions under ~/.grok/sessions.

    Product surface vs model:
    - surface = Grok Build (the local client that writes sessions)
    - model   = modelId from streams (e.g. grok-4.5)

    Web grok.com chat is NOT in these files.
    """
    grok_home = expand_home(os.environ.get("GROK_HOME", "~/.grok"))
    base: dict[str, Any] = {
        "provider": "grok",
        "label": "Grok",
        "surface": "Grok Build (local client)",
        "available": False,
        "notes": [
            "All local token peaks come from the Grok Build / Grok CLI client.",
            "Model (e.g. grok-4.5) is the modelId on each prompt stream.",
            "grok.com browser chat and xAI API console are not included.",
        ],
        "totals": {
            "prompts": 0,
            "sessions": 0,
            "peak_sum": 0,
            "peak_max": 0,
            "avg_peak": 0,
        },
        "by_day": {},
        "by_model": {},
        "by_surface": {},
        "recent": [],
        "source": str(grok_home / "sessions"),
    }

    if scan_prompt_usage is None or grok_summarise is None:
        base["error"] = "grok-usage scan module not found at ~/proj/grok-usage"
        return base
    if not (grok_home / "sessions").is_dir():
        base["error"] = f"no sessions dir at {grok_home / 'sessions'}"
        return base

    prompts = scan_prompt_usage(grok_home)
    summary = grok_summarise(prompts, days=days)
    base["available"] = True
    base["totals"] = summary["totals"]
    base["by_day"] = {
        day: {
            "prompts": s["prompts"],
            "tokens": s["peak_sum"],  # peak-sum intensity
            "peak_max": s["peak_max"],
            "metric": "peak_context_sum",
        }
        for day, s in summary["by_day"].items()
    }
    base["by_model"] = {
        m: {
            "prompts": s["prompts"],
            "tokens": s["peak_sum"],
            "peak_max": s["peak_max"],
        }
        for m, s in summary["by_model"].items()
    }
    # Surface is always Grok Build for local files
    t = summary["totals"]
    base["by_surface"] = {
        "Grok Build": {
            "prompts": t["prompts"],
            "tokens": t["peak_sum"],
            "peak_max": t["peak_max"],
            "models": list(summary["by_model"].keys()),
        }
    }
    base["recent"] = summary.get("recent") or []
    base["generated_at"] = summary.get("generated_at")
    return base


# ─── Claude Code ─────────────────────────────────────────────────────────────


def _load_claude_stats() -> tuple[dict[str, Any] | None, str]:
    candidates = [
        Path(__file__).resolve().parents[2] / "data.json",
        Path.home() / ".claude" / "stats-cache.json",
        Path.home() / ".claude-alt" / "stats-cache.json",
    ]
    best: dict[str, Any] | None = None
    best_src = ""
    best_date = ""
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        last = str(data.get("lastComputedDate") or "")
        if best is None or last > best_date:
            best = data
            best_src = str(path)
            best_date = last
    return best, best_src


def collect_claude(days: int | None = 30) -> dict[str, Any]:
    data, src = _load_claude_stats()
    base: dict[str, Any] = {
        "provider": "claude",
        "label": "Claude",
        "surface": "Claude Code",
        "available": False,
        "notes": [
            "Tokens from Claude Code stats-cache / dashboard rebuild (input+output+cache).",
            "Refresh via ./update.sh if lastComputed is stale.",
        ],
        "totals": {
            "prompts": 0,  # messages
            "sessions": 0,
            "tokens": 0,
            "messages": 0,
        },
        "by_day": {},
        "by_model": {},
        "source": src or "~/.claude/stats-cache.json",
    }
    if not data:
        base["error"] = "no Claude stats-cache / data.json found"
        return base

    base["available"] = True
    base["last_computed"] = data.get("lastComputedDate")
    base["totals"]["sessions"] = int(data.get("totalSessions") or 0)
    base["totals"]["messages"] = int(data.get("totalMessages") or 0)
    base["totals"]["prompts"] = base["totals"]["messages"]

    # daily tokens
    by_day: dict[str, dict[str, int]] = {}
    for row in data.get("dailyModelTokens") or []:
        day = row.get("date")
        if not day:
            continue
        tokens_by = row.get("tokensByModel") or {}
        total = int(sum(int(v or 0) for v in tokens_by.values()))
        by_day[day] = {
            "tokens": total,
            "prompts": 0,
            "sessions": 0,
            "metric": "model_tokens",
        }
    for row in data.get("dailyActivity") or []:
        day = row.get("date")
        if not day:
            continue
        cur = by_day.setdefault(
            day, {"tokens": 0, "prompts": 0, "sessions": 0, "metric": "model_tokens"}
        )
        cur["prompts"] = int(row.get("messageCount") or 0)
        cur["sessions"] = int(row.get("sessionCount") or 0)
        if not cur["tokens"] and row.get("totalTokens"):
            cur["tokens"] = int(row["totalTokens"])

    by_day = _filter_days(by_day, days)
    base["by_day"] = by_day
    base["totals"]["tokens"] = sum(d.get("tokens", 0) for d in by_day.values())
    if days:
        # windowed message sum if we have it
        base["totals"]["messages"] = sum(d.get("prompts", 0) for d in by_day.values())
        base["totals"]["prompts"] = base["totals"]["messages"]
        base["totals"]["sessions"] = sum(d.get("sessions", 0) for d in by_day.values())

    by_model: dict[str, dict[str, int]] = {}
    for model, u in (data.get("modelUsage") or {}).items():
        if not isinstance(u, dict):
            continue
        tokens = int(
            (u.get("inputTokens") or 0)
            + (u.get("outputTokens") or 0)
            + (u.get("cacheReadInputTokens") or 0)
            + (u.get("cacheCreationInputTokens") or 0)
        )
        by_model[model] = {
            "tokens": tokens,
            "input": int(u.get("inputTokens") or 0),
            "output": int(u.get("outputTokens") or 0),
            "cache_read": int(u.get("cacheReadInputTokens") or 0),
            "cache_write": int(u.get("cacheCreationInputTokens") or 0),
        }
    # if days filtered, re-sum models from dailyModelTokens in window only
    if days:
        by_model = {}
        raw = data.get("dailyModelTokens") or []
        allowed = set(by_day.keys())
        for row in raw:
            if row.get("date") not in allowed:
                continue
            for model, tok in (row.get("tokensByModel") or {}).items():
                by_model.setdefault(model, {"tokens": 0})
                by_model[model]["tokens"] += int(tok or 0)

    base["by_model"] = dict(
        sorted(by_model.items(), key=lambda kv: kv[1].get("tokens", 0), reverse=True)
    )
    return base


# ─── OpenAI / Codex ──────────────────────────────────────────────────────────


def _codex_rollout_files(codex: Path) -> list[Path]:
    files: list[Path] = []
    archived = codex / "archived_sessions"
    sessions = codex / "sessions"
    if archived.is_dir():
        files.extend(archived.glob("rollout-*.jsonl"))
        files.extend(archived.glob("*.jsonl"))
    if sessions.is_dir():
        files.extend(sessions.rglob("*.jsonl"))
    # de-dupe
    seen: set[Path] = set()
    out: list[Path] = []
    for p in files:
        rp = p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        out.append(p)
    return out


def _day_from_rollout_name(name: str) -> str | None:
    # rollout-2026-07-11T22-08-11-....jsonl
    if name.startswith("rollout-") and len(name) >= 18:
        candidate = name[8:18]
        if candidate[4] == "-" and candidate[7] == "-":
            return candidate
    return None


def _scan_codex_token_usage(codex: Path) -> dict[str, Any]:
    """
    Per session file, take the max payload.info.total_token_usage.total_tokens
    seen (cumulative session total). Sum those by day from the filename date.
    """
    by_day: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "sessions": 0,
            "tokens": 0,
            "input": 0,
            "output": 0,
            "cached_input": 0,
            "reasoning_output": 0,
            "prompts": 0,
            "metric": "total_token_usage",
        }
    )
    files = _codex_rollout_files(codex)
    sessions_with_tokens = 0
    for fp in files:
        day = _day_from_rollout_name(fp.name) or "unknown"
        max_total: int | None = None
        best: dict[str, int] = {}
        try:
            with fp.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if "total_token_usage" not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    info = (obj.get("payload") or {}).get("info") or {}
                    tu = info.get("total_token_usage")
                    if not isinstance(tu, dict):
                        continue
                    tot = int(tu.get("total_tokens") or 0)
                    if max_total is None or tot >= max_total:
                        max_total = tot
                        best = {
                            "tokens": tot,
                            "input": int(tu.get("input_tokens") or 0),
                            "output": int(tu.get("output_tokens") or 0),
                            "cached_input": int(tu.get("cached_input_tokens") or 0),
                            "reasoning_output": int(
                                tu.get("reasoning_output_tokens") or 0
                            ),
                        }
        except OSError:
            continue
        if max_total is None:
            continue
        sessions_with_tokens += 1
        row = by_day[day]
        row["sessions"] += 1
        row["prompts"] += 1
        row["tokens"] += best["tokens"]
        row["input"] += best["input"]
        row["output"] += best["output"]
        row["cached_input"] += best["cached_input"]
        row["reasoning_output"] += best["reasoning_output"]

    return {
        "by_day": dict(sorted(by_day.items())),
        "files_scanned": len(files),
        "sessions_with_tokens": sessions_with_tokens,
    }


def _codex_cache_path() -> Path:
    return expand_home("~/.cache/ai-usage/openai-tokens.json")


def collect_openai(days: int | None = 30) -> dict[str, Any]:
    """
    Codex CLI real tokens from session rollout JSONL files:

      ~/.codex/sessions/**/*.jsonl
      ~/.codex/archived_sessions/rollout-*.jsonl

    Each file's max `payload.info.total_token_usage` is the session cumulative total.
    """
    codex = expand_home("~/.codex")
    base: dict[str, Any] = {
        "provider": "openai",
        "label": "OpenAI",
        "surface": "Codex CLI",
        "available": False,
        "notes": [
            "Real tokens from Codex rollout session files (total_token_usage).",
            "Per session we take the max cumulative total_tokens in that file.",
            "Platform invoice may still differ slightly (billing rounding, non-Codex API).",
        ],
        "totals": {
            "sessions": 0,
            "prompts": 0,
            "tokens": 0,
            "input": 0,
            "output": 0,
            "cached_input": 0,
        },
        "by_day": {},
        "by_model": {},
        "source": str(codex / "sessions"),
    }
    if not codex.is_dir():
        base["error"] = "no ~/.codex directory"
        return base

    cache = _codex_cache_path()
    scan: dict[str, Any] | None = None
    # refresh cache if missing or older than 5 minutes
    try:
        if cache.is_file() and (datetime.now().timestamp() - cache.stat().st_mtime) < 300:
            scan = json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        scan = None

    if scan is None:
        scan = _scan_codex_token_usage(codex)
        try:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(scan), encoding="utf-8")
        except OSError:
            pass

    by_day_raw = scan.get("by_day") or {}
    by_day_f = _filter_days(by_day_raw, days)
    base["available"] = True
    base["by_day"] = by_day_f
    base["files_scanned"] = scan.get("files_scanned")
    base["sessions_with_tokens"] = scan.get("sessions_with_tokens")
    base["totals"]["sessions"] = sum(int(d.get("sessions") or 0) for d in by_day_f.values())
    base["totals"]["prompts"] = base["totals"]["sessions"]
    base["totals"]["tokens"] = sum(int(d.get("tokens") or 0) for d in by_day_f.values())
    base["totals"]["input"] = sum(int(d.get("input") or 0) for d in by_day_f.values())
    base["totals"]["output"] = sum(int(d.get("output") or 0) for d in by_day_f.values())
    base["totals"]["cached_input"] = sum(
        int(d.get("cached_input") or 0) for d in by_day_f.values()
    )
    base["by_model"] = {
        "codex (session rollouts)": {
            "tokens": base["totals"]["tokens"],
            "input": base["totals"]["input"],
            "output": base["totals"]["output"],
            "cached_input": base["totals"]["cached_input"],
            "sessions": base["totals"]["sessions"],
        }
    }
    base["source"] = f"{codex}/sessions + archived_sessions ({scan.get('files_scanned', 0)} files)"
    return base


# ─── Combined ────────────────────────────────────────────────────────────────


def collect_kimi(days: int | None = 30) -> dict[str, Any]:
    """Kimi CLI stats from kimi-dashboard JSON or ~/.kimi/kimi-stats.py."""
    base: dict[str, Any] = {
        "provider": "kimi",
        "label": "Kimi",
        "surface": "Kimi CLI",
        "available": False,
        "notes": ["Tokens from Kimi CLI session stats (input/output/cache)."],
        "totals": {
            "sessions": 0,
            "tokens": 0,
            "input": 0,
            "output": 0,
            "cached_input": 0,
            "prompts": 0,
        },
        "by_day": {},
        "by_model": {},
        "source": "",
    }
    candidates = [
        Path.home() / "proj" / "kimi-dashboard" / "kimi_stats.json",
        Path("/tmp/kimi_stats.json"),
    ]
    data = None
    src = ""
    for p in candidates:
        if p.is_file():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                src = str(p)
                break
            except (OSError, json.JSONDecodeError):
                continue
    # try regenerate
    if data is None:
        stats_py = Path.home() / ".kimi" / "kimi-stats.py"
        if stats_py.is_file():
            import subprocess

            try:
                raw = subprocess.check_output(
                    ["python3", str(stats_py), "--json"],
                    text=True,
                    timeout=60,
                    stderr=subprocess.DEVNULL,
                )
                data = json.loads(raw)
                src = f"{stats_py} --json"
            except Exception as e:
                base["error"] = f"kimi-stats failed: {e}"
                return base
    if not data:
        base["error"] = "no kimi_stats.json (run kimi-dashboard/update-dashboard.sh)"
        return base

    base["available"] = True
    base["source"] = src
    summary = data.get("summary") or {}
    sessions = data.get("sessions") or []
    by_day: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "sessions": 0,
            "tokens": 0,
            "input": 0,
            "output": 0,
            "cached_input": 0,
            "prompts": 0,
            "metric": "kimi_session_tokens",
        }
    )
    model_acc: dict[str, int] = defaultdict(int)
    for s in sessions:
        ms = s.get("last_timestamp") or s.get("first_timestamp")
        day = "unknown"
        if ms:
            try:
                dt = datetime.fromtimestamp(float(ms), tz=timezone.utc).astimezone(TZ)
                day = dt.strftime("%Y-%m-%d")
            except (TypeError, ValueError, OSError, OverflowError):
                day = "unknown"
        inp = int(s.get("input_tokens") or 0)
        out = int(s.get("output_tokens") or 0)
        cache = int(s.get("cache_read") or 0) + int(s.get("cache_creation") or 0)
        tok = inp + out + cache
        row = by_day[day]
        row["sessions"] += 1
        row["prompts"] += int(s.get("turns") or 1)
        row["input"] += inp
        row["output"] += out
        row["cached_input"] += cache
        row["tokens"] += tok
        for m in s.get("models_used") or ["kimi"]:
            model_acc[str(m) if m else "kimi"] += tok

    by_day_f = _filter_days(dict(by_day), days)
    base["by_day"] = by_day_f
    # all-time from summary
    all_in = int(summary.get("input_tokens") or 0)
    all_out = int(summary.get("output_tokens") or 0)
    all_cache = int(summary.get("cache_read") or 0) + int(summary.get("cache_creation") or 0)
    all_tok = all_in + all_out + all_cache
    window_tok = sum(d["tokens"] for d in by_day_f.values())
    if days and window_tok > 0:
        base["totals"]["sessions"] = sum(d["sessions"] for d in by_day_f.values())
        base["totals"]["tokens"] = window_tok
        base["totals"]["input"] = sum(d["input"] for d in by_day_f.values())
        base["totals"]["output"] = sum(d["output"] for d in by_day_f.values())
        base["totals"]["cached_input"] = sum(d["cached_input"] for d in by_day_f.values())
        base["totals"]["prompts"] = sum(d["prompts"] for d in by_day_f.values())
        base["window_empty"] = False
    else:
        base["totals"]["sessions"] = int(summary.get("sessions") or len(sessions))
        base["totals"]["input"] = all_in
        base["totals"]["output"] = all_out
        base["totals"]["cached_input"] = all_cache
        base["totals"]["tokens"] = all_tok
        base["totals"]["prompts"] = int(summary.get("turns") or 0)
        base["window_empty"] = bool(days and window_tok == 0)
        if base["window_empty"]:
            base["notes"].append(
                "No Kimi activity in selected window — showing all-time totals."
            )
    base["by_model"] = {
        m: {"tokens": t} for m, t in sorted(model_acc.items(), key=lambda x: -x[1])
    } or {"kimi": {"tokens": base["totals"]["tokens"]}}
    return base


def collect_glm(days: int | None = 30) -> dict[str, Any]:
    """
    GLM usage as recorded inside Claude Code stats (e.g. glm-4.7 routed via Claude Code).
    """
    claude = collect_claude(days=None)  # full model table, then filter window via daily
    base: dict[str, Any] = {
        "provider": "glm",
        "label": "GLM",
        "surface": "via Claude Code (modelUsage)",
        "available": False,
        "notes": [
            "GLM appears as models matching glm* in Claude Code stats (e.g. glm-4.7).",
            "Not a separate client install — routed through Claude Code telemetry.",
        ],
        "totals": {"tokens": 0, "sessions": 0, "prompts": 0},
        "by_day": {},
        "by_model": {},
        "source": claude.get("source") or "",
    }
    if not claude.get("available"):
        base["error"] = claude.get("error") or "claude stats unavailable"
        return base

    # models
    by_model = {}
    for m, s in (claude.get("by_model") or {}).items():
        if "glm" in m.lower():
            by_model[m] = s
    # daily from original data
    data, src = _load_claude_stats()
    by_day: dict[str, dict[str, int]] = defaultdict(
        lambda: {"tokens": 0, "prompts": 0, "sessions": 0, "metric": "glm_tokens"}
    )
    if data:
        for row in data.get("dailyModelTokens") or []:
            day = row.get("date")
            if not day:
                continue
            tbm = row.get("tokensByModel") or {}
            glm_sum = sum(int(v or 0) for k, v in tbm.items() if "glm" in str(k).lower())
            if glm_sum:
                by_day[day]["tokens"] += glm_sum
        # if no daily glm rows, still expose all-time model totals
    by_day_f = _filter_days(dict(by_day), days)
    # if windowed model list empty but all-time has glm, keep all-time models and filter day
    if not by_model and data:
        for m, u in (data.get("modelUsage") or {}).items():
            if "glm" not in m.lower() or not isinstance(u, dict):
                continue
            tokens = int(
                (u.get("inputTokens") or 0)
                + (u.get("outputTokens") or 0)
                + (u.get("cacheReadInputTokens") or 0)
                + (u.get("cacheCreationInputTokens") or 0)
            )
            by_model[m] = {"tokens": tokens}

    base["available"] = bool(by_model or by_day_f)
    if not base["available"]:
        base["error"] = "no GLM models in Claude stats"
        return base
    base["by_model"] = dict(
        sorted(by_model.items(), key=lambda kv: kv[1].get("tokens", 0), reverse=True)
    )
    base["by_day"] = by_day_f
    if by_day_f:
        base["totals"]["tokens"] = sum(d["tokens"] for d in by_day_f.values())
    else:
        base["totals"]["tokens"] = sum(s.get("tokens", 0) for s in by_model.values())
    base["source"] = src or base["source"]
    return base


def collect_all(days: int | None = 30) -> dict[str, Any]:
    grok = collect_grok(days=days)
    claude = collect_claude(days=days)
    openai = collect_openai(days=days)
    kimi = collect_kimi(days=days)
    glm = collect_glm(days=days)

    # unified day axis
    all_days: set[str] = set()
    for block in (grok, claude, openai, kimi, glm):
        all_days.update(block.get("by_day") or {})
    days_sorted = sorted(d for d in all_days if d != "unknown")

    combined_days = {}
    for day in days_sorted:
        g = (grok.get("by_day") or {}).get(day) or {}
        c = (claude.get("by_day") or {}).get(day) or {}
        o = (openai.get("by_day") or {}).get(day) or {}
        k = (kimi.get("by_day") or {}).get(day) or {}
        gl = (glm.get("by_day") or {}).get(day) or {}
        combined_days[day] = {
            "grok_tokens": int(g.get("tokens") or g.get("peak_sum") or 0),
            "claude_tokens": int(c.get("tokens") or 0),
            "openai_tokens": int(o.get("tokens") or 0),
            "kimi_tokens": int(k.get("tokens") or 0),
            "glm_tokens": int(gl.get("tokens") or 0),
            "openai_sessions": int(o.get("sessions") or 0),
            "grok_prompts": int(g.get("prompts") or 0),
            "claude_messages": int(c.get("prompts") or 0),
        }

    return {
        "generated_at": datetime.now(tz=TZ).isoformat(),
        "days": days,
        "providers": {
            "claude": claude,
            "grok": grok,
            "openai": openai,
            "kimi": kimi,
            "glm": glm,
        },
        "combined_by_day": combined_days,
        "distinction": {
            "grok_build_vs_model": {
                "Grok Build": "Local product/client (Grok Build TUI / CLI) — writes ~/.grok/sessions",
                "Grok 4.5 (model)": "modelId on each prompt (e.g. grok-4.5). Same client can switch models.",
                "not_tracked": "grok.com web chat, SuperGrok subscription line items, xAI API console",
            }
        },
    }
