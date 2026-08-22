/**
 * The room's browser client. One self-contained document: no CDN, no external
 * font, no build step — a tailnet has no reason to reach the public internet
 * just to render a chat box.
 *
 * Every server-supplied string is written with textContent, never innerHTML.
 * Message text, member names and permission previews are all untrusted input.
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
  :root {
    --bg: #fbfbfa; --panel: #fff; --ink: #1a1a18; --dim: #6b6b66;
    --line: #e4e4e0; --accent: #b8552b; --ok: #2f7d4f; --warn: #a8641a; --bad: #a33;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a; --panel: #1f1f23; --ink: #ececea; --dim: #9a9a94;
      --line: #33333a; --accent: #e08a5c; --ok: #7fc99b; --warn: #e0b06a; --bad: #e08b8b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 system-ui, -apple-system, Segoe UI, sans-serif;
    height: 100vh; display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 650; }
  .pill {
    font: 11px/1 var(--mono); padding: 4px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim); white-space: nowrap;
  }
  .pill.live { color: var(--ok); border-color: var(--ok); }
  .pill.busy { color: var(--warn); border-color: var(--warn); }
  .pill.off  { color: var(--bad); border-color: var(--bad); }
  main { flex: 1; display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } aside { display: none; } }
  #log { overflow-y: auto; padding: 14px 16px; }
  aside {
    border-left: 1px solid var(--line); background: var(--panel);
    overflow-y: auto; padding: 12px 14px;
  }
  aside h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--dim); margin: 16px 0 6px; font-weight: 600;
  }
  aside h2:first-child { margin-top: 0; }
  .msg { margin-bottom: 10px; }
  .msg.has-detail > div:first-child { cursor: pointer; }
  .msg.has-detail > div:first-child:hover .disclose { color: var(--accent); }
  .disclose { font: 11px/1 var(--mono); color: var(--dim); margin-left: 6px; }
  .detail {
    margin: 6px 0 0 10px; padding: 8px 10px; border-left: 2px solid var(--accent);
    background: var(--panel); border-radius: 0 6px 6px 0;
  }
  .detail .step {
    font: 12px/1.5 var(--mono); display: flex; gap: 8px; align-items: baseline;
  }
  .detail .step .tool { color: var(--accent); min-width: 8ch; }
  .detail .step .arg {
    color: var(--dim); white-space: pre-wrap; word-break: break-all; flex: 1;
  }
  .detail .step .dur { color: var(--dim); font-size: 11px; }
  .detail .summary {
    font: 11px/1.5 var(--mono); color: var(--dim);
    margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line);
  }
  .detail .running { color: var(--warn); }
  .who { font-weight: 650; }
  .who.claude { color: var(--accent); }
  .meta { font: 11px/1 var(--mono); color: var(--dim); margin-left: 6px; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .queued { border-left: 2px solid var(--warn); padding-left: 8px; }
  .note {
    font: 12px/1.5 var(--mono); color: var(--dim);
    border-left: 2px solid var(--line); padding-left: 8px; margin-bottom: 6px;
  }
  .note.conflict { color: var(--warn); border-color: var(--warn); }
  .note.observer { color: var(--accent); border-color: var(--accent); }
  #brief .line { font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; }
  #brief .head { color: var(--accent); }
  #brief .stale { color: var(--warn); font-size: 11px; }
  #admin .row {
    display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
    padding: 4px 0; border-bottom: 1px solid var(--line);
  }
  #admin .who { flex: 1; min-width: 7ch; font-size: 12px; }
  #admin .tag { font: 10px/1 var(--mono); color: var(--dim); }
  #admin select, #admin input {
    font: 11px/1 var(--mono); padding: 2px 4px; background: var(--bg);
    color: var(--ink); border: 1px solid var(--line); border-radius: 4px;
  }
  #admin input.wide { width: 100%; }
  #admin .danger { color: var(--bad); border-color: var(--bad); }
  #admin .bar { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0; }
  .note.reject { color: var(--bad); border-color: var(--bad); }
  table { width: 100%; border-collapse: collapse; font: 12px/1.5 var(--mono); }
  td { padding: 2px 0; }
  td.num { text-align: right; color: var(--dim); }
  .approval {
    border: 1px solid var(--warn); border-radius: 6px; padding: 8px; margin-bottom: 8px;
  }
  .approval pre {
    font: 11px/1.4 var(--mono); background: var(--bg); padding: 6px;
    border-radius: 4px; overflow-x: auto; margin: 6px 0; max-height: 140px;
  }
  form { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); background: var(--panel); }
  textarea {
    flex: 1; resize: none; font: inherit; padding: 8px 10px; border-radius: 6px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  }
  button {
    font: inherit; padding: 8px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.small { padding: 3px 9px; font-size: 12px; }
  label.toggle { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dim); }
  #banner {
    display: none; padding: 8px 16px; background: var(--bad); color: #fff; font-size: 13px;
  }
  #gate { padding: 40px 16px; text-align: center; }
  #gate input { font: inherit; padding: 8px; width: min(420px, 90%); }
</style>
</head>
<body>

<div id="banner"></div>

<div id="gate">
  <h1>${room}</h1>
  <p>Paste your join token to enter the room.</p>
  <p><input id="tok" placeholder="join token" autocomplete="off"></p>
  <p><button class="primary" id="enter">Enter</button></p>
</div>

<div id="app" hidden style="display:contents">
  <header>
    <h1>${room}</h1>
    <span class="pill" id="me">…</span>
    <span class="pill" id="conn">connecting</span>
    <span class="pill" id="state">idle</span>
    <span class="pill" id="payer"></span>
  </header>
  <main>
    <div id="log"></div>
    <aside>
      <h2>Room state</h2><div id="brief"><span class="note">observer off</span></div>
      <h2 id="adminHead" hidden>Admin</h2><div id="admin" hidden></div>
      <h2>Members</h2><div id="members"></div>
      <h2>Approvals</h2><div id="approvals"><span class="note">none pending</span></div>
      <h2>Cost by member</h2><table id="cost"></table>
      <h2>Cache ratio</h2><div id="ratio" class="note">no turns yet</div>
      <h2>Decisions</h2><div id="decisions"></div>
      <h2>Activity</h2><div id="activity"></div>
    </aside>
  </main>
  <form id="composer">
    <textarea id="text" rows="2" placeholder="Message the room. Mention the agent by @handle to address it."></textarea>
    <label class="toggle"><input type="checkbox" id="force"> to Claude</label>
    <button type="button" id="attach">Attach</button>
    <input type="file" id="file" hidden>
    <button type="submit" class="primary">Send</button>
  </form>
</div>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = new URL(location.href).searchParams.get('token') || localStorage.getItem('roomToken') || '';
  var me = null;
  var es = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // textContent only: all of this is untrusted
    return e;
  }

  function atBottom() {
    var l = $('log');
    return l.scrollHeight - l.scrollTop - l.clientHeight < 60;
  }
  function scroll() { var l = $('log'); l.scrollTop = l.scrollHeight; }

  // msgId -> turnId, and the DOM node for each message, so a turn that starts
  // after a message was already rendered can still make it expandable.
  var msgTurn = {};
  var nodes = {};
  var openDetails = {};   // turnId -> detail element currently expanded

  function addMessage(m) {
    var stick = atBottom();
    var wrap = el('div', 'msg' + (m.addressed ? ' queued' : ''));
    var head = el('div');
    var whoClass = 'who' + (m.kind === 'reply' || m.kind === 'system' ? ' claude' : '');
    var who = el('span', whoClass, m.name || 'unknown');
    head.appendChild(who);
    var bits = new Date(m.ts || Date.now()).toTimeString().slice(0, 5);
    if (m.addressed) bits += ' · to claude';
    if (m.attachment) bits += ' · ' + m.attachment.name;
    head.appendChild(el('span', 'meta', bits));
    var disclose = el('span', 'disclose', '');
    head.appendChild(disclose);
    wrap.appendChild(head);
    wrap.appendChild(el('div', 'body', m.text || ''));
    $('log').appendChild(wrap);
    nodes[m.id] = wrap;

    if (m.turnId) msgTurn[m.id] = m.turnId;
    head.onclick = function () { toggleDetail(m.id, wrap, disclose); };
    markExpandable(m.id);

    if (stick) scroll();
  }

  function markExpandable(msgId) {
    var wrap = nodes[msgId];
    if (!wrap || !msgTurn[msgId]) return;
    wrap.className += wrap.className.indexOf('has-detail') === -1 ? ' has-detail' : '';
    var d = wrap.querySelector('.disclose');
    if (d && !d.textContent) d.textContent = '▸ what claude did';
  }

  function toggleDetail(msgId, wrap, disclose) {
    var turnId = msgTurn[msgId];
    if (!turnId) return;
    var existing = wrap.querySelector('.detail');
    if (existing) {
      existing.remove();
      delete openDetails[turnId];
      disclose.textContent = '▸ what claude did';
      return;
    }
    disclose.textContent = '▾ what claude did';
    var box = el('div', 'detail');
    box.appendChild(el('div', 'step', 'loading…'));
    wrap.appendChild(box);
    openDetails[turnId] = box;
    fetch('/api/turn?id=' + encodeURIComponent(turnId) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) { if (t) renderDetail(box, t); else box.textContent = 'no detail recorded'; });
  }

  function stepRow(a, prevTs) {
    var row = el('div', 'step');
    var mark = a.kind === 'tool-start' ? '→' : a.kind === 'tool-end' ? '✓' : '·';
    row.appendChild(el('span', 'tool', mark + ' ' + (a.tool || a.type || a.kind)));
    if (a.input) {
      var v = a.input.file_path || a.input.command || a.input.pattern || a.input.path ||
        JSON.stringify(a.input);
      row.appendChild(el('span', 'arg', String(v).slice(0, 300)));
    } else {
      row.appendChild(el('span', 'arg', ''));
    }
    if (prevTs && a.ts) row.appendChild(el('span', 'dur', '+' + Math.max(0, a.ts - prevTs) + 'ms'));
    return row;
  }

  function renderDetail(box, t) {
    box.textContent = '';
    if (!t.activity.length) box.appendChild(el('div', 'step', 'no tool calls recorded'));
    var prev = null;
    t.activity.forEach(function (a) {
      box.appendChild(stepRow(a, prev));
      prev = a.ts;
    });
    t.replies.forEach(function (r) {
      box.appendChild(el('div', 'step', '💬 ' + r.text.slice(0, 400)));
    });
    var sum;
    if (t.usage) {
      sum = 'turn used ' + num(t.usage.input + t.usage.output + t.usage.cacheRead + t.usage.cacheCreate) +
        ' tokens · ' + Math.round((t.ratio || 0) * 100) + '% cached' +
        (t.endedAt ? ' · ' + ((t.endedAt - t.startedAt) / 1000).toFixed(1) + 's' : '');
    } else {
      sum = 'still running…';
    }
    var s = el('div', 'summary' + (t.usage ? '' : ' running'), sum);
    box.appendChild(s);
  }

  /** Live-append into any detail pane that is open for the running turn. */
  function liveAppend(a) {
    var box = a.turnId && openDetails[a.turnId];
    if (!box) return;
    var placeholder = box.querySelector('.summary');
    var row = stepRow(a, null);
    if (placeholder) box.insertBefore(row, placeholder); else box.appendChild(row);
  }

  function addNote(cls, text) {
    var stick = atBottom();
    $('log').appendChild(el('div', 'note ' + cls, text));
    if (stick) scroll();
  }

  function addActivity(a) {
    var box = $('activity');
    var line = a.kind === 'tool-start' ? '→ ' + (a.tool || 'tool')
      : a.kind === 'tool-end' ? '✓ ' + (a.tool || 'tool')
      : a.kind === 'notification' ? '! ' + (a.type || 'notice')
      : a.kind === 'session-start' ? 'session started' : a.kind;
    box.insertBefore(el('div', 'note', line), box.firstChild);
    while (box.childNodes.length > 40) box.removeChild(box.lastChild);
  }

  function num(v) {
    v = Math.round(v || 0);
    return v >= 1000000 ? (v / 1000000).toFixed(1) + 'M'
      : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
  }

  function costRow(t, name, u) {
    u = u || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    var row = el('tr');
    row.appendChild(el('td', null, name));
    row.appendChild(el('td', 'num', num(u.input + u.output + u.cacheRead + u.cacheCreate)));
    t.appendChild(row);
  }

  function renderCost(members, totals) {
    var t = $('cost');
    t.textContent = '';
    members.forEach(function (m) { costRow(t, m.name, totals[m.id]); });
    var obs = totals.observer;
    // The observer spends but is not a member, so it gets its own row.
    if (obs && (obs.input + obs.output) > 0) costRow(t, 'observer', obs);
  }

  function renderMembers(members) {
    var box = $('members');
    box.textContent = '';
    members.forEach(function (m) {
      box.appendChild(el('div', 'note', m.name + ' · ' + m.role));
    });
  }

  function renderBriefPanel(b) {
    var box = $('brief');
    box.textContent = '';
    if (!b || !b.on) { box.appendChild(el('span', 'note', 'observer off')); return; }
    if (b.paused) { box.appendChild(el('span', 'note', 'observer paused — over budget')); }
    if (!b.text) { box.appendChild(el('span', 'note', 'nothing summarised yet')); return; }
    // Section headers are the lines the renderer emits without indentation.
    b.text.split('\n').forEach(function (l) {
      box.appendChild(el('div', 'line' + (l.indexOf(' ') === 0 ? '' : ' head'), l));
    });
    if (b.stale || b.ageS > 30) {
      box.appendChild(el('div', 'stale', b.stale ? 'catching up…' : b.ageS + 's old'));
    }
  }

  // ---- admin panel: owners only -------------------------------------------
  function adminCall(action, body) {
    return fetch('/api/admin/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: token }, body || {}))
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) addNote('reject', 'admin: ' + r.reason);
      loadAdmin();
      return r;
    });
  }

  function btn(label, cls, fn) {
    var b = el('button', 'small' + (cls ? ' ' + cls : ''), label);
    b.onclick = fn;
    return b;
  }

  function memberRow(m) {
    var row = el('div', 'row');
    var who = el('span', 'who', m.name);
    row.appendChild(who);
    row.appendChild(el('span', 'tag', (m.canApprove ? 'approver ' : '') + (m.muted ? 'muted' : '')));

    var sel = document.createElement('select');
    ['owner', 'member', 'viewer'].forEach(function (r) {
      var o = document.createElement('option');
      o.value = r; o.textContent = r; o.selected = m.role === r;
      sel.appendChild(o);
    });
    sel.onchange = function () { adminCall('role', { memberId: m.id, role: sel.value }); };
    row.appendChild(sel);

    row.appendChild(btn(m.muted ? 'unmute' : 'mute', null, function () {
      adminCall('mute', { memberId: m.id, muted: !m.muted });
    }));
    row.appendChild(btn(m.canApprove ? 'unapprove' : 'approve', null, function () {
      adminCall('approve', { memberId: m.id, canApprove: !m.canApprove });
    }));
    row.appendChild(btn('copy link', null, function () {
      navigator.clipboard && navigator.clipboard.writeText(m.joinUrl);
    }));
    row.appendChild(btn('new link', null, function () {
      adminCall('rotate', { memberId: m.id });
    }));
    row.appendChild(btn('remove', 'danger', function () {
      if (confirm('Remove ' + m.name + '? Their link stops working immediately.')) {
        adminCall('remove', { memberId: m.id });
      }
    }));
    row.appendChild(btn('ban', 'danger', function () {
      if (confirm('Ban ' + m.name + '? They cannot be re-invited under that name.')) {
        adminCall('ban', { memberId: m.id, reason: '' });
      }
    }));
    return row;
  }

  function renderAdmin(s) {
    var box = $('admin');
    box.textContent = '';

    var bar = el('div', 'bar');
    bar.appendChild(btn(s.paused ? 'resume room' : 'pause room', s.paused ? 'danger' : null, function () {
      adminCall('pause', { paused: !s.paused });
    }));
    bar.appendChild(btn('clear queue', null, function () { adminCall('clearQueue', {}); }));
    box.appendChild(bar);

    var handleRow = el('div', 'row');
    handleRow.appendChild(el('span', 'who', 'agent @'));
    var hi = document.createElement('input');
    hi.className = 'wide'; hi.value = s.handles.join(',');
    hi.onkeydown = function (e) {
      if (e.key === 'Enter') adminCall('handles', { handles: hi.value });
    };
    handleRow.appendChild(hi);
    handleRow.appendChild(btn('set', null, function () { adminCall('handles', { handles: hi.value }); }));
    box.appendChild(handleRow);

    var inviteRow = el('div', 'row');
    inviteRow.appendChild(el('span', 'who', 'invite'));
    var ni = document.createElement('input');
    ni.placeholder = 'name';
    var rs = document.createElement('select');
    ['member', 'viewer', 'owner'].forEach(function (r) {
      var o = document.createElement('option'); o.value = r; o.textContent = r; rs.appendChild(o);
    });
    inviteRow.appendChild(ni);
    inviteRow.appendChild(rs);
    inviteRow.appendChild(btn('add', null, function () {
      if (!ni.value.trim()) return;
      adminCall('invite', { name: ni.value.trim(), role: rs.value }).then(function (r) {
        if (r.ok) { ni.value = ''; addNote('', 'invite link for ' + r.member.name + ': ' + r.joinUrl); }
      });
    }));
    box.appendChild(inviteRow);

    s.members.forEach(function (m) { box.appendChild(memberRow(m)); });

    if (s.bans.length) {
      box.appendChild(el('div', 'tag', 'banned:'));
      s.bans.forEach(function (b) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'who', b.name || b.addr));
        r.appendChild(btn('unban', null, function () { adminCall('unban', { key: b.name || b.addr }); }));
        box.appendChild(r);
      });
    }
  }

  function loadAdmin() {
    if (!me || me.role !== 'owner') return;
    fetch('/api/admin/state?token=' + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || !s.ok) return;
        $('admin').hidden = false;
        $('adminHead').hidden = false;
        renderAdmin(s);
      });
  }

  function renderDecisions(list) {
    var box = $('decisions');
    box.textContent = '';
    if (!list.length) { box.appendChild(el('span', 'note', 'none recorded')); return; }
    list.forEach(function (d) { box.appendChild(el('div', 'note', d.text)); });
  }

  var approvals = [];
  function renderApprovals() {
    var box = $('approvals');
    box.textContent = '';
    if (!me || !me.canApprove || !approvals.length) {
      box.appendChild(el('span', 'note', me && me.canApprove ? 'none pending' : 'not an approver'));
      return;
    }
    approvals.forEach(function (a) {
      var card = el('div', 'approval');
      card.appendChild(el('div', null, 'Claude wants ' + a.tool_name));
      card.appendChild(el('div', 'note', a.description || ''));
      var pre = el('pre', null, a.input_preview || '');
      card.appendChild(pre);
      ['allow', 'deny'].forEach(function (behavior) {
        var b = el('button', 'small', behavior);
        b.onclick = function () { verdict(a.request_id, behavior); };
        card.appendChild(b);
      });
      box.appendChild(card);
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

  function banner(text) {
    var b = $('banner');
    if (!text) { b.style.display = 'none'; return; }
    b.textContent = text;
    b.style.display = 'block';
  }

  function connect() {
    es = new EventSource('/events?token=' + encodeURIComponent(token));
    es.onopen = function () { $('conn').textContent = 'live'; $('conn').className = 'pill live'; banner(''); };
    es.onerror = function () {
      $('conn').textContent = 'offline'; $('conn').className = 'pill off';
      banner('Room offline. The Claude Code session may have exited. Retrying…');
    };
    es.addEventListener('message', function (e) { addMessage(JSON.parse(e.data)); });
    es.addEventListener('activity', function (e) {
      var a = JSON.parse(e.data);
      addActivity(a);
      liveAppend(a);
    });
    es.addEventListener('presence', function (e) { renderMembers(JSON.parse(e.data).members); });
    es.addEventListener('brief', function (e) { renderBriefPanel(JSON.parse(e.data)); });
    es.addEventListener('admin', function (e) {
      var d = JSON.parse(e.data);
      addNote('', 'admin: ' + d.action + (d.name ? ' ' + d.name : '') +
        (d.handles ? ' → @' + d.handles.join(', @') : '') +
        (typeof d.paused === 'boolean' ? (d.paused ? ' (paused)' : ' (resumed)') : ''));
      load();
    });
    es.addEventListener('decision', function (e) { load(); });
    es.addEventListener('turn', function (e) {
      var d = JSON.parse(e.data);
      $('state').textContent = d.started ? 'claude working' : 'idle';
      $('state').className = 'pill' + (d.started ? ' busy' : '');
      // A turn starts after its messages were already drawn, so this is where
      // they become expandable.
      if (d.started && d.msgIds) {
        d.msgIds.forEach(function (id) { msgTurn[id] = d.turnId; markExpandable(id); });
      }
      if (!d.started && d.summary && openDetails[d.turnId]) {
        fetch('/api/turn?id=' + encodeURIComponent(d.turnId) + '&token=' + encodeURIComponent(token))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (t) { if (t) renderDetail(openDetails[d.turnId], t); });
      }
    });
    es.addEventListener('cost', function (e) {
      var d = JSON.parse(e.data);
      $('ratio').textContent = 'last turn: ' + Math.round(d.ratio * 100) + '% cached';
      load();
    });
    es.addEventListener('conflicts', function (e) {
      JSON.parse(e.data).conflicts.forEach(function (c) {
        addNote('conflict', 'May contradict an earlier decision: "' + c.decision.text + '"');
      });
    });
    es.addEventListener('rejected', function (e) {
      var d = JSON.parse(e.data);
      addNote('reject', d.name + ' was rejected: ' + d.reason);
    });
    es.addEventListener('approval-request', function (e) {
      approvals.push(JSON.parse(e.data));
      renderApprovals();
    });
    es.addEventListener('approval', function (e) {
      var d = JSON.parse(e.data);
      approvals = approvals.filter(function (a) { return a.request_id !== d.request_id; });
      renderApprovals();
      addNote('', d.by + ' chose ' + d.behavior);
    });
  }

  function load() {
    return fetch('/api/state?token=' + encodeURIComponent(token))
      .then(function (r) {
        if (!r.ok) throw new Error('bad token');
        return r.json();
      })
      .then(function (s) {
        me = s.you;
        $('me').textContent = s.you.name + ' · ' + s.you.role;
        $('payer').textContent = s.payerMode === 'rotate' ? 'payer: rotating' : 'payer: host';
        renderMembers(s.members);
        renderCost(s.members, s.ledger);
        renderDecisions(s.decisions);
        renderBriefPanel(s.brief);
        $('state').textContent = s.paused ? 'paused' : s.busy ? 'claude working' : 'idle';
        if (s.paused) $('state').className = 'pill off';
        loadAdmin();
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
      $('log').textContent = '';
      s.messages.forEach(addMessage);
      scroll();
      connect();
    }).catch(function () {
      $('gate').style.display = 'block';
      $('app').hidden = true;
      banner('That token was not accepted.');
    });
  }

  $('enter').onclick = function () {
    token = $('tok').value.trim();
    if (token) start();
  };

  $('attach').onclick = function () { $('file').click(); };
  $('file').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var q = '/upload?token=' + encodeURIComponent(token) +
      '&name=' + encodeURIComponent(f.name) +
      '&text=' + encodeURIComponent($('text').value.trim());
    fetch(q, { method: 'POST', body: f }).then(function () {
      $('text').value = '';
      e.target.value = '';
    });
  };

  $('composer').onsubmit = function (e) {
    e.preventDefault();
    var text = $('text').value.trim();
    if (!text) return;
    $('text').value = '';
    fetch('/msg', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, text: text, force: $('force').checked })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) addNote('reject', 'Not sent: ' + r.reason);
    });
  };

  $('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  if (token) start();
})();
</script>
</body>
</html>`
}
