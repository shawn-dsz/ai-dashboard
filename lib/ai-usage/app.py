"""AI Usage Dashboard — Grok + Claude + OpenAI (Codex) on one page."""

from __future__ import annotations

import argparse
import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from providers import collect_all

DEFAULT_PORT = 8790
DEFAULT_HOST = "127.0.0.1"


def fmt_tokens(n: int | float) -> str:
    n = int(n or 0)
    if abs(n) >= 1_000_000_000:
        return f"{n / 1_000_000_000:.2f}B"
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if abs(n) >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _multi_line_chart(days: list[str], series: list[dict]) -> str:
    """
    series: [{key, label, color, values: [numbers aligned to days]}]
    """
    if not days or not series:
        return '<div class="sub">No data in this window</div>'

    W, H = 960, 300
    pad_l, pad_r, pad_t, pad_b = 58, 24, 28, 48
    plot_w = W - pad_l - pad_r
    plot_h = H - pad_t - pad_b
    n = len(days)
    max_v = max((max(s["values"] or [0]) for s in series), default=1) or 1

    grids = []
    for frac in (0, 0.25, 0.5, 0.75, 1.0):
        gy = pad_t + plot_h * (1 - frac)
        grids.append(
            f'<line class="c-grid" x1="{pad_l}" y1="{gy:.1f}" x2="{W - pad_r}" y2="{gy:.1f}" />'
        )
        grids.append(
            f'<text class="c-axis" x="{pad_l - 8}" y="{gy + 4:.1f}" text-anchor="end">{fmt_tokens(max_v * frac)}</text>'
        )

    lines = []
    legend = []
    for s in series:
        vals = s["values"]
        if not any(vals):
            continue
        pts = []
        for i, v in enumerate(vals):
            cx = pad_l + (plot_w * i / max(n - 1, 1) if n > 1 else plot_w / 2)
            cy = pad_t + plot_h - (float(v) / max_v) * plot_h
            pts.append(f"{cx:.1f},{cy:.1f}")
        color = s["color"]
        lines.append(
            f'<polyline fill="none" stroke="{color}" stroke-width="2.4" '
            f'stroke-linejoin="round" stroke-linecap="round" points="{" ".join(pts)}" />'
        )
        for i, v in enumerate(vals):
            if not v:
                continue
            cx = pad_l + (plot_w * i / max(n - 1, 1) if n > 1 else plot_w / 2)
            cy = pad_t + plot_h - (float(v) / max_v) * plot_h
            lines.append(
                f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="3" fill="{color}" stroke="#0b0f14" stroke-width="1">'
                f'<title>{days[i]} · {s["label"]}: {fmt_tokens(v)}</title></circle>'
            )
        legend.append(
            f'<span><i class="swatch" style="background:{color}"></i>{s["label"]}</span>'
        )

    labels = []
    for i, day in enumerate(days):
        show = n <= 16 or i == 0 or i == n - 1 or i % max(1, n // 8) == 0
        if not show:
            continue
        cx = pad_l + (plot_w * i / max(n - 1, 1) if n > 1 else plot_w / 2)
        lab = day[5:] if len(day) >= 10 else day
        labels.append(
            f'<text class="c-axis" x="{cx:.1f}" y="{H - 16}" text-anchor="middle">{lab}</text>'
        )

    return f"""
    <div class="chart-wrap card">
      <div class="chart-legend">{''.join(legend)}</div>
      <svg class="chart" viewBox="0 0 {W} {H}" role="img" aria-label="AI usage over time">
        {''.join(grids)}
        {''.join(lines)}
        {''.join(labels)}
      </svg>
    </div>
    """


def _provider_day_series(block: dict, value_key: str = "tokens") -> tuple[list[str], list[float]]:
    by_day = block.get("by_day") or {}
    days = list(by_day.keys())
    vals = []
    for d in days:
        row = by_day[d]
        if value_key == "tokens":
            vals.append(float(row.get("tokens") or row.get("peak_sum") or 0))
        elif value_key == "prompts":
            vals.append(float(row.get("prompts") or 0))
        elif value_key == "sessions":
            vals.append(float(row.get("sessions") or row.get("prompts") or 0))
        else:
            vals.append(float(row.get(value_key) or 0))
    return days, vals


def render_dashboard(data: dict, port: int, active_tab: str = "grok") -> str:
    days_n = data.get("days")
    period = f"Last {days_n} days" if days_n else "All time"
    gen = data.get("generated_at", "")
    grok = data["providers"]["grok"]
    claude = data["providers"]["claude"]
    openai = data["providers"]["openai"]
    combined = data.get("combined_by_day") or {}
    day_list = list(combined.keys())

    if active_tab not in {"grok", "claude", "openai"}:
        active_tab = "grok"

    # Per-provider charts
    g_days, g_tok = _provider_day_series(grok, "tokens")
    g_days2, g_pr = _provider_day_series(grok, "prompts")
    # align prompts to g_days
    if g_days2 == g_days:
        pass
    chart_grok = _multi_line_chart(
        g_days,
        [
            {"key": "tok", "label": "Peak token sum / day", "color": "#60a5fa", "values": g_tok},
            {"key": "pr", "label": "Prompts / day", "color": "#93c5fd", "values": g_pr},
        ],
    )

    c_days, c_tok = _provider_day_series(claude, "tokens")
    _, c_msg = _provider_day_series(claude, "prompts")
    chart_claude = _multi_line_chart(
        c_days,
        [
            {"key": "tok", "label": "Tokens / day", "color": "#c084fc", "values": c_tok},
            {"key": "msg", "label": "Messages / day", "color": "#e9d5ff", "values": c_msg},
        ],
    )

    o_days, o_tok = _provider_day_series(openai, "tokens")
    _, o_sess = _provider_day_series(openai, "sessions")
    chart_openai = _multi_line_chart(
        o_days,
        [
            {
                "key": "tok",
                "label": "Tokens / day (session totals)",
                "color": "#34d399",
                "values": o_tok,
            },
            {
                "key": "sess",
                "label": "Sessions / day",
                "color": "#6ee7b7",
                "values": o_sess,
            },
        ],
    )

    chart_all = _multi_line_chart(
        day_list,
        [
            {
                "key": "grok",
                "label": "Grok peak-token sum",
                "color": "#60a5fa",
                "values": [combined[d]["grok_tokens"] for d in day_list],
            },
            {
                "key": "claude",
                "label": "Claude tokens",
                "color": "#c084fc",
                "values": [combined[d]["claude_tokens"] for d in day_list],
            },
            {
                "key": "openai",
                "label": "OpenAI/Codex tokens",
                "color": "#34d399",
                "values": [combined[d].get("openai_tokens") or 0 for d in day_list],
            },
        ],
    )

    grok_model_rows = "".join(
        f"<tr><td>{m}</td><td class='n'>{s.get('prompts',0):,}</td>"
        f"<td class='n'>{fmt_tokens(s.get('tokens',0))}</td>"
        f"<td class='n'>{fmt_tokens(s.get('peak_max',0))}</td></tr>"
        for m, s in (grok.get("by_model") or {}).items()
    ) or "<tr><td colspan='4'>No Grok model data</td></tr>"

    claude_model_rows = "".join(
        f"<tr><td>{m}</td><td class='n'>{fmt_tokens(s.get('tokens',0))}</td></tr>"
        for m, s in list((claude.get("by_model") or {}).items())[:20]
    ) or "<tr><td colspan='2'>No Claude model data</td></tr>"

    # day tables
    def day_table(block: dict, cols: list[tuple[str, str]]) -> str:
        rows = []
        for day, s in reversed(list((block.get("by_day") or {}).items())[-21:]):
            cells = "".join(
                f"<td class='n'>{fmt_tokens(s.get(k, 0)) if k != 'prompts' and k != 'sessions' else f'{int(s.get(k, 0)):,}'}</td>"
                for k, _ in cols
            )
            # fix prompts/sessions formatting
            cells = ""
            for k, _lab in cols:
                v = s.get(k, 0)
                if k in {"prompts", "sessions", "messages"}:
                    cells += f"<td class='n'>{int(v or 0):,}</td>"
                else:
                    cells += f"<td class='n'>{fmt_tokens(v)}</td>"
            rows.append(f"<tr><td>{day}</td>{cells}</tr>")
        head = "".join(f"<th class='n'>{lab}</th>" for _, lab in cols)
        body = "".join(rows) or "<tr><td colspan='4'>No daily rows</td></tr>"
        return f"<table><thead><tr><th>Day</th>{head}</tr></thead><tbody>{body}</tbody></table>"

    grok_day_tbl = day_table(
        grok, [("prompts", "Prompts"), ("tokens", "Peak sum"), ("peak_max", "Peak max")]
    )
    claude_day_tbl = day_table(
        claude, [("prompts", "Messages"), ("sessions", "Sessions"), ("tokens", "Tokens")]
    )
    openai_day_tbl = day_table(
        openai,
        [
            ("sessions", "Sessions"),
            ("tokens", "Tokens"),
            ("input", "Input"),
            ("output", "Output"),
            ("cached_input", "Cached in"),
        ],
    )

    gt = grok.get("totals") or {}
    ct = claude.get("totals") or {}
    ot = openai.get("totals") or {}

    def status_pill(block: dict) -> str:
        # "data" = we found local source files (not a live websocket monitor)
        if block.get("available"):
            return '<span class="pill ok" title="Local source found and readable. Refreshes when you load/refresh the page (and every ~90s auto-reload). Not a continuous background agent.">data</span>'
        return f'<span class="pill bad">{block.get("error") or "missing"}</span>'

    named = f"http://ai.localhost:{port}"
    days_q = days_n if days_n is not None else 0

    def tab_cls(name: str) -> str:
        return "tab active" if active_tab == name else "tab"

    def panel_cls(name: str) -> str:
        return "tab-panel active" if active_tab == name else "tab-panel"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="90" />
  <title>AI Usage</title>
  <style>
    :root {{
      --bg: #0b0f14;
      --panel: #141b24;
      --text: #e8eef7;
      --muted: #8b9bb0;
      --line: #243041;
      --a: #60a5fa;
      --b: #34d399;
      --c: #c084fc;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      color: var(--text);
      background:
        radial-gradient(900px 500px at 0% -10%, #1e3a5f55, transparent 55%),
        radial-gradient(700px 400px at 100% 0%, #3b076455, transparent 45%),
        var(--bg);
      min-height: 100vh;
      padding: 28px 18px 48px;
    }}
    .wrap {{ max-width: 1040px; margin: 0 auto; }}
    header {{ display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }}
    h1 {{ margin: 0; font-size: 1.55rem; letter-spacing: -0.02em; }}
    .sub {{ color: var(--muted); margin-top: 6px; font-size: 0.92rem; line-height: 1.45; }}
    .badge {{
      border: 1px solid var(--line); background: var(--panel); border-radius: 999px;
      padding: 8px 12px; font-size: 0.85rem; color: var(--muted); height: fit-content;
    }}
    .badge a {{ color: var(--a); text-decoration: none; }}
    .actions {{ display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }}
    .actions a {{
      border: 1px solid var(--line); background: var(--panel); color: var(--text);
      border-radius: 10px; padding: 8px 12px; font-size: 0.85rem; text-decoration: none;
    }}
    .actions a:hover {{ border-color: var(--a); }}
    .tabs {{
      display: flex; gap: 6px; margin: 22px 0 0; flex-wrap: wrap;
      border-bottom: 1px solid var(--line); padding-bottom: 0;
    }}
    .tab {{
      appearance: none; border: 1px solid transparent; border-bottom: none;
      background: transparent; color: var(--muted); cursor: pointer;
      padding: 10px 16px; font-size: 0.95rem; font-weight: 600;
      border-radius: 10px 10px 0 0; text-decoration: none;
    }}
    .tab:hover {{ color: var(--text); background: #1a2330; }}
    .tab.active {{
      color: var(--text); background: var(--panel);
      border-color: var(--line); position: relative; top: 1px;
    }}
    .tab .dot {{
      display: inline-block; width: 8px; height: 8px; border-radius: 99px;
      margin-right: 8px; vertical-align: 1px;
    }}
    .tab-grok .dot {{ background: #60a5fa; }}
    .tab-claude .dot {{ background: #c084fc; }}
    .tab-openai .dot {{ background: #34d399; }}
    .tab-panel {{ display: none; padding-top: 8px; }}
    .tab-panel.active {{ display: block; }}
    .grid {{
      display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px; margin: 18px 0;
    }}
    .card {{
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px;
    }}
    .card .label {{ color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }}
    .card .value {{ font-size: 1.35rem; font-weight: 650; margin-top: 6px; font-variant-numeric: tabular-nums; }}
    .card .hint {{ color: var(--muted); font-size: 0.8rem; margin-top: 6px; }}
    h2 {{ font-size: 1.05rem; margin: 24px 0 10px; }}
    table {{
      width: 100%; border-collapse: collapse; background: var(--panel);
      border: 1px solid var(--line); border-radius: 14px; overflow: hidden; font-size: 0.9rem;
    }}
    th, td {{ padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; }}
    th {{ color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }}
    tr:last-child td {{ border-bottom: 0; }}
    td.n, th.n {{ text-align: right; font-variant-numeric: tabular-nums; }}
    .pill {{
      display: inline-block; font-size: 0.7rem; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--line); vertical-align: middle; margin-left: 6px;
    }}
    .pill.ok {{ color: #6ee7b7; border-color: #065f46; background: #064e3b55; }}
    .pill.bad {{ color: #fca5a5; border-color: #7f1d1d; background: #450a0a55; }}
    .chart-wrap {{ padding: 12px 14px 8px; }}
    .chart {{ width: 100%; height: auto; display: block; }}
    .chart-legend {{ display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 0.82rem; margin-bottom: 6px; }}
    .chart-legend .swatch {{
      display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px;
    }}
    .c-grid {{ stroke: #243041; stroke-width: 1; }}
    .c-axis {{ fill: var(--muted); font-size: 11px; font-family: ui-sans-serif, system-ui, sans-serif; }}
    .note {{ margin-top: 22px; color: var(--muted); font-size: 0.86rem; line-height: 1.55; }}
    .callout {{
      border-left: 3px solid var(--a); padding: 10px 14px; background: #0f172a99;
      border-radius: 0 12px 12px 0; margin: 12px 0 8px; color: var(--muted); font-size: 0.9rem; line-height: 1.5;
    }}
    .legend-box {{
      margin-top: 18px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px;
      background: var(--panel); color: var(--muted); font-size: 0.86rem; line-height: 1.5;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>AI Usage</h1>
        <div class="sub">{period} · generated {gen}<br/>
          Separate tabs per provider · local signals only</div>
        <div class="actions">
          <a href="/?tab={active_tab}&amp;days=7">7 days</a>
          <a href="/?tab={active_tab}&amp;days=30">30 days</a>
          <a href="/?tab={active_tab}&amp;days=90">90 days</a>
          <a href="/?tab={active_tab}&amp;days=0">All time</a>
          <a href="/api/summary.json?days={days_q}">JSON</a>
          <a href="/?tab={active_tab}&amp;days={days_q}">Refresh</a>
        </div>
      </div>
      <div class="badge">Open at <a href="{named}">{named}</a></div>
    </header>

    <nav class="tabs" role="tablist" aria-label="Provider">
      <a class="{tab_cls('grok')} tab-grok" role="tab" href="/?tab=grok&amp;days={days_q}" data-tab="grok">
        <span class="dot"></span>Grok {status_pill(grok)}
      </a>
      <a class="{tab_cls('claude')} tab-claude" role="tab" href="/?tab=claude&amp;days={days_q}" data-tab="claude">
        <span class="dot"></span>Claude {status_pill(claude)}
      </a>
      <a class="{tab_cls('openai')} tab-openai" role="tab" href="/?tab=openai&amp;days={days_q}" data-tab="openai">
        <span class="dot"></span>OpenAI {status_pill(openai)}
      </a>
    </nav>

    <!-- GROK TAB -->
    <section id="panel-grok" class="{panel_cls('grok')}" role="tabpanel">
      <div class="callout">
        <strong>Grok Build vs model:</strong>
        <em>Grok Build</em> = local client (writes <code>~/.grok/sessions</code>).
        <em>grok-4.5</em> = model id on each stream. Web grok.com not included.
      </div>
      <div class="grid">
        <div class="card"><div class="label">Peak sum</div><div class="value">{fmt_tokens(gt.get('peak_sum') or 0)}</div>
          <div class="hint">peak-context intensity</div></div>
        <div class="card"><div class="label">Prompts</div><div class="value">{gt.get('prompts',0):,}</div></div>
        <div class="card"><div class="label">Sessions</div><div class="value">{gt.get('sessions',0):,}</div></div>
        <div class="card"><div class="label">Peak max</div><div class="value">{fmt_tokens(gt.get('peak_max') or 0)}</div></div>
        <div class="card"><div class="label">Avg peak</div><div class="value">{fmt_tokens(gt.get('avg_peak') or 0)}</div></div>
      </div>
      <h2>Graph</h2>
      {chart_grok}
      <h2>By model (under Grok Build)</h2>
      <table>
        <thead><tr><th>Model</th><th class="n">Prompts</th><th class="n">Peak sum</th><th class="n">Peak max</th></tr></thead>
        <tbody>{grok_model_rows}</tbody>
      </table>
      <h2>By day</h2>
      {grok_day_tbl}
      <div class="note">Source: {grok.get('source')} · surface: {grok.get('surface')}</div>
    </section>

    <!-- CLAUDE TAB -->
    <section id="panel-claude" class="{panel_cls('claude')}" role="tabpanel">
      <div class="callout" style="border-color: var(--c)">
        <strong>Claude Code</strong> stats from local cache / dashboard rebuild.
        Refresh with <code>claude-code-dashboard/update.sh</code> if last computed is stale.
      </div>
      <div class="grid">
        <div class="card"><div class="label">Tokens</div><div class="value">{fmt_tokens(ct.get('tokens') or 0)}</div>
          <div class="hint">in + out + cache (window)</div></div>
        <div class="card"><div class="label">Messages</div><div class="value">{(ct.get('messages') or ct.get('prompts') or 0):,}</div></div>
        <div class="card"><div class="label">Sessions</div><div class="value">{ct.get('sessions',0):,}</div></div>
        <div class="card"><div class="label">Last computed</div><div class="value" style="font-size:1rem">{claude.get('last_computed') or '—'}</div></div>
      </div>
      <h2>Graph</h2>
      {chart_claude}
      <h2>By model</h2>
      <table>
        <thead><tr><th>Model</th><th class="n">Tokens</th></tr></thead>
        <tbody>{claude_model_rows}</tbody>
      </table>
      <h2>By day</h2>
      {claude_day_tbl}
      <div class="note">Source: {claude.get('source')} · surface: Claude Code</div>
    </section>

    <!-- OPENAI TAB -->
    <section id="panel-openai" class="{panel_cls('openai')}" role="tabpanel">
      <div class="callout" style="border-color: var(--b)">
        <strong>OpenAI / Codex</strong> — real tokens from rollout session JSONL
        (<code>total_token_usage</code> per session file). Platform invoice may still differ.
      </div>
      <div class="grid">
        <div class="card"><div class="label">Tokens</div><div class="value">{fmt_tokens(ot.get('tokens') or 0)}</div>
          <div class="hint">sum of session totals in window</div></div>
        <div class="card"><div class="label">Input</div><div class="value">{fmt_tokens(ot.get('input') or 0)}</div></div>
        <div class="card"><div class="label">Output</div><div class="value">{fmt_tokens(ot.get('output') or 0)}</div></div>
        <div class="card"><div class="label">Cached input</div><div class="value">{fmt_tokens(ot.get('cached_input') or 0)}</div></div>
        <div class="card"><div class="label">Sessions</div><div class="value">{ot.get('sessions',0):,}</div>
          <div class="hint">rollouts with token usage</div></div>
      </div>
      <h2>Graph</h2>
      {chart_openai}
      <h2>By day</h2>
      {openai_day_tbl}
      <div class="note">Source: {openai.get('source')} · files scanned: {openai.get('files_scanned', '—')} · surface: Codex CLI</div>
    </section>

    <div class="note">
      <strong>Optional overview chart (all providers, not 1:1 comparable):</strong>
    </div>
    <details class="card" style="margin-top:8px">
      <summary style="cursor:pointer;color:var(--muted)">Show combined overlay</summary>
      <div style="margin-top:12px">{chart_all}</div>
    </details>

    <div class="legend-box">
      <strong style="color:var(--text)">What “data” means:</strong>
      local source files were found and parsed when this page loaded.
      Not a continuous monitor. Page auto-reloads every ~90s; OpenAI token scan is cached ~5 minutes.
      <br/><strong style="color:var(--text)">Tokens:</strong>
      Claude = real model tokens from Claude Code stats ·
      OpenAI = real Codex <code>total_token_usage</code> from session rollouts ·
      Grok = peak context size per prompt (intensity, not a vendor bill line).
    </div>
    <div class="note">
      Not invoices. Standalone: grok-usage · claude-code-dashboard.
    </div>
  </div>
  <script>
    // Client-side tab switch without losing day filter when using buttons
    document.querySelectorAll('.tab[data-tab]').forEach(function (el) {{
      el.addEventListener('click', function (e) {{
        // allow normal navigation (preserves days in href)
      }});
    }});
  </script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "AIUsage/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        days_raw = (qs.get("days") or ["30"])[0]
        try:
            days_i = int(days_raw)
        except ValueError:
            days_i = 30
        days = None if days_i == 0 else days_i
        port = self.server.server_address[1]

        if parsed.path in {"/", "/index.html"}:
            tab = (qs.get("tab") or ["grok"])[0].lower().strip()
            if tab not in {"grok", "claude", "openai"}:
                tab = "grok"
            data = collect_all(days=days)
            html = render_dashboard(data, port=port, active_tab=tab)
            self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            return

        if parsed.path in {"/api/summary.json", "/api/summary"}:
            data = collect_all(days=days)
            self._send(
                200,
                json.dumps(data, indent=2).encode("utf-8"),
                "application/json; charset=utf-8",
            )
            return

        if parsed.path == "/health":
            self._send(200, b'{"ok":true}\n', "application/json")
            return

        self._send(404, b"not found\n", "text/plain; charset=utf-8")


def serve(host: str, port: int, open_browser: bool = False) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"AI Usage → http://127.0.0.1:{port}")
    print(f"           http://ai.localhost:{port}")
    print("  Ctrl-C to stop")
    if open_browser:
        webbrowser.open(f"http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ai-usage", description="Unified AI usage dashboard")
    sub = p.add_subparsers(dest="cmd")
    sp = sub.add_parser("serve")
    sp.add_argument("--host", default=DEFAULT_HOST)
    sp.add_argument("--port", type=int, default=DEFAULT_PORT)
    sp.add_argument("--open", action="store_true")
    sm = sub.add_parser("summary")
    sm.add_argument("--days", type=int, default=30)
    sc = sub.add_parser("scan")
    sc.add_argument("--days", type=int, default=30)

    args = p.parse_args(argv)
    if args.cmd is None:
        args = p.parse_args(["serve", *(argv or [])])

    if args.cmd == "serve":
        serve(args.host, args.port, open_browser=args.open)
        return 0
    if args.cmd in {"summary", "scan"}:
        days = None if args.days == 0 else args.days
        print(json.dumps(collect_all(days=days), indent=2))
        return 0
    p.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
