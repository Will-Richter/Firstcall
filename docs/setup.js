/* The connect screen, set-up steps and the account screen for the GitHub Pages copy of Firstcall.
   Once this device is connected to the owner's Google script it hands over to the app screens. */
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
  var ua = navigator.userAgent;
  var isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isPhone = isIos || /android/i.test(ua);
  var isInstalled = function () { return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); };
  var LOGO = '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="4" y="4" width="92" height="92" rx="25" fill="#F58220"/><g fill="none" stroke="#141A40" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="10" d="M29 40l12-9v40"/><path stroke-width="8" d="M55 39a16 16 0 0 1 0 24"/><path stroke-width="8" d="M66 29a31 31 0 0 1 0 44"/></g></svg>';
  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; });

  /* The script text is fetched ahead of time so that "Copy the script" can copy it the moment it is pressed. */
  var scriptText = '';
  function loadScript() { if (scriptText) return Promise.resolve(scriptText); return fetch('script.txt', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (t) { scriptText = t; return t; }); }
  function copy(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text); } catch (e) { /* fall through */ }
    return new Promise(function (ok, no) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      ta.remove();
      if (done) ok(); else no();
    });
  }
  function why(e) { return e && e.network ? 'No connection. Check your signal and try again.' : (e && e.message) || 'That did not work. Try again.'; }

  /* ---------- connect ---------- */
  var gate = null;
  var gateNote = null; /* { kind, text } */
  function showGate(message) {
    if (!gate) { gate = el('<div id="fc-gate" role="dialog" aria-modal="true" aria-label="Connect Firstcall"></div>'); document.body.appendChild(gate); gate.addEventListener('submit', onConnect); gate.addEventListener('click', onGateClick); }
    var typed = $('g-link') ? $('g-link').value : '';
    var field = '<label>' + (isPhone ? 'Your connection link' : 'Web app URL, or your connection link') + '<input id="g-link" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(typed) + '"></label>' +
      '<button class="g-go" type="submit">Connect</button>';
    var h = '<form class="g-card" novalidate><div class="g-logo">' + LOGO + 'Firstcall</div><h1>Connect Firstcall to your Gmail</h1>' +
      '<p>Firstcall reads your website form emails through a small script that runs in your own Google account. Set it up once, on a computer.</p>' +
      (message ? '<div class="g-err" role="alert">' + esc(message) + '</div>' : '') +
      (isPhone ? '<p>Already done that? Open the link it emailed you on this phone, or paste it here.</p>' + field + '<h2>Not set up yet</h2><p>Open this same page on a computer and follow these steps there.</p>' : '') +
      '<ol>' +
      '<li>Copy the script.<div class="g-acts"><button class="g-btn" type="button" data-g="copy-script">Copy the script</button>' + (gateNote ? '<span class="g-' + gateNote.kind + '" role="status">' + esc(gateNote.text) + '</span>' : '') + '</div></li>' +
      '<li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, signed in as the Gmail account your website forms go to. Delete what is in the editor, paste, and press Save.</li>' +
      '<li>Press <b>Deploy</b>, then <b>New deployment</b>. Click the cog beside "Select type" and pick <b>Web app</b>. Set "Execute as" to <b>Me</b> and "Who has access" to <b>Anyone</b> (not "Anyone with a Google account"). Press Deploy, then <b>Authorize access</b> and allow it.' +
      '<span class="g-hint">If Google says it hasn\'t verified the app, choose Advanced, then "Go to" your project. It is your own script, reading your own mail. "Anyone" is safe here: the script only answers a Firstcall that has its key.</span></li>' +
      '<li>Copy the <b>Web app URL</b> it shows you and paste it ' + (isPhone ? 'into Firstcall on the computer. It then offers to email the link to your phone.' : 'here.') + '</li></ol>' +
      (isPhone ? '' : field + '<p class="g-hint">Already set up on another device? Paste the connection link that was emailed to you.</p>') + '</form>';
    gate.innerHTML = h;
    gate.hidden = false;
    loadScript().catch(function () {});
  }
  function onGateClick(ev) {
    var b = ev.target.closest('[data-g]');
    if (!b) return;
    if (b.dataset.g === 'copy-script') {
      var ok = function () { gateNote = { kind: 'ok', text: 'Copied. Paste it into the script editor.' }; showGate(); };
      var no = function () { gateNote = { kind: 'bad', text: "Couldn't copy on this device. Open this page on a computer." }; showGate(); };
      if (scriptText) copy(scriptText).then(ok, no); else loadScript().then(function (t) { return copy(t); }).then(ok, no);
    }
  }
  function onConnect(ev) {
    ev.preventDefault();
    var text = $('g-link').value.trim();
    var btn = gate.querySelector('.g-go');
    var l = H.linkFromText(text);
    var url = l ? '' : H.scriptUrlIn(text);
    if (!l && !url) return showGate('Paste the Web app URL from the Deploy window (it ends in /exec), or your connection link.');
    btn.disabled = true; btn.textContent = 'Connecting';
    var first = !l;
    var step = l ? (H.useLink(l), api('me')) : H.claim(url).then(function () { return api('me'); });
    step.then(function (me) { gateNote = null; enter(me, first); }, function (e) {
      if (l) H.forget();
      showGate(e && e.code === 'bad_key' ? 'That connection link is no longer valid. Send yourself a new one from a device that is connected.' : why(e));
    });
  }

  /* ---------- hand over to the app ---------- */
  function enter(me, firstTime) {
    if (gate) gate.hidden = true;
    if (me) { H.me = me; H.remember('fc-me', me); } else H.me = H.recall('fc-me') || {};
    keepLinkForHomeScreen();
    H.start();
    chrome();
    if (!me) refreshMe().catch(function () {});
    if (firstTime && !isPhone) setTimeout(function () { openSettings('phone'); }, 900);
  }
  function refreshMe() { return api('me').then(function (me) { H.me = me; H.remember('fc-me', me); chrome(); return me; }); }
  H.onSignedOut = function () { H.forget(); showGate('This device is no longer connected. Paste your connection link to carry on.'); };
  H.onConnection = function (offline) { chrome(); if (!offline) setTimeout(function () { var s = $('syncbtn'); if (s && $('synclabel') && $('synclabel').textContent === 'Sync failed') s.click(); }, 300); };
  H.onData = function () { chrome(); };

  /* An iPhone gives a Home Screen app its own separate storage, so the connection saved in Safari does not carry
     over. Keeping the connection in the page address until it is installed lets "Add to Home Screen" take it along.
     Everywhere else the address is tidied straight away. */
  function keepLinkForHomeScreen() {
    var link = H.connectionLink();
    try {
      if (isIos && !isInstalled() && link) {
        var m = document.querySelector('link[rel="manifest"]');
        if (m) m.remove();
        history.replaceState(null, '', link.slice(link.indexOf('#')));
      } else if (location.hash.indexOf('#c=') === 0) history.replaceState(null, '', location.pathname);
    } catch (e) { /* the address stays as it is */ }
  }

  function boot() {
    if (H.connected()) enter(null, false); else showGate();
  }

  /* ---------- the bits of app chrome that only exist here: account button, set-up steps, notes ---------- */
  function steps() {
    var me = H.me || {};
    var out = [];
    if (!isPhone && !H.recall('fc-phone-done')) out.push({ id: 'phone', title: 'Open Firstcall on your phone', sub: 'Email yourself the link that connects it' });
    if (isPhone && !isInstalled()) out.push({ id: 'install', title: 'Add Firstcall to your Home Screen', sub: 'So it opens full screen from its own icon' });
    if (me.sm8 && !me.sm8.connected) out.push({ id: 'sm8', title: 'Connect ServiceM8', sub: 'To send a lead across as a client and job' });
    return out;
  }
  function chrome() {
    var row = document.querySelector('.brandrow');
    if (row && !$('fc-acct')) {
      var b = el('<button class="g-acct" id="fc-acct" aria-label="Account and set-up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></button>');
      b.addEventListener('click', function () { openSettings(); });
      row.appendChild(b);
    }
    var sb = $('syncbtn');
    if (sb) sb.setAttribute('aria-label', 'Check for new leads');
    var tools = $('tools');
    if (tools && !$('fc-net')) { tools.parentNode.insertBefore(el('<div id="fc-net" hidden><div></div></div>'), tools); tools.parentNode.insertBefore(el('<div id="fc-setup" hidden></div>'), tools); $('fc-setup').addEventListener('click', function (ev) { var s = ev.target.closest('[data-step]'); if (s) openSettings(s.dataset.step); }); }
    var net = $('fc-net');
    if (net) {
      var msg = H.offline ? 'No connection. Showing the copy saved on this device' + (H.pending() ? '; ' + H.pending() + (H.pending() === 1 ? ' change' : ' changes') + ' will be sent when you are back in range.' : '.')
        : H.loading ? 'Bringing in your last 12 months of enquiries: ' + H.loading + ' so far. This only happens once.' : '';
      net.hidden = !msg;
      net.firstChild.textContent = msg;
      net.firstChild.className = H.offline ? '' : 'g-info';
    }
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
  }

  /* ---------- account and set-up sheet ---------- */
  var sheet = null;
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
    loadScript().catch(function () {});
    if (focus) setTimeout(function () { var s = $('fc-sec-' + focus); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 120);
  }
  function closeSettings() {
    if (!sheet || sheet.hidden) return;
    sheet.classList.add('closing');
    setTimeout(function () { sheet.hidden = true; sheet.classList.remove('closing'); document.documentElement.classList.remove('lock'); }, 230);
    chrome();
  }
  function msg(id) { return note[id] ? '<div class="g-' + note[id].kind + '" role="status">' + esc(note[id].text) + '</div>' : ''; }
  function renderSettings() {
    if (!sheet || sheet.hidden) return;
    var me = H.me || {};
    var body = $('fc-sbody');
    var top = body.scrollTop;
    var typed = $('g-sm8key') ? $('g-sm8key').value : '';
    var focusId = document.activeElement && document.activeElement.id;
    var n = H.enquiries();
    var h = '';
    /* gmail */
    h += '<section class="sec" id="fc-sec-mail"><h3>Your website emails</h3><div class="g-state"><span class="g-dot on"></span>Connected' + (me.owner ? ' to ' + esc(me.owner) : '') + '</div>' +
      '<p class="hint">' + (n ? n + (n === 1 ? ' enquiry' : ' enquiries') + ' so far. ' : '') + 'The script in your Google account looks for new website form emails each time you open Firstcall or tap Sync.</p>' + msg('mail') +
      '<div class="rowacts"><button class="btn sm" data-g="copy-script">Copy the latest script</button></div></section>';
    /* other devices */
    h += '<section class="sec" id="fc-sec-phone"><h3>Your phone and other devices</h3><p class="hint">To use Firstcall on your phone, send yourself the connection link and open it there. Leads, notes and statuses are the same on every device.</p>' + msg('phone') +
      '<div class="rowacts"><button class="btn primary" data-g="mail-link">Email it to me</button><button class="btn" data-g="copy-link">Copy the link</button></div>' +
      '<p class="hint">Keep the link to yourself: anyone who has it can see your leads.</p></section>';
    /* ServiceM8 */
    h += '<section class="sec" id="fc-sec-sm8"><h3>ServiceM8</h3>';
    if (me.sm8 && me.sm8.connected) h += '<div class="g-state"><span class="g-dot on"></span>Connected' + (me.sm8.business ? ' to ' + esc(me.sm8.business) : '') + '</div>' + msg('sm8') + '<div class="rowacts"><button class="btn sm" data-g="sm8-off">Disconnect</button></div>';
    else h += '<div class="g-state"><span class="g-dot"></span>Not connected yet</div><p class="hint">In ServiceM8 on a computer, go to Settings, then API Keys, and create a key for Firstcall. It needs to be allowed to manage clients, contacts and jobs. Paste it here. It is kept in your Google account, not on this device.</p>' +
      '<label class="field">ServiceM8 API key<input id="g-sm8key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' + msg('sm8') + '<div class="rowacts"><button class="btn primary" data-g="sm8-on">Connect ServiceM8</button></div>';
    h += '</section>';
    /* home screen */
    if (!isInstalled()) h += '<section class="sec" id="fc-sec-install"><h3>Put Firstcall on your phone</h3>' + (isIos ? '<p class="hint">In Safari, tap the Share button, then Add to Home Screen. Firstcall then opens full screen from its own icon. If it asks for a connection link the first time, paste the one that was emailed to you.</p>' : installEvent ? '<div class="rowacts"><button class="btn primary" data-g="install">Install Firstcall</button></div>' : '<p class="hint">On your phone, open the browser menu and choose Add to Home screen or Install app. Firstcall then opens full screen from its own icon.</p>') + '</section>';
    /* notifications */
    h += '<section class="sec" id="fc-sec-push"><h3>Notifications</h3><p class="hint">This version of Firstcall does not send notifications. New enquiries show up when you open it or tap Sync.</p></section>';
    /* this device */
    h += '<section class="sec" id="fc-sec-acct"><h3>This device</h3><p class="hint">Disconnecting removes your leads from this device only. To cut off every device at once, open the Firstcall script in Google and run "disconnectEverything".</p>' + msg('acct') +
      '<div class="rowacts"><button class="btn sm" data-g="logout">Disconnect this device</button></div></section>';
    body.innerHTML = h;
    body.scrollTop = top;
    if ($('g-sm8key')) $('g-sm8key').value = typed;
    if (focusId && $(focusId)) $(focusId).focus();
  }
  function say(id, kind, text) { note[id] = { kind: kind, text: text }; renderSettings(); }

  function onSheetClick(ev) {
    var t = ev.target.closest('[data-g]');
    if (!t) return;
    var a = t.dataset.g;
    if (a === 'close') return closeSettings();
    if (a === 'copy-script') {
      var done = function () { say('mail', 'ok', 'Script copied. In the script editor, paste it over the old one, save, then Deploy, Manage deployments, edit, and choose New version.'); };
      var bad = function () { say('mail', 'err', "Couldn't copy on this device. Open Firstcall on a computer to copy it."); };
      if (scriptText) copy(scriptText).then(done, bad); else loadScript().then(function (x) { return copy(x); }).then(done, bad);
    } else if (a === 'mail-link') {
      t.disabled = true;
      api('mailLink', { link: H.connectionLink() }).then(function (r) { H.remember('fc-phone-done', 1); say('phone', 'ok', 'Sent to ' + r.to + '. Open that email on your phone and tap the link.'); chrome(); }, function (e) { say('phone', 'err', why(e)); });
    } else if (a === 'copy-link') {
      copy(H.connectionLink()).then(function () { H.remember('fc-phone-done', 1); say('phone', 'ok', 'Link copied.'); chrome(); }, function () { say('phone', 'err', "Couldn't copy on this device. Use Email it to me instead."); });
    } else if (a === 'sm8-on') {
      var key = ($('g-sm8key').value || '').trim();
      if (!key) return say('sm8', 'err', 'Paste your ServiceM8 API key first.');
      t.disabled = true;
      api('sm8.connect', { apiKey: key }, 60000).then(function () { $('g-sm8key').value = ''; note.sm8 = { kind: 'ok', text: 'ServiceM8 is connected.' }; return refreshMe(); }).then(renderSettings, function (e) { say('sm8', 'err', e && e.network ? why(e) : 'ServiceM8 said: ' + why(e)); });
    } else if (a === 'sm8-off') {
      api('sm8.disconnect').then(refreshMe).then(renderSettings, function (e) { say('sm8', 'err', why(e)); });
    } else if (a === 'install') {
      if (installEvent) { installEvent.prompt(); installEvent = null; }
    } else if (a === 'logout') {
      H.forget();
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* stays */ }
      location.reload();
    }
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeSettings(); });

  /* Keeps the app's own files on the device so it opens without reception. */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  boot();
})();
