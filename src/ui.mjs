/**
 * The room's browser client. One self-contained document: no CDN, no external
 * font, no build step — a tailnet has no reason to reach the public internet
 * just to render a chat room.
 *
 * Every server-supplied string is written with textContent, never innerHTML.
 * Message text, member names and permission previews are all untrusted input.
 *
 * ⚠ This whole file is one template literal. Inside the client script a single
 * backslash-n becomes a REAL line break and breaks the entire page. Always
 * double-escape. `test/ui.test.mjs` parses the emitted script to catch it.
 */

const esc = s =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export function renderUI(config) {
  const room = esc(config.roomName)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${room} · claude-room</title>
<style>
  /* Soft UI Evolution: subtle depth, measured contrast, no neumorphic mush. */
  :root {
    --bg:        #f6f6fb;
    --panel:     #ffffff;
    --panel-2:   #fbfbfe;
    --ink:       #1e1b33;
    --ink-2:     #4b4a63;
    --dim:       #6b7280;
    --line:      #e4e4ef;
    --line-2:    #eeeef6;
    --primary:   #5b5bd6;
    --primary-w: #eeeefc;
    --accent:    #047857;
    --accent-w:  #e7f6f0;
    --warn:      #b45309;
    --warn-w:    #fdf4e7;
    --bad:       #dc2626;
    --bad-w:     #fdecec;

    --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp5: 24px; --sp6: 32px;
    --r1: 6px; --r2: 10px; --r3: 14px;
    --shadow-1: 0 1px 2px rgba(24,24,50,.05), 0 1px 3px rgba(24,24,50,.04);
    --shadow-2: 0 2px 4px rgba(24,24,50,.05), 0 6px 16px rgba(24,24,50,.07);
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    --t: 180ms cubic-bezier(.4,0,.2,1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:        #131318;
      --panel:     #1b1b22;
      --panel-2:   #21212a;
      --ink:       #e9e9f2;
      --ink-2:     #c3c3d2;
      --dim:       #8e8ea3;
      --line:      #2c2c37;
      --line-2:    #26262f;
      --primary:   #8b8bf0;
      --primary-w: #23233a;
      --accent:    #34d399;
      --accent-w:  #17322a;
      --warn:      #fbbf24;
      --warn-w:    #33290f;
      --bad:       #f87171;
      --bad-w:     #3a1f1f;
      --shadow-1: 0 1px 2px rgba(0,0,0,.4);
      --shadow-2: 0 2px 6px rgba(0,0,0,.45), 0 8px 24px rgba(0,0,0,.35);
    }
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 var(--sans);
    height: 100dvh; display: flex; flex-direction: column;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }

  button, input, textarea, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  :focus-visible {
    outline: 2px solid var(--primary); outline-offset: 2px; border-radius: var(--r1);
  }

  /* ---------- header ---------- */
  header {
    display: flex; align-items: center; gap: var(--sp3);
    padding: var(--sp3) var(--sp4);
    background: var(--panel); border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: var(--sp2); margin-right: auto; min-width: 0; }
  .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none; }
  .brand h1 {
    margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .brand .sub { font: 11px/1 var(--mono); color: var(--dim); }

  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    font: 11px/1 var(--mono); padding: 6px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim); background: var(--panel-2);
    white-space: nowrap; transition: color var(--t), border-color var(--t);
  }
  .chip.ok   { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-w); }
  .chip.busy { color: var(--warn);   border-color: color-mix(in srgb, var(--warn) 40%, var(--line));   background: var(--warn-w); }
  .chip.off  { color: var(--bad);    border-color: color-mix(in srgb, var(--bad) 40%, var(--line));    background: var(--bad-w); }
  .chip .pulse { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .chip.busy .pulse { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

  .avatar {
    width: 26px; height: 26px; border-radius: 50%; flex: none;
    display: grid; place-items: center;
    font: 600 11px/1 var(--sans); color: #fff; letter-spacing: .02em;
  }
  .avatar.sm { width: 20px; height: 20px; font-size: 9px; }

  /* ---------- layout ---------- */
  main { flex: 1; display: grid; grid-template-columns: minmax(0,1fr) 340px; min-height: 0; }
  #log { overflow-y: auto; overscroll-behavior: contain; padding: var(--sp5) var(--sp5) var(--sp4); }
  .stream { max-width: 780px; margin: 0 auto; }

  aside {
    border-left: 1px solid var(--line); background: var(--panel);
    overflow-y: auto; padding: var(--sp4); display: flex; flex-direction: column; gap: var(--sp2);
  }
  .card {
    border: 1px solid var(--line); border-radius: var(--r2);
    background: var(--panel-2); overflow: hidden;
  }
  .card > summary, .card > .card-h {
    display: flex; align-items: center; gap: var(--sp2);
    padding: 10px var(--sp3); cursor: pointer; list-style: none;
    font: 600 11px/1 var(--sans); text-transform: uppercase; letter-spacing: .07em;
    color: var(--dim); user-select: none;
  }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary:hover { color: var(--ink-2); }
  .card > summary .count {
    margin-left: auto; font: 10px/1 var(--mono); background: var(--line-2);
    padding: 3px 6px; border-radius: 999px; color: var(--dim);
  }
  .card .body { padding: 0 var(--sp3) var(--sp3); }
  .card .chev { transition: transform var(--t); flex: none; }
  details[open] > summary .chev { transform: rotate(90deg); }

  /* ---------- messages ---------- */
  .msg { display: flex; gap: var(--sp3); padding: var(--sp2) 0; }
  .msg + .msg.same { padding-top: 0; }
  .msg.same .avatar { visibility: hidden; height: 0; }
  .msg .col { min-width: 0; flex: 1; }
  .msg .who { display: flex; align-items: baseline; gap: var(--sp2); }
  .msg .who b { font-weight: 620; font-size: 14px; }
  .msg .when { font: 10px/1 var(--mono); color: var(--dim); }
  .msg .body {
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2);
    margin-top: 2px;
  }
  .msg.addressed .col {
    border-left: 2px solid var(--primary); padding-left: var(--sp3); margin-left: -1px;
  }
  .tag {
    font: 10px/1 var(--mono); padding: 3px 6px; border-radius: 999px;
    background: var(--primary-w); color: var(--primary); border: 1px solid transparent;
  }
  .msg.reply .body { color: var(--ink); }
  .msg.reply .who b { color: var(--primary); }

  /* A mirror is another seat's turn or reply, echoed into this room only for
     awareness - never a request. Deliberately quieter than everything else
     so a reader never mistakes "context" for "someone is talking to you". */
  .msg.mirror { opacity: .62; }
  .msg.mirror .who b { color: var(--dim); font-weight: 500; }
  .msg.mirror .body { font-style: italic; }
  .tag.dim { background: var(--line-2); color: var(--dim); }

  .note {
    display: flex; gap: var(--sp2); align-items: flex-start;
    border-radius: var(--r2); padding: 10px var(--sp3); margin: var(--sp2) 0;
    font-size: 13px; background: var(--panel); border: 1px solid var(--line);
    color: var(--ink-2);
  }
  .note svg { flex: none; margin-top: 2px; }
  .note.warn { background: var(--warn-w); border-color: color-mix(in srgb, var(--warn) 35%, var(--line)); color: var(--warn); }
  .note.bad  { background: var(--bad-w);  border-color: color-mix(in srgb, var(--bad) 35%, var(--line));  color: var(--bad); }
  .note.obs  { background: var(--primary-w); border-color: color-mix(in srgb, var(--primary) 30%, var(--line)); color: var(--primary); }

  /* ---------- turn detail ---------- */
  .disclose {
    display: inline-flex; align-items: center; gap: 5px; margin-top: 6px;
    font: 11px/1 var(--mono); color: var(--dim); background: none; border: 0; padding: 4px 0;
    transition: color var(--t);
  }
  .disclose:hover { color: var(--primary); }
  .detail {
    margin-top: var(--sp2); border: 1px solid var(--line); border-radius: var(--r2);
    background: var(--panel); box-shadow: var(--shadow-1); overflow: hidden;
  }
  .step {
    display: grid; grid-template-columns: 74px 1fr auto; gap: var(--sp3);
    align-items: baseline; padding: 7px var(--sp3);
    font: 12px/1.5 var(--mono); border-bottom: 1px solid var(--line-2);
  }
  .step:last-child { border-bottom: 0; }
  .step .tool { color: var(--primary); font-weight: 600; }
  .step .tool.end { color: var(--accent); }
  .step .arg { color: var(--dim); white-space: pre-wrap; word-break: break-all; }
  .step .dur { color: var(--dim); font-size: 10px; }
  .detail .foot {
    padding: 8px var(--sp3); font: 11px/1.4 var(--mono); color: var(--dim);
    background: var(--panel-2); border-top: 1px solid var(--line-2);
  }
  .detail .foot.running { color: var(--warn); }

  /* ---------- sidebar bits ---------- */
  .row { display: flex; align-items: center; gap: var(--sp2); padding: 6px 0; font-size: 13px; }
  .row + .row { border-top: 1px solid var(--line-2); }
  .row .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font: 10px/1 var(--mono); color: var(--dim); }
  .seat-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .bar { height: 4px; border-radius: 999px; background: var(--line-2); overflow: hidden; margin-top: 4px; }
  .bar i { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width 400ms var(--t); }
  .brief-line { font: 12px/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
  .brief-line.head { color: var(--primary); font-weight: 600; margin-top: 6px; }
  .empty { font-size: 12px; color: var(--dim); font-style: italic; padding: 4px 0; }

  .btn {
    border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
    border-radius: var(--r1); padding: 5px 10px; font: 500 12px/1.3 var(--sans);
    transition: background var(--t), border-color var(--t), color var(--t);
  }
  .btn:hover { background: var(--panel-2); border-color: var(--dim); color: var(--ink); }
  .btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
  .btn.danger:hover { background: var(--bad-w); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .field {
    border: 1px solid var(--line); background: var(--panel); border-radius: var(--r1);
    padding: 5px 8px; font: 12px/1.4 var(--mono); min-width: 0; width: 100%;
  }
  select.field { font-family: var(--sans); }

  .approval { border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line)); background: var(--warn-w); border-radius: var(--r2); padding: var(--sp3); margin-bottom: var(--sp2); }
  .approval h4 { margin: 0 0 4px; font-size: 13px; color: var(--warn); }
  .approval pre { font: 11px/1.45 var(--mono); background: var(--panel); border-radius: var(--r1); padding: 8px; margin: 8px 0; overflow-x: auto; max-height: 130px; color: var(--ink-2); }
  .approval .acts { display: flex; gap: var(--sp2); }

  /* ---------- composer ---------- */
  form#composer {
    border-top: 1px solid var(--line); background: var(--panel); padding: var(--sp3) var(--sp4);
  }
  .composer-inner { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--sp2); }
  .composer-box {
    display: flex; align-items: flex-end; gap: var(--sp2);
    border: 1px solid var(--line); border-radius: var(--r3); background: var(--panel-2);
    padding: var(--sp2); transition: border-color var(--t), box-shadow var(--t);
  }
  .composer-box:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-w); }
  #text {
    flex: 1; border: 0; background: none; resize: none; outline: none;
    padding: 6px; max-height: 180px; min-height: 24px; font-size: 14px;
  }
  .composer-hint { display: flex; align-items: center; gap: var(--sp3); font: 11px/1 var(--mono); color: var(--dim); flex-wrap: wrap; }
  .toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .iconbtn {
    border: 0; background: none; color: var(--dim); padding: 6px; border-radius: var(--r1);
    display: grid; place-items: center; transition: color var(--t), background var(--t);
  }
  .iconbtn:hover { color: var(--primary); background: var(--primary-w); }

  #banner { display: none; padding: 10px var(--sp4); background: var(--bad); color: #fff; font-size: 13px; text-align: center; }

  /* ---------- gate ---------- */
  #gate { flex: 1; display: grid; place-items: center; padding: var(--sp5); }
  .gate-card {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--r3);
    box-shadow: var(--shadow-2); padding: var(--sp6); width: min(420px, 100%); text-align: center;
  }
  .gate-card h2 { margin: 0 0 4px; font-size: 19px; letter-spacing: -.01em; }
  .gate-card p { margin: 0 0 var(--sp4); color: var(--dim); font-size: 13px; }
  .gate-card .field { text-align: center; margin-bottom: var(--sp3); padding: 9px; }

  /* ---------- responsive ---------- */
  @media (max-width: 940px) {
    main { grid-template-columns: 1fr; }
    aside {
      border-left: 0; border-top: 1px solid var(--line);
      max-height: 42dvh; position: sticky; bottom: 0;
    }
    #log { padding: var(--sp4) var(--sp3); }
  }
</style>
</head>
<body>

<div id="banner" role="alert"></div>

<div id="gate">
  <div class="gate-card">
    <h2>${room}</h2>
    <p>Paste your join token to enter the room.</p>
    <input id="tok" class="field" placeholder="join token" autocomplete="off" aria-label="Join token">
    <button class="btn primary" id="enter" style="width:100%;padding:9px">Enter room</button>
  </div>
</div>

<div id="app" hidden style="display:contents">
  <header>
    <div class="brand">
      <span class="dot" id="livedot"></span>
      <div style="min-width:0">
        <h1>${room}</h1>
        <div class="sub" id="mesub">…</div>
      </div>
    </div>
    <span class="chip" id="state"><span class="pulse"></span><span>idle</span></span>
    <span class="chip" id="queue" hidden></span>
    <span class="chip" id="conn">connecting</span>
  </header>

  <main>
    <div id="log"><div class="stream" id="stream"></div></div>
    <aside>
      <details class="card" id="cBrief" open>
        <summary><span class="chev"></span>Room state<span class="count" id="briefCount"></span></summary>
        <div class="body" id="brief"></div>
      </details>

      <details class="card" id="cApprovals">
        <summary><span class="chev"></span>Approvals<span class="count" id="apprCount">0</span></summary>
        <div class="body" id="approvals"></div>
      </details>

      <details class="card" open>
        <summary><span class="chev"></span>Members<span class="count" id="memCount"></span></summary>
        <div class="body" id="members"></div>
      </details>

      <details class="card" id="cSeats">
        <summary><span class="chev"></span>Agents<span class="count" id="seatCount"></span></summary>
        <div class="body" id="seats"></div>
      </details>

      <details class="card">
        <summary><span class="chev"></span>Cost</summary>
        <div class="body" id="cost"></div>
      </details>

      <details class="card">
        <summary><span class="chev"></span>Decisions<span class="count" id="decCount">0</span></summary>
        <div class="body" id="decisions"></div>
      </details>

      <details class="card">
        <summary><span class="chev"></span>Activity</summary>
        <div class="body" id="activity"></div>
      </details>

      <details class="card" id="cAdmin" hidden>
        <summary><span class="chev"></span>Admin</summary>
        <div class="body" id="admin"></div>
      </details>
    </aside>
  </main>

  <form id="composer">
    <div class="composer-inner">
      <div class="composer-box">
        <textarea id="text" rows="1" placeholder="Message the room…" aria-label="Message"></textarea>
        <button type="button" class="iconbtn" id="attach" title="Attach a file" aria-label="Attach a file"></button>
        <input type="file" id="file" hidden>
        <button type="submit" class="btn primary" id="send">Send</button>
      </div>
      <div class="composer-hint">
        <label class="toggle"><input type="checkbox" id="force"> send to agent</label>
        <span id="hint"></span>
      </div>
    </div>
  </form>
</div>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = new URL(location.href).searchParams.get('token') || localStorage.getItem('roomToken') || '';
  var me = null, es = null, state = null;

  // ---- tiny SVG icon set (no emoji: they render inconsistently and read as
  // decoration to screen readers) ----
  var PATHS = {
    chevron: 'M9 18l6-6-6-6',
    send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
    clip: 'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48',
    info: 'M12 16v-4M12 8h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z',
    warn: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
    bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z'
  };
  function icon(name, size) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('width', size || 14); s.setAttribute('height', size || 14);
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', PATHS[name] || PATHS.info);
    s.appendChild(p);
    return s;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // untrusted: textContent only
    return e;
  }

  // Stable colour per name so people are recognisable at a glance.
  function hue(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }
  function avatar(name, small) {
    var a = el('div', 'avatar' + (small ? ' sm' : ''), (name || '?').slice(0, 2).toLowerCase());
    a.style.background = 'hsl(' + hue(name || '?') + ' 52% 46%)';
    a.title = name || '';
    return a;
  }

  function num(v) {
    v = Math.round(v || 0);
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  }
  function clock(ts) { return new Date(ts || Date.now()).toTimeString().slice(0, 5); }

  // ---------------- message stream ----------------
  var msgTurn = {}, nodes = {}, openDetails = {}, lastAuthor = null;

  function atBottom() {
    var l = $('log');
    return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  }
  function scroll() { var l = $('log'); l.scrollTop = l.scrollHeight; }

  function addMessage(m) {
    var stick = atBottom();
    var same = lastAuthor === m.name && m.kind !== 'system';
    lastAuthor = m.kind === 'system' ? null : m.name;

    var wrap = el('div', 'msg' + (m.addressed ? ' addressed' : '') +
      (m.kind === 'reply' ? ' reply' : '') + (m.kind === 'mirror' ? ' mirror' : '') + (same ? ' same' : ''));
    wrap.appendChild(avatar(m.name || '?'));

    var col = el('div', 'col');
    if (!same) {
      var who = el('div', 'who');
      who.appendChild(el('b', null, m.name || 'unknown'));
      who.appendChild(el('span', 'when', clock(m.ts)));
      if (m.addressed) who.appendChild(el('span', 'tag', 'to agent'));
      // Quiet, not hidden: a mirror is another seat's output echoed here for
      // awareness, never a request - the tag says so at a glance.
      if (m.kind === 'mirror') who.appendChild(el('span', 'tag dim', 'mirror'));
      if (m.attachment) who.appendChild(el('span', 'when', m.attachment.name));
      col.appendChild(who);
    }
    col.appendChild(el('div', 'body', m.text || ''));

    var d = el('button', 'disclose');
    d.type = 'button';
    d.appendChild(icon('chevron', 12));
    d.appendChild(el('span', null, 'what the agent did'));
    d.hidden = true;
    d.onclick = function () { toggleDetail(m.id, col, d); };
    col.appendChild(d);

    wrap.appendChild(col);
    $('stream').appendChild(wrap);
    nodes[m.id] = { wrap: wrap, col: col, disc: d };
    if (m.turnId) msgTurn[m.id] = m.turnId;
    markExpandable(m.id);
    if (stick) scroll();
  }

  function markExpandable(id) {
    var n = nodes[id];
    if (n && msgTurn[id]) n.disc.hidden = false;
  }

  function addNote(kind, text, iconName) {
    var stick = atBottom();
    var n = el('div', 'note' + (kind ? ' ' + kind : ''));
    n.appendChild(icon(iconName || 'info', 14));
    n.appendChild(el('span', null, text));
    if (kind === 'bad') n.setAttribute('role', 'alert');
    $('stream').appendChild(n);
    lastAuthor = null;
    if (stick) scroll();
  }

  function toggleDetail(msgId, col, disc) {
    var turnId = msgTurn[msgId];
    if (!turnId) return;
    var open = col.querySelector('.detail');
    if (open) { open.remove(); delete openDetails[turnId]; return; }
    var box = el('div', 'detail');
    box.appendChild(el('div', 'foot', 'loading…'));
    col.appendChild(box);
    openDetails[turnId] = box;
    fetch('/api/turn?id=' + encodeURIComponent(turnId) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) { if (t) renderDetail(box, t); else box.textContent = 'no detail recorded'; });
  }

  function stepRow(a, prev) {
    var row = el('div', 'step');
    var t = el('span', 'tool' + (a.kind === 'tool-end' ? ' end' : ''), a.tool || a.type || a.kind);
    row.appendChild(t);
    var v = '';
    if (a.input) {
      v = a.input.file_path || a.input.command || a.input.pattern || a.input.path || JSON.stringify(a.input);
    }
    row.appendChild(el('span', 'arg', String(v).slice(0, 300)));
    row.appendChild(el('span', 'dur', prev && a.ts ? '+' + Math.max(0, a.ts - prev) + 'ms' : ''));
    return row;
  }

  function renderDetail(box, t) {
    box.textContent = '';
    if (!t.activity.length) box.appendChild(el('div', 'step', 'no tool calls recorded'));
    var prev = null;
    t.activity.forEach(function (a) { box.appendChild(stepRow(a, prev)); prev = a.ts; });
    t.replies.forEach(function (r) {
      var row = el('div', 'step');
      row.appendChild(el('span', 'tool end', 'reply'));
      row.appendChild(el('span', 'arg', r.text.slice(0, 400)));
      row.appendChild(el('span', 'dur', ''));
      box.appendChild(row);
    });
    var txt = t.usage
      ? num(t.usage.input + t.usage.output + t.usage.cacheRead + t.usage.cacheCreate) + ' tokens · ' +
        Math.round((t.ratio || 0) * 100) + '% cached' +
        (t.endedAt ? ' · ' + ((t.endedAt - t.startedAt) / 1000).toFixed(1) + 's' : '')
      : 'still running…';
    box.appendChild(el('div', 'foot' + (t.usage ? '' : ' running'), txt));
  }

  function liveAppend(a) {
    var box = a.turnId && openDetails[a.turnId];
    if (!box) return;
    var foot = box.querySelector('.foot');
    var row = stepRow(a, null);
    if (foot) box.insertBefore(row, foot); else box.appendChild(row);
  }

  // ---------------- sidebar ----------------
  function renderMembers(members) {
    var box = $('members'); box.textContent = '';
    $('memCount').textContent = members.length;
    members.forEach(function (m) {
      var r = el('div', 'row');
      r.appendChild(avatar(m.name, true));
      r.appendChild(el('span', 'grow', m.name));
      var bits = [m.role];
      if (m.muted) bits.push('muted');
      r.appendChild(el('span', 'meta', bits.join(' · ')));
      box.appendChild(r);
    });
  }

  // Each seat is one agent session, bound to exactly one owner's Anthropic
  // account (CLAUDE_CONFIG_DIR isolation - see README). The seats list only
  // ever holds seats that are currently online (Seats#online), so presence
  // in this list already means "reachable"; the dot just makes that visible
  // without a reader having to know that convention.
  function renderSeats(seats, members, ledger) {
    var box = $('seats'); box.textContent = '';
    $('seatCount').textContent = seats.length;
    if (!seats.length) { box.appendChild(el('div', 'empty', 'no agents connected')); return; }
    var byId = {};
    members.forEach(function (m) { byId[m.id] = m; });
    seats.forEach(function (s) {
      var owner = byId[s.ownerId];
      var u = ledger[s.memberId] || {};
      var spent = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
      var r = el('div', 'row');
      var dot = el('span', 'seat-dot');
      dot.title = 'online';
      r.appendChild(dot);
      r.appendChild(el('span', 'grow', '@' + s.handle));
      r.appendChild(el('span', 'meta', (owner ? owner.name : 'unknown owner') + ' · ' + num(spent)));
      box.appendChild(r);
    });
  }

  function renderCost(members, totals) {
    var box = $('cost'); box.textContent = '';
    var rows = members.map(function (m) {
      var u = totals[m.id] || {};
      return { name: m.name, v: (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0) };
    });
    var o = totals.observer;
    if (o && (o.input + o.output) > 0) rows.push({ name: 'observer', v: o.input + o.output });
    var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
    rows.forEach(function (r) {
      var wrap = el('div', 'row');
      var col = el('div', 'grow');
      var head = el('div', 'row');
      head.style.padding = '0';
      head.style.border = '0';
      head.appendChild(el('span', 'grow', r.name));
      head.appendChild(el('span', 'meta', num(r.v)));
      col.appendChild(head);
      var bar = el('div', 'bar');
      var fill = el('i');
      fill.style.width = Math.round((r.v / max) * 100) + '%';
      if (r.name === 'observer') fill.style.background = 'var(--accent)';
      bar.appendChild(fill);
      col.appendChild(bar);
      wrap.appendChild(col);
      box.appendChild(wrap);
    });
    if (!rows.length) box.appendChild(el('div', 'empty', 'nothing spent yet'));
  }

  function renderBriefPanel(b) {
    var box = $('brief'); box.textContent = '';
    $('briefCount').textContent = '';
    if (!b || !b.on) { box.appendChild(el('div', 'empty', 'observer off')); return; }
    if (b.paused) box.appendChild(el('div', 'empty', 'observer paused — over budget'));
    if (!b.text) { box.appendChild(el('div', 'empty', 'nothing summarised yet')); return; }
    // Double-escaped: a single-escaped newline here would become a real line
    // break inside the emitted script and break the whole page.
    b.text.split('\\n').forEach(function (l) {
      box.appendChild(el('div', 'brief-line' + (l.indexOf(' ') === 0 ? '' : ' head'), l));
    });
    var notes = [];
    if (b.pending > 0) notes.push(b.pending + ' new not yet summarised');
    if (b.ageS > 30) notes.push('built ' + b.ageS + 's ago');
    if (notes.length) $('briefCount').textContent = notes.join(' · ');
  }

  function renderDecisions(list) {
    var box = $('decisions'); box.textContent = '';
    $('decCount').textContent = list.length;
    if (!list.length) { box.appendChild(el('div', 'empty', 'none recorded')); return; }
    list.forEach(function (d) {
      var r = el('div', 'row');
      r.appendChild(el('span', 'grow', d.text));
      r.title = d.text;
      box.appendChild(r);
    });
  }

  function addActivity(a) {
    var box = $('activity');
    var label = a.kind === 'tool-start' ? (a.tool || 'tool')
      : a.kind === 'tool-end' ? (a.tool || 'tool') + ' done'
      : a.kind === 'notification' ? (a.type || 'notice')
      : a.kind === 'session-start' ? 'session started' : a.kind;
    var r = el('div', 'row');
    r.appendChild(icon(a.kind === 'tool-start' ? 'bolt' : 'info', 12));
    r.appendChild(el('span', 'grow', label));
    box.insertBefore(r, box.firstChild);
    while (box.childNodes.length > 40) box.removeChild(box.lastChild);
  }

  // ---------------- approvals ----------------
  var approvals = [];
  function renderApprovals() {
    var box = $('approvals'); box.textContent = '';
    $('apprCount').textContent = approvals.length;
    if (!me || !me.canApprove) { box.appendChild(el('div', 'empty', 'you are not an approver')); return; }
    if (!approvals.length) { box.appendChild(el('div', 'empty', 'nothing pending')); return; }
    $('cApprovals').open = true;
    approvals.forEach(function (a) {
      var c = el('div', 'approval');
      c.appendChild(el('h4', null, 'Agent wants to run ' + a.tool_name));
      c.appendChild(el('div', 'meta', a.description || ''));
      if (a.input_preview) c.appendChild(el('pre', null, a.input_preview));
      var acts = el('div', 'acts');
      var yes = el('button', 'btn primary', 'Allow');
      yes.onclick = function () { verdict(a.request_id, 'allow'); };
      var no = el('button', 'btn danger', 'Deny');
      no.onclick = function () { verdict(a.request_id, 'deny'); };
      acts.appendChild(yes); acts.appendChild(no);
      c.appendChild(acts);
      box.appendChild(c);
    });
  }
  function verdict(id, behavior) {
    fetch('/verdict', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, request_id: id, behavior: behavior })
    }).then(function () {
      approvals = approvals.filter(function (a) { return a.request_id !== id; });
      renderApprovals();
    });
  }

  // ---------------- admin ----------------
  function adminCall(action, body) {
    return fetch('/api/admin/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: token }, body || {}))
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) addNote('bad', 'admin: ' + r.reason, 'warn');
      loadAdmin();
      return r;
    });
  }
  function mkBtn(label, cls, fn) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button'; b.onclick = fn;
    return b;
  }
  function renderAdmin(s) {
    var box = $('admin'); box.textContent = '';

    var bar = el('div', 'row');
    bar.appendChild(mkBtn(s.paused ? 'Resume room' : 'Pause room', s.paused ? 'danger' : '', function () {
      adminCall('pause', { paused: !s.paused });
    }));
    bar.appendChild(mkBtn('Clear queue', '', function () { adminCall('clearQueue', {}); }));
    box.appendChild(bar);

    var hr = el('div', 'row');
    hr.appendChild(el('span', 'meta', 'agent @'));
    var hi = el('input', 'field');
    hi.value = s.handles.join(',');
    hi.setAttribute('aria-label', 'Agent handles');
    hr.appendChild(hi);
    hr.appendChild(mkBtn('Set', '', function () { adminCall('handles', { handles: hi.value }); }));
    box.appendChild(hr);

    var ir = el('div', 'row');
    var ni = el('input', 'field'); ni.placeholder = 'new member'; ni.setAttribute('aria-label', 'New member name');
    var rs = el('select', 'field');
    ['member', 'viewer', 'owner'].forEach(function (r) {
      var o = el('option', null, r); o.value = r; rs.appendChild(o);
    });
    ir.appendChild(ni); ir.appendChild(rs);
    ir.appendChild(mkBtn('Invite', 'primary', function () {
      if (!ni.value.trim()) return;
      adminCall('invite', { name: ni.value.trim(), role: rs.value }).then(function (r) {
        if (r.ok) { ni.value = ''; addNote('', 'invite link for ' + r.member.name + ': ' + r.joinUrl, 'info'); }
      });
    }));
    box.appendChild(ir);

    s.members.forEach(function (m) {
      var r = el('div', 'row');
      r.appendChild(avatar(m.name, true));
      r.appendChild(el('span', 'grow', m.name));

      var sel = el('select', 'field');
      sel.style.width = 'auto';
      ['owner', 'member', 'viewer'].forEach(function (role) {
        var o = el('option', null, role); o.value = role; o.selected = m.role === role; sel.appendChild(o);
      });
      sel.onchange = function () { adminCall('role', { memberId: m.id, role: sel.value }); };
      r.appendChild(sel);

      r.appendChild(mkBtn(m.muted ? 'unmute' : 'mute', '', function () {
        adminCall('mute', { memberId: m.id, muted: !m.muted });
      }));
      r.appendChild(mkBtn('link', '', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(m.joinUrl);
        addNote('', 'copied ' + m.name + "'s join link", 'info');
      }));
      r.appendChild(mkBtn('remove', 'danger', function () {
        if (confirm('Remove ' + m.name + '? Their link stops working immediately.')) {
          adminCall('remove', { memberId: m.id });
        }
      }));
      box.appendChild(r);
    });

    if (s.bans.length) {
      box.appendChild(el('div', 'meta', 'banned'));
      s.bans.forEach(function (b) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'grow', b.name || b.addr));
        r.appendChild(mkBtn('unban', '', function () { adminCall('unban', { key: b.name || b.addr }); }));
        box.appendChild(r);
      });
    }
  }
  function loadAdmin() {
    if (!me || me.role !== 'owner') return;
    fetch('/api/admin/state?token=' + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s && s.ok) { $('cAdmin').hidden = false; renderAdmin(s); } });
  }

  // ---------------- header ----------------
  function setState(s) {
    var pill = $('state'), label = pill.lastChild;
    if (s.paused) { pill.className = 'chip off'; label.textContent = 'paused'; }
    else if (s.busy) { pill.className = 'chip busy'; label.textContent = 'agent working'; }
    else { pill.className = 'chip'; label.textContent = 'idle'; }
    var q = $('queue');
    if (s.pending > 0) { q.hidden = false; q.textContent = s.pending + ' queued'; } else { q.hidden = true; }
  }

  function setHint(s) {
    var h = s.handles.map(function (x) { return '@' + x; }).join(' or ');
    var can = me.role !== 'viewer' && !me.muted;
    $('hint').textContent = can
      ? 'mention ' + h + ' to reach the agent — anything else stays in the room'
      : (me.muted ? 'you are muted — you can chat, but not address the agent'
                  : 'you are a viewer — you can chat, but not address the agent');
    $('force').disabled = !can;
  }

  // ---------------- live ----------------
  function banner(text) {
    var b = $('banner');
    if (!text) { b.style.display = 'none'; return; }
    b.textContent = text; b.style.display = 'block';
  }

  function connect() {
    es = new EventSource('/events?token=' + encodeURIComponent(token));
    es.onopen = function () {
      $('conn').className = 'chip ok'; $('conn').textContent = 'live';
      $('livedot').style.background = 'var(--accent)';
      banner('');
    };
    es.onerror = function () {
      $('conn').className = 'chip off'; $('conn').textContent = 'offline';
      $('livedot').style.background = 'var(--bad)';
      banner('Room offline — the agent session may have exited. Retrying…');
    };
    es.addEventListener('message', function (e) { addMessage(JSON.parse(e.data)); });
    es.addEventListener('activity', function (e) {
      var a = JSON.parse(e.data); addActivity(a); liveAppend(a);
    });
    es.addEventListener('presence', function (e) { renderMembers(JSON.parse(e.data).members); });
    es.addEventListener('brief', function (e) { renderBriefPanel(JSON.parse(e.data)); });
    es.addEventListener('decision', function () { load(); });
    es.addEventListener('turn', function (e) {
      var d = JSON.parse(e.data);
      if (d.started && d.msgIds) {
        d.msgIds.forEach(function (id) { msgTurn[id] = d.turnId; markExpandable(id); });
      }
      if (!d.started && d.turnId && openDetails[d.turnId]) {
        fetch('/api/turn?id=' + encodeURIComponent(d.turnId) + '&token=' + encodeURIComponent(token))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (t) { if (t) renderDetail(openDetails[d.turnId], t); });
      }
      load();
    });
    es.addEventListener('cost', function () { load(); });
    es.addEventListener('conflicts', function (e) {
      JSON.parse(e.data).conflicts.forEach(function (c) {
        addNote('warn', 'This may contradict an earlier decision: "' + c.decision.text + '"', 'warn');
      });
    });
    es.addEventListener('rejected', function (e) {
      var d = JSON.parse(e.data);
      addNote('bad', d.name + ' was rejected: ' + d.reason, 'warn');
    });
    es.addEventListener('approval-request', function (e) {
      approvals.push(JSON.parse(e.data)); renderApprovals();
    });
    es.addEventListener('approval', function (e) {
      var d = JSON.parse(e.data);
      approvals = approvals.filter(function (a) { return a.request_id !== d.request_id; });
      renderApprovals();
      addNote('', d.by + ' chose ' + d.behavior, 'info');
    });
    es.addEventListener('admin', function (e) {
      var d = JSON.parse(e.data);
      var msg = 'admin: ' + d.action + (d.name ? ' ' + d.name : '') +
        (d.handles ? ' → @' + d.handles.join(', @') : '') +
        (typeof d.paused === 'boolean' ? (d.paused ? ' (paused)' : ' (resumed)') : '');
      addNote('', msg, 'info');
      load();
    });
  }

  function load() {
    return fetch('/api/state?token=' + encodeURIComponent(token))
      .then(function (r) { if (!r.ok) throw new Error('bad token'); return r.json(); })
      .then(function (s) {
        state = s; me = s.you;
        $('mesub').textContent = s.you.name + ' · ' + s.you.role + (s.you.canApprove ? ' · approver' : '');
        renderMembers(s.members);
        renderSeats(s.seats || [], s.members, s.ledger);
        renderCost(s.members, s.ledger);
        renderDecisions(s.decisions);
        renderBriefPanel(s.brief);
        setState(s);
        setHint(s);
        approvals = s.pendingApprovals || [];
        renderApprovals();
        (s.turns || []).forEach(function (t) {
          (t.msgIds || []).forEach(function (id) { msgTurn[id] = t.id; markExpandable(id); });
        });
        return s;
      });
  }

  function start() {
    localStorage.setItem('roomToken', token);
    $('gate').style.display = 'none';
    $('app').hidden = false;
    load().then(function (s) {
      $('stream').textContent = ''; lastAuthor = null;
      s.messages.forEach(addMessage);
      scroll();
      connect();
    }).catch(function () {
      $('gate').style.display = 'grid';
      $('app').hidden = true;
      banner('That token was not accepted.');
    });
  }

  // ---------------- composer ----------------
  $('attach').appendChild(icon('clip', 16));
  $('enter').onclick = function () { token = $('tok').value.trim(); if (token) start(); };
  $('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('enter').click(); });

  $('attach').onclick = function () { $('file').click(); };
  $('file').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var q = '/upload?token=' + encodeURIComponent(token) +
      '&name=' + encodeURIComponent(f.name) +
      '&text=' + encodeURIComponent($('text').value.trim());
    fetch(q, { method: 'POST', body: f }).then(function () {
      $('text').value = ''; e.target.value = ''; autosize();
    });
  };

  function autosize() {
    var t = $('text');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
  }
  $('text').addEventListener('input', autosize);

  $('composer').onsubmit = function (e) {
    e.preventDefault();
    var text = $('text').value.trim();
    if (!text) return;
    $('text').value = ''; autosize();
    fetch('/msg', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, text: text, force: $('force').checked })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) addNote('bad', 'Not sent: ' + r.reason, 'warn');
    });
  };
  $('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });

  document.querySelectorAll('.chev').forEach(function (c) { c.appendChild(icon('chevron', 12)); });

  if (token) start();
})();
</script>
</body>
</html>`
}
