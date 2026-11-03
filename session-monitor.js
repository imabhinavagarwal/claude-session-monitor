#!/usr/bin/env node
// Claude session monitor. Reads local ~/.claude/projects/*.jsonl, serves a live dashboard.
// Run:   node session-monitor.js            then open http://localhost:4317
// Check: node session-monitor.js --check
// ponytail: local sessions only. Cloud / Remote-Control sessions on other machines
//           are not in local files; add a fetch source when that's wired up.

const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects'); // os.homedir() is cross-platform (HOME unset on Windows)
const PORT = process.env.SM_PORT || 4317;
const WORKING_SEC = 90;        // active in last 90s = working
const WINDOW_H = 24;           // only list sessions touched in last 24h
const KEEP_GRACE_SEC = 600;    // keep a recently-active session even if liveness can't confirm it

// Classify from last meaningful entry + age. Pure, so --check can test it.
// 'ended' = Claude finished a turn (assistant text). scan() decides if that's really
// needs_input (session still open) or idle (done/closed) via the liveness gate.
function classify(last, ageSec) {
  if (!last) return 'idle';
  const recent = ageSec < WORKING_SEC;
  // Assistant text (no tool_use) = finished talking = 'ended'; the scan gate decides needs_input.
  // A tool_use is Claude running tools when recent = working, or parked on a permission/question
  // prompt when stale = 'ended'. Any other recent entry (user) = working, else idle.
  if (last.role === 'assistant') return last.isToolUse ? (recent ? 'working' : 'ended') : 'ended';
  return recent ? 'working' : 'idle';
}

// Live interactive `claude` processes: {pid, cwd, sid}. Used to (a) gate needs_input to
// actually-open sessions, and (b) focus a session's window on click. Memoized 8s.
// ponytail: cwd match is coarse — many sessions per repo collapse to the newest one.
let _live = { a: [], at: 0 };
let _psOk = false; // did the last ps run succeed? gate the "drop closed" filter on it
let _chromeExt = 0; // count of `claude --chrome-native-host` procs = active Claude-in-Chrome connections
function liveProcs() {
  if (Date.now() - _live.at < 8000) return _live.a;
  const a = [];
  let ok = false, extN = 0;
  try {
    const ps = cp.execSync('ps -eo pid,command', { encoding: 'utf8' }).split('\n');
    ok = true;
    for (const ln of ps) {
      if (!/\bclaude\b/.test(ln)) continue;
      if (/--chrome-native-host/.test(ln)) { extN++; continue; } // extension bridge, not an interactive session
      // keep only interactive session procs; drop SDK agents, plugins, mem/mcp helpers
      if (/stream-json|session-monitor|statusline-capture|\.py\b|\bnode \/|\bbun \/|claude-mem|worker-service|mcp-server|chroma|dashboard-server|inbox-wait|spool-forwarder/.test(ln)) continue;
      const m = ln.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = +m[1], cmd = m[2];
      let cwd = null;
      try {
        const o = cp.execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: 'utf8' });
        const mm = o.match(/^n(.+)$/m);
        if (mm) cwd = mm[1];
      } catch { /* proc gone */ }
      const sm = cmd.match(/--session-id\s+([0-9a-f-]{36})/) || cmd.match(/--resume\s+([0-9a-f-]{36})/);
      a.push({ pid, cwd, sid: sm ? sm[1] : null });
    }
  } catch { /* ps unavailable */ }
  _psOk = ok;
  _chromeExt = extN;
  _live = { a, at: Date.now() };
  return a;
}
function chromeExtCount() { liveProcs(); return _chromeExt; } // ensure a fresh ps scan, then read the count

// Keep a session only while it looks open: clickable (live proc or cmux tab), or touched within
// KEEP_GRACE_SEC — liveness (ps/lsof/cmux) has gaps but an active session keeps writing. ps
// failed → list everything rather than blank the dashboard.
function listable(click, psOk, ageSec) { return !psOk || click || ageSec < KEEP_GRACE_SEC; }

// Walk a shell pid up to the GUI .app that owns it, then raise it. pid is validated
// (an integer, present in liveProcs) before it reaches here — safe to interpolate.
// AppleScript to select the iTerm2/Terminal tab whose session runs on this tty.
function ttyScript(app, tty) {
  if (/iTerm/i.test(app)) return `tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select w
          select t
          activate
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
  return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected of t to true
        set frontmost of w to true
        activate
        return
      end if
    end repeat
  end repeat
end tell`;
}

function focusPid(pid) {
  // Session's controlling tty -> used to pick the exact tab in iTerm2/Terminal.
  let tty = '';
  try { const t = cp.execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf8' }).trim(); if (/^ttys\d+$/.test(t)) tty = '/dev/' + t; } catch {}
  // Start at the PARENT: the claude proc's own argv can contain a .app path (mcp-config),
  // which would false-match. Walk ancestors for the first GUI .app bundle that owns it.
  let cur = 1, bundle = null, appPid = null;
  try { cur = parseInt(cp.execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8' }).trim(), 10); } catch {}
  for (let i = 0; i < 12 && cur > 1; i++) {
    let cmd = '';
    try { cmd = cp.execSync(`ps -o command= -p ${cur}`, { encoding: 'utf8' }).trim(); } catch { break; }
    const bm = cmd.match(/^(.*?\.app)\/Contents\/MacOS\//); // outer .app bundle path
    if (bm) { bundle = bm[1]; appPid = cur; break; }
    let ppid = 1;
    try { ppid = parseInt(cp.execSync(`ps -o ppid= -p ${cur}`, { encoding: 'utf8' }).trim(), 10); } catch { break; }
    cur = ppid;
  }
  const base = bundle ? bundle.split('/').pop() : '';
  // tty gives exact-tab focus on iTerm2/Terminal (needs Automation permission, one prompt).
  // Otherwise `open <bundle>` raises the app (no permission). Returns a status string for /focus.
  const PIPE = { stdio: ['ignore', 'ignore', 'pipe'] };
  try {
    if (tty && (/iTerm/i.test(base) || base === 'Terminal.app')) {
      cp.execFileSync('osascript', ['-e', ttyScript(base, tty)], PIPE); return 'tty:' + base;
    } else if (bundle) {
      cp.execFileSync('open', [bundle], PIPE); return 'open:' + base;
    } else {
      cp.execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${appPid || pid}) to true`], PIPE); return 'syse';
    }
  } catch (e) { return 'err:' + (e.stderr ? e.stderr.toString() : e.message).trim().slice(0, 160); }
}

// Focus a session: exact cmux tab if cmux knows it, else raise/focus the host app.
// Returns a status string so /focus can report what actually happened.
function focusTarget(sid, pid) {
  if (sid) {
    const ws = cmuxSessions().get(sid);
    if (ws) {
      try {
        cp.execFileSync(CMUX, ['workspace', 'select', '--workspace', ws], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CMUX_QUIET: '1' } });
        cp.execFileSync('open', ['/Applications/cmux.app'], { stdio: ['ignore', 'ignore', 'pipe'] });
        return 'cmux:' + ws;
      } catch (e) { return 'cmux-err:' + (e.stderr ? e.stderr.toString() : e.message).trim().slice(0, 160); }
    }
  }
  if (pid) return focusPid(pid);
  return 'no-handle';
}

// cmux exposes a control CLI that maps a claude sessionId -> its workspace, so we can
// focus the EXACT tab (not just the app). Returns false for non-cmux sessions.
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

// Map of cmux sessionId -> workspace. cmux tracks sessions by id (not pid), so even an
// idle/closed session stays focusable while cmux keeps its workspace. Memoized 8s.
let _cmux = { m: new Map(), at: 0 };
function cmuxSessions() {
  if (Date.now() - _cmux.at < 8000) return _cmux.m;
  const m = new Map();
  try {
    const out = cp.execSync(`${CMUX} sessions list`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const l of out.split('\n')) {
      const idm = l.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/);
      const wsm = l.match(/workspace=(\S+)/);
      if (idm && wsm) m.set(idm[1], wsm[1]);
    }
  } catch { /* cmux not installed/running */ }
  _cmux = { m, at: Date.now() };
  return m;
}

const COLOR = { working: '#34d399', needs_input: '#fbbf24', idle: '#6b7280' };
const LABEL = { working: 'working', needs_input: 'needs input', idle: 'idle' };

// Pull title (first real user message) + last meaningful entry from raw jsonl lines.
function parseSession(lines) {
  let title = null, last = null, cwd = null;
  for (const ln of lines) {
    let d; try { d = JSON.parse(ln); } catch { continue; }
    if (d.cwd) cwd = d.cwd;
    const m = d.message;
    if (!m || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const arr = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
    const isToolUse = arr.some(x => x.type === 'tool_use');
    const isToolResult = arr.some(x => x.type === 'tool_result');
    last = { role: m.role || d.type, isToolUse };
    if (!title && d.type === 'user' && !isToolResult) {
      const t = arr.filter(x => x.type === 'text').map(x => x.text).join(' ').replace(/^❯\s*/, '').trim();
      // skip harness/command noise
      if (t && !t.startsWith('<') && !t.startsWith('Caveman') && !t.startsWith('/')) title = t;
    }
  }
  return { title, last, cwd };
}

function scan() {
  const now = Date.now();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return out; }
  const procs = liveProcs();
  const liveSet = new Set(procs.map(p => p.cwd).filter(Boolean));
  const cmuxMap = cmuxSessions();
  for (const d of dirs) {
    if (d.includes('claude-mem-observer')) continue; // background observer sessions, never your input
    const dir = path.join(ROOT, d);
    let files; try { files = fs.readdirSync(dir); } catch { continue; }
    // mtime per .jsonl; newest = the session currently open in this project (if any)
    const stats = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try { stats.push({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }); } catch {}
    }
    if (!stats.length) continue;
    const newest = stats.reduce((a, b) => b.m > a.m ? b : a).f;
    for (const { f, m } of stats) {
      const ageSec = (now - m) / 1000;
      if (ageSec > WINDOW_H * 3600) continue;           // drop stale
      let raw; try { raw = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { continue; }
      if (!raw) continue;
      const { title, last, cwd } = parseSession(raw.split('\n'));
      const sid = f.replace('.jsonl', '');
      let status = classify(last, ageSec);
      // liveness gate: an 'ended' turn is needs_input only for the open session — the newest
      // transcript in a repo that still has a live claude (cwd is the only link; no session-id).
      const inLiveCwd = !!(cwd && liveSet.has(cwd));
      const newestOpen = f === newest && inLiveCwd;
      if (status === 'ended') status = newestOpen ? 'needs_input' : 'idle';
      // pid for click-to-focus: exact by --session-id when present, else any live proc in the repo
      let pid = null;
      const bySid = procs.find(p => p.sid === sid);
      if (bySid) pid = bySid.pid;
      else if (inLiveCwd) { const byCwd = procs.find(p => p.cwd === cwd); if (byCwd) pid = byCwd.pid; }
      const click = !!pid || cmuxMap.has(sid); // focusable: live proc in repo, or cmux holds the tab
      if (!listable(click, _psOk, ageSec)) continue; // closed: no live claude, not cmux-held, not recent → drop
      out.push({
        id: sid,
        project: d.replace(/^-Users-[^-]+-/, '').replace(/-/g, '/'),
        title: title || '(no prompt yet)',
        status, ageSec: Math.round(ageSec), pid, click,
      });
    }
  }
  const rank = { needs_input: 0, working: 1, idle: 2 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.ageSec - b.ageSec));
  return out;
}

function ago(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
}

// ---- header: rate limits + 30d token usage ----
const LIMITS_FILES = [ // read freshest; capture file first, token-optimizer's as fallback
  path.join(os.homedir(), '.claude', 'monitor', 'rate-limits.json'),
  path.join(os.homedir(), '.claude', 'token-optimizer', 'rate-limits.json'),
];

let _tok = { t: 0, at: 0 };
// ponytail: full 30d rescan is O(files); memoize 60s so the 4s UI refresh stays cheap.
function tokens30d() {
  if (Date.now() - _tok.at < 60000) return _tok.t;
  const cut = Date.now() - 30 * 86400000;
  let sum = 0, dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return _tok.t; }
  for (const d of dirs) {
    if (d.includes('claude-mem-observer')) continue;
    const dir = path.join(ROOT, d);
    let files; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < cut) continue;
      let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const ln of raw.split('\n')) {
        if (!ln.includes('"usage"')) continue;            // cheap pre-filter before JSON.parse
        let x; try { x = JSON.parse(ln); } catch { continue; }
        const u = x.message && x.message.usage;
        if (!u) continue;
        if (x.timestamp && Date.parse(x.timestamp) < cut) continue;
        sum += (u.input_tokens || 0) + (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
    }
  }
  _tok = { t: sum, at: Date.now() };
  return sum;
}

function header() {
  let limits = { ok: false };
  try {
    const cands = LIMITS_FILES.map(f => { try { return { f, j: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return null; } }).filter(Boolean);
    if (!cands.length) throw 0;
    const { j } = cands.sort((a, b) => (b.j.timestamp || 0) - (a.j.timestamp || 0))[0]; // freshest
    const now = Date.now();
    const mk = o => o ? {
      pending: Math.max(0, 100 - (o.used_percentage || 0)),
      resetsInSec: Math.max(0, Math.round((o.resets_at * 1000 - now) / 1000)),
    } : null;
    limits = { ok: true, five: mk(j.five_hour), week: mk(j.seven_day), ageSec: Math.round((now - (j.timestamp || 0)) / 1000) };
  } catch { /* file missing -> ok:false */ }
  return { limits, tokens30d: tokens30d() };
}

function humic(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : '' + n;
}
function fmtReset(s) {
  return s >= 86400 ? Math.round(s / 86400) + 'd' : s >= 3600 ? (s / 3600).toFixed(1) + 'h' : Math.round(s / 60) + 'm';
}
const LIMITS_STALE_SEC = 3600; // older than 1h = don't trust the % (statusline hasn't refreshed it)

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Claude Sessions</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b0d10;--card:#15181d;--line:#262b33;--txt:#e6e9ee;--dim:#8b93a0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);
font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px 16px}
h1{font-size:15px;font-weight:600;margin:0 0 2px}
.sub{color:var(--dim);font-size:12px;margin-bottom:20px}
.grid{display:grid;gap:10px;max-width:760px;margin:0 auto}
.hdr{max-width:760px;margin:0 auto 16px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--c);
border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.card.need{border-color:#4a3c13;background:#1c1710;box-shadow:0 0 0 1px #fbbf2440}
.dot{width:9px;height:9px;border-radius:50%;background:var(--c);flex:none}
.dot.live{animation:p 1.4s infinite}@keyframes p{50%{opacity:.25}}
.mid{flex:1;min-width:0}
.title{overflow-wrap:anywhere}
.meta{color:var(--dim);font-size:11px;margin-top:3px;overflow-wrap:anywhere}
.badge{font-size:11px;color:var(--c);flex:none}
.need .badge{font-weight:700}
.card.clk{cursor:pointer}
.card.clk:hover{border-color:var(--c);background:#1b1f26}
.go{font-size:11px;color:var(--dim);flex:none;margin-left:2px}
.card.clk:hover .go{color:var(--c)}
.empty{color:var(--dim);text-align:center;padding:40px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:760px;margin:0 auto 20px}
@media(max-width:560px){.stats{grid-template-columns:1fr}}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tl{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.tb{font-size:22px;font-weight:700;margin:5px 0 2px}
.ts{color:var(--dim);font-size:11px}
.stale .tb{color:var(--dim)}
.secl{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em;
max-width:760px;margin:18px auto 8px}
.bar{max-width:760px;margin:0 auto 12px;padding:8px 12px;border-radius:8px;
background:#2a1215;border:1px solid #5b2327;color:#fca5a5;font-size:12px;display:none}
.bar.on{display:block}
.ctl{max-width:760px;margin:0 auto 4px;display:flex;justify-content:flex-end;gap:8px}
.ctl button{background:var(--card);border:1px solid var(--line);color:var(--dim);
border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;font-size:11px}
.ctl button:hover{color:var(--txt)}
details.old{max-width:760px;margin:10px auto 0}
details.old>summary{color:var(--dim);font-size:11px;text-transform:uppercase;
letter-spacing:.06em;cursor:pointer;padding:4px 0;list-style:revert}
details.old .grid{margin-top:8px}
</style></head><body>
<div class="hdr"><h1>Claude Sessions</h1><div class="sub" id="sub">loading…</div></div>
<div class="bar" id="bar"></div>
<div class="stats" id="stats"></div>
<div class="ctl"><button id="sortBtn"></button></div>
<div id="root"></div>
<script>
const C={working:'#34d399',needs_input:'#fbbf24',idle:'#6b7280'};
const L={working:'working',needs_input:'needs input',idle:'idle'};
function ago(s){return s<60?s+'s':s<3600?Math.round(s/60)+'m':Math.round(s/3600)+'h'}
function card(x){
  const need=x.status==='needs_input';
  const clk=x.click?' clk':'';
  const onclick=x.click?' data-id="'+x.id+'" data-pid="'+(x.pid||0)+'" onclick="winFocus(this)" title="click to focus this window"':'';
  const when=need?'waiting '+ago(x.ageSec):ago(x.ageSec)+' ago';
  return '<div class="card'+(need?' need':'')+clk+'" style="--c:'+C[x.status]+'"'+onclick+'>'+
    '<span class="dot'+(x.status==='working'?' live':'')+'"></span>'+
    '<div class="mid"><div class="title">'+esc(x.title)+'</div>'+
    '<div class="meta">'+esc(x.project)+' · '+when+'</div></div>'+
    '<span class="badge">'+L[x.status]+(need?' ←':'')+'</span>'+
    (x.click?'<span class="go">↗ open</span>':'')+'</div>';
}
// --- sort (persisted) ---
function sortMode(){try{return localStorage.getItem('sm-sort')||'recent';}catch(e){return 'recent';}}
function setSort(m){try{localStorage.setItem('sm-sort',m);}catch(e){}}
function sortSessions(a){
  const byProj=(p,q)=>(p.project||'').localeCompare(q.project||'')||p.ageSec-q.ageSec;
  const byRecent=(p,q)=>p.ageSec-q.ageSec;
  return a.slice().sort(sortMode()==='project'?byProj:byRecent);
}
// --- alerts on new needs_input ---
let seen=null, actx;
function beep(){
  try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    const o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);
    o.type='sine';o.frequency.value=880;const t=actx.currentTime;
    g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(0.2,t+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001,t+0.3);o.start();o.stop(t+0.3);
  }catch(e){}
}
function alertNew(need){
  const ids=need.map(x=>x.id);
  if(seen===null){seen=new Set(ids);return;} // no alert on first load
  for(const x of need) if(!seen.has(x.id)){
    beep();
    if(window.Notification&&Notification.permission==='granted')
      try{new Notification('Claude needs input',{body:x.title+' · '+x.project});}catch(e){}
  }
  seen=new Set(ids);
}
function setBar(msg){const b=document.getElementById('bar');if(msg){b.textContent=msg;b.classList.add('on');}else b.classList.remove('on');}
function winFocus(el){fetch('/focus?id='+encodeURIComponent(el.dataset.id)+'&pid='+el.dataset.pid).catch(()=>{})}
function webFocus(el){const q=el.dataset.cdp?'cdp='+encodeURIComponent(el.dataset.cdp):'web=1&w='+el.dataset.w+'&t='+el.dataset.t;fetch('/focus?'+q).catch(()=>{})}
function extFocus(){fetch('/focus?chrome=1').catch(()=>{})}
function webCard(x){
  const foc=x.cdp?'data-cdp="'+esc(x.cdp)+'"':'data-w="'+x.w+'" data-t="'+x.t+'"';
  return '<div class="card clk" style="--c:#8b5cf6" '+foc+' onclick="webFocus(this)" title="click to focus this Chrome tab">'+
    '<span class="dot"></span>'+
    '<div class="mid"><div class="title">'+esc(x.title)+'</div>'+
    '<div class="meta">Chrome · claude.ai</div></div>'+
    '<span class="badge">web</span><span class="go">↗ open</span></div>';
}
function extCard(n){
  return '<div class="card clk" style="--c:#8b5cf6" onclick="extFocus()" title="focus Chrome">'+
    '<span class="dot live"></span>'+
    '<div class="mid"><div class="title">Claude in Chrome (extension)</div>'+
    '<div class="meta">'+n+' active connection'+(n>1?'s':'')+'</div></div>'+
    '<span class="badge">ext</span><span class="go">↗ open</span></div>';
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function humic(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':''+n}
function fmtReset(s){return s>=86400?Math.round(s/86400)+'d':s>=3600?(s/3600).toFixed(1)+'h':Math.round(s/60)+'m'}
function tile(label,big,sub,stale){return '<div class="tile'+(stale?' stale':'')+'"><div class="tl">'+label+'</div><div class="tb">'+big+'</div><div class="ts">'+esc(sub)+'</div></div>'}
function renderStats(H){
  const L=H.limits, fresh=L.ok && L.ageSec<3600; let h='';
  const cell=(lab,o)=> fresh && o ? tile(lab, o.pending+'%', 'resets in '+fmtReset(o.resetsInSec))
    : tile(lab,'—', L.ok?('stale · '+fmtReset(L.ageSec)+' old'):'no rate-limits.json', true);
  h+=cell('Session (5h) left', L.five);
  h+=cell('Weekly (7d) left', L.week);
  h+=tile('Tokens (30d)', humic(H.tokens30d), 'all local sessions');
  document.getElementById('stats').innerHTML=h;
}
const OLD=7200; // idle sessions older than 2h collapse into "older"
async function tick(){
  try{
    const r=await fetch('/api/sessions'); const resp=await r.json();
    setBar('');
    renderStats(resp.header);
    const d=resp.sessions;
    const web=resp.web||[];
    const ext=resp.ext||0;
    const need=sortSessions(d.filter(x=>x.status==='needs_input'));
    const rest=d.filter(x=>x.status!=='needs_input');
    const old=sortSessions(rest.filter(x=>x.status==='idle'&&x.ageSec>OLD));
    const active=sortSessions(rest.filter(x=>!(x.status==='idle'&&x.ageSec>OLD)));
    const n=need.length;
    alertNew(need);
    document.getElementById('sub').textContent=
      d.length+' active · '+n+' need input'+(n?'  ⚠':'')+(web.length?' · '+web.length+' web':'')+(ext?' · chrome ext':'');
    document.title=(n?'('+n+') ':'')+'Claude Sessions';
    let h='';
    if(need.length)h+='<div class="secl">needs your input</div><div class="grid">'+need.map(card).join('')+'</div>';
    if(active.length)h+='<div class="secl">running / idle</div><div class="grid">'+active.map(card).join('')+'</div>';
    if(web.length||ext)h+='<div class="secl">web (Chrome)</div><div class="grid">'+(ext?extCard(ext):'')+web.map(webCard).join('')+'</div>';
    if(old.length)h+='<details class="old"><summary>older idle ('+old.length+')</summary><div class="grid">'+old.map(card).join('')+'</div></details>';
    if(!d.length&&!web.length&&!ext)h='<div class="empty">no sessions active in last 24h</div>';
    document.getElementById('root').innerHTML=h;
  }catch(e){setBar('disconnected — monitor not responding. retrying…');}
}
function updSortBtn(){document.getElementById('sortBtn').textContent='sort: '+sortMode();}
document.getElementById('sortBtn').onclick=()=>{setSort(sortMode()==='recent'?'project':'recent');updSortBtn();tick();};
updSortBtn();
if(window.Notification&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});
tick();setInterval(tick,4000);
</script></body></html>`;

// --- Claude-in-Chrome web sessions: list claude.ai tabs + focus them (macOS only, no status) ---
// The extension keeps no local transcript, so these have no working/idle state — only presence.
const CHROME_LIST = `if application "Google Chrome" is running then
  tell application "Google Chrome"
    set out to ""
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      set ti to 0
      repeat with tb in tabs of w
        set ti to ti + 1
        if (URL of tb) contains "claude.ai" then set out to out & wi & (character id 9) & ti & (character id 9) & (title of tb) & (character id 9) & (URL of tb) & (character id 10)
      end repeat
    end repeat
    return out
  end tell
end if`;
function parseChromeTabs(raw) {
  const tabs = [];
  for (const ln of String(raw).split('\n')) {
    if (!ln.trim()) continue;
    const p = ln.split('\t');
    if (p.length < 4) continue;
    const w = p[0], t = p[1], url = p[p.length - 1], title = p.slice(2, -1).join(' '); // title may contain tabs
    if (!url.includes('claude.ai')) continue;
    tabs.push({ id: 'chrome-' + w + '-' + t, w: +w, t: +t, title: title.trim() || 'Claude', url: url.trim() });
  }
  return tabs;
}
// Chrome tabs via CDP (DevTools HTTP endpoint — any OS with --remote-debugging-port) or osascript
// on macOS. Refreshed in the background: osascript is synchronous and can hang on the first
// Automation prompt, so it must never run inside a request — serve the cached list.
const CDP_PORT = process.env.CHROME_CDP_PORT || 9222;
function cdpGet(pathname, cb) { // GET from DevTools; cb(parsedJSON) or cb(null) on any failure
  const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname, timeout: 1200 }, res => {
    let s = ''; res.on('data', d => s += d); res.on('end', () => { try { cb(JSON.parse(s)); } catch { cb(null); } });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
}
function cdpActivate(id) { cdpGet('/json/activate/' + encodeURIComponent(id), () => {}); return 'cdp'; } // fire-and-forget
let _chromeTabs = [];
function refreshChrome() {
  cdpGet('/json', arr => {
    if (Array.isArray(arr)) { // CDP up (any OS): list claude.ai pages, focus by target id
      _chromeTabs = arr.filter(x => x.type === 'page' && /claude\.ai/.test(x.url || ''))
        .map(x => ({ id: 'cdp-' + x.id, cdp: x.id, title: (x.title || 'Claude').trim(), url: x.url }));
      return;
    }
    if (process.platform !== 'darwin') { _chromeTabs = []; return; } // no osascript off macOS
    cp.execFile('osascript', ['-e', CHROME_LIST], { timeout: 4000 }, (err, out) => {
      if (!err) _chromeTabs = parseChromeTabs(out || ''); // Chrome closed → '' → []; denied → keep last
    });
  });
}
function chromeTabs() { return _chromeTabs; }
function focusChromeTab(w, t) {
  const s = `tell application "Google Chrome"
  set active tab index of window ${w} to ${t}
  set index of window ${w} to 1
  activate
end tell`;
  try { cp.execFileSync('osascript', ['-e', s], { stdio: ['ignore', 'ignore', 'pipe'] }); return 'chrome'; } catch { return 'chrome-fail'; }
}
function focusChrome() { // raise Chrome itself — the extension has no tab to focus
  try { cp.execFileSync('osascript', ['-e', 'tell application "Google Chrome" to activate'], { stdio: ['ignore', 'ignore', 'pipe'] }); return 'chrome'; } catch { return 'chrome-fail'; }
}
function focusChromeExt() { // extension has no tab of its own; land on a claude.ai tab if open, else raise Chrome
  const t = chromeTabs()[0];
  if (!t) return focusChrome();
  return t.cdp ? cdpActivate(t.cdp) : focusChromeTab(t.w, t.t);
}

function serve() {
  http.createServer((req, res) => {
    if (req.url.startsWith('/api/sessions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ header: header(), sessions: scan(), web: chromeTabs(), ext: chromeExtCount() }));
    } else if (req.url.startsWith('/focus')) {
      const u = new URL(req.url, 'http://x');
      if (u.searchParams.get('chrome')) { // extension: focus a claude.ai tab if open, else raise Chrome
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(focusChromeExt());
        return;
      }
      const cdp = u.searchParams.get('cdp');
      if (cdp) { // focus a claude.ai tab by DevTools target id, whitelisted against current tabs
        const okCdp = chromeTabs().some(x => x.cdp === cdp);
        res.writeHead(okCdp ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(okCdp ? cdpActivate(cdp) : 'bad');
        return;
      }
      if (u.searchParams.get('web')) { // focus a Claude-in-Chrome tab, whitelisted against current tabs
        const w = parseInt(u.searchParams.get('w'), 10), t = parseInt(u.searchParams.get('t'), 10);
        const okWeb = chromeTabs().some(x => x.w === w && x.t === t);
        res.writeHead(okWeb ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(okWeb ? focusChromeTab(w, t) : 'bad');
        return;
      }
      const id = u.searchParams.get('id') || '';
      const pid = parseInt(u.searchParams.get('pid'), 10);
      const okPid = Number.isInteger(pid) && liveProcs().some(p => p.pid === pid); // whitelist live pid
      const okId = /^[0-9a-f-]{36}$/.test(id);
      const result = (okPid || okId) ? focusTarget(okId ? id : null, okPid ? pid : null) : 'bad';
      res.writeHead(okPid || okId ? 200 : 400, { 'content-type': 'text/plain' });
      res.end(result);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    }
  }).listen(PORT, () => console.log(`Claude session monitor → http://localhost:${PORT}`));
  refreshChrome(); setInterval(refreshChrome, 5000); // background Chrome-tab scan, never blocks a request
}

function check() {
  const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok:', m); };
  ok(classify({ role: 'assistant', isToolUse: false }, 5) === 'ended', 'assistant text = ended (gate decides needs_input)');
  ok(classify({ role: 'assistant', isToolUse: false }, 3600) === 'ended', 'old assistant text = ended too');
  ok(classify({ role: 'assistant', isToolUse: true }, 5) === 'working', 'recent tool_use = working');
  ok(classify({ role: 'assistant', isToolUse: true }, 9999) === 'ended', 'stale tool_use = parked on a prompt (scan flags needs_input)');
  ok(classify({ role: 'user', isToolUse: false }, 5) === 'working', 'recent user = working');
  ok(classify({ role: 'user', isToolUse: false }, 9999) === 'idle', 'stale user = idle');
  ok(classify(null, 5) === 'idle', 'no entry = idle');
  const ct = parseChromeTabs('1\t2\tClaude chat\thttps://claude.ai/chat/abc\n1\t3\tGoogle\thttps://google.com\n');
  ok(ct.length === 1 && ct[0].w === 1 && ct[0].t === 2 && ct[0].id === 'chrome-1-2', 'chrome tabs: keeps claude.ai, drops others, parses w/t');
  const { title, last } = parseSession([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the bug' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
  ]);
  ok(title === 'fix the bug', 'title from first user msg');
  ok(last.role === 'assistant' && !last.isToolUse, 'last entry parsed');
  // regression: closed sessions (not clickable) are dropped when ps worked, kept when it failed
  ok(listable(true, true, 9999) === true, 'open session listed');
  ok(listable(false, true, 9999) === false, 'closed + stale session dropped when ps ok');
  ok(listable(false, true, 5) === true, 'recently-active session kept despite no liveness match');
  ok(listable(false, false, 9999) === true, 'ps failed → list everything (no blank dashboard)');

  console.log('all checks passed');
}

function tui() {
  const A = { working: '\x1b[32m', needs_input: '\x1b[33m', idle: '\x1b[90m' }; // green/amber/grey
  const R = '\x1b[0m', B = '\x1b[1m', INV = '\x1b[7m', U = '\x1b[4m';
  let linePid = [], lineId = [], lineWeb = []; // per screen row: clickable pid / session id / chrome {w,t}
  function draw() {
    const d = scan();
    const web = chromeTabs();
    const ext = chromeExtCount();
    const need = d.filter(x => x.status === 'needs_input');
    const rest = d.filter(x => x.status !== 'needs_input');
    const H = header(), L = H.limits, fresh = L.ok && L.ageSec < 3600;
    const lc = (lab, o) => fresh && o ? lab + ' ' + B + o.pending + '%' + R + '\x1b[90m (resets ' + fmtReset(o.resetsInSec) + ')' + R
      : lab + ' \x1b[90m' + (L.ok ? '— stale ' + fmtReset(L.ageSec) : '— no data') + R;
    const row = x => {
      const dot = A[x.status] + '●' + R;
      const lab = A[x.status] + (x.status === 'needs_input' ? INV + B : '') + LABEL[x.status].padEnd(11) + R;
      const t = x.click ? U + x.title.slice(0, 44) + R + ' ↗' : x.title.slice(0, 46);
      return ' ' + dot + ' ' + lab + ' \x1b[90m' + ago(x.ageSec).padStart(4) + R +
        '  ' + A[x.status] + t.padEnd(x.click ? 55 : 46) + R + ' \x1b[90m' + x.project.slice(0, 26) + R;
    };
    const webRow = x => ' ' + '\x1b[35m●' + R + ' \x1b[35m' + 'web'.padEnd(11) + R + ' \x1b[90m    ' + R +
      '  \x1b[35m' + (U + x.title.slice(0, 44) + R + ' ↗').padEnd(55) + R + ' \x1b[90mChrome · claude.ai' + R;
    const lines = [], pids = [], ids = [], webs = [];
    const put = (text, pid, id, web) => { lines.push(text); pids.push(pid || null); ids.push(id || null); webs.push(web || null); };
    put(B + 'Claude Sessions' + R + '  \x1b[90m' + d.length + ' active · ' +
      (need.length ? A.needs_input + need.length + ' need input ←' + R : '0 need input') +
      (web.length ? ' · ' + web.length + ' web' : '') + (ext ? ' · chrome ext' : '') +
      '  \x1b[90m(' + new Date().toLocaleTimeString() + ', click a ↗ row, ctrl-c quits)' + R);
    put('\x1b[90m' + lc('5h:', L.five) + '   ' + lc('7d:', L.week) + '   30d tokens: ' + B + humic(H.tokens30d) + R);
    put('');
    if (need.length) {
      put(B + '── needs your input ──' + R);
      need.forEach(x => put(row(x), x.pid, x.click ? x.id : null));
      put('');
    }
    if (rest.length) {
      put('\x1b[90m── running / idle ──' + R);
      rest.forEach(x => put(row(x), x.pid, x.click ? x.id : null));
    }
    if (web.length || ext) {
      put('');
      put('\x1b[95m── web (Chrome) ──' + R);
      if (ext) put(' \x1b[35m●' + R + ' \x1b[35m' + 'ext'.padEnd(11) + R + ' \x1b[90m    ' + R +
        '  \x1b[35m' + (U + 'Claude in Chrome (extension)' + R + ' ↗').padEnd(55) + R +
        ' \x1b[90m' + ext + ' connection' + (ext > 1 ? 's' : '') + R, null, null, { chrome: true });
      web.forEach(x => put(webRow(x), null, null, x.cdp ? { cdp: x.cdp } : { w: x.w, t: x.t }));
    }
    if (!d.length && !web.length && !ext) put('\x1b[90m  no sessions active in last 24h' + R);
    linePid = pids; lineId = ids; lineWeb = webs;
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n'));
  }
  if (!process.stdout.isTTY) { draw(); return; } // piped: one frame, no mouse
  const done = () => { try { process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h'); process.stdin.setRawMode(false); } catch {} process.exit(0); };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?25l'); // enable SGR mouse click reporting, hide cursor
  refreshChrome(); setInterval(refreshChrome, 5000); // background Chrome-tab scan for the web section
  process.stdin.on('data', buf => {
    const s = buf.toString('utf8');
    if (s.includes('\x03') || s === 'q') return done();         // ctrl-c / q
    const re = /\x1b\[<(\d+);(\d+);(\d+)M/g; let m;              // SGR mouse press
    while ((m = re.exec(s))) {
      if ((+m[1] & 3) === 0) { const y = (+m[3]) - 1, pid = linePid[y], id = lineId[y], wb = lineWeb[y]; if (wb) { if (wb.chrome) focusChromeExt(); else if (wb.cdp) cdpActivate(wb.cdp); else focusChromeTab(wb.w, wb.t); } else if (id || pid) focusTarget(id, pid); } // left-button press
    }
  });
  process.on('SIGINT', done);
  draw();
  setInterval(draw, 4000);
}

if (process.argv.includes('--check')) check();
else if (process.argv.includes('--tui')) tui();
else serve();
