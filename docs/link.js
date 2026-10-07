/* Lets the Firstcall screens, which were written to run inside Claude, run from GitHub Pages.
   The screens ask for two things: a place to keep leads ("db") and connections to email and ServiceM8 ("mcp").
   Here both are answered by a small Google script in the owner's own Google account (see script.txt).
   Leads are also kept on this device, so the app opens straight away and keeps working with poor reception;
   changes made then are sent when the connection is back. */
(function () {
  'use strict';
  var H = (window.__firstcallHost = { standalone: true, pages: true, me: null, offline: false });
  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to remove */ } }
  };
  var state = { rev: -1, subs: new Map(), leads: new Map(), docs: new Map(), loaded: false };
  var listeners = { subs: [], leads: [] };
  var outbox = LS.get('fc-outbox') || [];
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var started = false;

  /* ---------- the connection: the script's address and its key ---------- */
  var link = null;
  function validLink(l) { return !!(l && typeof l.u === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(l.u) && typeof l.k === 'string' && /^[A-Za-z0-9]{32,128}$/.test(l.k)); }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
  function fromText(text) {
    /* Accepts a whole connection link, or just the part after "#c=". */
    var m = /#c=([A-Za-z0-9_-]+)/.exec(String(text || '')) || /^\s*([A-Za-z0-9_-]{60,})\s*$/.exec(String(text || ''));
    if (!m) return null;
    try { var l = JSON.parse(unb64(m[1])); return validLink(l) ? { u: l.u, k: l.k } : null; } catch (e) { return null; }
  }
  /* Finds the script's address in whatever was pasted. Business Google accounts are given a longer form of the
     address (with /a/macros/their-domain/); the short form is the one that answers without a Google sign-in. */
  H.scriptUrlIn = function (text) { var m = /https:\/\/script\.google\.com\/(?:a\/macros\/[^\/\s]+\/|macros\/)s\/([A-Za-z0-9_-]+)\/exec/.exec(String(text || '')); return m ? 'https://script.google.com/macros/s/' + m[1] + '/exec' : ''; };
  H.connectionLink = function () { return link ? location.origin + location.pathname + '#c=' + b64(JSON.stringify(link)) : ''; };
  H.connected = function () { return !!link; };
  H.useLink = function (l) { if (!validLink(l)) return false; link = { u: l.u, k: l.k }; LS.set('fc-link', link); return true; };
  H.linkFromText = fromText;
  (function init() {
    var fromHash = fromText(location.hash);
    var saved = LS.get('fc-link');
    if (fromHash) { link = fromHash; LS.set('fc-link', link); } else if (validLink(saved)) link = { u: saved.u, k: saved.k };
  })();

  function post(url, body, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms || 45000);
    /* Sent as plain text so the browser makes one simple request; the script reads it as JSON. */
    return fetch(url, { method: 'POST', redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }).then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* Google answered with a page instead: the script is not deployed for "Anyone", or was removed */ }
        if (!json) throw { code: 'not_a_script', message: 'That address did not answer like the Firstcall script. Check it was deployed as a Web app with access set to Anyone.' };
        if (json.error) throw json.error;
        return json;
      });
    }, function () {
      clearTimeout(timer);
      throw { network: true, message: 'No connection' };
    });
  }
  function api(action, body, ms) {
    if (!link) return Promise.reject({ code: 'bad_key', message: 'Not connected' });
    var b = Object.assign({ k: link.k, action: action }, body || {});
    return post(link.u, b, ms).then(function (j) { setOffline(false); return j; }, function (e) {
      if (e && e.code === 'bad_key' && started && H.onSignedOut) H.onSignedOut();
      throw e;
    });
  }
  H.api = api;
  /* First connection from the computer where the script was just deployed. */
  H.claim = function (url) {
    return post(url, { action: 'claim' }, 45000).then(function (j) {
      if (!H.useLink({ u: url, k: j.key })) throw { code: 'failed', message: 'The script answered in a way Firstcall did not expect. Copy the latest script and deploy it again.' };
      return j;
    });
  };

  function setOffline(v) {
    if (H.offline === v) return;
    H.offline = v;
    if (H.onConnection) H.onConnection(v);
  }

  /* ---------- the copy kept on this device ---------- */
  function saveCache() {
    if (!link) return;
    LS.set('fc-cache', { u: link.u, rev: state.rev, subs: Array.from(state.subs.values()), leads: Array.from(state.leads.entries()) });
  }
  function loadCache() {
    var c = LS.get('fc-cache');
    if (!c || !link || c.u !== link.u) return false;
    state.subs = new Map((c.subs || []).map(function (d) { return [d.mid, d]; }));
    state.leads = new Map(c.leads || []);
    state.rev = -1; /* always ask for the current copy once */
    return true;
  }
  function applyOutbox() { outbox.forEach(function (o) { state.leads.set(o.lead, o.data); }); }
  function snapshot(kind) {
    var docs = [];
    state[kind].forEach(function (data, id) { docs.push({ id: id, exists: true, data: function () { return data; }, metadata: { fromCache: H.offline, hasPendingWrites: false } }); });
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: H.offline, hasPendingWrites: outbox.length > 0 } };
  }
  function emit(kind) {
    listeners[kind].slice().forEach(function (l) { try { l(snapshot(kind)); } catch (e) { setTimeout(function () { throw e; }, 0); } });
  }

  var refreshing = null;
  var writes = 0; /* goes up whenever a change is made here or finishes saving */
  H.loading = 0;  /* enquiries read so far while the first 12 months are being brought in */
  function refresh(again) {
    if (refreshing) return refreshing;
    var asOf = writes;
    refreshing = api('sync', { rev: state.rev }, 70000).then(function (j) {
      refreshing = null;
      /* A copy that was already on its way while a change was being saved may be missing that change.
         Showing it would undo the change on screen, so it is thrown away and a fresh copy is asked for. */
      if (asOf !== writes && (again || 0) < 3) return refresh((again || 0) + 1);
      if (!j.same) {
        state.rev = j.rev;
        state.subs = new Map((j.subs || []).map(function (d) { return [d.mid, d]; }));
        state.leads = new Map(Object.keys(j.leads || {}).map(function (k) { return [k, j.leads[k]]; }));
        applyOutbox();
        saveCache();
      }
      H.loading = j.more ? j.count || 0 : 0;
      if (!j.same || !state.loaded) { state.loaded = true; emit('subs'); emit('leads'); }
      if (H.onData) H.onData();
      /* The first time, a year of emails comes over a few seconds' worth at a time. */
      if (j.more) return refresh(0);
      return j;
    }, function (e) {
      refreshing = null;
      if (e && e.network) setOffline(true);
      throw e;
    });
    return refreshing;
  }
  H.refresh = refresh;

  /* ---------- changes waiting to be sent ---------- */
  var flushing = false;
  var retryTimer = null;
  function queue(lead, data) {
    var copy = JSON.parse(JSON.stringify(data));
    var i = outbox.findIndex(function (o, n) { return o.lead === lead && !(flushing && n === 0); });
    if (i >= 0) outbox[i].data = copy; else outbox.push({ lead: lead, data: copy });
    writes++;
    LS.set('fc-outbox', outbox);
    flush();
  }
  function flush() {
    if (flushing || !outbox.length || !started) return;
    flushing = true;
    var item = outbox[0];
    api('save', { lead: item.lead, data: item.data }).then(function (j) {
      if (j && j.rev === state.rev + 1) state.rev = j.rev; /* our own change and nothing else moved */
      done();
    }, function (e) {
      if (e && (e.network || e.code === 'bad_key' || e.code === 'not_a_script')) {
        flushing = false;
        if (e.network) setOffline(true);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, 8000);
        return;
      }
      if (H.toast) H.toast("A change couldn't be saved: " + ((e && e.message) || 'the script refused it'));
      done();
    });
    function done() {
      writes++;
      outbox.shift();
      LS.set('fc-outbox', outbox);
      flushing = false;
      saveCache();
      if (H.onData) H.onData();
      if (outbox.length) flush();
    }
  }

  /* ---------- "db": the same calls the screens make inside Claude ---------- */
  function docRef(path) {
    var i = path.indexOf('/');
    var col = path.slice(0, i);
    var id = path.slice(i + 1);
    var mapOf = function () { return col === 'leads' ? state.leads : col === 'subs' ? state.subs : state.docs; };
    var keyOf = col === 'leads' || col === 'subs' ? id : path;
    return {
      id: id, path: path,
      get: function () {
        return ready.then(function () {
          var v = mapOf().get(keyOf);
          if (v === undefined && path === 'meta/app') v = LS.get('fc-meta') || undefined;
          return { id: id, exists: v !== undefined, data: function () { return v; }, metadata: { fromCache: H.offline, hasPendingWrites: false } };
        });
      },
      set: function (data) {
        var copy = JSON.parse(JSON.stringify(data));
        if (col === 'subs') { state.subs.set(id, copy); emit('subs'); return Promise.resolve(); }
        if (col === 'leads') { state.leads.set(id, copy); queue(id, copy); emit('leads'); return Promise.resolve(); }
        state.docs.set(path, copy);
        if (path === 'meta/app') LS.set('fc-meta', copy); /* when this device last checked: kept here only */
        return Promise.resolve();
      },
      update: function (data) { return this.set(Object.assign({}, mapOf().get(keyOf) || {}, data)); },
      delete: function () { mapOf().delete(keyOf); return Promise.resolve(); },
      onSnapshot: function (next) { this.get().then(next); return function () {}; }
    };
  }
  function collectionRef(name) {
    var q = {
      path: name,
      limit: function () { return q; }, where: function () { return q; }, orderBy: function () { return q; },
      doc: function (id) { return docRef(name + '/' + id); },
      get: function () { return ready.then(function () { return snapshot(name); }); },
      onSnapshot: function (next) {
        if (!listeners[name]) return function () {};
        listeners[name].push(next);
        if (state.loaded) setTimeout(function () { next(snapshot(name)); }, 0);
        return function () { var i = listeners[name].indexOf(next); if (i >= 0) listeners[name].splice(i, 1); };
      }
    };
    return q;
  }
  var db = { doc: docRef, collection: collectionRef };

  /* ---------- "mcp": email and ServiceM8, answered by the Google script ---------- */
  function toolError(e, step) {
    if (e && e.network) return { code: 'server_unavailable', message: 'No connection', server: 'ServiceM8' };
    if (e && (e.code === 'bad_key' || e.code === 'not_a_script')) return { code: 'server_unavailable', message: 'Connect again', server: 'ServiceM8' };
    var msg = (e && e.message) || 'no details given';
    if (e && e.step) msg = 'it stopped while ' + e.step + ' (' + msg + ')';
    if (e && e.done && e.done.length) msg += '. Already created in ServiceM8: ' + e.done.join(', ') + '. Check ServiceM8 before trying again';
    if (e && e.code === 'sm8_unreachable' && !(e.done && e.done.length) && step === 'write') return { code: 'server_unavailable', message: msg, server: 'ServiceM8' };
    return { code: 'tool_error', message: msg, server: 'ServiceM8' };
  }
  function wrap(json) { return { payload: json, content: [] }; }
  var mcp = {
    callTool: function (server, tool, input) {
      input = input || {};
      if (server === 'Gmail') {
        /* "Sync" asks the script to look for new form emails and hand back anything that changed. */
        if (tool === 'search_threads') return refresh().then(function () { return { payload: { threads: [] }, content: [] }; }, function (e) {
          throw (e && e.network) || (e && (e.code === 'bad_key' || e.code === 'not_a_script')) ? { code: 'server_unavailable', message: 'No connection', server: 'Firstcall' } : { code: 'tool_error', message: (e && e.message) || 'no details given', server: 'Firstcall' };
        });
        return Promise.resolve({ payload: { messages: [] }, content: [] });
      }
      if (server === 'ServiceM8') {
        if (tool === 'search') return api('sm8.search', { query: input.query }).then(wrap, function (e) { throw toolError(e, 'read'); });
        if (tool === 'list_job_templates') return api('sm8.templates').then(wrap, function (e) { throw toolError(e, 'read'); });
        if (tool === 'create_job') {
          var desc = String(input.job_description || '');
          var phone = /^Phone:\s*(.+)$/mi.exec(desc);
          var email = /^Email:\s*(\S+@\S+)\s*$/mi.exec(desc);
          return api('sm8.job', {
            company_name: input.company_name, job_address: input.job_address, job_description: desc,
            job_template_uuid: input.job_template_uuid, phone: phone ? phone[1] : '', email: email ? email[1] : ''
          }, 120000).then(function (j) {
            if (j && j.job_contact_saved === false && H.toast) setTimeout(function () { H.toast("Job created, but the contact wasn't added to it. Add it in ServiceM8."); }, 3400);
            return wrap(j);
          }, function (e) { throw toolError(e, 'write'); });
        }
      }
      return Promise.reject({ code: 'not_in_manifest', message: 'Not available', server: server });
    },
    listTools: function () { return Promise.resolve({ servers: [{ server: 'Gmail', authStatus: 'connected', tools: [] }, { server: 'ServiceM8', authStatus: 'connected', tools: [] }] }); },
    invalidate: function () { return Promise.resolve(); },
    describeTool: function () { return Promise.reject({ code: 'bad_request', message: 'No schema' }); }
  };

  window.claude = { use: function (name) { return ready.then(function () { return name === 'db' ? db : name === 'mcp' ? mcp : null; }); } };

  /* ---------- start, called by the set-up screen once this device is connected ---------- */
  H.start = function () {
    var hadCache = loadCache();
    if (!hadCache) { state.subs = new Map(); state.leads = new Map(); }
    applyOutbox();
    if (hadCache) state.loaded = true;
    if (!started) {
      started = true;
      readyResolve();
      setInterval(function () { if (!document.hidden) { refresh().catch(function () {}); flush(); } }, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh().catch(function () {}); flush(); } });
      window.addEventListener('online', function () { refresh().catch(function () {}); flush(); });
    }
    if (state.loaded) { emit('subs'); emit('leads'); }
    flush();
    return refresh().catch(function () { if (!state.loaded) { state.loaded = true; emit('subs'); emit('leads'); } });
  };
  H.forget = function () { LS.del('fc-cache'); LS.del('fc-outbox'); LS.del('fc-link'); LS.del('fc-meta'); LS.del('fc-me'); outbox = []; link = null; };
  H.hasCache = function () { var c = LS.get('fc-cache'); return !!(c && link && c.u === link.u); };
  H.pending = function () { return outbox.length; };
  H.enquiries = function () { return state.subs.size; };
  H.remember = function (k, v) { LS.set(k, v); };
  H.recall = function (k) { return LS.get(k); };

  /* Opens a lead's card by its key. */
  H.openLead = function (key) {
    var tries = 0;
    (function attempt() {
      var el = document.querySelector('[data-act="open"][data-key="' + String(key).replace(/["\\]/g, '\\$&') + '"]');
      if (el) { el.click(); return; }
      if (tries === 4) { var all = document.querySelector('[data-act="filter"][data-f="all"]'); if (all) all.click(); }
      if (++tries < 20) setTimeout(attempt, 400);
    })();
  };
})();
