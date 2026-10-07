/* Lets the Firstcall screens, which were written to run inside Claude, run on this server instead.
   It provides the two things the screens ask Claude for: a place to keep leads ("db") and the connections
   to email and ServiceM8 ("mcp"). Leads are also kept on this device, so the app opens straight away and
   keeps working with poor reception; changes made then are sent when the connection is back. */
(function () {
  'use strict';
  var H = (window.__firstcallHost = { standalone: true, me: null, offline: false });
  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to remove */ } }
  };
  var state = { rev: 0, subs: new Map(), leads: new Map(), docs: new Map(), loaded: false };
  var listeners = { subs: [], leads: [] };
  var outbox = LS.get('fc-outbox') || [];
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var started = false;

  /* ---------- connection ---------- */
  function api(method, path, body, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms || 25000);
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      signal: ctl.signal,
      headers: body ? { 'Content-Type': 'application/json', 'X-Firstcall': '1' } : { 'X-Firstcall': '1' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* a proxy or wifi sign-in page answered instead */ }
        if (!json) throw { network: true, message: 'The server did not answer properly' };
        if (!res.ok) {
          var err = json.error || {};
          err.status = res.status;
          if (res.status === 401 && err.code === 'signed_out' && started && H.onSignedOut) H.onSignedOut();
          throw err;
        }
        setOffline(false);
        return json;
      });
    }, function () {
      clearTimeout(timer);
      throw { network: true, message: 'No connection' };
    });
  }
  H.api = api;

  function setOffline(v) {
    if (H.offline === v) return;
    H.offline = v;
    if (H.onConnection) H.onConnection(v);
  }

  /* ---------- the copy kept on this device ---------- */
  function saveCache() {
    if (!H.me) return;
    LS.set('fc-cache', {
      email: H.me.email, rev: state.rev,
      subs: Array.from(state.subs.values()),
      leads: Array.from(state.leads.entries()),
      docs: Array.from(state.docs.entries())
    });
  }
  function loadCache(email) {
    var c = LS.get('fc-cache');
    if (!c || c.email !== email) return false;
    state.subs = new Map((c.subs || []).map(function (d) { return [d.mid, d]; }));
    state.leads = new Map(c.leads || []);
    state.docs = new Map(c.docs || []);
    state.rev = 0; /* always ask the server for its current copy */
    return true;
  }
  function applyOutbox() {
    outbox.forEach(function (o) {
      if (o.path.indexOf('leads/') === 0) state.leads.set(o.path.slice(6), o.data);
      else state.docs.set(o.path, o.data);
    });
  }
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
  function refresh(again) {
    if (refreshing) return refreshing;
    var asOf = writes;
    refreshing = api('GET', '/api/data?rev=' + state.rev).then(function (j) {
      refreshing = null;
      /* A copy that was already on its way while a change was being saved may be missing that change.
         Showing it would undo the change on screen, so it is thrown away and a fresh copy is asked for. */
      if (asOf !== writes && (again || 0) < 3) return refresh((again || 0) + 1);
      if (!j.same) {
        state.rev = j.rev;
        state.subs = new Map((j.subs || []).map(function (d) { return [d.mid, d]; }));
        state.leads = new Map(Object.keys(j.leads || {}).map(function (k) { return [k, j.leads[k]]; }));
        state.docs = new Map(Object.keys(j.docs || {}).map(function (k) { return [k, j.docs[k]]; }));
        applyOutbox();
        saveCache();
        state.loaded = true;
        emit('subs');
        emit('leads');
        if (H.onData) H.onData();
      } else if (!state.loaded) {
        state.loaded = true;
        emit('subs');
        emit('leads');
      }
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
  function queue(path, data) {
    var copy = JSON.parse(JSON.stringify(data));
    var i = outbox.findIndex(function (o, n) { return o.path === path && !(flushing && n === 0); });
    if (i >= 0) outbox[i].data = copy; else outbox.push({ path: path, data: copy });
    writes++;
    LS.set('fc-outbox', outbox);
    flush();
  }
  function flush() {
    if (flushing || !outbox.length || !started) return;
    flushing = true;
    var item = outbox[0];
    var path = item.path.indexOf('leads/') === 0 ? '/api/leads/' + encodeURIComponent(item.path.slice(6)) : '/api/docs/' + item.path;
    api('PUT', path, { data: item.data }).then(function () {
      done(true);
    }, function (e) {
      if (e && (e.network || e.status === 401 || e.status >= 500 || e.status === 429)) {
        flushing = false;
        if (e.network) setOffline(true);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, 6000);
        return;
      }
      if (H.toast) H.toast("A change couldn't be saved: " + ((e && e.message) || 'the server refused it'));
      done(false);
    });
    function done() {
      writes++;
      outbox.shift();
      LS.set('fc-outbox', outbox);
      flushing = false;
      saveCache();
      if (outbox.length) flush();
    }
  }

  /* ---------- "db": the same calls the screens make inside Claude ---------- */
  function docRef(path) {
    var i = path.indexOf('/');
    var col = path.slice(0, i);
    var id = path.slice(i + 1);
    var map = col === 'leads' ? state.leads : col === 'subs' ? state.subs : state.docs;
    var keyOf = col === 'leads' || col === 'subs' ? id : path;
    return {
      id: id, path: path,
      get: function () {
        return ready.then(function () {
          var m = col === 'leads' ? state.leads : col === 'subs' ? state.subs : state.docs;
          var v = m.get(keyOf);
          return { id: id, exists: v !== undefined, data: function () { return v; }, metadata: { fromCache: H.offline, hasPendingWrites: false } };
        });
      },
      set: function (data) {
        var copy = JSON.parse(JSON.stringify(data));
        if (col === 'subs') { state.subs.set(id, copy); emit('subs'); return Promise.resolve(); }
        if (col === 'leads') { state.leads.set(id, copy); queue(path, copy); emit('leads'); return Promise.resolve(); }
        state.docs.set(path, copy);
        if (path === 'meta/app') queue(path, copy);
        return Promise.resolve();
      },
      update: function (data) {
        var cur = Object.assign({}, (col === 'leads' ? state.leads : state.docs).get(keyOf) || {}, data);
        return this.set(cur);
      },
      delete: function () { map.delete(keyOf); return Promise.resolve(); },
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

  /* ---------- "mcp": email and ServiceM8, answered by this server ---------- */
  function toolError(e, step) {
    if (e && e.network) return { code: 'server_unavailable', message: 'No connection', server: 'ServiceM8' };
    if (e && e.status === 401) return { code: 'server_unavailable', message: 'Log in again', server: 'ServiceM8' };
    var msg = (e && e.message) || 'no details given';
    if (e && e.step) msg = "it stopped while " + e.step + ' (' + msg + ')';
    if (e && e.done && e.done.length) msg += '. Already created in ServiceM8: ' + e.done.join(', ') + '. Check ServiceM8 before trying again';
    if (e && e.code === 'sm8_unreachable' && !(e.done && e.done.length) && step === 'write') return { code: 'server_unavailable', message: msg, server: 'ServiceM8' };
    return { code: 'tool_error', message: msg, server: 'ServiceM8' };
  }
  var mcp = {
    callTool: function (server, tool, input) {
      input = input || {};
      if (server === 'Gmail') {
        /* Form emails arrive on their own through the mail link, so "sync" only needs the server's latest copy. */
        if (tool === 'search_threads') return refresh().then(function () { return { payload: { threads: [] }, content: [] }; }, function (e) {
          throw (e && e.network) || (e && e.status === 401) ? { code: 'server_unavailable', message: 'No connection', server: 'Firstcall' } : { code: 'tool_error', message: (e && e.message) || 'no details given', server: 'Firstcall' };
        });
        return Promise.resolve({ payload: { messages: [] }, content: [] });
      }
      if (server === 'ServiceM8') {
        if (tool === 'search') return api('POST', '/api/sm8/search', { query: input.query }).then(wrap, function (e) { throw toolError(e, 'read'); });
        if (tool === 'list_job_templates') return api('GET', '/api/sm8/templates').then(wrap, function (e) { throw toolError(e, 'read'); });
        if (tool === 'create_job') {
          var desc = String(input.job_description || '');
          var phone = /^Phone:\s*(.+)$/mi.exec(desc);
          var email = /^Email:\s*(\S+@\S+)\s*$/mi.exec(desc);
          return api('POST', '/api/sm8/job', {
            company_name: input.company_name, job_address: input.job_address, job_description: desc,
            job_template_uuid: input.job_template_uuid, phone: phone ? phone[1] : '', email: email ? email[1] : ''
          }, 90000).then(function (j) {
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
  function wrap(json) { return { payload: json, content: [] }; }

  window.claude = { use: function (name) { return ready.then(function () { return name === 'db' ? db : name === 'mcp' ? mcp : null; }); } };

  /* ---------- start, called by the log-in screen once someone is signed in ---------- */
  H.start = function (me, fromCache) {
    H.me = me;
    LS.set('fc-email', me.email);
    var hadCache = loadCache(me.email);
    if (!hadCache) { state.subs = new Map(); state.leads = new Map(); state.docs = new Map(); }
    applyOutbox();
    if (hadCache || fromCache) state.loaded = true;
    if (!started) {
      started = true;
      readyResolve();
      setInterval(function () { if (!document.hidden) { refresh().catch(function () {}); flush(); } }, 20000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh().catch(function () {}); flush(); } });
      window.addEventListener('online', function () { refresh().catch(function () {}); flush(); });
    }
    if (state.loaded) { emit('subs'); emit('leads'); }
    flush();
    return refresh().catch(function () { if (!state.loaded) { state.loaded = true; emit('subs'); emit('leads'); } });
  };
  H.forget = function () { LS.del('fc-cache'); LS.del('fc-outbox'); LS.del('fc-email'); outbox = []; };
  H.lastEmail = function () { return LS.get('fc-email'); };
  H.hasCache = function () { var c = LS.get('fc-cache'); return !!(c && c.email && c.email === LS.get('fc-email')); };
  H.pending = function () { return outbox.filter(function (o) { return o.path.indexOf('leads/') === 0; }).length; };
  H.enquiries = function () { return state.subs.size; };

  /* Opens a lead's card, e.g. after tapping its notification. */
  H.openLead = function (key) {
    var tries = 0;
    (function attempt() {
      var sel = '[data-act="open"][data-key="' + String(key).replace(/["\\]/g, '\\$&') + '"]';
      var el = document.querySelector(sel);
      if (el) { el.click(); return; }
      if (tries === 4) { var all = document.querySelector('[data-act="filter"][data-f="all"]'); if (all) all.click(); }
      if (++tries < 20) setTimeout(attempt, 400);
    })();
  };
})();
