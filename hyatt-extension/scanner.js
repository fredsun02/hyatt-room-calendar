// ==UserScript==
// @name         Hyatt Room Calendar
// @namespace    hyatt-room-year
// @version      0.17.0
// @description  Room availability and points rates on Hyatt.com.
// @match        https://www.hyatt.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(async function () {
  'use strict';
  const platform = globalThis.__HRYV_PLATFORM;
  if (!platform && document.documentElement?.hasAttribute('data-hryv-extension')) return;
  if (window.__hryvLoaded) return;
  window.__hryvLoaded = true;
  if (platform) {
    try { await platform.ready; }
    catch (e) { platform.showError('Could not read saved progress. Reload the page: ' + e.message); return; }
  }

  const API = '/shop/service/rooms/roomrates/';
  const CACHE_PREFIX = 'hryv:';
  const CACHE_TTL_MS = 6 * 3600 * 1000;
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const ago = ms => {
    const minutes = Math.max(1, Math.round(ms / 60000));
    return minutes < 90 ? count(minutes, 'minute') : minutes < 48 * 60 ? count(Math.round(minutes / 60), 'hour') : count(Math.round(minutes / 1440), 'day');
  };

  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (s, n) => { const d = fromISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
  const weekdayMon0 = s => (fromISO(s).getUTCDay() + 6) % 7;
  const todayLocal = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
  const sleepAbortable = (ms, signal) => new Promise(resolve => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done);
  });
  const COOLDOWN_MIN = 5;
  const COOLDOWN_TRIES = 24;

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const kv = platform?.storage || {
    get(key) {
      try {
        if (hasGM) return GM_getValue(key, null);
        const v = localStorage.getItem(key);
        return v == null ? null : JSON.parse(v);
      } catch (e) { return null; }
    },
    set(key, val) {
      try { if (hasGM) GM_setValue(key, val); else localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    },
    del(key) {
      try { if (hasGM) GM_deleteValue(key); else localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
    async flush() { return true; },
    async snapshot() {
      const keys = hasGM && typeof GM_listValues === 'function' ? GM_listValues() : Object.keys(localStorage);
      return Object.fromEntries(keys.filter(isBackupKey).map(key => [key, kv.get(key)]));
    },
  };
  const isBackupKey = key => /^hryv:(?:[a-z0-9]{5}\|[1-4]\|[1-7]|pts\|[a-z0-9]{5}\|[1-4]|auto-recover)$/.test(key);
  const STORE_URL = 'http://127.0.0.1:8787';
  const hasXHR = typeof GM_xmlhttpRequest === 'function';
  function remote(method, key, body) {
    if (platform) return platform.remote(method, key, body);
    return new Promise(resolve => {
      if (!hasXHR) return resolve({ ok: false });
      try {
        GM_xmlhttpRequest({
          method,
          url: STORE_URL + (key ? '/kv/' + encodeURIComponent(key) : '/health'),
          headers: { 'X-HRYV': '1', 'Content-Type': 'application/json' },
          data: body === undefined ? undefined : JSON.stringify(body),
          timeout: 4000,
          onload: r => {
            let data = null;
            try { data = r.responseText ? JSON.parse(r.responseText) : null; } catch (e) { /* ignore */ }
            resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
          },
          onerror: () => resolve({ ok: false }),
          ontimeout: () => resolve({ ok: false }),
        });
      } catch (e) { resolve({ ok: false }); }
    });
  }
  let remoteUp = null;
  let remoteChecking = null;
  let remoteCheckedAt = 0;
  function remoteCheck() {
    if (remoteUp !== null && Date.now() - remoteCheckedAt < (remoteUp ? 30000 : 5000)) return Promise.resolve(remoteUp);
    if (!remoteChecking) {
      remoteChecking = remote('GET').then(r => {
        remoteCheckedAt = Date.now(); remoteUp = !!(r.ok && r.data && r.data.ok); return remoteUp;
      }).finally(() => { remoteChecking = null; });
    }
    return remoteChecking;
  }
  async function remoteGet(key) {
    if (!(await remoteCheck())) return null;
    const r = await remote('GET', key);
    return r.ok ? r.data : null;
  }
  const remoteWrites = new Map();
  const isCashKey = key => /^hryv:[a-z0-9]{5}\|\d+\|\d+$/.test(key);
  function remoteWrite(method, key, val) {
    const snapshot = val === undefined ? undefined : JSON.parse(JSON.stringify(val));
    const next = (remoteWrites.get(key) || Promise.resolve()).then(async () => {
      if (!(await remoteCheck())) return false;
      if (method === 'PUT' && isCashKey(key)) {
        // Keep newer dates written by someone else, such as the background collector, since this cache was loaded.
        const current = await remote('GET', key);
        if (current.ok && current.data) mergeStore(snapshot, current.data);
      }
      const r = await remote(method, key, snapshot);
      if (!r.ok) { remoteUp = false; remoteCheckedAt = Date.now(); }
      return r.ok;
    });
    remoteWrites.set(key, next);
    next.finally(() => { if (remoteWrites.get(key) === next) remoteWrites.delete(key); });
    return next;
  }
  const remotePut = (key, val) => remoteWrite('PUT', key, val);
  const remoteDel = key => remoteWrite('DELETE', key);
  function mergeStore(into, other) {
    if (!other || !other.days) return false;
    let changed = false;
    for (const [d, rec] of Object.entries(other.days)) {
      const mine = into.days[d];
      if (rec && (!mine || rec.ts > mine.ts)) { into.days[d] = rec; changed = true; }
    }
    for (const [c, t] of Object.entries(other.titles || {})) if (!into.titles[c]) { into.titles[c] = t; changed = true; }
    if (!into.currency && other.currency) { into.currency = other.currency; changed = true; }
    return changed;
  }

  function migrateFromLocalStorage() {
    if (platform || !hasGM) return;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('hryv:') || k === 'hryv:resume') continue;
        if (GM_getValue(k, null) == null) GM_setValue(k, JSON.parse(localStorage.getItem(k)));
      }
    } catch (e) { /* ignore */ }
  }

  const RESUME_KEY = 'hryv:resume';
  const RESUME_TTL_MS = 24 * 3600 * 1000;
  const RESUME_DELAY_MS = 5000;
  const AUTO_RECOVERY_LIMIT = 2;
  // A city scan checks many hotels for a few dates.
  const CITY_MAX_HOTELS = 100, CITY_MAX_DAYS = 31, CITY_DEFAULT_DAYS = 7;
  const isCode = s => typeof s === 'string' && /^[a-z0-9]{5}$/.test(s);
  function validResume(r) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.start) ||
      !(Number.isFinite(r.ts) && Date.now() - r.ts >= 0 && Date.now() - r.ts < RESUME_TTL_MS) ||
      !(Number.isInteger(r.los) && r.los >= 1 && r.los <= 7) ||
      !(Number.isInteger(r.adults) && r.adults >= 1 && r.adults <= 4)) return false;
    if (r.mode === 'city') {
      return Array.isArray(r.spirits) && r.spirits.length >= 1 && r.spirits.length <= CITY_MAX_HOTELS && r.spirits.every(isCode) &&
        Number.isInteger(r.n) && r.n >= 1 && r.n <= CITY_MAX_DAYS;
    }
    return isCode(r.spirit) && Number.isInteger(r.n) && r.n >= 1 && r.n <= 400;
  }
  function readResume() {
    try {
      const r = kv.get(RESUME_KEY);
      return validResume(r) ? r : null;
    } catch (e) { return null; }
  }
  async function writeResume(r) {
    const v = { ...r, ts: Date.now() };
    const local = kv.set(RESUME_KEY, v) && await kv.flush();
    const disk = await remotePut(RESUME_KEY, v);
    return { local, disk };
  }
  async function clearResume() { kv.del(RESUME_KEY); await kv.flush(); return remoteDel(RESUME_KEY); }
  async function readResumeRemote() {
    const r = await remoteGet(RESUME_KEY);
    return validResume(r) ? r : null;
  }

  function helperRequest(action, details = {}) {
    if (platform) return platform.helper(action, details);
    return new Promise(resolve => {
      const id = crypto.randomUUID();
      const finish = result => {
        clearTimeout(timer); document.removeEventListener('hryv-helper-response', receive); resolve(result);
      };
      function receive(event) {
        try { const data = JSON.parse(event.detail); if (data.id === id) finish(data.result || { ok: false }); }
        catch (e) { /* ignore */ }
      }
      const timer = setTimeout(() => finish({ ok: false, error: 'Cookie Helper did not respond' }), ['ping', 'reload-status'].includes(action) ? 1500 : 15000);
      document.addEventListener('hryv-helper-response', receive);
      document.dispatchEvent(new CustomEvent('hryv-helper-request', { detail: JSON.stringify({ ...details, id, action }) }));
    });
  }
  // The extension bundles cookie recovery, so its messages must not point users to a separate Cookie Helper.
  const HELPER_MISSING = 'Auto-resume could not reach the extension. Reload this Hyatt tab; if that does not help, clear Hyatt cookies manually and reload.';
  const HELPER_OUTDATED = 'Auto-resume needs an update. Reload Hyatt Room Calendar in chrome://extensions/, then reload this tab.';

  function detectFromURL() {
    const u = new URL(location.href);
    const segs = u.pathname.split('/').filter(Boolean);
    let spirit = u.searchParams.get('spiritCode') || '';
    let room = '';
    let lang = segs.find(s => /^[a-z]{2}-[A-Z]{2}$/.test(s)) || 'en-US';

    const shopIdx = segs.indexOf('shop');
    if (!spirit && shopIdx >= 0) {
      const cand = segs[shopIdx + 1] === 'rooms' ? segs[shopIdx + 2] : segs[shopIdx + 1];
      if (cand && /^[a-z0-9]{5}$/i.test(cand)) spirit = cand;
    }
    const roomsIdx = segs.indexOf('rooms');
    if (!spirit) {
      const upto = roomsIdx >= 0 ? segs.slice(0, roomsIdx) : segs;
      for (const s of upto) {
        const m = s.match(/^([a-z0-9]{5})-[a-z0-9-]+$/i);
        if (m) spirit = m[1];
      }
    }
    if (roomsIdx >= 0 && segs[roomsIdx + 1] && /^[A-Z0-9]{3,6}$/.test(segs[roomsIdx + 1])) room = segs[roomsIdx + 1];
    return { spirit: spirit.toLowerCase(), room, lang };
  }

  async function fetchDay(spirit, checkin, los, adults, signal) {
    const checkout = addDays(checkin, los);
    const url = `${API}${encodeURIComponent(spirit)}?checkinDate=${checkin}&checkoutDate=${checkout}` +
      `&rooms=1&adults=${adults}&kids=0&rate=Standard&rateFilter=standard`;
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include', signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    const text = await r.text();
    if (!text) { const e = new Error('Empty response'); e.status = 0; throw e; }
    let j;
    try { j = JSON.parse(text); }
    catch (cause) { const e = new Error('Unexpected response; Hyatt may have blocked the request'); e.status = 0; throw e; }
    const rooms = {};
    const titles = {};
    let currency = '';
    for (const [code, v] of Object.entries(j.roomRates || {})) {
      const stex = (v.ratePlans || []).some(rp => rp && rp.stexCashAvailable) ? 1 : 0;
      rooms[code] = [v.roomQuantity ?? 0, v.lowestCashRate ?? v.lowestPublicRate ?? null, stex,
        typeof v.roomCategory === 'string' ? v.roomCategory : null];
      titles[code] = (v.roomType && v.roomType.title) || code;
      if (v.currencyCode) currency = v.currencyCode;
    }
    return { rooms, titles, currency };
  }

  const BLOCK_LIMIT = 4;
  // Runs tasks ({ kind, spirit, date }) with `run`, which makes the request(s) for one task.
  async function scan({ tasks, run, concurrency, interval, signal, onTask }) {
    let idx = 0;
    let conc = concurrency;
    let pauseUntil = 0;
    let blockedStreak = 0;
    let blocked = false;
    const isBlock = e => e.blocked || e.status === 0 || e.status === 403 || e.status === 429;
    async function worker(id) {
      while (!signal.aborted && !blocked) {
        if (id >= conc) { if (idx >= tasks.length) return; await sleepAbortable(500, signal); continue; }
        const i = idx++;
        if (i >= tasks.length) return;
        const task = tasks[i];
        for (let attempt = 1; !signal.aborted && !blocked; attempt++) {
          const wait = pauseUntil - Date.now();
          if (wait > 0) await sleepAbortable(wait, signal);
          if (blocked || signal.aborted) return;
          const t0 = performance.now();
          try {
            const res = await run(task, signal);
            blockedStreak = 0;
            await onTask(task, res, null, performance.now() - t0);
            break;
          } catch (e) {
            if (signal.aborted) return;
            if (isBlock(e) && ++blockedStreak >= BLOCK_LIMIT) { blocked = true; return; }
            if (isBlock(e) || e.status >= 500) {
              pauseUntil = Date.now() + 5000 * attempt;
              conc = 1;
            }
            if (attempt >= 3 && !isBlock(e)) { await onTask(task, null, e.message || String(e), performance.now() - t0); break; }
          }
        }
        await sleepAbortable(interval * 1000 * (0.7 + Math.random() * 0.6), signal);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, k) => worker(k)));
    return blocked ? 'blocked' : (signal.aborted ? 'aborted' : 'done');
  }

  const cacheKey = (spirit, adults, los) => `${CACHE_PREFIX}${spirit}|${adults}|${los}`;
  function loadCache(key) {
    try { return kv.get(key) || { titles: {}, currency: '', days: {} }; }
    catch (e) { return { titles: {}, currency: '', days: {} }; }
  }
  const putTimers = {};
  function saveCache(key, data) {
    kv.set(key, data);
    clearTimeout(putTimers[key]);
    putTimers[key] = setTimeout(() => remotePut(key, data), 800);
  }
  async function saveCacheNow(key, data) {
    const local = kv.set(key, data) && await kv.flush();
    clearTimeout(putTimers[key]);
    const disk = await remotePut(key, data);
    return { local, disk };
  }
  async function clearCache(key) {
    kv.del(key);
    await kv.flush();
    clearTimeout(putTimers[key]);
    return remoteDel(key);
  }

  const PTS_CATS = [
    ['STANDARD_ROOM', 'Standard room'], ['CLUB', 'Club room'], ['STANDARD_SUITE', 'Standard suite'], ['PREMIUM_SUITE', 'Premium suite'],
    ['UPGRADE_CLUB', 'Club upgrade'], ['UPGRADE_STANDARD_SUITE', 'Standard suite upgrade'], ['UPGRADE_PREMIUM_SUITE', 'Premium suite upgrade'],
  ];
  const TIERS = [
    ['SUPER_OFF_PEAK', 'Super off-peak', '#16783e'], ['OFF_PEAK', 'Off-peak', '#a6d96a'], ['STANDARD', 'Standard', '#ffffbf'],
    ['PEAK', 'Peak', '#fdae61'], ['SUPER_PEAK', 'Super peak', '#d7191c'],
  ];
  const TIER_MAP = Object.fromEntries(TIERS.map(([k, name, c], i) => [k, { name, c, ink: i === 0 || i === 4 ? '#fff' : '#25332e', rank: i + 1 }]));
  const CELL_SIZE = 26, CELL_STEP = CELL_SIZE + 3;
  const PTS_CHUNK = 70;
  const PTS_TTL_MS = 6 * 3600 * 1000;
  // The server collector refreshes points calendars daily, so its calendars and proofs stay usable for 36 hours.
  const COLLECTOR_PTS_TTL_MS = 36 * 3600 * 1000;
  const ptsTTL = x => (x && x.source === 'collector' ? COLLECTOR_PTS_TTL_MS : PTS_TTL_MS);
  const STRIPE = 'repeating-linear-gradient(45deg,rgba(0,0,0,.32) 0 1.5px,transparent 1.5px 4px)';

  async function fetchJSON(url, signal) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include', signal });
    const t = await r.text();
    if (r.status === 403 || r.status === 429 || !t) {
      const e = new Error(r.status === 200 ? 'Empty response' : 'HTTP ' + r.status); e.blocked = true; throw e;
    }
    try { return { status: r.status, j: JSON.parse(t) }; }
    catch (e) { const er = new Error('Unexpected response; Hyatt may have blocked the request'); er.blocked = true; throw er; }
  }
  async function fetchPoints(spirit, start, n, adults, onProgress, signal) {
    const end = addDays(start, n - 1);
    const prices = {};
    let hotelCategory = '';
    const chunks = Math.ceil(n / PTS_CHUNK);
    let k = 0;
    for (let s0 = start; s0 <= end; s0 = addDays(s0, PTS_CHUNK)) {
      let e0 = addDays(s0, PTS_CHUNK - 1);
      if (e0 > end) e0 = end;
      onProgress && onProgress(++k, chunks + 1);
      let res = await fetchJSON(`/explore-hotels/service/avail?spiritCode=${spirit}&startDate=${s0}&endDate=${e0}`, signal);
      if ((res.status !== 200 || !res.j.roomCategories) && s0 === start && s0 < e0) {
        res = await fetchJSON(`/explore-hotels/service/avail?spiritCode=${spirit}&startDate=${addDays(s0, 1)}&endDate=${e0}`, signal);
      }
      if (res.status !== 200 || !res.j.roomCategories) continue;
      for (const [cat, days] of Object.entries(res.j.roomCategories)) {
        prices[cat] = prices[cat] || {};
        for (const [d, v] of Object.entries(days || {})) {
          prices[cat][d] = [v.pointsLevel || '', v.pointsValue ?? null, v.pointsCash ? (v.pointsCash.pointsValue ?? null) : null];
        }
      }
      if (res.j.hotelCategory) hotelCategory = String(res.j.hotelCategory).trim();
    }
    onProgress && onProgress(chunks + 1, chunks + 1);
    const avail = {};
    let info = '';
    const res = await fetchJSON(`/explore-hotels/service/avail/days?spiritCode=${spirit}&startDate=${start}&endDate=${end}` +
      `&numAdults=${adults}&numChildren=0&roomQuantity=1&los=1&isMock=false`, signal);
    if (res.status === 200) {
      info = res.j.responseInfo || '';
      for (const [d, cats] of Object.entries(res.j.days || {})) {
        for (const c of Object.keys(cats || {})) (avail[c] = avail[c] || {})[d] = 1;
      }
    }
    return { ts: Date.now(), spirit, start, end, adults, prices, avail, hotelCategory, info };
  }

  const validRoomProof = p => p && [1, 2].includes(p.version) && p.rooms && Number.isFinite(p.ts) &&
    Date.now() >= p.ts && Date.now() - p.ts < ptsTTL(p);
  const reusableRoomProof = (p, retryEmpty = false) => validRoomProof(p) &&
    (!p.error && Object.keys(p.rooms).length > 0 || p.version === 2 && !retryEmpty && Date.now() - p.ts < 60000);
  function roomProofSamples(P, cash, selectedRoom) {
    const available = Object.keys(P.avail.STANDARD_ROOM || {}).filter(d => d >= P.start && d <= P.end).sort();
    if (available.length) return { dates: [...new Set([available[0], available.at(-1)])], source: 'calendar' };
    const priced = Object.keys(P.prices.STANDARD_ROOM || {}).filter(d => d >= P.start && d <= P.end).sort();
    const dates = [priced[Math.min(2, priced.length - 1)] || P.start];
    const now = Date.now();
    const cashDays = Object.entries(cash?.days || {}).filter(([d, rec]) => d >= P.start && d <= P.end &&
      rec && now >= rec.ts && now - rec.ts < CACHE_TTL_MS)
      .sort(([a], [b]) => a.localeCompare(b));
    const codes = rec => Object.entries(rec?.r || {}).filter(([, v]) => v[0] > 0 && v[2] !== 1).map(([code]) => code);
    const covered = new Set(codes(cash?.days?.[dates[0]]));
    while (dates.length < 3) {
      const ranked = cashDays.filter(([d]) => !dates.includes(d)).map(([d, rec]) => {
        const unseen = codes(rec).filter(code => !covered.has(code));
        return { d, unseen, score: unseen.length + (unseen.includes(selectedRoom) ? 1000 : 0) };
      }).sort((a, b) => b.score - a.score || a.d.localeCompare(b.d));
      if (!ranked[0]?.score) break;
      dates.push(ranked[0].d); ranked[0].unseen.forEach(code => covered.add(code));
    }
    if (dates.length < 2) {
      const other = priced.find(d => !dates.includes(d));
      if (other) dates.push(other);
    }
    return { dates, source: 'price-fallback' };
  }
  async function fetchRoomProof(P, signal, cash, selectedRoom) {
    const samples = roomProofSamples(P, cash, selectedRoom);
    const proof = { version: 2, ts: Date.now(), rooms: {}, dates: [], error: '', sampleSource: samples.source };
    for (const date of samples.dates) {
      try {
        const res = await fetchJSON(`${API}${encodeURIComponent(P.spirit)}?checkinDate=${date}&checkoutDate=${addDays(date, 1)}` +
          `&rooms=1&adults=${P.adults}&kids=0&rate=Standard&rateFilter=woh`, signal);
        if (res.status !== 200 || !res.j.roomRates) throw new Error('No valid room data returned by the award request');
        proof.dates.push(date);
        for (const [code, room] of Object.entries(res.j.roomRates)) {
          const plan = (room.ratePlans || []).find(p => p && p.id === 'LPRM' && p.ratePlanCategory === 'POINTS' && Number(p.points) > 0);
          if (plan) proof.rooms[code] = { date, plan: plan.id, category: plan.ratePlanCategory, points: plan.points };
        }
      } catch (e) {
        if (signal.aborted) throw e;
        proof.error = e.message;
        break;
      }
    }
    return proof;
  }

  // Hotel finder. Hyatt's Explore Hotels page embeds every property in `window.STORE`; one fetch is cached for a week.
  // Entries: [code, name, city, province, country, brand, award category, English URL slug, country code,
  // sub-region code, latitude, longitude]. The background collector shares this cache and filters by the codes.
  // Lists saved before 0.17.0 have no coordinates; the City tab downloads the list again.
  const HOTELS_TTL_MS = 7 * 24 * 3600 * 1000;
  const HOTELS_RETRY_MS = 60000;
  const hotelsKey = lang => `${CACHE_PREFIX}hotels|${lang}`;
  const validHotels = (h, lang) => h && h.lang === lang && Array.isArray(h.list) && h.list.length > 0 &&
    Number.isFinite(h.ts) && Date.now() >= h.ts && Date.now() - h.ts < HOTELS_TTL_MS;
  const hotelsHaveCoords = h => h.list[0].length >= 12;
  async function fetchHotels(lang) {
    const r = await fetch(`/${lang}/explore-hotels`, { headers: { Accept: 'text/html' }, credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const m = /window\.STORE\s*=\s*\{/.exec(html);
    if (!m) throw new Error('hotel list not found; Hyatt may have blocked the request');
    // Take the object literal up to its matching brace, skipping braces inside strings.
    const begin = m.index + m[0].length - 1;
    let depth = 0, inString = false, end = -1;
    for (let i = begin; i < html.length; i++) {
      const ch = html.charCodeAt(i);
      if (inString) { if (ch === 92) i++; else if (ch === 34) inString = false; }
      else if (ch === 34) inString = true;
      else if (ch === 123) depth++;
      else if (ch === 125 && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) throw new Error('hotel list is incomplete');
    // The store is JSON apart from a few `new Date(…)` values.
    const store = JSON.parse(html.slice(begin, end).replace(/new Date\(("(?:[^"\\]|\\.)*"|-?\d+)\)/g, '$1'));
    const list = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (typeof o.spiritCode !== 'string') { Object.values(o).forEach(walk); return; }
      // Partner (e.g. Mr & Mrs Smith), externally booked and unbookable properties do not use the room-rate service.
      if (!/^[a-z0-9]{5}$/.test(o.spiritCode) || o.propertyType !== 'HYATT' || o.booking?.isExternal || o.openStatus === 'NOT_BOOKABLE') return;
      const loc = o.location || {}, geo = loc.geolocation || {};
      list.push([o.spiritCode, String(o.name || o.spiritCode), loc.city || '', loc.stateProvince?.label || '',
        loc.country?.label || '', o.brand?.label || '', o.awardCategory?.key || '',
        String(o.url || '').split('/').pop().replace(/^[a-z0-9]{5}-/, '').replace(/-/g, ' '),
        loc.country?.key || '', loc.subRegion?.key || '',
        Number.isFinite(geo.latitude) ? geo.latitude : null, Number.isFinite(geo.longitude) ? geo.longitude : null]);
    })(store.properties);
    if (!list.length) throw new Error('hotel list is empty');
    return { ts: Date.now(), lang, list };
  }
  const fold = s => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const indexHotels = list => list.map(h => {
    const hay = fold([h[0], h[1], h[2], h[3], h[4], h[5], h[7]].join(' '));
    return { h, hay, words: hay.split(/[^\p{L}\p{N}]+/u), name: fold(h[1]), city: fold(h[2]), slug: fold(h[7]) };
  });
  // Every query word must match a word prefix, a substring, or (for Chinese) all of its characters in any order.
  function searchHotels(index, query, limit = 8) {
    const q = fold(query).trim();
    const tokens = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!tokens.length) return [];
    const hits = [];
    for (const x of index) {
      let score = 0;
      for (const t of tokens) {
        if (x.words.some(w => w.startsWith(t))) score += 3;
        else if (x.hay.includes(t)) score += 2;
        else if (/\p{Script=Han}/u.test(t) && [...t].every(ch => x.hay.includes(ch))) score += 1;
        else { score = -1; break; }
      }
      if (score < 0) continue;
      if (x.h[0] === q) score += 100;
      if (x.name === q) score += 50;
      if (x.name.startsWith(q) || x.slug.startsWith(q)) score += 10;
      if (x.city === q) score += 5;
      hits.push([score, x.h]);
    }
    return hits.sort((a, b) => b[0] - a[0] || a[1][1].length - b[1][1].length || a[1][1].localeCompare(b[1][1]))
      .slice(0, limit).map(([, h]) => h);
  }

  const hasCoords = h => Number.isFinite(h[10]) && Number.isFinite(h[11]) && !(h[10] === 0 && h[11] === 0);
  function distanceKm(a, b) {
    const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  // City tab: hotels grouped by city and by state or province, searched like hotels.
  function indexPlaces(list) {
    const groups = new Map();
    const add = (key, type, label, detail, h) => {
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, type, label, detail, hotels: [], area: h[8] + '|' + h[3] });
      g.hotels.push(h);
    };
    for (const h of list) {
      if (h[2]) add(`city|${h[8]}|${h[3]}|${h[2]}`, 'city', h[2], [h[3], h[4]].filter(Boolean).join(', '), h);
      if (h[3]) add(`region|${h[8]}|${h[3]}`, 'region', h[3], h[4], h);
    }
    // A translated list leaves some cities in English (纽约 and New York). An English city name found in the URL
    // names of at least half of another city's hotels, in the same country and region and within 10 km, is the same city.
    const cities = [...groups.values()].filter(g => g.type === 'city');
    const latin = t => !/[^\P{L}\p{Script=Latin}]/u.test(t);
    const words = t => ` ${fold(t).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    const center = g => {
      const at = g.hotels.filter(hasCoords);
      return at.length ? [at.reduce((t, h) => t + h[10], 0) / at.length, at.reduce((t, h) => t + h[11], 0) / at.length] : null;
    };
    for (const e of cities.filter(g => latin(g.label))) {
      const name = words(e.label), here = center(e);
      if (name.length < 5 || !here || !groups.has(e.key)) continue;
      const same = cities.filter(g => g !== e && !latin(g.label) && g.area === e.area && groups.has(g.key) &&
        g.hotels.filter(h => words(h[7]).includes(name)).length * 2 >= g.hotels.length &&
        center(g) && distanceKm(here, center(g)) <= 10);
      if (!same.length) continue;
      const all = [e, ...same].sort((a, b) => b.hotels.length - a.hotels.length || latin(a.label) - latin(b.label));
      all[0].label = all.map(g => g.label).join(' / ');
      all[0].hotels = all.flatMap(g => g.hotels);
      for (const g of all.slice(1)) groups.delete(g.key);
    }
    return [...groups.values()].map(g => {
      const hay = fold(g.label + ' ' + g.detail);
      // English URL slugs let an English name find a city listed in another language, e.g. "tokyo" for 东京.
      return { ...g, hay, words: hay.split(/[^\p{L}\p{N}]+/u), slugs: g.hotels.map(h => fold(h[7])) };
    });
  }
  function matchTokens(tokens, hay, words) {
    let score = 0;
    for (const t of tokens) {
      if (words.some(w => w.startsWith(t))) score += 3;
      else if (hay.includes(t)) score += 2;
      else if (/\p{Script=Han}/u.test(t) && [...t].every(ch => hay.includes(ch))) score += 1;
      else return -1;
    }
    return score;
  }
  function searchPlaces(places, index, query) {
    const q = fold(query).trim();
    const tokens = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!tokens.length) return [];
    const hits = [];
    for (const g of places) {
      let score = matchTokens(tokens, g.hay, g.words);
      if (score >= 0) {
        const label = fold(g.label);
        score += 20 + (label === q ? 50 : label.startsWith(q) ? 10 : 0) + (g.type === 'city' ? 1 : 0);
      } else {
        // Most of the area's hotels have the words in their English URL names; one-hotel areas show as "Near …" instead.
        const matched = g.slugs.filter(s => tokens.every(t => s.includes(t))).length;
        if (g.slugs.length < 2 || matched * 2 <= g.slugs.length) continue;
        score = tokens.length + matched / 1000;
      }
      hits.push([score, g]);
    }
    const found = hits.sort((a, b) => b[0] - a[0] || b[1].hotels.length - a[1].hotels.length).slice(0, 6).map(([, g]) => g);
    const near = searchHotels(index, query, 3).map(h => ({ key: 'near|' + h[0], type: 'near', label: h[1], detail: '', hotels: [h] }));
    return [...found, ...near];
  }

  const CSS = `
  .hryv-fab{position:fixed;left:16px;bottom:16px;z-index:99998;background:#0D2D52;color:#fff;border:none;border-radius:20px;
    padding:8px 14px;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;cursor:pointer;
    box-shadow:0 2px 8px rgba(0,0,0,.25)}
  .hryv-fab:hover{background:#1a4a87}
  .hryv-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center}
  .hryv-modal{background:#fff;color:#222;border-radius:12px;padding:20px 22px;max-width:96vw;max-height:92vh;overflow:auto;box-sizing:border-box;min-width:0;
    box-shadow:0 6px 24px rgba(0,0,0,.3);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .hryv-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e5e5;padding-bottom:10px;margin-bottom:12px}
  .hryv-head h3{margin:0;font-size:17px}
  .hryv-x{border:none;background:none;font-size:24px;line-height:1;color:#888;cursor:pointer}
  .hryv-x:hover{color:#000}
  .hryv-controls{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin-bottom:10px}
  .hryv-controls label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:#555}
  .hryv-controls input,.hryv-controls select{padding:4px 6px;border:1px solid #ccc;border-radius:5px;font-size:13px;color:#222;background:#fff}
  .hryv-controls input[type=number]{width:70px}
  .hryv-controls input.hryv-code{width:80px}
  .hryv-controls input.hryv-find{width:220px}
  .hryv-findbox{position:relative}
  .hryv-suggest,.hryv-places{position:absolute;left:0;top:100%;z-index:3;margin-top:3px;width:340px;max-width:80vw;max-height:300px;overflow-y:auto;
    background:#fff;border:1px solid #ccc;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.18)}
  .hryv-suggest[hidden],.hryv-places[hidden]{display:none}
  .hryv-suggest-item,.hryv-place-item{display:flex;flex-direction:column;gap:1px;padding:6px 9px;cursor:pointer}
  .hryv-suggest-item b,.hryv-place-item b{font-weight:600;color:#222}
  .hryv-suggest-item span,.hryv-place-item span{font-size:11px;color:#666}
  .hryv-suggest-item.on,.hryv-suggest-item:hover,.hryv-place-item.on,.hryv-place-item:hover{background:#e3ecf7}
  .hryv-suggest-msg,.hryv-place-msg{padding:6px 9px;font-size:12px;color:#666}
  .hryv-btn{background:#0D2D52;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer}
  .hryv-btn.secondary{background:#fff;color:#0D2D52;border:1px solid #0D2D52}
  .hryv-btn:disabled{opacity:.45;cursor:not-allowed}
  .hryv-progress{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin:6px 0 4px}
  .hryv-progress>div{height:100%;width:0;background:#0D2D52;transition:width .2s}
  .hryv-status{font-size:12px;color:#555;min-height:18px}
  .hryv-legend{display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:11px;color:#555;margin:10px 0 6px}
  .hryv-legend span{display:inline-flex;align-items:center;gap:4px}
  .hryv-calendar{max-width:100%;overflow-x:auto;padding:3px 2px 7px}
  .hryv-chart{display:grid;width:max-content;grid-template-columns:auto 1fr;grid-template-rows:auto auto;gap:4px 4px;margin-top:4px}
  .hryv-months{grid-column:2;position:relative;height:14px;font-size:11px;color:#555}
  .hryv-months div{position:absolute;top:0;white-space:nowrap}
  .hryv-wk{grid-column:1;grid-row:2;display:grid;grid-template-rows:repeat(7,${CELL_SIZE}px);gap:3px;font-size:10px;color:#777}
  .hryv-wk div{line-height:${CELL_SIZE}px}
  .hryv-grid{grid-column:2;grid-row:2;display:grid;grid-template-rows:repeat(7,${CELL_SIZE}px);grid-auto-flow:column;grid-auto-columns:${CELL_SIZE}px;gap:3px}
  .hryv-cell{position:relative;width:${CELL_SIZE}px;height:${CELL_SIZE}px;border-radius:3px;background:#ebedf0;box-sizing:border-box}
  .hryv-stock-cell,.hryv-stock-key{--hryv-tier:#ebedf0;--hryv-ink:#38434b;background:transparent;border:0;border-radius:4px}
  .hryv-stock{position:absolute;inset:0;border-radius:inherit;background-color:var(--hryv-tier);pointer-events:none}
  .hryv-qty-label{position:absolute;inset:0;display:grid;place-items:center;color:var(--hryv-ink);font-size:12px;line-height:1;font-weight:700;pointer-events:none;font-variant-numeric:tabular-nums}
  .hryv-stock.hryv-empty{background-image:${STRIPE};opacity:.4}
  .hryv-stock.hryv-empty+.hryv-qty-label{color:#263440;text-shadow:0 0 2px #fff,0 0 2px #fff}
  .hryv-stock.hryv-pending{opacity:.35}
  .hryv-stock.hryv-pending+.hryv-qty-label{font-size:16px;font-weight:500}
  .hryv-stock.hryv-err{opacity:.35}
  .hryv-stale .hryv-qty-label{font-style:italic}
  .hryv-stale::after{content:'';position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:#46525c;box-shadow:0 0 0 1px #fff;pointer-events:none}
  .hryv-stock.hryv-pending+.hryv-qty-label,.hryv-stock.hryv-err+.hryv-qty-label{color:#38434b}
  .hryv-tier-key{width:22px;height:22px;box-sizing:border-box;justify-content:center;border-radius:4px;font-weight:700}
  .hryv-legend .hryv-stock-key{display:inline-block;flex-shrink:0}
  .hryv-legend .hryv-qty-label{display:grid}
  .hryv-cell.hryv-pad{background:transparent}
  .hryv-cell.hryv-pending{background:#fff;border:1px dashed #ccc}
  .hryv-cell.hryv-err{background:repeating-linear-gradient(45deg,#f3c4c4,#f3c4c4 2px,#fff 2px,#fff 4px)}
  .hryv-cell.hryv-click{cursor:pointer}
  .hryv-cell.hryv-click:hover{outline:2px solid #0D2D52;outline-offset:1px}
  .hryv-sw{width:12px;height:12px;border-radius:3px;display:inline-block;box-sizing:border-box}
  .hryv-summary,.hryv-citysummary{margin:12px 0 6px;font-size:13px}
  .hryv-summary .hryv-dates,.hryv-citysummary .hryv-dates{color:#555;font-size:12px;margin-top:4px;word-break:break-all}
  .hryv-table{border-collapse:collapse;font-size:12px;margin-top:8px}
  .hryv-table th,.hryv-table td{border:1px solid #e3e3e3;padding:3px 6px;text-align:center;white-space:nowrap}
  .hryv-table th{background:#f6f8fa;font-weight:600}
  .hryv-table td.hryv-name{text-align:left}
  .hryv-table tr.hryv-row{cursor:pointer}
  .hryv-table tr.hryv-row:hover td{background:#f0f4fa}
  .hryv-table tr.hryv-sel td{background:#e3ecf7}
  .hryv-note{font-size:11px;color:#777;margin-top:12px;line-height:1.5}
  .hryv-tabs{display:flex;gap:6px;margin-left:16px}
  .hryv-tab{border:1px solid #0D2D52;background:#fff;color:#0D2D52;border-radius:14px;padding:3px 12px;font-size:12px;font-weight:600;cursor:pointer}
  .hryv-tab.on{background:#0D2D52;color:#fff}
  .hryv-head h3{display:flex;align-items:center}
  .hryv-cell.hryv-na{background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.32) 0 1.5px,transparent 1.5px 4px);opacity:.5}
  .hryv-storeinfo{font-size:11px;color:#8a5a00;margin:2px 0 4px}
  .hryv-storeinfo.ok{color:#2f6f3e}
  .hryv-resume{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:8px 0;padding:10px 12px;background:#f0f4f8;border:1px solid #c9d6e6;border-radius:8px;font-size:12px;color:#333}
  .hryv-citywrap{max-width:100%;overflow-x:auto;padding:2px 0 6px}
  .hryv-city{border-collapse:separate;border-spacing:3px;font-size:12px}
  .hryv-city th{font-size:11px;font-weight:600;color:#555;padding:2px 3px;white-space:nowrap;line-height:1.2}
  .hryv-city th.hryv-sort{cursor:pointer;user-select:none}
  .hryv-city th.hryv-sort:hover,.hryv-city th.hryv-sorted{color:#0D2D52}
  .hryv-city td{padding:0;text-align:center;white-space:nowrap}
  .hryv-city .hryv-hotel{position:sticky;left:0;z-index:1;background:#fff;text-align:left;min-width:190px;max-width:290px;white-space:normal;padding:2px 8px 2px 0}
  .hryv-city th.hryv-hotel{z-index:2}
  .hryv-city .hryv-hotel>label{display:flex;gap:6px;align-items:flex-start}
  .hryv-city .hryv-hotel input{margin:2px 0 0}
  .hryv-city .hryv-hname{border:0;background:none;padding:0;font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#0D2D52;text-align:left;cursor:pointer}
  .hryv-city .hryv-hname:hover:not(:disabled){text-decoration:underline}
  .hryv-city .hryv-hname:disabled{cursor:default}
  .hryv-city .hryv-hsub{display:block;font-size:10px;color:#777;line-height:1.3}
  .hryv-city .hryv-num{min-width:30px;color:#555}
  .hryv-city .hryv-c{position:relative;min-width:62px;height:34px;border-radius:4px;background:#f1f3f5;color:#25332e;box-sizing:border-box;line-height:1.15;font-variant-numeric:tabular-nums}
  .hryv-city .hryv-c b{display:block;font-size:12px}
  .hryv-city .hryv-c small{display:block;font-size:10px;opacity:.75}
  .hryv-city .hryv-c.hryv-link{cursor:pointer}
  .hryv-city .hryv-c.hryv-link:hover{outline:2px solid #0D2D52;outline-offset:-2px}
  .hryv-city .hryv-c.hryv-best{background:#c9ecd2;box-shadow:inset 0 0 0 1px #2f8f4e}
  .hryv-city .hryv-c.hryv-soldout{color:#7a838a;background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.08) 0 1.5px,transparent 1.5px 4px)}
  .hryv-city .hryv-c.hryv-na{opacity:.5;background-image:${STRIPE}}
  .hryv-city .hryv-c.hryv-pending{background:#fff;border:1px dashed #ccc;color:#999}
  .hryv-city .hryv-c.hryv-err{background:#fbe3e3;color:#8b1b1b}
  .hryv-city .hryv-c.hryv-stale b{font-style:italic}
  .hryv-city tr.hryv-off .hryv-c,.hryv-city tr.hryv-off .hryv-num,.hryv-city tr.hryv-off .hryv-hname,.hryv-city tr.hryv-off .hryv-hsub{opacity:.4}
  .hryv-citykey{display:inline-block;min-width:22px;height:16px;padding:0 3px;border-radius:3px;box-sizing:border-box;font-size:10px;line-height:16px;text-align:center;background:#f1f3f5;position:relative}
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function labelled(text, input) {
    const l = el('label');
    l.append(text, input);
    return l;
  }
  function select(options, value) {
    const s = el('select');
    options.forEach(([v, t]) => s.add(new Option(t, v)));
    if (value != null) s.value = String(value);
    return s;
  }

  let overlay = null;
  let restoreUI = null;

  function openUI(prefill) {
    if (overlay) { overlay.style.display = 'flex'; if (prefill && restoreUI) restoreUI(prefill); return; }
    const det = detectFromURL();

    const state = {
      lang: (prefill && prefill.lang) || det.lang,
      room: (prefill && prefill.room) || det.room,
      cache: null,
      cacheKeyStr: '',
      errors: {},
      running: false,
      ctrl: null,
      done: 0, failed: 0, total: 0, tSum: 0, interval: 0, conc: 1, cooldownMsg: '',
      mode: 'cash', pts: null, ptsLoading: false,
      starting: false, reloading: false, recoveryError: '', recoveryFailures: 0,
      job: null, word: 'date',
    };
    // City tab: the area's hotels, their cached cash and points data, and display choices.
    const city = {
      place: null, rows: [], off: new Set(), pinned: null, caches: {}, pts: {}, errors: {}, dirty: new Set(),
      view: 'cash', sort: ['name', 1], loadSeq: 0,
    };

    overlay = el('div', 'hryv-overlay');
    overlay.lang = 'en';
    const modal = el('div', 'hryv-modal');
    overlay.appendChild(modal);

    const head = el('div', 'hryv-head');
    const h3 = el('h3', null, 'Room calendar');
    const tabs = el('span', 'hryv-tabs');
    const tabCash = el('button', 'hryv-tab on', 'Cash');
    const tabPts = el('button', 'hryv-tab', 'Points');
    const tabCity = el('button', 'hryv-tab', 'City');
    tabCity.title = 'Compare every hotel in a city for a few dates';
    tabs.append(tabCash, tabPts, tabCity);
    h3.append(tabs);
    const x = el('button', 'hryv-x', '×');
    x.setAttribute('aria-label', 'Close calendar');
    head.append(h3, x);

    const inSpirit = el('input', 'hryv-code'); inSpirit.value = det.spirit; inSpirit.placeholder = 'e.g. hfegh';
    const inFind = el('input', 'hryv-find'); inFind.type = 'search'; inFind.placeholder = 'Hotel name, city or code';
    inFind.autocomplete = 'off'; inFind.spellcheck = false;
    const findList = el('div', 'hryv-suggest'); findList.id = 'hryv-suggest'; findList.hidden = true;
    findList.setAttribute('role', 'listbox');
    inFind.setAttribute('role', 'combobox'); inFind.setAttribute('aria-autocomplete', 'list');
    inFind.setAttribute('aria-controls', findList.id); inFind.setAttribute('aria-expanded', 'false');
    const lbFind = el('div', 'hryv-findbox'); lbFind.append(labelled('Find hotel', inFind), findList);
    const selRoom = el('select');
    const inStart = el('input'); inStart.type = 'date'; inStart.value = todayLocal();
    const inDays = el('input'); inDays.type = 'number'; inDays.min = 1; inDays.max = 400; inDays.value = 365;
    const selLos = select([1, 2, 3, 4, 5, 6, 7].map(n => [n, count(n, 'night')]), 1);
    const selAdults = select([1, 2, 3, 4].map(n => [n, String(n)]), 1);
    const selConc = select([1, 2, 3, 4, 5, 6].map(n => [n, String(n)]), 3);
    const inInterval = el('input'); inInterval.type = 'number'; inInterval.min = 0; inInterval.max = 60; inInterval.step = 1; inInterval.value = 0;
    const inAuto = el('input'); inAuto.type = 'checkbox'; inAuto.checked = kv.get('hryv:auto-recover') !== false;
    // Cash and Points share Days; the City tab keeps its own, shorter value in the same field.
    const daysGroup = m => (m === 'city' ? 'city' : 'hotel');
    const daysFor = { hotel: inDays.value, city: String(CITY_DEFAULT_DAYS) };
    function setDays(group, value) {
      daysFor[group] = String(value);
      if (daysGroup(state.mode) === group) inDays.value = value;
    }
    const inPlace = el('input', 'hryv-find'); inPlace.type = 'search'; inPlace.placeholder = 'City, region or hotel';
    inPlace.autocomplete = 'off'; inPlace.spellcheck = false;
    const placeList = el('div', 'hryv-places'); placeList.id = 'hryv-places'; placeList.hidden = true;
    placeList.setAttribute('role', 'listbox');
    inPlace.setAttribute('role', 'combobox'); inPlace.setAttribute('aria-autocomplete', 'list');
    inPlace.setAttribute('aria-controls', placeList.id); inPlace.setAttribute('aria-expanded', 'false');
    const lbPlace = el('div', 'hryv-findbox'); lbPlace.append(labelled('City or area', inPlace), placeList);
    const selNear = select([[0, 'None'], [5, 'Within 5 km'], [10, 'Within 10 km'], [25, 'Within 25 km'], [50, 'Within 50 km']], 0);
    const lbNear = labelled('Nearby hotels', selNear);
    lbNear.title = 'Also include hotels within this distance of the area’s center.';
    const CITY_VIEWS = [['cash', 'Cash: lowest rate'], ['sua', 'Cash: standard suites (points + SUA)'],
      ...PTS_CATS.map(([k, name]) => [k, 'Points: ' + name])];
    const selView = select(CITY_VIEWS, 'cash');
    const lbView = labelled('Show', selView);
    function applyPrefill(p) {
      inStart.value = p.start;
      selLos.value = String(p.los); selAdults.value = String(p.adults);
      selConc.value = String(Math.max(1, Math.min(6, Number(p.conc) || 3)));
      inInterval.value = Number(p.interval) || 0;
      inAuto.checked = p.autoRecover !== false;
      state.lang = p.lang || det.lang;
      state.recoveryFailures = Math.max(0, Math.min(AUTO_RECOVERY_LIMIT, Number(p.recoveryFailures) || 0));
      if (p.mode === 'city') {
        setDays('city', p.n);
        // Restore the area as it was; the hotels being scanned stay selected and the others unchecked.
        const a = p.area;
        const area = a && ['city', 'region', 'near'].includes(a.type) && Array.isArray(a.codes) && a.codes.length && a.codes.every(isCode) ? a : null;
        city.place = area ? { type: area.type, key: String(area.key || ''), label: String(area.label || ''), codes: area.codes.slice(0, CITY_MAX_HOTELS) }
          : { type: 'list', label: String(p.place || ''), codes: [...p.spirits] };
        if (area && [0, 5, 10, 25, 50].includes(area.radius)) selNear.value = String(area.radius);
        city.pinned = [...p.spirits];
        city.off = new Set();
        if (CITY_VIEWS.some(([k]) => k === p.view)) { city.view = p.view; selView.value = p.view; }
        inPlace.value = placeText(city.place);
        return;
      }
      inSpirit.value = p.spirit; setDays('hotel', p.n);
      state.room = p.room || ''; selRoom.innerHTML = '';
    }
    if (prefill) {
      applyPrefill(prefill);
    }
    const btnScan = el('button', 'hryv-btn', 'Start scan');
    const btnStop = el('button', 'hryv-btn secondary', 'Stop'); btnStop.disabled = true;
    const btnCsv = el('button', 'hryv-btn secondary', 'Export CSV');
    const btnClear = el('button', 'hryv-btn secondary', 'Clear cache');
    const btnBackup = el('button', 'hryv-btn secondary', 'Export backup');
    btnBackup.title = 'Export room and points data for all hotels';
    const btnSettings = platform ? el('button', 'hryv-btn secondary', 'Settings') : null;

    const controls = el('div', 'hryv-controls');
    const lbRoom = labelled('Room', selRoom), lbLos = labelled('Nights', selLos);
    const lbSpirit = labelled('Hotel code', inSpirit);
    const lbConc = labelled('Parallel requests', selConc), lbInterval = labelled('Delay (sec)', inInterval);
    const lbAuto = labelled('Auto-resume', inAuto);
    lbAuto.title = 'Clear Hyatt cookies and reload if requests are blocked.';
    const selCat = select(PTS_CATS, 'STANDARD_ROOM');
    const lbCat = labelled('Award type', selCat);
    const btnPts = el('button', 'hryv-btn', 'Load rates');
    const btnPtsReload = el('button', 'hryv-btn secondary', 'Refresh rates');
    controls.append(
      lbFind, lbSpirit, lbRoom, lbCat, lbPlace, lbNear, labelled('Start date', inStart),
      labelled('Days', inDays), lbLos, labelled('Adults', selAdults),
      lbConc, lbInterval, lbAuto, lbView, btnScan, btnStop, btnCsv, btnClear, btnPts, btnPtsReload, btnBackup
    );
    if (btnSettings) controls.append(btnSettings);

    const prog = el('div', 'hryv-progress'); const progBar = el('div'); prog.appendChild(progBar);
    const status = el('div', 'hryv-status');
    const storeInfo = el('div', 'hryv-storeinfo');
    function showStoreInfo() {
      if (platform) {
        const error = platform.storage.error();
        storeInfo.textContent = error ? 'Save failed: ' + error + '. Auto-resume is paused until progress can be saved.'
          : 'Storage: browser' + (remoteUp ? ' + local backup.'
            : platform.remoteEnabled ? '. Local backup is offline.' : '.');
        storeInfo.classList.toggle('ok', !error);
        return;
      }
      storeInfo.textContent = remoteUp
        ? 'Storage: browser + local backup.'
        : remoteUp === false
          ? 'Storage: browser only. Local backup is offline.'
          : 'Checking local backup…';
      storeInfo.classList.toggle('ok', !!remoteUp);
    }
    showStoreInfo();
    const helperInfo = el('div', 'hryv-storeinfo', 'Checking auto-resume…');
    helperRequest('ping').then(r => {
      helperInfo.textContent = r.ok && !r.backgroundReload
        ? (platform ? HELPER_OUTDATED : `Cookie Helper ${r.version || ''} needs an update. Install version 1.0.3 or later.`)
        : r.ok
        ? `Auto-resume ready · v${r.version}`
        : platform ? HELPER_MISSING : 'Cookie Helper is not connected. Clear Hyatt cookies manually, then reload to resume.';
      helperInfo.title = 'The second reload runs at least 5 seconds after the page loads. Navigation restarts the timer.';
      helperInfo.classList.toggle('ok', !!(r.ok && r.backgroundReload));
    });
    const resumeBar = el('div', 'hryv-resume');
    const btnResume = el('button', 'hryv-btn', 'Reload and resume');
    const SETTINGS_URL = 'chrome://settings/content/all?searchSubpage=hyatt';
    const btnCopy = el('button', 'hryv-btn secondary', 'Copy settings address');
    btnCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(SETTINGS_URL); btnCopy.textContent = 'Copied'; }
      catch (e) { btnCopy.textContent = 'Could not copy. Enter the address manually.'; }
      setTimeout(() => { btnCopy.textContent = 'Copy settings address'; }, 2000);
    });
    const hint = el('span');
    hint.append('Open the copied settings address in a new tab and clear Hyatt site data. Then return here and click “Reload and resume”.');
    resumeBar.append(btnCopy, btnResume, hint);
    resumeBar.style.display = 'none';

    const legend = el('div', 'hryv-legend');
    const legendItem = (style, text) => {
      const s = el('span'); const sw = el('span', 'hryv-sw'); Object.assign(sw.style, style); s.append(sw, text); return s;
    };
    legend.append(el('b', null, 'Rooms left'));
    [['', '3', 'Available'], ['hryv-empty', '0', 'Sold out'], ['', '3', 'Checked over 6 hours ago', 'hryv-stale'],
      ['hryv-pending', '·', 'Not checked'], ['hryv-err', '!', 'Request failed']].forEach(([cls, value, text, cellCls = '']) => {
      const item = el('span'), sw = el('span', 'hryv-cell hryv-stock-key ' + cellCls);
      sw.style.setProperty('--hryv-tier', '#a6d96a');
      sw.append(el('span', 'hryv-stock ' + cls), el('span', 'hryv-qty-label', value));
      item.append(sw, text); legend.append(item);
    });
    const cashTierLegend = el('div', 'hryv-legend hryv-cash-tiers');
    cashTierLegend.append(el('b', null, 'Standard room points tier'));
    TIERS.forEach(([key, name]) => {
      const t = TIER_MAP[key], item = el('span'), badge = el('span', 'hryv-tier-key', t.rank);
      badge.style.backgroundColor = t.c; badge.style.color = t.ink;
      item.append(badge, name); cashTierLegend.append(item);
    });
    cashTierLegend.append(legendItem({ backgroundColor: '#ebedf0' }, 'Price unavailable'));

    const ptsLegend = el('div', 'hryv-legend');
    const ptsStatus = el('div', 'hryv-status');
    ptsLegend.style.display = 'none';
    const calendar = el('div', 'hryv-calendar');
    const chart = el('div', 'hryv-chart');
    const months = el('div', 'hryv-months');
    const wk = el('div', 'hryv-wk');
    WEEKDAYS.forEach((w, i) => wk.appendChild(el('div', null, i % 2 === 0 ? w : '')));
    const grid = el('div', 'hryv-grid');
    chart.append(months, wk, grid);
    calendar.append(chart);

    const summary = el('div', 'hryv-summary');
    const tableWrap = el('div'); tableWrap.style.overflowX = 'auto';
    const NOTE_CASH = 'Counts reflect Hyatt’s online inventory for the selected stay. Dates are arrival dates. ' +
      'Results are cached for 6 hours; scans only check missing or expired dates. Older results keep their last value, marked with a dot. ' +
      'Background colors show standard room points tiers for the arrival night, not award availability. ' +
      '◆ marks a room found with a standard room award; ★ marks a standard suite. Unconfirmed rooms may still qualify for standard room awards.';
    const NOTE_PTS = 'Points rates and award availability are separate. Availability is checked for one-night stays. ' +
      'Click an available date to open Hyatt’s booking page. Results are cached for 6 hours; use Refresh rates to check again.';
    const NOTE_CITY = 'A city scan makes one request per hotel and date, plus two per hotel for points rates. ' +
      'Results are shared with each hotel’s calendar and cached for 6 hours; older results are shown in italics with a dot, and a scan checks them again. ' +
      'Prices are the lowest standard rate for the stay in each hotel’s currency. Click a hotel’s name to open its calendar, or a date to open Hyatt’s booking page.';
    const note = el('div', 'hryv-note', NOTE_CASH);
    const cityLegend = el('div', 'hryv-legend');
    const citySummary = el('div', 'hryv-citysummary');
    const cityWrap = el('div', 'hryv-citywrap');

    modal.append(head, controls, prog, status, ptsStatus, storeInfo, helperInfo, resumeBar, legend, cashTierLegend, ptsLegend, calendar,
      summary, tableWrap, cityLegend, citySummary, cityWrap, note);
    document.body.appendChild(overlay);

    // Where each control and section appears: Cash, Points or City.
    const SHOWN_IN = new Map([
      [lbFind, 'cash pts'], [lbSpirit, 'cash pts'], [lbRoom, 'cash'], [lbCat, 'pts'],
      [lbPlace, 'city'], [lbNear, 'city'], [lbView, 'city'],
      [lbLos, 'cash city'], [lbConc, 'cash city'], [lbInterval, 'cash city'], [lbAuto, 'cash city'],
      [btnScan, 'cash city'], [btnStop, 'cash city'], [btnCsv, 'cash city'], [btnClear, 'cash'], [btnPts, 'pts'], [btnPtsReload, 'pts'],
      [prog, 'cash city'], [status, 'cash city'], [ptsStatus, 'cash pts'], [storeInfo, 'cash city'], [helperInfo, 'cash city'],
      [legend, 'cash'], [cashTierLegend, 'cash'], [ptsLegend, 'pts'], [calendar, 'cash pts'], [summary, 'cash pts'], [tableWrap, 'cash pts'],
      [cityLegend, 'city'], [citySummary, 'city'], [cityWrap, 'city'],
    ]);
    const showFor = m => SHOWN_IN.forEach((modes, e) => { e.style.display = modes.split(' ').includes(m) ? '' : 'none'; });
    showFor('cash');

    const cfg = () => {
      const isCity = state.mode === 'city', max = isCity ? CITY_MAX_DAYS : 400;
      return {
        spirit: inSpirit.value.trim().toLowerCase(),
        start: inStart.value || todayLocal(),
        n: Math.max(1, Math.min(max, parseInt(inDays.value, 10) || (isCity ? CITY_DEFAULT_DAYS : 365))),
        los: parseInt(selLos.value, 10),
        adults: parseInt(selAdults.value, 10),
        conc: parseInt(selConc.value, 10),
        interval: Math.max(0, Math.min(60, parseFloat(inInterval.value) || 0)),
        autoRecover: inAuto.checked,
      };
    };
    const datesOf = c => Array.from({ length: c.n }, (_, i) => addDays(c.start, i));
    const isFresh = rec => rec && Date.now() - rec.ts < CACHE_TTL_MS;

    let reloadSeq = 0;
    async function reloadCache() {
      const c = cfg();
      state.cacheKeyStr = c.spirit ? cacheKey(c.spirit, c.adults, c.los) : '';
      state.cache = state.cacheKeyStr ? loadCache(state.cacheKeyStr) : { titles: {}, currency: '', days: {} };
      state.errors = {};
      refreshRoomOptions();
      render();
      const seq = ++reloadSeq, key = state.cacheKeyStr, cache = state.cache;
      if (!key) return;
      const other = await remoteGet(key);
      showStoreInfo();
      if (seq !== reloadSeq || state.cache !== cache) return;
      const localCount = Object.keys(cache.days).length;
      if (mergeStore(cache, other)) { kv.set(key, cache); refreshRoomOptions(); render(); }
      if (remoteUp && localCount > Object.keys((other && other.days) || {}).length) remotePut(key, cache);
    }

    function refreshRoomOptions() {
      const titles = state.cache.titles;
      const codes = Object.keys(titles).sort();
      const want = selRoom.value || state.room;
      selRoom.innerHTML = '';
      if (want && !titles[want]) selRoom.add(new Option(`${want} (not found yet)`, want));
      const info = stdSuiteInfo();
      codes.forEach(code => selRoom.add(new Option(`${code} · ${titles[code]}${roomTag(code, info)}`, code)));
      if (!selRoom.options.length) selRoom.add(new Option('Select after scanning', ''));
      if (want) selRoom.value = want;
    }

    let rafPending = false;
    function scheduleRender() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; render(); });
    }

    function bookingURL(spirit, d, los, adults) {
      return `https://www.hyatt.com/${state.lang}/shop/rooms/${spirit}?checkinDate=${d}&checkoutDate=${addDays(d, los)}` +
        `&rooms=1&adults=${adults}&kids=0&rate=Standard`;
    }

    function ptsURL(spirit, d, adults) {
      return `https://www.hyatt.com/${state.lang}/shop/rooms/${spirit}?checkinDate=${d}&checkoutDate=${addDays(d, 1)}` +
        `&rooms=1&adults=${adults}&kids=0&rateFilter=woh`;
    }

    function renderPoints() {
      const c = cfg();
      const cat = selCat.value;
      const P = state.pts;
      const dates = datesOf(c);
      const offset = weekdayMon0(c.start);
      grid.innerHTML = '';
      months.innerHTML = '';
      for (let k = 0; k < offset; k++) grid.appendChild(el('div', 'hryv-cell hryv-pad'));
      let lastLabelCol = -10, priced = 0;
      const avail = [], tierCount = {}, tierPts = {};
      dates.forEach((d, i) => {
        const col = Math.floor((offset + i) / 7);
        if (((i === 0 && +d.slice(8) <= 14) || d.endsWith('-01')) && col - lastLabelCol >= 3) {
          const m = el('div', null, MONTHS[Number(d.slice(5, 7)) - 1]);
          m.style.left = col * CELL_STEP + 'px';
          months.appendChild(m);
          lastLabelCol = col;
        }
        const cell = el('div', 'hryv-cell');
        const wd = WEEKDAYS[weekdayMon0(d)];
        const inRange = P && d >= P.start && d <= P.end;
        const v = inRange && P.prices[cat] ? P.prices[cat][d] : null;
        if (!inRange) {
          cell.classList.add('hryv-pending');
          cell.title = `${d} (${wd})\nNot loaded`;
        } else if (!v) {
          cell.title = `${d} (${wd})\nNo points rate for this category`;
        } else {
          priced++;
          const [lv, pts, pc] = v;
          const t = TIER_MAP[lv];
          cell.style.backgroundColor = t ? t.c : '#bbb';
          tierCount[lv] = (tierCount[lv] || 0) + 1;
          if (pts != null && tierPts[lv] == null) tierPts[lv] = pts;
          let title = `${d} (${wd})\n${t ? t.name : (lv || 'Unknown tier')}` +
            (pts != null ? ` · ${Number(pts).toLocaleString('en-US')} points` : '') +
            (pc != null ? `\nPoints + Cash: ${Number(pc).toLocaleString('en-US')} points + cash` : '');
          const ok = !!(P.avail[cat] && P.avail[cat][d]);
          if (ok) {
            avail.push(d);
            cell.classList.add('hryv-click');
            title += '\nAward available. Click to book.';
            cell.addEventListener('click', () => window.open(ptsURL(c.spirit, d, c.adults), '_blank'));
          } else {
            cell.classList.add('hryv-na');
            title += '\nNo award available';
          }
          cell.title = title;
        }
        grid.appendChild(cell);
      });

      ptsLegend.innerHTML = '';
      TIERS.forEach(([k, name, col]) => {
        if (P && !tierCount[k]) return;
        ptsLegend.append(legendItem({ background: col }, name + (tierPts[k] != null ? ` (${Number(tierPts[k]).toLocaleString('en-US')})` : '')));
      });
      const naSw = legendItem({ backgroundColor: '#ffffbf', backgroundImage: STRIPE }, 'No award available');
      naSw.firstChild.style.opacity = '.5';
      ptsLegend.append(naSw);
      ptsLegend.append(legendItem({ border: '1px dashed #ccc', background: '#fff' }, 'Not loaded'));

      summary.innerHTML = '';
      tableWrap.innerHTML = '';
      if (!c.spirit) { summary.textContent = 'Find a hotel or enter its five-character code, e.g. hfegh.'; return; }
      if (!P) { summary.textContent = 'Click Load rates to check points prices and award availability.'; return; }
      const name = (PTS_CATS.find(x => x[0] === cat) || [cat, cat])[1];
      const line = el('div');
      line.append(el('b', null, name),
        ` · Rates for ${priced}/${dates.filter(d => d >= P.start && d <= P.end).length} dates; awards available on ${count(avail.length, 'date')}. ` +
        (P.hotelCategory ? `Hotel category ${P.hotelCategory}.` : '') +
        (P.info === 'soldOutHotel' ? 'No awards returned for this date range.' : ''));
      summary.appendChild(line);
      if (avail.length) {
        summary.appendChild(el('div', 'hryv-dates',
          avail.slice(0, 80).map(d => d.slice(5)).join(', ') + (avail.length > 80 ? ` … ${count(avail.length, 'date')} total` : '')));
      }
      summary.appendChild(el('div', 'hryv-dates',
        `Updated ${new Date(P.ts).toLocaleString('en-US', { hour12: false })} · ${P.start} to ${P.end} · ${count(P.adults, 'adult')} · One-night stays.`));
    }

    function refreshCatOptions() {
      const P = state.pts;
      const want = selCat.value;
      selCat.innerHTML = '';
      PTS_CATS.forEach(([k, name]) => {
        if (P && !P.prices[k]) return;
        const n = P && P.avail[k] ? Object.keys(P.avail[k]).length : null;
        selCat.add(new Option(name + (n != null ? ` (${count(n, 'date')} available)` : ''), k));
      });
      if ([...selCat.options].some(o => o.value === want)) selCat.value = want;
    }

    let pointsSeq = 0, pointsLoadingKey = '', pointsCtrl = null;
    const pointsConfigKey = c => [c.spirit, c.adults, c.start, c.n].join('|');
    async function loadPoints(force, retryRoomProof = false) {
      const c = cfg();
      if (!/^[a-z0-9]{5}$/.test(c.spirit)) { ptsStatus.textContent = 'Find a hotel or enter a five-character hotel code.'; return; }
      const requestKey = pointsConfigKey(c);
      if (state.ptsLoading && pointsLoadingKey === requestKey && !force) return;
      const seq = ++pointsSeq;
      if (pointsCtrl) pointsCtrl.abort();
      pointsCtrl = new AbortController();
      const signal = pointsCtrl.signal;
      const current = () => seq === pointsSeq && requestKey === pointsConfigKey(cfg());
      pointsLoadingKey = requestKey;
      state.ptsLoading = true;
      btnPts.disabled = true; btnPtsReload.disabled = true;
      try {
        const key = `hryv:pts|${c.spirit}|${c.adults}`;
        const end = addDays(c.start, c.n - 1);
        const usable = x => x && (!x.spirit || x.spirit === c.spirit) && x.adults === c.adults &&
          Date.now() - x.ts < ptsTTL(x) && x.start <= c.start && x.end >= end;
        let cached = kv.get(key);
        if (!force && !usable(cached)) cached = (await remoteGet(key)) || cached;
        if (!current()) return;
        if (!force && usable(cached)) {
          state.pts = { ...cached, spirit: c.spirit }; state.ptsErr = '';
          ptsStatus.textContent = cached.source === 'collector'
            ? `Using points rates collected ${ago(Date.now() - cached.ts)} ago. Select Refresh rates to update.`
            : 'Using cached points rates. Select Refresh rates to update.';
        } else {
          render();
          const fetched = await fetchPoints(c.spirit, c.start, c.n, c.adults, (i, total) => {
            if (current()) ptsStatus.textContent = `Loading points rates: ${i}/${total}…`;
          }, signal);
          if (!force && validRoomProof(cached?.standardRoomProof)) fetched.standardRoomProof = cached.standardRoomProof;
          kv.set(key, fetched);
          remotePut(key, fetched);
          if (!current()) return;
          state.pts = fetched;
          state.ptsErr = '';
          ptsStatus.textContent = '';
        }
        const P = state.pts;
        render();
        if (force || !reusableRoomProof(P.standardRoomProof, retryRoomProof)) {
          ptsStatus.textContent = 'Checking standard room awards…';
          const proof = await fetchRoomProof(P, signal, state.cache, selRoom.value);
          if (!current()) return;
          P.standardRoomProof = proof;
        }
        kv.set(key, P); remotePut(key, P);
        ptsStatus.textContent = P.standardRoomProof.error
          ? 'Rates loaded. Room verification failed; retry with Refresh rates.'
          : P.source === 'collector' ? `Using points rates collected ${ago(Date.now() - P.ts)} ago. Select Refresh rates to update.` : '';
      } catch (e) {
        if (!current() || signal.aborted) return;
        state.ptsErr = e.message;
        ptsStatus.textContent = e.blocked
          ? `Hyatt blocked the request (${e.message}). Clear Hyatt cookies and reload to retry.`
          : `Could not load rates: ${e.message}`;
      } finally {
        if (seq === pointsSeq) {
          state.ptsLoading = false;
          btnPts.disabled = false; btnPtsReload.disabled = false;
          refreshCatOptions();
          refreshRoomOptions();
          render();
        }
      }
    }

    function setMode(m) {
      const prev = state.mode, before = daysGroup(prev), after = daysGroup(m);
      if (before !== after) {
        daysFor[before] = inDays.value;
        inDays.value = daysFor[after];
        inDays.max = after === 'city' ? CITY_MAX_DAYS : 400;
      }
      state.mode = m;
      tabCash.classList.toggle('on', m === 'cash');
      tabPts.classList.toggle('on', m === 'pts');
      tabCity.classList.toggle('on', m === 'city');
      showFor(m);
      note.textContent = m === 'cash' ? NOTE_CASH : m === 'pts' ? NOTE_PTS : NOTE_CITY;
      resumeBar.style.display = m !== 'pts' && state.cooldownMsg ? 'flex' : 'none';
      if (m === 'city') { openCity(); return; }
      closePlaces();
      // A city scan may have saved new results for this hotel.
      if (prev === 'city' && !state.running) reloadCache(); else render();
      // Dates or Adults changed on the City tab: load this hotel's points rates for them (cached rates are reused).
      const ptsOutdated = !state.pts || pointsLoadingKey !== pointsConfigKey(cfg());
      if (cfg().spirit && (m === 'pts' && !state.pts || prev === 'city' && !state.running && ptsOutdated)) loadPoints(false);
    }

    function stdPoints(d) {
      const P = state.pts, c = cfg();
      const valid = P && P.spirit === c.spirit && P.adults === c.adults && Date.now() - P.ts < ptsTTL(P) && d >= P.start && d <= P.end;
      const v = valid && P.prices.STANDARD_ROOM && P.prices.STANDARD_ROOM[d];
      return v ? { level: v[0], pts: v[1], name: (TIER_MAP[v[0]] || {}).name || (v[0] || 'Unknown tier') } : null;
    }
    const fmtK = n => (n % 1000 === 0 ? n / 1000 + 'k' : (n / 1000).toFixed(1) + 'k');
    function stdSuiteInfo() {
      const set = new Set(), standardRooms = new Set();
      let legacy = 0;
      for (const rec of Object.values(state.cache.days)) {
        for (const [code, v] of Object.entries(rec.r)) {
          if (v.length < 3) legacy++;
          else if (v[2] === 1) set.add(code);
        }
      }
      const P = state.pts, c = cfg(), proof = P?.standardRoomProof;
      if (P?.spirit === c.spirit && P.adults === c.adults && validRoomProof(proof)) {
        for (const [code, v] of Object.entries(proof.rooms)) {
          if (v.plan === 'LPRM' && v.category === 'POINTS' && Number(v.points) > 0 && !set.has(code)) standardRooms.add(code);
        }
      }
      return { set, standardRooms, proof, legacy: legacy > 0 };
    }
    function roomTag(code, info) {
      return info.standardRooms.has(code) ? ' (◆ Standard room)' : info.set.has(code) ? ' (★ Standard suite)' : '';
    }
    function roomKind(code, info) {
      return info.standardRooms.has(code) ? '◆ Standard room (confirmed)' : info.set.has(code) ? '★ Standard suite'
        : 'Unconfirmed';
    }

    function render() {
      if (state.mode === 'pts') return renderPoints();
      if (state.mode === 'city') return renderCity();
      const c = cfg();
      const room = selRoom.value;
      const days = state.cache.days;
      const cur = state.cache.currency;
      const dates = datesOf(c);
      const offset = weekdayMon0(c.start);

      grid.innerHTML = '';
      months.innerHTML = '';
      for (let k = 0; k < offset; k++) grid.appendChild(el('div', 'hryv-cell hryv-pad'));

      let lastLabelCol = -10;
      let scanned = 0, stale = 0;
      const avail = [];
      const classInfo = stdSuiteInfo();
      dates.forEach((d, i) => {
        const col = Math.floor((offset + i) / 7);
        if (((i === 0 && +d.slice(8) <= 14) || d.endsWith('-01')) && col - lastLabelCol >= 3) {
          const m = el('div', null, MONTHS[Number(d.slice(5, 7)) - 1]);
          m.style.left = col * CELL_STEP + 'px';
          months.appendChild(m);
          lastLabelCol = col;
        }
        const cell = el('div', 'hryv-cell hryv-stock-cell');
        cell.dataset.date = d;
        const stock = el('span', 'hryv-stock');
        const qtyLabel = el('span', 'hryv-qty-label', '·');
        cell.append(stock, qtyLabel);
        const rec = days[d];
        const wd = WEEKDAYS[weekdayMon0(d)];
        // A failed retry hides an older value; otherwise an old result stays visible, marked as stale.
        if (!rec || (!isFresh(rec) && state.errors[d])) {
          if (state.errors[d]) { stock.classList.add('hryv-err'); qtyLabel.textContent = '!'; cell.title = `${d} (${wd})\nRequest failed: ${state.errors[d]}`; }
          else { stock.classList.add('hryv-pending'); cell.title = `${d} (${wd})\nNot checked`; }
        } else {
          scanned++;
          if (!isFresh(rec)) { stale++; cell.classList.add('hryv-stale'); }
          const v = room ? rec.r[room] : null;
          const q = v ? v[0] : 0;
          qtyLabel.textContent = room ? String(q) : '—';
          if (String(q).length > 2) qtyLabel.style.fontSize = '9px';
          cell.dataset.quantity = room ? q : '';
          if (q > 0) {
            avail.push([d, q, v[1], v[2] === 1]);
            cell.classList.add('hryv-click');
            const price = v[1] != null ? `\nFrom ${cur} ${Number(v[1]).toLocaleString('en-US')}` : '';
            const isStd = v[2] === 1;
            const ptsLine = isStd
              ? `\n★ Standard suite: standard room points + a Suite Upgrade Award`
              : '';
            cell.title = `${d} (${wd})\n${count(q, 'room')} left${price}\nCategory: ${roomKind(room, classInfo)}${ptsLine}\nClick to book.`;
            cell.addEventListener('click', () => window.open(bookingURL(c.spirit, d, c.los, c.adults), '_blank'));
          } else {
            if (room) stock.classList.add('hryv-empty');
            cell.title = `${d} (${wd})\n${room ? 'Sold out' : 'Select a room'}`;
          }
          if (!isFresh(rec)) cell.title += `\nChecked ${ago(Date.now() - rec.ts)} ago`;
        }
        const sp = stdPoints(d), t = sp && TIER_MAP[sp.level];
        if (sp) {
          if (t) {
            cell.style.setProperty('--hryv-tier', t.c);
            cell.style.setProperty('--hryv-ink', t.ink);
          }
          cell.dataset.tier = sp.level || 'UNKNOWN';
          cell.title += `\nStandard room points on arrival: ${sp.pts != null ? Number(sp.pts).toLocaleString('en-US') + ' pts · ' : ''}${sp.name}` +
            (t ? ` (tier ${t.rank})` : ' (unknown tier)');
        } else {
          cell.title += '\nStandard room points: ' + (state.ptsLoading ? 'Loading' : state.ptsErr ? 'Request failed' : 'No rate found');
        }
        cell.setAttribute('aria-label', cell.title);
        grid.appendChild(cell);
      });

      summary.innerHTML = '';
      if (!c.spirit) {
        summary.textContent = 'Find a hotel or enter its five-character code, e.g. hfegh.';
      } else if (!room) {
        summary.textContent = `${scanned}/${dates.length} dates checked${stale ? ` (${stale} over 6 hours ago)` : ''}. Select a room after scanning.`;
      } else {
        const info = stdSuiteInfo();
        const isStdSuite = info.set.has(room);
        const name = (state.cache.titles[room] ? `${room} · ${state.cache.titles[room]}` : room) + roomTag(room, info);
        const line = el('div');
        line.append(el('b', null, name), ` · ${scanned}/${dates.length} dates checked${stale ? ` (${stale} over 6 hours ago)` : ''}; ${count(avail.length, 'date')} available.`);
        summary.appendChild(line);
        if (avail.length) {
          const list = avail.slice(0, 60).map(([d, q, , std]) => {
            const sp = std ? stdPoints(d) : null;
            return `${d.slice(5)}(${q}${sp && sp.pts != null ? '·' + fmtK(sp.pts) : ''})`;
          }).join(', ');
          summary.appendChild(el('div', 'hryv-dates', list + (avail.length > 60 ? ` … ${count(avail.length, 'date')} total` : '')));
        }
        let hint;
        if (info.standardRooms.has(room)) {
          hint = `Standard room award found on ${info.proof.rooms[room].date}. Check Points for current award availability.`;
        } else if (isStdSuite) {
          hint = state.pts
            ? 'Standard suite. Date entries show rooms left and standard room points for use with a Suite Upgrade Award.'
            : state.ptsLoading ? 'Standard suite. Loading standard room points rates…'
              : state.ptsErr ? `Standard suite. Could not load points rates: ${state.ptsErr}` : 'Standard suite.';
        } else if (info.set.size) {
          hint = `Standard suites found: ${[...info.set].map(c2 => `${c2} (${state.cache.titles[c2] || c2})`).join(', ')}.`;
        } else if (scanned) {
          hint = 'No standard suite found in the checked dates.';
        } else hint = '';
        if (!info.standardRooms.has(room) && !isStdSuite) hint += ' Award category unconfirmed; the hotel may not have released awards.';
        if (info.legacy) hint += ' Some older records lack suite flags. Clear the cache and scan again to update them.';
        summary.appendChild(el('div', 'hryv-dates', hint));
      }

      renderTable(c, dates, room);
    }

    function renderTable(c, dates, room) {
      const days = state.cache.days;
      const titles = state.cache.titles;
      const codes = Object.keys(titles).sort();
      tableWrap.innerHTML = '';
      if (!codes.length) return;

      const classInfo = stdSuiteInfo();
      const stdSet = classInfo.set;
      const monthKeys = [];
      dates.forEach(d => { const m = d.slice(0, 7); if (monthKeys[monthKeys.length - 1] !== m) monthKeys.push(m); });
      const scannedPerMonth = {};
      const counts = {};
      codes.forEach(code => { counts[code] = {}; });
      dates.forEach(d => {
        const rec = days[d];
        if (!rec) return;
        const m = d.slice(0, 7);
        scannedPerMonth[m] = (scannedPerMonth[m] || 0) + 1;
        codes.forEach(code => {
          const v = rec.r[code];
          if (v && v[0] > 0) counts[code][m] = (counts[code][m] || 0) + 1;
        });
      });

      const t = el('table', 'hryv-table');
      const thead = el('tr');
      thead.append(el('th', null, 'Room'), el('th', null, 'Name'), el('th', null, 'Category'), el('th', null, 'Available dates'));
      monthKeys.forEach(m => thead.appendChild(el('th', null, `${m.slice(2, 4)}/${m.slice(5)}`)));
      t.appendChild(thead);
      const sub = el('tr');
      sub.append(el('td', null, ''), el('td', 'hryv-name', 'Dates checked'), el('td', null, ''), el('td', null, ''));
      monthKeys.forEach(m => sub.appendChild(el('td', null, String(scannedPerMonth[m] || 0))));
      t.appendChild(sub);

      codes.forEach(code => {
        const tr = el('tr', 'hryv-row' + (code === room ? ' hryv-sel' : ''));
        const total = Object.values(counts[code]).reduce((a, b) => a + b, 0);
        const isStd = stdSet.has(code);
        tr.append(el('td', null, (classInfo.standardRooms.has(code) ? '◆' : isStd ? '★' : '') + code),
          el('td', 'hryv-name', titles[code]), el('td', null, roomKind(code, classInfo)), el('td', null, String(total)));
        monthKeys.forEach(m => {
          const n = counts[code][m] || 0;
          const s = scannedPerMonth[m] || 0;
          const td = el('td', null, s ? String(n) : '');
          if (s && n) {
            const ratio = n / s;
            td.style.background = ratio > 0.66 ? '#c9ecd2' : ratio > 0.33 ? '#e3f5e7' : '#f3fbf5';
          }
          tr.appendChild(td);
        });
        tr.addEventListener('click', () => { selRoom.value = code; render(); });
        t.appendChild(tr);
      });
      tableWrap.appendChild(t);
    }

    function setStatus() {
      const pct = state.total ? Math.round((state.done + state.failed) * 100 / state.total) : 0;
      progBar.style.width = pct + '%';
      if (state.cooldownMsg) { status.textContent = state.cooldownMsg; return; }
      if (!state.running && !state.total) { status.textContent = ''; return; }
      const left = state.total - state.done - state.failed;
      const avg = (state.done ? state.tSum / state.done : 1800) + state.interval * 1000;
      const eta = state.running && left > 0 ? ` · About ${count(Math.ceil(left * avg / state.conc / 60000), 'minute')} left` : '';
      status.textContent = `${state.running ? 'Scanning' : 'Done'}: ${state.done}/${state.total} ${state.word}s` +
        (state.failed ? ` · ${state.failed} failed` : '') +
        (state.running ? ` · ${state.interval}s delay` : '') + eta + '.';
    }

    // One task's request(s): a cash date, or a hotel's points calendar for the scanned dates.
    const runTask = (task, c, signal) => task.kind === 'points'
      ? fetchPoints(task.spirit, c.start, c.n, c.adults, null, signal)
      : fetchDay(task.spirit, task.date, c.los, c.adults, signal);

    async function cooldown(task, c, signal, onTask) {
      for (let k = 1; k <= COOLDOWN_TRIES; k++) {
        const at = new Date(Date.now() + COOLDOWN_MIN * 60000);
        resumeBar.style.display = 'flex';
        state.cooldownMsg = `Paused: Hyatt is blocking requests. ${count(state.done, state.word)} completed. ` +
          (state.recoveryError ? state.recoveryError + ' ' : '') +
          `Retry ${k}/${COOLDOWN_TRIES} at ${pad(at.getHours())}:${pad(at.getMinutes())}. ` +
          `Use the steps below to reset manually, or click Stop to cancel.`;
        setStatus();
        await sleepAbortable(COOLDOWN_MIN * 60000, signal);
        if (signal.aborted) return false;
        const t0 = performance.now();
        try {
          const res = await runTask(task, c, signal);
          await onTask(task, res, null, performance.now() - t0);
          state.cooldownMsg = '';
          resumeBar.style.display = 'none';
          return true;
        } catch (e) {
          if (signal.aborted) return false;
        }
      }
      state.cooldownMsg = `Stopped: requests are still blocked after ${count(COOLDOWN_MIN * COOLDOWN_TRIES / 60, 'hour')}. ` +
        `Try Start scan later to check the remaining ${state.word}s.`;
      return false;
    }

    async function reloadAndResume(resetCookies, signal) {
      if (signal && signal.aborted) return false;
      const job = state.job || (state.mode === 'city' ? cityJob() : hotelJob());
      if (resetCookies) {
        if (!inAuto.checked) return false;
        if (state.recoveryFailures >= AUTO_RECOVERY_LIMIT) {
          state.recoveryError = 'No progress after two resets. Waiting before retrying.';
          return false;
        }
        const helper = await helperRequest('ping');
        if (!helper.ok) { state.recoveryError = platform ? HELPER_MISSING : 'Cookie Helper is not connected. Clear Hyatt cookies and reload to resume.'; return false; }
        if (!helper.backgroundReload) { state.recoveryError = platform ? HELPER_OUTDATED : 'Update Cookie Helper to 1.0.3 or later in chrome://extensions/.'; return false; }
        if (signal.aborted) return false;
        state.recoveryFailures++;
      }
      const saved = await job.save();
      if (signal && signal.aborted) return false;
      const resumeSaved = await writeResume(job.settings());
      if (signal && signal.aborted) return false;
      if (!((saved.local && resumeSaved.local) || (saved.disk && resumeSaved.disk))) {
        state.recoveryError = 'Progress could not be saved. Reload cancelled.';
        return false;
      }
      if (resetCookies) {
        state.cooldownMsg = 'Progress saved. Clearing Hyatt cookies in 3 seconds, then reloading twice. Click Stop to cancel.';
        setStatus();
        await sleepAbortable(3000, signal);
        if (signal.aborted) return false;
        const result = await helperRequest('reset');
        if (signal.aborted) { await helperRequest('reload-cancel'); return false; }
        if (!result.ok) { state.recoveryError = 'Cookie reset failed: ' + (result.error || 'Unknown error'); return false; }
      }
      state.reloading = true;
      if (state.ctrl) state.ctrl.abort();
      location.reload();
      return true;
    }

    async function startScan(options = {}) {
      if (state.running || state.starting) return;
      state.starting = true;
      try {
        const run = () => runJob(state.mode === 'city' ? cityJob() : hotelJob(), !!options.auto);
        if (navigator.locks) {
          await navigator.locks.request('hryv:scan', { ifAvailable: true }, async lock => {
            if (!lock) { status.textContent = 'A scan is running in another Hyatt tab.'; return; }
            await run();
          });
        } else await run();
      } finally { state.starting = false; }
    }

    // After an automatic reset, wait for the second reload before resuming.
    async function waitForSecondReload(signal) {
      let second = await helperRequest('reload-status');
      if (signal.aborted) return;
      if (second.pending) {
        const waitingSince = Date.now();
        while (!signal.aborted) {
          if (!second.ok || Date.now() - waitingSince > 130000) {
            state.keepResume = true;
            throw new Error((second.error || 'The second reload did not finish') + ' Saved progress is still available.');
          }
          if (!second.pending) break;
          const wait = second.remainingMs == null ? 'Waiting for the page to load' : `Reloading in ${count(Math.max(1, Math.ceil(second.remainingMs / 1000)), 'second')}`;
          state.cooldownMsg = `First reload complete. ${wait}. Click Stop to cancel.`;
          setStatus();
          await sleepAbortable(1000, signal);
          if (signal.aborted) return;
          second = await helperRequest('reload-status');
        }
        if (signal.aborted) return;
      }
      state.cooldownMsg = `Resuming in ${count(RESUME_DELAY_MS / 1000, 'second')}. Click Stop to cancel.`;
      setStatus();
      await sleepAbortable(RESUME_DELAY_MS, signal);
    }

    // The single-hotel scan: one hotel, every date in the range.
    function hotelJob() {
      const c = cfg();
      return {
        c, word: 'date', lockable: [inFind, inSpirit, inDays],
        problem: isCode(c.spirit) ? '' : 'Find a hotel or enter a five-character hotel code.',
        done: 'Done. All selected dates are cached.',
        // From the scan's own settings: Days on the form changes while the City tab is open.
        settings: () => ({ ...c, room: selRoom.value || state.room, lang: state.lang, recoveryFailures: state.recoveryFailures }),
        async prepare(auto) {
          await reloadCache();
          if (auto) loadPoints(false, true);
          return datesOf(c).filter(d => !isFresh(state.cache.days[d])).map(date => ({ kind: 'cash', spirit: c.spirit, date }));
        },
        needs: t => !isFresh(state.cache.days[t.date]),
        failed: t => !!state.errors[t.date],
        accept(t, res) {
          state.cache.days[t.date] = { ts: Date.now(), r: res.rooms };
          Object.assign(state.cache.titles, res.titles);
          if (res.currency) state.cache.currency = res.currency;
          delete state.errors[t.date];
          refreshRoomOptions();
          kv.set(state.cacheKeyStr, state.cache);
        },
        fail(t, err) { state.errors[t.date] = err; },
        persist() { saveCache(state.cacheKeyStr, state.cache); },
        save: () => saveCacheNow(state.cacheKeyStr, state.cache),
        saveLocal() { if (state.cacheKeyStr && state.cache) kv.set(state.cacheKeyStr, state.cache); },
        async finish() { if (state.cacheKeyStr && state.cache) await saveCacheNow(state.cacheKeyStr, state.cache); },
      };
    }

    async function runJob(job, auto) {
      const c = job.c;
      if (job.problem) { status.textContent = job.problem; return; }
      const lockable = [inStart, selLos, selAdults, selConc, inInterval, inAuto, ...job.lockable];
      closeFind(); closePlaces();
      Object.assign(state, {
        running: true, reloading: false, keepResume: false, ctrl: new AbortController(), done: 0, failed: 0, total: 0, tSum: 0,
        interval: c.interval, conc: c.conc, cooldownMsg: '', recoveryError: '', job, word: job.word,
      });
      if (!auto) state.recoveryFailures = 0;
      const signal = state.ctrl.signal;
      resumeBar.style.display = 'none';
      btnScan.disabled = true; btnStop.disabled = false;
      lockable.forEach(e => { e.disabled = true; });
      render();
      try {
        await writeResume(job.settings());
        if (signal.aborted) return;
        if (auto) {
          await waitForSecondReload(signal);
          if (signal.aborted) return;
        }
        const todo = await job.prepare(auto);
        if (signal.aborted) return;
        state.total = todo.length; state.cooldownMsg = '';
        setStatus();
        if (!todo.length) state.cooldownMsg = job.done;
        let sinceSave = 0;
        const onTask = async (task, res, err, ms) => {
          if (signal.aborted) return;
          if (res) {
            job.accept(task, res);
            state.done++; state.tSum += ms;
            state.recoveryFailures = 0;
            kv.set(RESUME_KEY, { ...job.settings(), ts: Date.now() });
            if (++sinceSave >= 10) {
              job.persist(); writeResume(job.settings()); sinceSave = 0;
            }
            await kv.flush();
            if (platform) showStoreInfo();
          } else { job.fail(task, err); state.failed++; }
          setStatus(); scheduleRender();
        };
        const pending = () => todo.filter(t => job.needs(t) && !job.failed(t));

        while (!signal.aborted) {
          const remaining = pending();
          if (!remaining.length) break;
          const outcome = await scan({
            tasks: remaining, run: (task, s) => runTask(task, c, s),
            concurrency: c.conc, interval: state.interval, signal, onTask,
          });
          if (outcome !== 'blocked' || signal.aborted) break;
          await job.save();
          if (signal.aborted) break;
          await writeResume(job.settings());
          if (signal.aborted) break;
          if (await reloadAndResume(true, signal)) return;
          if (signal.aborted) break;
          const next = pending()[0];
          if (!next || !(await cooldown(next, c, signal, onTask))) break;
        }
      } catch (e) {
        if (!signal.aborted) state.cooldownMsg = 'Scan stopped: ' + (e.message || String(e));
      } finally {
        if (!state.reloading) {
          await job.finish();
          if (!state.keepResume) await clearResume();
        }
        state.running = false;
        if (signal.aborted && !state.reloading) state.cooldownMsg = 'Stopped. Auto-resume cancelled.';
        btnScan.disabled = false; btnStop.disabled = true;
        lockable.forEach(e => { e.disabled = false; });
        setStatus(); refreshRoomOptions(); render();
      }
    }

    function exportCSV() {
      const c = cfg();
      const titles = state.cache.titles;
      const codes = Object.keys(titles).sort();
      const info = stdSuiteInfo();
      const rows = [['date', 'weekday', 'room_code', 'room_name', 'rooms_left', 'lowest_rate', 'currency', 'is_standard_suite', 'std_room_points', 'std_room_points_tier', 'room_category', 'is_standard_room', 'standard_room_evidence_date', 'checked_at']];
      datesOf(c).forEach(d => {
        const rec = state.cache.days[d];
        if (!rec) return;
        codes.forEach(code => {
          const v = rec.r[code];
          const sp = stdPoints(d);
          rows.push([d, WEEKDAYS[weekdayMon0(d)], code, titles[code], v ? v[0] : 0, v && v[1] != null ? v[1] : '', state.cache.currency,
            v && v.length >= 3 ? v[2] : '', sp && sp.pts != null ? sp.pts : '', sp ? sp.name : '',
            v && v[3] || '', info.standardRooms.has(code) ? 1 : info.set.has(code) ? 0 : '',
            info.standardRooms.has(code) ? info.proof.rooms[code].date : '', new Date(rec.ts).toISOString()]);
        });
      });
      downloadCSV(rows, `hyatt_${c.spirit}_${c.start}_${c.n}d_${c.los}n_${c.adults}a.csv`);
    }
    function downloadCSV(rows, name) {
      const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    btnScan.addEventListener('click', () => startScan());
    btnResume.addEventListener('click', async () => {
      btnResume.disabled = true;
      if (!(await reloadAndResume(false, state.running ? state.ctrl.signal : null))) {
        btnResume.disabled = false;
        if (state.recoveryError) { state.cooldownMsg = state.recoveryError; setStatus(); }
      }
    });
    btnStop.addEventListener('click', () => {
      if (state.ctrl) state.ctrl.abort();
      if (pointsCtrl) pointsCtrl.abort();
      helperRequest('reload-cancel');
      clearResume();
    });
    inAuto.addEventListener('change', () => kv.set('hryv:auto-recover', inAuto.checked));
    btnCsv.addEventListener('click', () => (state.mode === 'city' ? exportCityCSV() : exportCSV()));
    btnBackup.addEventListener('click', async () => {
      btnBackup.disabled = true;
      try {
        const entries = Object.fromEntries(Object.entries(await kv.snapshot()).filter(([key]) => isBackupKey(key)));
        const blob = new Blob([JSON.stringify({ format: 'hryv-backup', version: 1, exportedAt: new Date().toISOString(), entries }, null, 2)], { type: 'application/json' });
        const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `hyatt-backup-${todayLocal()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) { status.textContent = 'Backup export failed: ' + e.message; }
      finally { btnBackup.disabled = false; }
    });
    if (btnSettings) btnSettings.addEventListener('click', () => platform.openSettings());
    btnClear.addEventListener('click', async () => {
      if (state.running) return;
      btnClear.disabled = true;
      try {
        if (state.cacheKeyStr) await clearCache(state.cacheKeyStr);
        Object.assign(state, { total: 0, done: 0, failed: 0, cooldownMsg: '' });
        await reloadCache(); setStatus();
      } finally { btnClear.disabled = false; }
    });
    selRoom.addEventListener('change', render);
    selCat.addEventListener('change', render);
    tabCash.addEventListener('click', () => setMode('cash'));
    tabPts.addEventListener('click', () => setMode('pts'));
    tabCity.addEventListener('click', () => setMode('city'));
    btnPts.addEventListener('click', () => loadPoints(false));
    btnPtsReload.addEventListener('click', () => loadPoints(true));

    // Hotel list shared by Find hotel and City or area: fetched on first search, kept for a week.
    let hotels = null, hotelIndex = [], placeIndex = null, hotelsLoading = null, hotelsFailedAt = 0, hotelsError = '';
    const hotelLang = () => (/^[a-z]{2}-[A-Z]{2}$/.test(state.lang) ? state.lang : 'en-US');
    const hotelDetail = h => [h[0], [h[2], h[4]].filter(Boolean).join(', '), h[6] && 'Category ' + h[6]].filter(Boolean).join(' · ');
    function useHotels(h) { hotels = h; hotelIndex = indexHotels(h.list); placeIndex = null; }
    const places = () => (placeIndex ||= indexPlaces(hotels.list));
    function cachedHotels(needCoords = false) {
      const lang = hotelLang();
      const ok = h => validHotels(h, lang) && (!needCoords || hotelsHaveCoords(h));
      if (!ok(hotels)) {
        const saved = kv.get(hotelsKey(lang));
        if (ok(saved)) useHotels(saved);
      }
      return ok(hotels);
    }
    function ensureHotels(needCoords = false, onLoading) {
      if (cachedHotels(needCoords)) return Promise.resolve();
      if (hotelsLoading) return hotelsLoading;
      if (Date.now() - hotelsFailedAt < HOTELS_RETRY_MS) return Promise.reject(new Error(hotelsError));
      if (onLoading) onLoading();
      hotelsLoading = fetchHotels(hotelLang()).then(h => { useHotels(h); kv.set(hotelsKey(h.lang), h); }, e => {
        hotelsFailedAt = Date.now(); hotelsError = e.message; throw e;
      }).finally(() => { hotelsLoading = null; });
      return hotelsLoading;
    }

    // A search box with a suggestion list. lookup(query, show) returns { items, message }.
    function combobox(input, list, { itemClass, msgClass, idPrefix, lookup, describe, pick }) {
      let results = [], active = -1, timer = 0;
      function highlight() {
        list.querySelectorAll('.' + itemClass).forEach((o, i) => {
          o.classList.toggle('on', i === active); o.setAttribute('aria-selected', String(i === active));
          if (i === active) o.scrollIntoView({ block: 'nearest' });
        });
        if (active >= 0) input.setAttribute('aria-activedescendant', idPrefix + active);
        else input.removeAttribute('aria-activedescendant');
      }
      function show(items, message) {
        results = items; active = items.length ? 0 : -1;
        list.replaceChildren();
        if (message) list.append(el('div', msgClass, message));
        items.forEach((item, i) => {
          const opt = el('div', itemClass); opt.id = idPrefix + i; opt.setAttribute('role', 'option');
          const [title, detail] = describe(item);
          opt.append(el('b', null, title), el('span', null, detail));
          opt.addEventListener('click', () => choose(item));
          list.append(opt);
        });
        highlight();
        list.hidden = !message && !items.length;
        input.setAttribute('aria-expanded', String(!list.hidden));
      }
      function close() {
        clearTimeout(timer);
        list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      }
      function choose(item) { close(); pick(item); }
      async function update() {
        const q = input.value.trim();
        if (!q || input.disabled) { close(); return; }
        const found = await lookup(q, show);
        // A newer keystroke has its own lookup; a blurred or locked box shows nothing.
        if (input.value.trim() !== q) return;
        if (document.activeElement !== input || input.disabled) { close(); return; }
        show(found.items, found.message);
      }
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 150); });
      input.addEventListener('focus', () => input.select());
      input.addEventListener('blur', close);
      // Keep focus in the input while a result is clicked or the list is scrolled.
      list.addEventListener('mousedown', e => e.preventDefault());
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!results.length || list.hidden) return;
          e.preventDefault();
          active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
          highlight();
        } else if (e.key === 'Enter' && !list.hidden && results[active]) {
          e.preventDefault(); choose(results[active]);
        } else if (e.key === 'Escape' && !list.hidden) {
          e.preventDefault(); close();
        }
      });
      return { close };
    }
    const loadingList = show => () => show([], 'Loading Hyatt’s hotel list…');

    // Find hotel: choosing a result fills Hotel code.
    const finder = combobox(inFind, findList, {
      itemClass: 'hryv-suggest-item', msgClass: 'hryv-suggest-msg', idPrefix: 'hryv-opt-',
      async lookup(q, show) {
        try { await ensureHotels(false, loadingList(show)); }
        catch (e) { return { items: [], message: `Hotel list unavailable (${e.message}). Enter the five-character code instead.` }; }
        const items = searchHotels(hotelIndex, q);
        return { items, message: items.length ? '' : 'No matching hotel.' };
      },
      describe: h => [h[1], hotelDetail(h)],
      pick: pickHotel,
    });
    function closeFind() { finder.close(); }
    function syncFindName() {
      const code = inSpirit.value.trim().toLowerCase();
      const h = cachedHotels() ? hotels.list.find(x => x[0] === code) : null;
      inFind.value = h ? h[1] : '';
      inFind.title = h ? hotelDetail(h) : '';
    }
    function pickHotel(h) {
      inFind.value = h[1]; inFind.title = hotelDetail(h);
      if (inSpirit.value.trim().toLowerCase() === h[0]) return;
      inSpirit.value = h[0];
      inSpirit.dispatchEvent(new Event('change'));
    }
    inSpirit.addEventListener('change', syncFindName);

    // City or area: a city, a state or region, or the hotels near one hotel.
    const CITY_AREA_KEY = 'hryv:city-area';
    function placeText(p) { return p.type === 'near' ? 'Near ' + p.label : p.label; }
    const pickPlace = combobox(inPlace, placeList, {
      itemClass: 'hryv-place-item', msgClass: 'hryv-place-msg', idPrefix: 'hryv-place-',
      async lookup(q, show) {
        try { await ensureHotels(true, loadingList(show)); }
        catch (e) { return { items: [], message: `Hotel list unavailable (${e.message}). Try again in a minute.` }; }
        const items = searchPlaces(places(), hotelIndex, q);
        return { items, message: items.length ? '' : 'No matching city, region or hotel.' };
      },
      describe: g => (g.type === 'near' ? ['Near ' + g.label, hotelDetail(g.hotels[0])]
        : [g.label, [count(g.hotels.length, 'hotel'), g.detail, g.type === 'region' ? 'State or region' : ''].filter(Boolean).join(' · ')]),
      pick(g) {
        city.place = { type: g.type, key: g.key, label: g.label, codes: g.hotels.map(h => h[0]) };
        city.off = new Set();
        if (g.type === 'near' && !Number(selNear.value)) selNear.value = '10';
        inPlace.value = placeText(city.place);
        buildRows(); saveArea(); loadCityData();
      },
    });
    function closePlaces() { pickPlace.close(); }
    function saveArea() {
      const p = city.place;
      if (p && p.type !== 'list') kv.set(CITY_AREA_KEY, { type: p.type, key: p.key, label: p.label, codes: p.codes, radius: Number(selNear.value), off: [...city.off] });
    }
    function openCity() {
      if (!city.place) {
        const saved = kv.get(CITY_AREA_KEY);
        if (saved && ['city', 'region', 'near'].includes(saved.type) && Array.isArray(saved.codes) && saved.codes.length && saved.codes.every(isCode)) {
          city.place = { type: saved.type, key: String(saved.key || ''), label: String(saved.label || ''), codes: saved.codes.slice(0, CITY_MAX_HOTELS) };
          city.off = new Set((saved.off || []).filter(isCode));
          if ([0, 5, 10, 25, 50].includes(saved.radius)) selNear.value = String(saved.radius);
          inPlace.value = placeText(city.place);
        }
      }
      // A running city scan keeps its data; otherwise read the latest saved results.
      if (!(state.running && state.job?.city)) {
        buildRows(!city.pinned);
        if (city.pinned) {
          const pinned = new Set(city.pinned), shown = new Set(city.rows.map(r => r.h[0]));
          for (const s of city.pinned) if (!shown.has(s)) city.rows.push({ h: codeOnly(s), km: null });
          city.off = new Set(city.rows.map(r => r.h[0]).filter(s => !pinned.has(s)));
          city.pinned = null;
        }
        loadCityData();
      }
      render();
    }
    // Rows: the area's hotels plus, with Nearby hotels, others within that distance of the area's center.
    // Downloading the hotel list never interrupts a running city scan or an automatic resume.
    function buildRows(fetchList = true) {
      const p = city.place;
      city.rows = []; city.truncated = 0;
      if (!p) return;
      const named = cachedHotels();
      const radius = p.type === 'list' ? 0 : Number(selNear.value);
      if (fetchList && !cachedHotels(radius > 0)) {
        ensureHotels(radius > 0).then(() => { if (!(state.running && state.job?.city)) { buildRows(false); loadCityData(); } }, () => {});
      }
      const byCode = new Map(named ? hotels.list.map(h => [h[0], h]) : []);
      const group = named && p.key && p.type !== 'near' ? places().find(g => g.key === p.key) : null;
      const codes = group ? group.hotels.map(h => h[0]) : p.codes;
      const base = codes.map(code => byCode.get(code) || codeOnly(code));
      const located = base.filter(hasCoords);
      const center = located.length ? [located.reduce((t, h) => t + h[10], 0) / located.length, located.reduce((t, h) => t + h[11], 0) / located.length] : null;
      let list = base;
      if (radius && center && cachedHotels(true)) {
        // Nearest first, so the 100-hotel limit drops the farthest.
        const inArea = new Set(codes);
        list = base.concat(hotels.list.filter(h => !inArea.has(h[0]) && hasCoords(h))
          .map(h => [distanceKm(center, [h[10], h[11]]), h]).filter(([km]) => km <= radius).sort((a, b) => a[0] - b[0]).map(([, h]) => h));
      }
      city.truncated = Math.max(0, list.length - CITY_MAX_HOTELS);
      city.rows = list.slice(0, CITY_MAX_HOTELS).map(h => ({ h, km: center && hasCoords(h) ? distanceKm(center, [h[10], h[11]]) : null }));
    }
    function codeOnly(code) { return [code, code.toUpperCase(), '', '', '', '', '', '', '', '', null, null]; }
    const ptsKeyOf = (spirit, adults) => `hryv:pts|${spirit}|${adults}`;
    const ptsHasDate = (P, d) => d >= P.start && d <= P.end;
    const ptsCovers = (P, c) => !!P && P.start <= c.start && P.end >= addDays(c.start, c.n - 1);
    const freshPts = (P, c) => (P && P.adults === c.adults && Date.now() >= P.ts && Date.now() - P.ts < ptsTTL(P) ? P : null);
    const cityPoints = (spirit, c) => freshPts(city.pts[spirit], c);
    // Cached cash and points data for the rows, then anything newer in hryv-store.
    async function loadCityData() {
      const c = cfg(), seq = ++city.loadSeq, before = city.pts;
      city.caches = {}; city.pts = {}; city.errors = {}; city.dirty = new Set();
      for (const { h } of city.rows) {
        city.caches[h[0]] = loadCache(cacheKey(h[0], c.adults, c.los));
        // A short calendar from this tab, kept only in memory beside a longer saved one, still serves these dates.
        const saved = kv.get(ptsKeyOf(h[0], c.adults)), mine = before[h[0]];
        city.pts[h[0]] = !ptsCovers(freshPts(saved, c), c) && ptsCovers(freshPts(mine, c), c) ? mine : saved;
      }
      render();
      if (!city.rows.length || !(await remoteCheck())) { showStoreInfo(); return; }
      await Promise.all(city.rows.map(async ({ h }) => {
        const key = cacheKey(h[0], c.adults, c.los), pk = ptsKeyOf(h[0], c.adults);
        const [other, P] = await Promise.all([remoteGet(key), remoteGet(pk)]);
        if (seq !== city.loadSeq) return;
        const cache = city.caches[h[0]];
        if (cache && mergeStore(cache, other)) kv.set(key, cache);
        if (P && P.adults === c.adults && Number.isFinite(P.ts) && !(city.pts[h[0]]?.ts >= P.ts)) { city.pts[h[0]] = P; kv.set(pk, P); }
      }));
      if (seq === city.loadSeq) { showStoreInfo(); render(); }
    }

    const money = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const exact = v => Number(v).toLocaleString('en-US');
    // One grid entry: value (for comparing and sorting), text, sub, classes, colors, tooltip and link.
    function cityCell(spirit, name, d, view, c) {
      const head = `${name}\n${d} (${WEEKDAYS[weekdayMon0(d)]})`;
      const cache = city.caches[spirit], P = cityPoints(spirit, c);
      const std = P && ptsHasDate(P, d) ? P.prices.STANDARD_ROOM?.[d] : null;
      const stdTier = std && TIER_MAP[std[0]];
      const stdLine = std ? `\nStandard room points: ${std[1] != null ? exact(std[1]) + ' · ' : ''}${stdTier ? stdTier.name : std[0] || 'Unknown tier'}` : '';
      const tierStyle = t => (t ? { backgroundColor: t.c, color: t.ink } : null);
      if (view === 'cash' || view === 'sua') {
        const rec = cache?.days[d], err = city.errors[`cash|${spirit}|${d}`];
        if (!rec || (!isFresh(rec) && err)) {
          return err ? { text: '!', cls: ['hryv-err'], title: `${head}\nRequest failed: ${err}` } : { text: '·', cls: ['hryv-pending'], title: `${head}\nNot checked` };
        }
        const cls = isFresh(rec) ? [] : ['hryv-stale'];
        const when = isFresh(rec) ? '' : `\nChecked ${ago(Date.now() - rec.ts)} ago`;
        const open = Object.entries(rec.r).filter(([, v]) => v[0] > 0).sort((a, b) => (a[1][1] ?? Infinity) - (b[1][1] ?? Infinity));
        const line = ([code, v]) => `${v[2] === 1 ? '★ ' : ''}${code} · ${cache.titles[code] || code}: ${count(v[0], 'room')} left` +
          (v[1] != null ? ` · ${cache.currency} ${exact(v[1])}` : '');
        if (view === 'cash') {
          if (!open.length) return { text: 'Sold out', cls: [...cls, 'hryv-soldout'], title: `${head}\nNo rooms available${stdLine}${when}` };
          const v = open[0][1], suite = open.some(([, x]) => x[2] === 1);
          return { value: v[1] ?? null, text: v[1] != null ? money(v[1]) : count(v[0], 'room'), sub: `${v[0]} left${suite ? ' ★' : ''}`, cls,
            title: `${head}\n${open.map(line).join('\n')}${stdLine}${when}\nClick to book.`, href: bookingURL(spirit, d, c.los, c.adults) };
        }
        const suites = open.filter(([, v]) => v[2] === 1);
        if (!suites.length) return { text: '—', cls, title: `${head}\nNo standard suite available${stdLine}${when}` };
        const left = suites.reduce((n, [, v]) => n + v[0], 0);
        // Without a current points calendar the suites still show; Start scan loads the points.
        if (std?.[1] == null) {
          return { text: `★ ${left} left`, sub: 'points ·', cls, title: `${head}\n${suites.map(line).join('\n')}\n` +
            `Standard room points not loaded. Start scan loads them.${when}`, href: ptsURL(spirit, d, c.adults) };
        }
        return { value: std[1], text: exact(std[1]), sub: `★ ${left} left`, cls, style: tierStyle(stdTier),
          title: `${head}\n${suites.map(line).join('\n')}${stdLine}\n` +
            `Standard suite with standard room points and a Suite Upgrade Award.${when}\nClick to open points rates.`,
          href: ptsURL(spirit, d, c.adults) };
      }
      const err = city.errors[`points|${spirit}|${c.start}`];
      if (!P || !ptsHasDate(P, d)) {
        return err ? { text: '!', cls: ['hryv-err'], title: `${head}\nRequest failed: ${err}` } : { text: '·', cls: ['hryv-pending'], title: `${head}\nNot loaded` };
      }
      const label = (PTS_CATS.find(([k]) => k === view) || [view, view])[1];
      const v = P.prices[view]?.[d];
      if (!v) return { text: '—', title: `${head}\nNo points rate for ${label.toLowerCase()}` };
      const t = TIER_MAP[v[0]], ok = !!P.avail[view]?.[d];
      return { value: ok ? v[1] ?? null : null, text: v[1] != null ? exact(v[1]) : t ? t.name : '?', sub: ok ? '' : 'No award',
        cls: ok ? [] : ['hryv-na'], style: tierStyle(t),
        title: `${head}\n${label}: ${t ? t.name : v[0] || 'Unknown tier'}${v[1] != null ? ` · ${exact(v[1])} points` : ''}` +
          `${v[2] != null ? `\nPoints + Cash: ${exact(v[2])} points + cash` : ''}\n${ok ? 'Award available. Click to book.' : 'No award available'}`,
        href: ok ? ptsURL(spirit, d, c.adults) : '' };
    }

    function renderCityLegend(view) {
      cityLegend.replaceChildren();
      const key = (text, label, style, cls = '') => {
        const item = el('span'), k = el('span', 'hryv-citykey ' + cls, text);
        if (style) Object.assign(k.style, style);
        item.append(k, label); return item;
      };
      const common = [key('123', 'Checked over 6 hours ago', { fontStyle: 'italic' }, 'hryv-stale'),
        key('·', 'Not checked', { background: '#fff', border: '1px dashed #ccc', color: '#999' }), key('!', 'Request failed', { background: '#fbe3e3', color: '#8b1b1b' })];
      if (view === 'cash') {
        cityLegend.append(el('b', null, 'Lowest rate'), key('', 'Lowest that night', { background: '#c9ecd2', boxShadow: 'inset 0 0 0 1px #2f8f4e' }),
          key('★', 'Standard suite available'), key('', 'Sold out', { backgroundImage: 'repeating-linear-gradient(45deg,rgba(0,0,0,.12) 0 1.5px,transparent 1.5px 4px)' }), ...common);
        return;
      }
      cityLegend.append(el('b', null, view === 'sua' ? 'Standard room points tier' : 'Points tier'));
      TIERS.forEach(([k, name]) => cityLegend.append(key(String(TIER_MAP[k].rank), name, { backgroundColor: TIER_MAP[k].c, color: TIER_MAP[k].ink })));
      if (view === 'sua') cityLegend.append(key('★', 'Standard suites left; the number is the standard room points to use with a Suite Upgrade Award'), key('—', 'No standard suite'), ...common);
      else cityLegend.append(key('', 'No award available', { backgroundColor: '#ffffbf', backgroundImage: STRIPE, opacity: '.5' }), key('—', 'No points rate'), ...common);
    }

    function renderCity() {
      const c = cfg(), dates = datesOf(c), view = city.view;
      renderCityLegend(view);
      cityWrap.replaceChildren(); citySummary.replaceChildren();
      if (!city.place) { citySummary.textContent = 'Type a city, region or hotel name in City or area, then choose a result.'; return; }
      if (!city.rows.length) { citySummary.textContent = 'No hotels found for this area.'; return; }
      const running = state.running, showKm = city.place.type === 'near' || Number(selNear.value) > 0;
      const rows = city.rows.map(row => {
        const s = row.h[0], cells = dates.map(d => cityCell(s, row.h[1], d, view, c));
        const best = cells.reduce((b, x, i) => (x.value != null && (!b || x.value < b[0]) ? [x.value, dates[i]] : b), null);
        return { ...row, s, cells, best, on: !city.off.has(s), cur: city.caches[s]?.currency || '' };
      });
      // The lowest value each night among selected hotels; cash rates compare only within one currency.
      const lowest = dates.map((d, i) => {
        const m = new Map();
        for (const r of rows) {
          const v = r.cells[i].value, k = view === 'cash' ? r.cur : '';
          if (r.on && v != null && !(m.get(k) <= v)) m.set(k, v);
        }
        return m;
      });
      let [sortKey, dir] = city.sort;
      if (!['name', 'cat', 'best'].includes(sortKey) && !dates.includes(sortKey)) [sortKey, dir] = ['name', 1];
      const sortVal = r => (sortKey === 'cat' ? Number(r.h[6]) || null : sortKey === 'best' ? r.best?.[0] ?? null : r.cells[dates.indexOf(sortKey)].value ?? null);
      rows.sort((a, b) => {
        if (sortKey !== 'name') {
          const x = sortVal(a), y = sortVal(b);
          if (x != null || y != null) {
            if (x == null) return 1;
            if (y == null) return -1;
            if (x !== y) return dir * (x - y);
          }
        }
        return (sortKey === 'name' ? dir : 1) * a.h[1].localeCompare(b.h[1]);
      });

      const table = el('table', 'hryv-city'), head = el('tr');
      const allBox = el('input'); allBox.type = 'checkbox'; allBox.disabled = running;
      allBox.checked = rows.every(r => r.on); allBox.indeterminate = !allBox.checked && rows.some(r => r.on);
      allBox.setAttribute('aria-label', 'Include all hotels');
      allBox.addEventListener('click', e => e.stopPropagation());
      allBox.addEventListener('change', () => {
        city.off = allBox.checked ? new Set() : new Set(city.rows.map(r => r.h[0]));
        saveArea(); render();
      });
      const th = (text, key, cls = '') => {
        const cell = el('th', cls + (key ? ' hryv-sort' : '') + (key === sortKey ? ' hryv-sorted' : ''));
        if (Array.isArray(text)) text.forEach((t, i) => { if (i) cell.append(el('br')); cell.append(t); }); else cell.append(text);
        if (key === sortKey) cell.append(dir > 0 ? ' ▲' : ' ▼');
        if (key) {
          cell.title = 'Sort';
          cell.addEventListener('click', () => { city.sort = [key, key === sortKey ? -dir : 1]; render(); });
        }
        return cell;
      };
      const hotelHead = th('Hotel', 'name', 'hryv-hotel');
      hotelHead.prepend(allBox, ' ');
      head.append(hotelHead, th('Cat.', 'cat'), th('Best', 'best'),
        ...dates.map(d => th([WEEKDAYS[weekdayMon0(d)], `${d.slice(5, 7)}/${d.slice(8)}`], d)));
      table.append(head);
      for (const r of rows) {
        const tr = el('tr', r.on ? '' : 'hryv-off');
        tr.dataset.hotel = r.s;
        const hotelCell = el('td', 'hryv-hotel'), wrap = el('label');
        const box = el('input'); box.type = 'checkbox'; box.checked = r.on; box.disabled = running;
        box.setAttribute('aria-label', 'Include ' + r.h[1]);
        box.addEventListener('change', () => { if (box.checked) city.off.delete(r.s); else city.off.add(r.s); saveArea(); render(); });
        const text = el('span'), name = el('button', 'hryv-hname', r.h[1]);
        name.type = 'button'; name.disabled = running; name.title = 'Open this hotel’s calendar for these dates';
        name.addEventListener('click', e => { e.preventDefault(); openHotel(r.s); });
        text.append(name, el('span', 'hryv-hsub', [r.s, r.h[5], showKm && r.km != null ? r.km.toFixed(1) + ' km' : '', r.cur].filter(Boolean).join(' · ')));
        wrap.append(box, text); hotelCell.append(wrap);
        const best = el('td', 'hryv-num');
        if (r.best) {
          best.append(el('b', null, view === 'cash' ? money(r.best[0]) : exact(r.best[0])));
          best.append(el('span', 'hryv-hsub', `${r.best[1].slice(5, 7)}/${r.best[1].slice(8)}`));
        }
        tr.append(hotelCell, el('td', 'hryv-num', r.h[6] || ''), best);
        r.cells.forEach((x, i) => {
          const td = el('td', ['hryv-c', ...(x.cls || [])].join(' '));
          td.dataset.date = dates[i];
          td.append(el('b', null, x.text));
          if (x.sub) td.append(el('small', null, x.sub));
          if (x.style) Object.assign(td.style, x.style);
          if (r.on && x.value != null && lowest[i].get(view === 'cash' ? r.cur : '') === x.value) td.classList.add('hryv-best');
          td.title = x.title;
          if (x.href) {
            td.classList.add('hryv-link');
            td.addEventListener('click', () => window.open(x.href, '_blank'));
          }
          tr.append(td);
        });
        table.append(tr);
      }
      cityWrap.append(table);

      const sel = rows.filter(r => r.on);
      let checked = 0, stale = 0;
      for (const r of sel) for (const d of dates) {
        const rec = city.caches[r.s]?.days[d];
        if (rec) { checked++; if (!isFresh(rec)) stale++; }
      }
      const first = el('div');
      first.append(el('b', null, placeText(city.place)),
        ` · ${count(sel.length, 'hotel')} selected of ${rows.length} · ${checked}/${sel.length * dates.length} hotel-dates checked` +
        (stale ? ` (${stale} over 6 hours ago)` : '') + '.');
      citySummary.append(first);
      // The lowest value in the grid, in the most common currency for cash rates.
      const currencies = sel.map(r => r.cur).filter(Boolean);
      const mainCur = currencies.sort((a, b) => currencies.filter(x => x === b).length - currencies.filter(x => x === a).length)[0] || '';
      let low = null;
      for (const r of sel) if (r.best && (view !== 'cash' || r.cur === mainCur) && (!low || r.best[0] < low.r.best[0])) low = { r };
      if (low) {
        const [v, d] = low.r.best, when = `${d.slice(5)} (${WEEKDAYS[weekdayMon0(d)]})`;
        citySummary.append(el('div', 'hryv-dates', view === 'cash' ? `Lowest rate: ${low.r.h[1]} · ${mainCur} ${exact(v)} on ${when}.`
          : view === 'sua' ? `Lowest standard suite with a Suite Upgrade Award: ${low.r.h[1]} · ${exact(v)} points on ${when}.`
            : `Lowest available award: ${low.r.h[1]} · ${exact(v)} points on ${when}.`));
      }
      if (city.truncated) citySummary.append(el('div', 'hryv-dates', `Showing the first ${CITY_MAX_HOTELS} hotels; ${city.truncated} more are not included. Choose a smaller area.`));
      if (!running) {
        const ptsNeeded = sel.filter(r => !ptsCovers(cityPoints(r.s, c), c)).length;
        let cashNeeded = 0;
        for (const r of sel) for (const d of dates) if (!isFresh(city.caches[r.s]?.days[d])) cashNeeded++;
        citySummary.append(el('div', 'hryv-dates', !sel.length ? 'Select at least one hotel to scan.'
          : cashNeeded + ptsNeeded ? `Start scan checks ${count(cashNeeded, 'hotel-date')} and ${count(ptsNeeded, 'points calendar')}: about ${count(cashNeeded + 2 * ptsNeeded, 'request')}.`
            : 'All selected hotels and dates are cached.'));
      }
    }

    function openHotel(spirit) {
      if (state.running) return;
      setDays('hotel', cfg().n);
      inSpirit.value = spirit;
      setMode('cash');
      inSpirit.dispatchEvent(new Event('change'));
    }

    // The city scan: points calendars first, then each date for every selected hotel, nearest date first.
    function cityJob() {
      const c = cfg();
      const selected = () => city.rows.map(r => r.h[0]).filter(s => !city.off.has(s));
      let spirits = selected();
      const id = t => `${t.kind}|${t.spirit}|${t.date}`;
      const keyOf = s => cacheKey(s, c.adults, c.los);
      const pointsReady = s => ptsCovers(cityPoints(s, c), c);
      const label = city.place ? placeText(city.place) : '';
      const p = city.place;
      const area = p && p.type !== 'list' ? { type: p.type, key: p.key, label: p.label, codes: p.codes, radius: Number(selNear.value) } : null;
      async function saveAll() {
        const results = await Promise.all([...city.dirty].map(s => saveCacheNow(keyOf(s), city.caches[s])));
        return { local: results.every(r => r.local), disk: results.every(r => r.disk) };
      }
      return {
        c, city: true, word: 'check', lockable: [inPlace, selNear, inDays],
        problem: !city.rows.length ? 'Choose a city or area first.' : !spirits.length ? 'Select at least one hotel.' : '',
        done: 'Done. All selected hotels and dates are cached.',
        settings: () => ({ mode: 'city', spirits, place: label, area, start: c.start, n: c.n, los: c.los, adults: c.adults, conc: c.conc,
          interval: c.interval, autoRecover: inAuto.checked, lang: state.lang, recoveryFailures: state.recoveryFailures, view: city.view }),
        async prepare(auto) {
          // A manual start waits for the hotel list, so names and nearby hotels are complete; a resume scans the saved hotels.
          const radius = city.place?.type === 'list' ? 0 : Number(selNear.value);
          if (!auto && !cachedHotels(radius > 0)) {
            try { await ensureHotels(radius > 0); } catch (e) { /* scan the hotels already shown */ }
            buildRows(false);
            spirits = selected();
          }
          await loadCityData();
          const tasks = spirits.filter(s => !pointsReady(s)).map(s => ({ kind: 'points', spirit: s, date: c.start }));
          for (const date of datesOf(c)) for (const s of spirits) if (!isFresh(city.caches[s]?.days[date])) tasks.push({ kind: 'cash', spirit: s, date });
          return tasks;
        },
        needs: t => (t.kind === 'points' ? !pointsReady(t.spirit) : !isFresh(city.caches[t.spirit]?.days[t.date])),
        failed: t => !!city.errors[id(t)],
        accept(t, res) {
          delete city.errors[id(t)];
          if (t.kind === 'points') {
            const key = ptsKeyOf(t.spirit, c.adults), old = city.pts[t.spirit];
            if (validRoomProof(old?.standardRoomProof)) res.standardRoomProof = old.standardRoomProof;
            city.pts[t.spirit] = res;
            // A fresh, longer calendar (e.g. a year from the collector) stays saved; the grid uses this one.
            const span = P => fromISO(P.end) - fromISO(P.start);
            const keepOld = old && old.adults === c.adults && Date.now() >= old.ts && Date.now() - old.ts < ptsTTL(old) &&
              !(res.start <= old.start && res.end >= old.end) && span(old) > span(res);
            if (!keepOld) { kv.set(key, res); remotePut(key, res); }
            return;
          }
          const cache = city.caches[t.spirit] ||= loadCache(keyOf(t.spirit));
          cache.days[t.date] = { ts: Date.now(), r: res.rooms };
          Object.assign(cache.titles, res.titles);
          if (res.currency) cache.currency = res.currency;
          city.dirty.add(t.spirit);
          kv.set(keyOf(t.spirit), cache);
        },
        fail(t, err) { city.errors[id(t)] = err; },
        persist() { for (const s of city.dirty) saveCache(keyOf(s), city.caches[s]); },
        save: saveAll,
        saveLocal() { for (const s of city.dirty) kv.set(keyOf(s), city.caches[s]); },
        finish: saveAll,
      };
    }

    function exportCityCSV() {
      const c = cfg(), dates = datesOf(c);
      const rows = [['hotel_code', 'hotel_name', 'city', 'award_category', 'date', 'weekday', 'room_code', 'room_name', 'rooms_left', 'lowest_rate', 'currency',
        'is_standard_suite', 'room_category', 'std_room_points', 'std_room_points_tier', 'std_room_award_available', 'checked_at']];
      for (const { h } of city.rows) {
        const cache = city.caches[h[0]], P = cityPoints(h[0], c);
        if (city.off.has(h[0]) || !cache) continue;
        for (const d of dates) {
          const rec = cache.days[d];
          if (!rec) continue;
          const std = P && ptsHasDate(P, d) ? P.prices.STANDARD_ROOM?.[d] : null;
          const base = [h[0], h[1], h[2], h[6], d, WEEKDAYS[weekdayMon0(d)]];
          const tail = [std && std[1] != null ? std[1] : '', std ? TIER_MAP[std[0]]?.name || std[0] : '',
            std ? (P.avail.STANDARD_ROOM?.[d] ? 1 : 0) : '', new Date(rec.ts).toISOString()];
          const codes = Object.keys(rec.r).sort();
          if (!codes.length) rows.push([...base, '', '', 0, '', cache.currency, '', '', ...tail]);
          for (const code of codes) {
            const v = rec.r[code];
            rows.push([...base, code, cache.titles[code] || code, v[0], v[1] ?? '', cache.currency, v.length >= 3 ? v[2] : '', v[3] || '', ...tail]);
          }
        }
      }
      const area = (city.place ? placeText(city.place) : 'city').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'city';
      downloadCSV(rows, `hyatt_city_${area}_${c.start}_${c.n}d_${c.los}n_${c.adults}a.csv`);
    }

    // Hotel settings load the hotel's points calendar; the City tab reloads the area's data instead.
    [inSpirit, selAdults].forEach(e => e.addEventListener('change', () => {
      state.pts = null; state.ptsErr = ''; refreshCatOptions();
      render();
      if (state.mode !== 'city' && cfg().spirit) loadPoints(false);
    }));
    inDays.addEventListener('change', () => { if (state.mode !== 'city' && cfg().spirit) loadPoints(false); });
    inStart.addEventListener('change', () => { if (state.mode !== 'city' && cfg().spirit) loadPoints(false); });
    [inSpirit, selLos, selAdults].forEach(e => e.addEventListener('change', reloadCache));
    [selLos, selAdults].forEach(e => e.addEventListener('change', () => { if (state.mode === 'city') loadCityData(); }));
    [inStart, inDays].forEach(e => e.addEventListener('change', render));
    selNear.addEventListener('change', () => { buildRows(); saveArea(); loadCityData(); });
    selView.addEventListener('change', () => { city.view = selView.value; render(); });
    const hide = () => { overlay.style.display = 'none'; };
    x.addEventListener('click', hide);
    overlay.addEventListener('click', e => { if (e.target === overlay) hide(); });

    reloadCache();
    syncFindName();
    if (!prefill && cfg().spirit) loadPoints(false);

    restoreUI = p => {
      if (state.running || state.starting) return;
      applyPrefill(p);
      syncFindName();
      state.pts = null;
      reloadCache();
      setMode(p.mode === 'city' ? 'city' : 'cash');
      startScan({ auto: true });
    };
    window.addEventListener('pagehide', () => {
      if (!state.running || state.ctrl.signal.aborted) return;
      state.reloading = true;
      state.job.saveLocal();
      kv.set(RESUME_KEY, { ...state.job.settings(), ts: Date.now() });
      state.ctrl.abort();
      if (pointsCtrl) pointsCtrl.abort();
    });
    if (prefill?.mode === 'city') setMode('city');
    if (prefill) startScan({ auto: true });
  }

  async function init() {
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const fab = el('button', 'hryv-fab', 'Room calendar');
    fab.title = 'Check room availability by date';
    fab.addEventListener('click', () => openUI());
    document.body.appendChild(fab);
    if (platform) platform.onOpen(() => openUI());
    migrateFromLocalStorage();
    let resume = readResume();
    if (!resume) resume = await readResumeRemote();
    // A paused scan resumes in one of your tabs, never in the background collector's pinned tab.
    if (resume && platform && await platform.isCollectorTab()) resume = null;
    if (resume) openUI(resume);
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
