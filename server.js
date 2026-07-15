#!/usr/bin/env node
/**
 * Dashboard server — static files + API proxy to claude-peers broker.
 *
 * Usage: node server.js [port]
 *
 * Serves static files from the project directory and proxies
 * /api/peers to the broker at 127.0.0.1:7899.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { readdir, readFile, stat } = require('fs/promises');
const { execFileSync } = require('child_process');
const { getAccountRoots } = require('./account-roots');

const PORT = parseInt(process.argv[2] || '8080', 10);
const BROKER_HOST = '127.0.0.1';
const BROKER_PORT = 7899;
const ROOT = __dirname;

// Remote hosts to also fetch peers from (via SSH + broker)
const REMOTE_HOSTS = [
  { name: 'henry', ssh: 'henry', brokerPort: 7899 },
];
// Account projects directories to search for session JSONL files. Falls
// back to the single personal dir when the helper returns nothing (e.g. an
// override that hides the default accounts), so enrichment never breaks.
function getProjectsDirs() {
  const roots = getAccountRoots();
  if (roots.length > 0) return roots.map(r => r.projectsDir);
  return [path.join(process.env.HOME, '.claude', 'projects')];
}
const SUPERSET_DIR = path.join(process.env.HOME, '.superset');
const SUPERSET_DB = path.join(SUPERSET_DIR, 'local.db');
const SUPERSET_STATE = path.join(SUPERSET_DIR, 'app-state.json');
const REGISTRY_PATH = path.join(ROOT, 'agent-registry.json');

// Agent name pool - curated names for auto-assignment
const AGENT_NAMES = [
  'Pixel', 'Byte', 'Chip', 'Nova', 'Spark', 'Onyx', 'Zinc', 'Sage',
  'Flux', 'Drift', 'Ember', 'Quill', 'Rune', 'Volt', 'Haze', 'Echo',
  'Neon', 'Fern', 'Moss', 'Clay', 'Dusk', 'Wren', 'Lark', 'Reed',
  'Ash', 'Vale', 'Cove', 'Peak', 'Mist', 'Glen', 'Storm', 'Frost',
];

// Persistent colour palette for agents (index stored in registry)
const AGENT_COLOURS = [
  ['#ff5555','#cc3333'], ['#00d68f','#009966'], ['#7b61ff','#5533cc'],
  ['#4da6ff','#3377cc'], ['#ffaa33','#cc8800'], ['#ff79c6','#cc5599'],
  ['#50fa7b','#33cc55'], ['#f1fa8c','#cccc44'], ['#8be9fd','#55bbcc'],
  ['#bd93f9','#9966dd'],
];

/**
 * Load agent registry from disk. Returns { agents: { [id]: { name, colourIndex, lastActiveAt } } }
 */
function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Enrich peers with persistent names, colours, and lastActiveAt from the registry.
 * Auto-assigns name and colour to new agents. Updates lastActiveAt for active agents.
 */
function enrichWithRegistry(peers) {
  const registry = loadRegistry();
  let dirty = false;

  const usedColours = new Set(Object.values(registry).map(r => r.colourIndex));

  const enriched = peers.map(p => {
    let entry = registry[p.id];
    if (!entry) {
      // Auto-assign colour (round-robin, prefer unused)
      let colourIndex = 0;
      for (let i = 0; i < AGENT_COLOURS.length; i++) {
        if (!usedColours.has(i)) { colourIndex = i; break; }
      }
      usedColours.add(colourIndex);

      entry = { colourIndex, lastActiveAt: null };
      registry[p.id] = entry;
      dirty = true;
    }

    // Update lastActiveAt when agent is active
    if (p.isActive) {
      entry.lastActiveAt = new Date().toISOString();
      dirty = true;
    }

    // Agent name priority: session agent name (from hook) > registry override > fallback
    const agentName = p.sessionAgentName || entry.name || p.id.slice(0, 8);

    return {
      ...p,
      agentName,
      agentColours: AGENT_COLOURS[entry.colourIndex % AGENT_COLOURS.length],
      lastActiveAt: entry.lastActiveAt,
    };
  });

  if (dirty) saveRegistry(registry);
  return enriched;
}

/**
 * Read Superset workspace data and build a CWD-to-workspace map.
 * Combines local.db (workspaces, worktrees, projects) with app-state.json (tab names).
 */
async function getSupersetWorkspaces() {
  try {
    // Read workspace/worktree/project data from SQLite via CLI
    const sql = `
      SELECT
        w.id as workspace_id,
        w.name as workspace_name,
        w.branch,
        w.type,
        p.main_repo_path as project_path,
        p.name as project_name,
        wt.path as worktree_path
      FROM workspaces w
      JOIN projects p ON w.project_id = p.id
      LEFT JOIN worktrees wt ON w.worktree_id = wt.id
      WHERE w.deleting_at IS NULL
    `;
    const dbOutput = execFileSync('sqlite3', ['-json', SUPERSET_DB, sql], { encoding: 'utf8', timeout: 3000 });
    const rows = JSON.parse(dbOutput);

    // Read tab state for session names
    const stateData = JSON.parse(await readFile(SUPERSET_STATE, 'utf8'));
    const tabs = stateData?.tabsState?.tabs || [];

    // Build workspace_id -> tab name map
    const tabNames = {};
    for (const tab of tabs) {
      if (tab.workspaceId && tab.name) {
        // Prefer the most descriptive tab name (Claude Code sessions have session names)
        const existing = tabNames[tab.workspaceId];
        if (!existing || (tab.name.includes('Claude Code') === false && tab.name.length > 3)) {
          tabNames[tab.workspaceId] = tab.name;
        }
      }
    }

    // Build CWD -> workspace info map
    const cwdMap = {};
    for (const row of rows) {
      const cwd = row.worktree_path || row.project_path;
      if (!cwd) continue;
      cwdMap[cwd] = {
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        projectName: row.project_name,
        branch: row.branch,
        type: row.type,
        tabName: tabNames[row.workspace_id] || null,
      };
    }

    return cwdMap;
  } catch {
    return {};
  }
}

/**
 * Enrich peers with Superset workspace data (tab names, workspace info).
 */
async function enrichWithSupersetData(peers) {
  const cwdMap = await getSupersetWorkspaces();
  return peers.map(p => {
    const ws = cwdMap[p.cwd];
    if (ws) {
      return {
        ...p,
        supersetTabName: ws.tabName,
        supersetProject: ws.projectName,
        supersetWorkspace: ws.workspaceName,
        supersetWorkspaceId: ws.workspaceId,
        supersetBranch: ws.branch,
        supersetType: ws.type,
      };
    }
    return p;
  });
}

/**
 * Look up session info for a given CWD and optional sessionId.
 * When sessionId is provided, reads that specific JSONL.
 * Otherwise falls back to the most recently modified JSONL in the project directory.
 */
async function getSessionInfo(cwd, sessionId) {
  const projectKey = cwd.replace(/\//g, '-');

  // The project directory may live under any account root. Pick the first
  // account whose project directory exists; prefer one that holds the
  // requested sessionId's JSONL when a sessionId is supplied.
  let projectDir = null;
  for (const baseDir of getProjectsDirs()) {
    const candidate = path.join(baseDir, projectKey);
    let exists = false;
    try {
      const s = await stat(candidate);
      exists = s.isDirectory();
    } catch { /* not in this account root */ }
    if (!exists) continue;

    if (sessionId) {
      try {
        await stat(path.join(candidate, sessionId + '.jsonl'));
        projectDir = candidate; // exact session match, use this root
        break;
      } catch { /* sessionId not here, keep as a fallback */ }
    }
    if (!projectDir) projectDir = candidate; // first existing dir wins
  }

  if (!projectDir) return null;

  try {
    let targetFile = null;

    // If sessionId provided, try to read that specific JSONL
    if (sessionId) {
      const specificFile = sessionId + '.jsonl';
      try {
        await stat(path.join(projectDir, specificFile));
        targetFile = specificFile;
      } catch { /* file doesn't exist, fall through */ }
    }

    // Fall back to most recently modified JSONL
    if (!targetFile) {
      const files = await readdir(projectDir);
      const jsonls = files.filter(f => f.endsWith('.jsonl'));
      if (jsonls.length === 0) return null;

      let newest = null;
      let newestMtime = 0;
      for (const f of jsonls) {
        const s = await stat(path.join(projectDir, f));
        if (s.mtimeMs > newestMtime) {
          newestMtime = s.mtimeMs;
          newest = f;
        }
      }
      if (!newest) return null;
      targetFile = newest;
    }

    sessionId = targetFile.replace('.jsonl', '');

    // Try sessions-index.json for the summary
    let topic = null;
    const indexPath = path.join(projectDir, 'sessions-index.json');
    try {
      const indexData = JSON.parse(await readFile(indexPath, 'utf8'));
      const entry = (indexData.entries || []).find(e => e.sessionId === sessionId);
      if (entry && entry.summary) topic = entry.summary;
    } catch { /* no index, fall through */ }

    // Read JSONL for first prompt (if no topic), last user timestamp, user messages, and recap
    const content = await readFile(path.join(projectDir, targetFile), 'utf8');
    let lastUserTimestamp = null;
    let firstPrompt = null;
    const userMessages = [];
    let lastAssistantText = null;
    let sessionColor = null;
    let sessionAgentName = null;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        // Extract session colour and agent name from hooks
        if (entry.attachment?.stdout || entry.attachment?.content) {
          const hookText = (entry.attachment.stdout || '') + ' ' +
            (typeof entry.attachment.content === 'string' ? entry.attachment.content : JSON.stringify(entry.attachment.content || ''));
          // Match "Session color: X" or "Session color set to: X"
          const colorMatch = hookText.match(/Session color(?:\s+set to)?:\s*(\w+)/i);
          if (colorMatch) sessionColor = colorMatch[1].toLowerCase();
          // Also match "color": "X" from JSON identity output
          if (!sessionColor) {
            const jsonColorMatch = hookText.match(/"color":\s*"(\w+)"/);
            if (jsonColorMatch) sessionColor = jsonColorMatch[1].toLowerCase();
          }
          // Extract agent name from SessionStart hook
          // Format 1: "Agent name: Talc"
          // Format 2: "Your agent name for this session is 'Wildwood'"
          if (!sessionAgentName) {
            const m1 = hookText.match(/Agent name:\s*(\w+)/);
            if (m1) sessionAgentName = m1[1];
            if (!sessionAgentName) {
              const m2 = hookText.match(/agent name[^']*'(\w+)'/i);
              if (m2) sessionAgentName = m2[1];
            }
          }
        }

        // Track assistant messages for recap (last one wins)
        if (entry.type === 'assistant') {
          const msg = entry.message;
          if (msg) {
            let text = null;
            if (typeof msg.content === 'string') text = msg.content;
            else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === 'text' && block.text) { text = block.text; break; }
              }
            }
            if (text) lastAssistantText = text;
          }
        }

        if (entry.type !== 'user') continue;

        // Track last user message timestamp
        if (entry.timestamp) {
          lastUserTimestamp = entry.timestamp;
        }

        // Extract user message text
        const msg = entry.message;
        let text = null;
        if (msg) {
          if (typeof msg.content === 'string') text = msg.content;
          else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) { text = block.text; break; }
            }
          }
        }

        if (text) {
          // Skip messages that are just hook/system content
          const trimmed = text.trim();
          if (trimmed.length > 0 && !trimmed.startsWith('<system-reminder>') && !trimmed.startsWith('<local-command')) {
            userMessages.push({
              text: trimmed.slice(0, 200),
              timestamp: entry.timestamp || null,
            });
          }
          if (!firstPrompt) firstPrompt = trimmed.slice(0, 120);
        }
      } catch { /* skip malformed lines */ }
    }

    // Build recap from last assistant message (first 300 chars)
    const recap = lastAssistantText ? lastAssistantText.slice(0, 300) : null;

    return {
      sessionId,
      sessionColor,
      sessionAgentName,
      sessionTopic: topic || firstPrompt || null,
      lastInstructionAt: lastUserTimestamp || null,
      userMessages: userMessages.slice(-15),
      recap,
    };
  } catch {
    return null;
  }
}

/**
 * Enrich peers array with session info from local session files.
 */
async function enrichWithSessionInfo(peers) {
  const promises = peers.map(async (p) => {
    // Pass the peer's sessionId so we read the correct JSONL (not just the newest)
    const info = await getSessionInfo(p.cwd, p.sessionId || null);
    return {
      ...p,
      sessionId: info?.sessionId || p.sessionId || null,
      sessionColor: info?.sessionColor || null,
      sessionAgentName: info?.sessionAgentName || null,
      sessionTopic: info?.sessionTopic || null,
      lastInstructionAt: info?.lastInstructionAt || null,
      userMessages: info?.userMessages || [],
      recap: info?.recap || null,
    };
  });
  return Promise.all(promises);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  let filePath = path.join(ROOT, req.url === '/' ? '/index.html' : req.url);
  // Strip query params
  filePath = filePath.split('?')[0];

  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

/**
 * Fetch peers from a remote host via SSH, with CPU-based activity detection.
 * Returns an array of peer objects tagged with { host: name }.
 * Fails gracefully (returns []) if SSH or broker is unavailable.
 */
function fetchRemotePeers(remote) {
  return new Promise((resolve) => {
    // Single SSH command: query broker + get PIDs + sample CPU twice
    const script = `
      # Query broker
      PEERS=$(curl -sf -X POST http://127.0.0.1:${remote.brokerPort}/list-peers -H 'Content-Type: application/json' -d '{"scope":"machine"}' 2>/dev/null)
      if [ -z "$PEERS" ] || [ "$PEERS" = "null" ]; then echo '[]'; exit 0; fi

      # Get PIDs from peers
      PIDS=$(echo "$PEERS" | python3 -c "import json,sys; ps=json.load(sys.stdin); print(','.join(str(p['pid']) for p in ps))" 2>/dev/null)
      if [ -z "$PIDS" ]; then echo "$PEERS"; exit 0; fi

      # Get PPIDs
      PPIDS_RAW=$(ps -p "$PIDS" -o pid=,ppid= 2>/dev/null)

      # Get parent PIDs for CPU sampling
      PARENT_PIDS=$(echo "$PPIDS_RAW" | awk '{print $2}' | sort -u | grep -v '^[01]$' | tr '\\n' ',' | sed 's/,$//')
      if [ -z "$PARENT_PIDS" ]; then echo "$PEERS"; exit 0; fi

      # CPU sample 1
      T1=$(ps -p "$PARENT_PIDS" -o pid=,cputime= 2>/dev/null)
      sleep 0.2
      # CPU sample 2
      T2=$(ps -p "$PARENT_PIDS" -o pid=,cputime= 2>/dev/null)

      # Combine and output as JSON
      python3 -c "
import json, sys, re

peers = json.loads('''$PEERS''')
ppid_raw = '''$PPIDS_RAW'''.strip()
t1_raw = '''$T1'''.strip()
t2_raw = '''$T2'''.strip()

ppid_map = {}
for line in ppid_raw.split('\\\\n'):
    parts = line.split()
    if len(parts) >= 2: ppid_map[parts[0]] = parts[1]

def parse_time(s):
    segs = s.split(':')
    if len(segs) == 3: return int(segs[0])*3600 + int(segs[1])*60 + float(segs[2])
    if len(segs) == 2: return int(segs[0])*60 + float(segs[1])
    return 0

t1, t2 = {}, {}
for line in t1_raw.split('\\\\n'):
    parts = line.split()
    if len(parts) >= 2: t1[parts[0]] = parse_time(parts[1])
for line in t2_raw.split('\\\\n'):
    parts = line.split()
    if len(parts) >= 2: t2[parts[0]] = parse_time(parts[1])

cpu_map = {}
for pid in t1:
    if pid in t2:
        cpu_map[pid] = ((t2[pid] - t1[pid]) / 0.2) * 100

for p in peers:
    ppid = ppid_map.get(str(p['pid']))
    cpu = cpu_map.get(ppid, 0) if ppid else 0
    p['cpu'] = round(cpu, 1)
    p['parentPid'] = int(ppid) if ppid else None
    p['isActive'] = cpu > 5

print(json.dumps(peers))
" 2>/dev/null || echo "$PEERS"
    `;

    execFile('ssh', ['-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=no', remote.ssh, 'bash -s'], { timeout: 8000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const peers = JSON.parse(stdout.trim());
        // Tag each peer with the remote host name
        resolve(peers.map(p => ({ ...p, host: remote.name })));
      } catch { resolve([]); }
    });

    // Feed the script to stdin... actually execFile doesn't support stdin easily.
    // Let me use a different approach.
  });
}

// Simpler approach: use child_process.exec with the script piped via SSH
function fetchRemotePeersSimple(remote) {
  return new Promise((resolve) => {
    const cmd = `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${remote.ssh} "curl -sf -X POST http://127.0.0.1:${remote.brokerPort}/list-peers -H 'Content-Type: application/json' -d '{\\\"scope\\\":\\\"machine\\\"}' 2>/dev/null || echo '[]'"`;
    require('child_process').exec(cmd, { timeout: 6000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const peers = JSON.parse(stdout.trim());
        if (!Array.isArray(peers)) { resolve([]); return; }
        // Tag with host, mark activity via last_seen recency (no CPU sampling for remote)
        const now = Date.now();
        resolve(peers.map(p => {
          const lastSeen = new Date(p.last_seen).getTime();
          const seenAgo = now - lastSeen;
          return { ...p, host: remote.name, cpu: 0, parentPid: null, isActive: seenAgo < 10000 };
        }));
      } catch { resolve([]); }
    });
  });
}

function proxyToBroker(reqPath, postBody, res) {
  const options = {
    hostname: BROKER_HOST,
    port: BROKER_PORT,
    path: reqPath,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', (chunk) => { body += chunk; });
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  });

  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Broker unavailable', detail: e.message }));
  });

  proxyReq.write(postBody);
  proxyReq.end();
}

/**
 * Send enriched local peers as response, after merging in remote peers.
 * Remote fetch happens in parallel and is non-blocking (fails gracefully).
 */
function sendPeersResponse(res, localPeers) {
  // Fetch remote peers in parallel
  const remotePromises = REMOTE_HOSTS.map(r => fetchRemotePeersSimple(r));
  Promise.all(remotePromises).then(remoteResults => {
    const remotePeers = remoteResults.flat();
    // Enrich remote peers with registry (names + colours)
    const allPeers = enrichWithRegistry([...localPeers, ...remotePeers]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allPeers));
  }).catch(() => {
    // If remote fetch fails, just send local peers
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(localPeers));
  });
}

const server = http.createServer((req, res) => {
  // API proxy routes
  if (req.url === '/api/peers' && req.method === 'GET') {
    // Fetch peers from broker, then enrich with CPU-based activity detection
    const options = {
      hostname: BROKER_HOST,
      port: BROKER_PORT,
      path: '/list-peers',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk) => { body += chunk; });
      proxyRes.on('end', () => {
        try {
          const peers = JSON.parse(body);
          if (!Array.isArray(peers)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
            return;
          }
          // The broker registers the MCP server (bun) PID.
          // The actual claude process is the parent. Check activity on parent PIDs.
          // We use /proc-style cputime sampling: read cputime, wait, read again.
          // On macOS, use `ps -o cputime` which gives cumulative CPU time.
          const pids = peers.map(p => p.pid);
          if (pids.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
          }
          // Get PPIDs for all registered PIDs
          execFile('ps', ['-p', pids.join(','), '-o', 'pid=,ppid='], (err, stdout) => {
            const ppidMap = {};
            if (!err && stdout) {
              stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) ppidMap[parts[0]] = parts[1];
              });
            }
            const parentPids = [...new Set(Object.values(ppidMap).filter(p => p !== '1' && p !== '0'))];
            if (parentPids.length === 0) {
              const cpuEnriched = peers.map(p => ({ ...p, cpu: 0, isActive: false }));
              enrichWithSessionInfo(cpuEnriched).then(e => enrichWithSupersetData(e)).then(e => enrichWithRegistry(e)).then(enriched => {
                sendPeersResponse(res, enriched);
              }).catch(err => {
                console.error('Enrichment error:', err);
                sendPeersResponse(res, cpuEnriched);
              });
              return;
            }
            // Sample 1: get cumulative CPU time (in seconds)
            const parseTimes = (out) => {
              const m = {};
              if (!out) return m;
              out.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                  const pid = parts[0];
                  // cputime format: HH:MM:SS or MM:SS.xx
                  const t = parts[1];
                  const segs = t.split(':');
                  let secs = 0;
                  if (segs.length === 3) secs = parseInt(segs[0])*3600 + parseInt(segs[1])*60 + parseFloat(segs[2]);
                  else if (segs.length === 2) secs = parseInt(segs[0])*60 + parseFloat(segs[1]);
                  m[pid] = secs;
                }
              });
              return m;
            };
            execFile('ps', ['-p', parentPids.join(','), '-o', 'pid=,cputime='], (e1, s1) => {
              const t1 = parseTimes(s1);
              const now1 = Date.now();
              // Sample 2 after 200ms
              setTimeout(() => {
                execFile('ps', ['-p', parentPids.join(','), '-o', 'pid=,cputime='], (e2, s2) => {
                  const t2 = parseTimes(s2);
                  const elapsed = (Date.now() - now1) / 1000;
                  const cpuMap = {};
                  for (const pid of parentPids) {
                    if (t1[pid] !== undefined && t2[pid] !== undefined) {
                      cpuMap[pid] = ((t2[pid] - t1[pid]) / elapsed) * 100;
                    }
                  }
                  const cpuEnriched = peers.map(p => {
                    const ppid = ppidMap[String(p.pid)];
                    const cpu = ppid ? (cpuMap[ppid] || 0) : 0;
                    return { ...p, cpu: Math.round(cpu * 10) / 10, parentPid: ppid ? parseInt(ppid) : null, isActive: cpu > 5 };
                  });
                  enrichWithSessionInfo(cpuEnriched).then(e => enrichWithSupersetData(e)).then(e => enrichWithRegistry(e)).then(enriched => {
                    sendPeersResponse(res, enriched);
                  });
                });
              }, 200);
            });
          });
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body);
        }
      });
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Broker unavailable', detail: e.message }));
    });
    proxyReq.write(JSON.stringify({ scope: 'machine' }));
    proxyReq.end();
    return;
  }

  // Rename an agent: PUT /api/agents/<id>/name  body: { name: "NewName" }
  const renameMatch = req.url.match(/^\/api\/agents\/([^/]+)\/name$/);
  if (renameMatch && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (!name || typeof name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name required' }));
          return;
        }
        const agentId = decodeURIComponent(renameMatch[1]);
        const registry = loadRegistry();
        if (!registry[agentId]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent not found' }));
          return;
        }
        registry[agentId].name = name.trim().slice(0, 20);
        saveRegistry(registry);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: registry[agentId].name }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // Launch Ghostty terminal for an agent's session
  if (req.url === '/api/launch-terminal' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { cwd, sessionId } = JSON.parse(body);
        if (!cwd) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'cwd required' }));
          return;
        }
        // Build claude command - resume session if we have the ID
        const claudeCmd = sessionId
          ? `claude --resume ${sessionId}`
          : 'claude --continue';
        // Launch Ghostty: -e takes the rest as command + args
        const { spawn } = require('child_process');
        const script = `cd ${cwd} && ${claudeCmd}`;
        spawn('/Applications/Ghostty.app/Contents/MacOS/ghostty', [
          '-e', '/bin/bash', '--login', '-c', script,
        ], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Unified AI usage (Claude / Grok / OpenAI / Kimi / GLM) via Python collectors
  if (req.url && req.url.startsWith('/api/ai-usage') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const days = u.searchParams.get('days') || '30';
    const py = process.env.AI_USAGE_PYTHON || 'python3';
    const script = path.join(process.env.HOME || '', 'proj/ai-usage/app.py');
    const env = {
      ...process.env,
      PYTHONPATH: [
        path.join(process.env.HOME || '', 'proj/ai-usage'),
        path.join(process.env.HOME || '', 'proj/grok-usage'),
        process.env.PYTHONPATH || '',
      ].filter(Boolean).join(path.delimiter),
    };
    execFile(
      py,
      [script, 'scan', '--days', String(days)],
      { env, timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          res.writeHead(500, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({
            error: 'ai-usage scan failed',
            detail: err.message,
            stderr: (stderr || '').slice(0, 800),
          }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(stdout);
      },
    );
    return;
  }

  if (req.url === '/api/health' && req.method === 'GET') {
    const options = {
      hostname: BROKER_HOST,
      port: BROKER_PORT,
      path: '/health',
      method: 'GET',
    };
    const proxyReq = http.request(options, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk) => { body += chunk; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      });
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Broker unavailable', detail: e.message }));
    });
    proxyReq.end();
    return;
  }

  // Static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`AI Dashboard listening on http://localhost:${PORT}`);
  console.log(`  AI usage (tabs):  http://localhost:${PORT}/index.html`);
  console.log(`  Claude activity:  http://localhost:${PORT}/claude-activity.html`);
  console.log(`  Agents (home):    http://claude-agents:${PORT}/`);
  console.log(`  API:              /api/ai-usage?days=30`);
  console.log(`  Peers proxy:      /api/peers -> broker:${BROKER_PORT}`);
});
