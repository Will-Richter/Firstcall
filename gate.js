/* Log-in, sign-up, set-up steps and the account screen. Once someone is signed in it hands over to the app screens. */
(function () {
  'use strict';
  var H = window.__firstcallHost;
  if (!H) return;
  var api = H.api;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(html) { var t = document.createElement('div'); t.innerHTML = html; return t.firstElementChild; }
  var toastT;
  H.toast = function (m) { var t = $('toast'); if (!t) return; t.hidden = true; void t.offsetWidth; t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3200); };
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isInstalled = function () { return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); };
  var LOGO = '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="4" y="4" width="92" height="92" rx="25" fill="#F58220"/><g fill="none" stroke="#141A40" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="10" d="M29 40l12-9v40"/><path stroke-width="8" d="M55 39a16 16 0 0 1 0 24"/><path stroke-width="8" d="M66 29a31 31 0 0 1 0 44"/></g></svg>';
  var ago = function (ms) { var m = Math.max(0, Math.round((Date.now() - ms) / 6e4)); if (m < 2) return 'just now'; if (m < 60) return m + ' minutes ago'; var h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago'); var d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago'); };
  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; });

  /* ---------- log in / create account ---------- */
  var gate = null;
  var mode = 'login';
  var info = { firstRun: false, signups: false };
  function showGate(message) {
    if (!gate) { gate = el('<div id="fc-gate" role="dialog" aria-modal="true" aria-label="Log in to Firstcall"></div>'); document.body.appendChild(gate); gate.addEventListener('submit', onSubmit); gate.addEventListener('click', onGateClick); }
    var typed = $('g-email') ? $('g-email').value : (H.lastEmail() || '');
    var title = mode === 'create' ? (info.firstRun ? 'Create your account' : 'Create an account') : mode === 'reset' ? 'Reset your password' : 'Log in';
    var lead = mode === 'create' ? (info.firstRun ? 'This is a new Firstcall. The account you create now owns it.' : 'Your leads, statuses and notes are kept under this account.')
      : mode === 'reset' ? 'Enter your email, the ServiceM8 API key connected to your account, and a new password.' : 'Your website leads, ready to call.';
    var h = '<form class="g-card" novalidate><div class="g-logo">' + LOGO + 'Firstcall</div><h1>' + title + '</h1><p>' + lead + '</p>' +
      (message ? '<div class="g-err" role="alert">' + esc(message) + '</div>' : '') +
      '<label>Email<input id="g-email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" value="' + esc(typed) + '" required></label>';
    if (mode === 'reset') h += '<label>ServiceM8 API key<input id="g-key" type="password" autocomplete="off" required></label><label>New password<input id="g-pass" type="password" autocomplete="new-password" minlength="8" required></label>';
    else h += '<label>Password<input id="g-pass" type="password" autocomplete="' + (mode === 'create' ? 'new-password' : 'current-password') + '" minlength="8" required></label>';
    h += '<button class="g-go" type="submit">' + (mode === 'create' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Log in') + '</button><div class="g-row">';
    if (mode !== 'login' && !(mode === 'create' && info.firstRun)) h += '<button class="g-link" type="button" data-mode="login">Back to log in</button>';
    if (mode === 'login' && info.signups) h += '<button class="g-link" type="button" data-mode="create">Create an account</button>';
    if (mode === 'login') h += '<button class="g-link" type="button" data-mode="reset">Forgot password</button>';
    gate.innerHTML = h + '</div></form>';
    gate.hidden = false;
    var first = $('g-email');
    if (first && !first.value) first.focus(); else if ($('g-pass')) $('g-pass').focus();
  }
  function onGateClick(ev) { var b = ev.target.closest('[data-mode]'); if (b) { mode = b.dataset.mode; showGate(); } }
  function onSubmit(ev) {
    ev.preventDefault();
    var email = $('g-email').value.trim();
    var pass = $('g-pass').value;
    if (!email || !pass) return showGate('Enter your email and password.');
    if (mode !== 'login' && pass.length < 8) return showGate('Use a password of at least 8 characters.');
    var btn = gate.querySelector('.g-go');
    btn.disabled = true;
    var call = mode === 'create' ? api('POST', '/api/signup', { email: email, password: pass })
      : mode === 'reset' ? api('POST', '/api/reset', { email: email, apiKey: $('g-key').value.trim(), next: pass })
        : api('POST', '/api/login', { email: email, password: pass });
    call.then(function (me) { enter(me); }, function (e) { showGate(e && e.network ? 'No connection. Check your signal and try again.' : (e && e.message) || 'That did not work. Try again.'); });
  }

  /* ---------- hand over to the app ---------- */
  function enter(me) {
    var other = H.lastEmail() && H.lastEmail() !== me.email;
    if (other) H.forget();
    if (gate) gate.hidden = true;
    H.start(me);
    chrome();
    var want = new URLSearchParams(location.search).get('lead');
    if (want) { H.openLead(want); history.replaceState(null, '', '/'); }
  }
  function refreshMe() { return api('GET', '/api/me').then(function (me) { if (me.signedIn) { H.me = me; chrome(); } return me; }); }
  H.onSignedOut = function () { mode = 'login'; showGate('You have been logged out. Log in again to carry on.'); };
  H.onConnection = function (offline) { chrome(); if (!offline) setTimeout(function () { var s = $('syncbtn'); if (s && $('synclabel') && $('synclabel').textContent === 'Sync failed') s.click(); }, 300); };
  H.onData = function () { chrome(); };

  function boot() {
    api('GET', '/api/me', null, 12000).then(function (me) {
      info = me;
      if (me.signedIn) return enter(me);
      mode = me.firstRun ? 'create' : 'login';
      showGate();
    }, function () {
      if (H.hasCache()) {
        /* No reception: open from what is saved on this phone, and keep trying the server. */
        H.offline = true;
        H.start({ email: H.lastEmail(), sm8: {}, mail: {}, push: {} }, true);
        chrome();
        var t = setInterval(function () { refreshMe().then(function (me) { if (me.signedIn) { clearInterval(t); H.refresh().catch(function () {}); } else { clearInterval(t); H.onSignedOut(); } }, function () {}); }, 8000);
      } else {
        mode = 'login';
        showGate('No connection. Check your signal, then try again.');
      }
    });
  }

  /* ---------- the bits of app chrome that only exist here: account button, set-up steps, offline note ---------- */
  var pushChecked = false;
  var pushState = 'unknown'; /* unsupported | install | off | on | blocked */
  function readPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { pushState = isIos && !isInstalled() ? 'install' : 'unsupported'; return Promise.resolve(); }
    if (Notification.permission === 'denied') { pushState = 'blocked'; return Promise.resolve(); }
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      pushState = sub ? 'on' : 'off';
      /* Tell the server again about this device once per visit, in case it has forgotten it (after a password change, say). */
      if (sub && !pushChecked && H.me && !H.offline) { pushChecked = true; var j = sub.toJSON(); api('POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys }).catch(function () { pushChecked = false; }); }
    }, function () { pushState = 'unsupported'; });
  }
  function steps() {
    var me = H.me || {};
    var out = [];
    if (!(me.mail && me.mail.count) && !H.enquiries()) out.push({ id: 'mail', title: 'Connect your website emails', sub: 'So new enquiries land here by themselves' });
    if (!(me.sm8 && me.sm8.connected)) out.push({ id: 'sm8', title: 'Connect ServiceM8', sub: 'To send a lead across as a client and job' });
    if (pushState === 'off' || pushState === 'install') out.push({ id: 'push', title: 'Turn on notifications', sub: pushState === 'install' ? 'Add Firstcall to your Home Screen first' : 'Hear about a new lead within a minute or two' });
    return out;
  }
  function chrome() {
    var row = document.querySelector('.brandrow');
    if (row && !$('fc-acct')) {
      var b = el('<button class="g-acct" id="fc-acct" aria-label="Account and set-up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></button>');
      b.addEventListener('click', function () { openSettings(); });
      row.appendChild(b);
    }
    var tools = $('tools');
    if (tools && !$('fc-net')) { tools.parentNode.insertBefore(el('<div id="fc-net" hidden><div></div></div>'), tools); tools.parentNode.insertBefore(el('<div id="fc-setup" hidden></div>'), tools); $('fc-setup').addEventListener('click', function (ev) { var s = ev.target.closest('[data-step]'); if (s) openSettings(s.dataset.step); }); }
    var sb = $('syncbtn');
    if (sb) sb.setAttribute('aria-label', 'Check for new leads');
    var net = $('fc-net');
    if (net) { net.hidden = !H.offline; net.firstChild.textContent = 'No connection. Showing the copy saved on this phone' + (H.pending() ? '; ' + H.pending() + (H.pending() === 1 ? ' change' : ' changes') + ' will be sent when you are back in range.' : '.'); }
    readPush().then(function () {
      var todo = H.offline ? [] : steps();
      var box = $('fc-setup');
      var acct = $('fc-acct');
      if (acct) { var dot = acct.querySelector('i'); if (todo.length && !dot) acct.appendChild(document.createElement('i')); else if (!todo.length && dot) dot.remove(); }
      if (!box) return;
      box.hidden = !todo.length;
      if (!todo.length) return;
      box.innerHTML = '<div class="g-box"><h2>' + (todo.length === 1 ? 'One step left to finish setting up' : todo.length + ' steps left to finish setting up') + '</h2>' + todo.map(function (s, i) {
        return '<button class="g-step" data-step="' + s.id + '"><span class="g-num">' + (i + 1) + '</span><span><b>' + s.title + '</b><span>' + s.sub + '</span></span><svg class="g-chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4l6 6-6 6"/></svg></button>';
      }).join('') + '</div>';
    });
  }

  /* ---------- account and set-up sheet ---------- */
  var sheet = null;
  var mailInfo = null;
  var note = {}; /* one message per section: { kind: 'err' | 'ok', text } */
  function openSettings(focus) {
    if (!sheet) {
      sheet = el('<div id="fc-settings" hidden><div class="scrim" data-g="close"></div><aside class="sheet" role="dialog" aria-modal="true" aria-label="Account and set-up"><div class="sh-head"><span class="iconbtn" aria-hidden="true"></span><div class="t">Account and set-up</div><button class="iconbtn" data-g="close" aria-label="Close"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div><div class="sh-body still" id="fc-sbody"></div></aside></div>');
      document.body.appendChild(sheet);
      sheet.addEventListener('click', onSheetClick);
    }
    note = {};
    sheet.classList.remove('closing');
    sheet.hidden = false;
    document.documentElement.classList.add('lock');
    renderSettings();
    refreshMe().then(renderSettings, function () {});
    api('GET', '/api/mail').then(function (m) { mailInfo = m; renderSettings(); }, function () {});
    if (focus) setTimeout(function () { var s = $('fc-sec-' + focus); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 120);
  }
  function closeSettings() {
    if (!sheet || sheet.hidden) return;
    sheet.classList.add('closing');
    setTimeout(function () { sheet.hidden = true; sheet.classList.remove('closing'); document.documentElement.classList.remove('lock'); }, 230);
    chrome();
  }
  function msg(id) { return note[id] ? '<div class="g-' + note[id].kind + '" role="status">' + esc(note[id].text) + '</div>' : ''; }
  function keep(ids) { var v = {}; ids.forEach(function (i) { var e = $(i); if (e) v[i] = e.value; }); return v; }
  function renderSettings() {
    if (!sheet || sheet.hidden) return;
    var me = H.me || {};
    var body = $('fc-sbody');
    var top = body.scrollTop;
    var typed = keep(['g-sm8key', 'g-cur', 'g-new']);
    var focusId = document.activeElement && document.activeElement.id;
    var h = '';
    /* website emails */
    var count = me.mail && me.mail.count;
    h += '<section class="sec" id="fc-sec-mail"><h3>Website emails</h3><div class="g-state"><span class="g-dot' + (count ? ' on' : '') + '"></span>' +
      (count ? esc(count + (count === 1 ? ' enquiry' : ' enquiries') + ' received' + (me.mail.lastAt ? ', the latest ' + ago(me.mail.lastAt) : '')) : 'Not connected yet') + '</div>' +
      '<p class="hint">A small script in your own Google account checks your inbox every minute and passes new website form emails to Firstcall. Nothing else in your mailbox is read or sent.</p>' +
      '<ol><li>On a computer, open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, signed in as the Gmail account that receives your website forms.</li>' +
      '<li>Delete what is in the editor and paste the script from the button below.</li>' +
      '<li>Press Save, pick <code>setup</code> in the function list at the top, press Run, and choose Allow when Google asks.</li></ol>' +
      '<div class="rowacts"><button class="btn primary" data-g="copy-script"' + (mailInfo ? '' : ' disabled') + '>Copy the script</button><button class="btn" data-g="email-script"' + (mailInfo ? '' : ' disabled') + '>Email it to me</button></div>' + msg('mail') +
      (count ? '' : '<p class="hint">Your last 12 months of enquiries arrive a minute or so after you press Run.</p>') + '</section>';
    /* ServiceM8 */
    h += '<section class="sec" id="fc-sec-sm8"><h3>ServiceM8</h3>';
    if (me.sm8 && me.sm8.connected) h += '<div class="g-state"><span class="g-dot on"></span>Connected' + (me.sm8.business ? ' to ' + esc(me.sm8.business) : '') + '</div>' + msg('sm8') + '<div class="rowacts"><button class="btn sm" data-g="sm8-off">Disconnect</button></div>';
    else h += '<div class="g-state"><span class="g-dot"></span>Not connected yet</div><p class="hint">In ServiceM8 on a computer, go to Settings, then API Keys, and create a key for Firstcall. It needs to be allowed to manage clients, contacts and jobs. Paste it here.</p>' +
      '<label class="field">ServiceM8 API key<input id="g-sm8key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' + msg('sm8') + '<div class="rowacts"><button class="btn primary" data-g="sm8-on">Connect ServiceM8</button></div>';
    h += '</section>';
    /* notifications */
    h += '<section class="sec" id="fc-sec-push"><h3>Notifications</h3>';
    if (pushState === 'on') h += '<div class="g-state"><span class="g-dot on"></span>On for this device</div>' + msg('push') + '<div class="rowacts"><button class="btn sm" data-g="push-test">Send a test</button><button class="btn sm" data-g="push-off">Turn off</button></div>';
    else if (pushState === 'off') h += '<div class="g-state"><span class="g-dot"></span>Off for this device</div><p class="hint">Get a notification on this device when a new website lead arrives.</p>' + msg('push') + '<div class="rowacts"><button class="btn primary" data-g="push-on">Turn on notifications</button></div>';
    else if (pushState === 'install') h += '<div class="g-state"><span class="g-dot"></span>Add to Home Screen first</div><p class="hint">On iPhone, notifications only work once Firstcall is on your Home Screen. In Safari, tap the Share button, then Add to Home Screen, open Firstcall from the new icon, and come back here.</p>';
    else if (pushState === 'blocked') h += '<div class="g-state"><span class="g-dot"></span>Blocked on this device</div><p class="hint">Notifications for Firstcall are switched off in this device\'s settings. Allow them there, then come back here.</p>';
    else h += '<div class="g-state"><span class="g-dot"></span>Not available in this browser</div>';
    h += '</section>';
    /* home screen */
    if (!isInstalled()) h += '<section class="sec" id="fc-sec-install"><h3>Put Firstcall on your phone</h3>' + (isIos ? '<p class="hint">In Safari, tap the Share button, then Add to Home Screen. Firstcall then opens full screen from its own icon.</p>' : installEvent ? '<div class="rowacts"><button class="btn primary" data-g="install">Install Firstcall</button></div>' : '<p class="hint">In your browser menu, choose Add to Home screen or Install app. Firstcall then opens full screen from its own icon.</p>') + '</section>';
    /* account */
    h += '<section class="sec" id="fc-sec-acct"><h3>Account</h3><div class="g-state">' + esc(me.email || '') + '</div>' +
      '<label class="field">Current password<input id="g-cur" type="password" autocomplete="current-password"></label><label class="field">New password<input id="g-new" type="password" autocomplete="new-password"></label>' + msg('acct') +
      '<div class="rowacts"><button class="btn sm" data-g="pass">Change password</button><button class="btn sm" data-g="logout">Log out</button></div></section>';
    body.innerHTML = h;
    body.scrollTop = top;
    Object.keys(typed).forEach(function (i) { var e = $(i); if (e) e.value = typed[i]; });
    if (focusId && $(focusId)) $(focusId).focus();
  }
  function say(id, kind, text) { note[id] = { kind: kind, text: text }; renderSettings(); }
  function why(e) { return e && e.network ? 'No connection. Try again when you have signal.' : (e && e.message) || 'That did not work.'; }
  function b64ToBytes(s) { var p = (s + '===='.slice((s.length + 3) % 4 + 1)).replace(/-/g, '+').replace(/_/g, '/'); var raw = atob(p); var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }

  function onSheetClick(ev) {
    var t = ev.target.closest('[data-g]');
    if (!t) return;
    var a = t.dataset.g;
    if (a === 'close') return closeSettings();
    if (a === 'copy-script') {
      if (!mailInfo) return;
      var done = function () { say('mail', 'ok', 'Script copied. Paste it into the Google script editor.'); };
      var fail = function () { say('mail', 'err', "Couldn't copy on this device. Use Email it to me, then copy it from the email."); };
      try { navigator.clipboard.writeText(mailInfo.script).then(done, fail); } catch (e) { fail(); }
    } else if (a === 'email-script') {
      if (!mailInfo) return;
      location.href = 'mailto:' + encodeURIComponent(H.me.email) + '?subject=' + encodeURIComponent('Firstcall mail link script') + '&body=' + encodeURIComponent('Paste everything below the line into script.google.com, then run "setup".\n\n----------\n' + mailInfo.script);
    } else if (a === 'sm8-on') {
      var key = ($('g-sm8key').value || '').trim();
      if (!key) return say('sm8', 'err', 'Paste your ServiceM8 API key first.');
      t.disabled = true;
      api('POST', '/api/sm8/connect', { apiKey: key }, 40000).then(function () { $('g-sm8key').value = ''; note.sm8 = { kind: 'ok', text: 'ServiceM8 is connected.' }; return refreshMe(); }).then(renderSettings, function (e) { say('sm8', 'err', e && e.network ? why(e) : 'ServiceM8 said: ' + why(e)); });
    } else if (a === 'sm8-off') {
      api('DELETE', '/api/sm8').then(refreshMe).then(renderSettings, function (e) { say('sm8', 'err', why(e)); });
    } else if (a === 'push-on') {
      t.disabled = true;
      Notification.requestPermission().then(function (p) {
        if (p !== 'granted') throw { message: 'Notifications were not allowed on this device.' };
        return navigator.serviceWorker.ready;
      }).then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(H.me.push.key) }); })
        .then(function (sub) { var j = sub.toJSON(); return api('POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys }); })
        .then(function () { note.push = { kind: 'ok', text: 'Notifications are on for this device.' }; return readPush(); })
        .then(function () { renderSettings(); chrome(); }, function (e) { readPush().then(function () { say('push', 'err', why(e)); }); });
    } else if (a === 'push-off') {
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (!sub) return null;
        return api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () {}).then(function () { return sub.unsubscribe(); });
      }).then(readPush).then(function () { note.push = null; renderSettings(); chrome(); }, function (e) { say('push', 'err', why(e)); });
    } else if (a === 'push-test') {
      api('POST', '/api/push/test').then(function (r) { say('push', r.sent ? 'ok' : 'err', r.sent ? 'Sent. It should arrive in a few seconds.' : "The test couldn't be delivered. Turn notifications off and on again."); }, function (e) { say('push', 'err', why(e)); });
    } else if (a === 'install') {
      if (installEvent) { installEvent.prompt(); installEvent = null; }
    } else if (a === 'pass') {
      var cur = $('g-cur').value, next = $('g-new').value;
      if (!cur || next.length < 8) return say('acct', 'err', 'Enter your current password and a new one of at least 8 characters.');
      api('POST', '/api/password', { current: cur, next: next }).then(function () { $('g-cur').value = ''; $('g-new').value = ''; pushChecked = false; readPush(); say('acct', 'ok', 'Password changed. Other devices have been logged out.'); }, function (e) { say('acct', 'err', why(e)); });
    } else if (a === 'logout') {
      var out = function () { api('POST', '/api/logout', {}).catch(function () {}).then(function () { H.forget(); location.reload(); }); };
      if (pushState === 'on') navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) { return sub ? api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () {}).then(function () { return sub.unsubscribe(); }) : null; }).then(out, out);
      else out();
    }
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeSettings(); });

  /* ---------- home screen app: saved files, notifications ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'lead') { H.refresh().catch(function () {}); if (d.key) H.openLead(d.key); }
    });
  }
  boot();
})();
