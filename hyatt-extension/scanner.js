// ==UserScript==
// @name         Hyatt Room Calendar
// @namespace    hyatt-room-year
// @version      0.14.0
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
  function remoteWrite(method, key, val) {
    const snapshot = val === undefined ? undefined : JSON.parse(JSON.stringify(val));
    const next = (remoteWrites.get(key) || Promise.resolve()).then(async () => {
      if (!(await remoteCheck())) return false;
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
  function validResume(r) {
    return r && /^[a-z0-9]{5}$/.test(r.spirit) && /^\d{4}-\d{2}-\d{2}$/.test(r.start) &&
      Number.isFinite(r.ts) && Date.now() - r.ts >= 0 && Date.now() - r.ts < RESUME_TTL_MS &&
      Number.isInteger(r.n) && r.n >= 1 && r.n <= 400 &&
      Number.isInteger(r.los) && r.los >= 1 && r.los <= 7 &&
      Number.isInteger(r.adults) && r.adults >= 1 && r.adults <= 4;
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
  async function scan({ dates, spirit, los, adults, concurrency, interval, signal, onDay }) {
    let idx = 0;
    let conc = concurrency;
    let pauseUntil = 0;
    let blockedStreak = 0;
    let blocked = false;
    const isBlock = e => e.status === 0 || e.status === 403 || e.status === 429;
    async function worker(id) {
      while (!signal.aborted && !blocked) {
        if (id >= conc) { if (idx >= dates.length) return; await sleepAbortable(500, signal); continue; }
        const i = idx++;
        if (i >= dates.length) return;
        const d = dates[i];
        for (let attempt = 1; !signal.aborted && !blocked; attempt++) {
          const wait = pauseUntil - Date.now();
          if (wait > 0) await sleepAbortable(wait, signal);
          if (blocked || signal.aborted) return;
          const t0 = performance.now();
          try {
            const res = await fetchDay(spirit, d, los, adults, signal);
            blockedStreak = 0;
            await onDay(d, res, null, performance.now() - t0);
            break;
          } catch (e) {
            if (signal.aborted) return;
            if (isBlock(e) && ++blockedStreak >= BLOCK_LIMIT) { blocked = true; return; }
            if (isBlock(e) || e.status >= 500) {
              pauseUntil = Date.now() + 5000 * attempt;
              conc = 1;
            }
            if (attempt >= 3 && !isBlock(e)) { await onDay(d, null, e.message || String(e), performance.now() - t0); break; }
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
    Date.now() >= p.ts && Date.now() - p.ts < PTS_TTL_MS;
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
  // Entries: [code, name, city, province, country, brand, award category, English URL slug].
  const HOTELS_TTL_MS = 7 * 24 * 3600 * 1000;
  const HOTELS_RETRY_MS = 60000;
  const hotelsKey = lang => `${CACHE_PREFIX}hotels|${lang}`;
  const validHotels = (h, lang) => h && h.lang === lang && Array.isArray(h.list) && h.list.length > 0 &&
    Number.isFinite(h.ts) && Date.now() >= h.ts && Date.now() - h.ts < HOTELS_TTL_MS;
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
      const loc = o.location || {};
      list.push([o.spiritCode, String(o.name || o.spiritCode), loc.city || '', loc.stateProvince?.label || '',
        loc.country?.label || '', o.brand?.label || '', o.awardCategory?.key || '',
        String(o.url || '').split('/').pop().replace(/^[a-z0-9]{5}-/, '').replace(/-/g, ' ')]);
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
  .hryv-suggest{position:absolute;left:0;top:100%;z-index:2;margin-top:3px;width:340px;max-width:80vw;max-height:300px;overflow-y:auto;
    background:#fff;border:1px solid #ccc;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.18)}
  .hryv-suggest[hidden]{display:none}
  .hryv-suggest-item{display:flex;flex-direction:column;gap:1px;padding:6px 9px;cursor:pointer}
  .hryv-suggest-item b{font-weight:600;color:#222}
  .hryv-suggest-item span{font-size:11px;color:#666}
  .hryv-suggest-item.on,.hryv-suggest-item:hover{background:#e3ecf7}
  .hryv-suggest-msg{padding:6px 9px;font-size:12px;color:#666}
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
  .hryv-summary{margin:12px 0 6px;font-size:13px}
  .hryv-summary .hryv-dates{color:#555;font-size:12px;margin-top:4px;word-break:break-all}
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
    tabs.append(tabCash, tabPts);
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
    function applyPrefill(p) {
      inSpirit.value = p.spirit; inStart.value = p.start; inDays.value = p.n;
      selLos.value = String(p.los); selAdults.value = String(p.adults);
      selConc.value = String(Math.max(1, Math.min(6, Number(p.conc) || 3)));
      inInterval.value = Number(p.interval) || 0;
      inAuto.checked = p.autoRecover !== false;
      state.lang = p.lang || det.lang;
      state.room = p.room || ''; selRoom.innerHTML = '';
      state.recoveryFailures = Math.max(0, Math.min(AUTO_RECOVERY_LIMIT, Number(p.recoveryFailures) || 0));
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
    const lbConc = labelled('Parallel requests', selConc), lbInterval = labelled('Delay (sec)', inInterval);
    const lbAuto = labelled('Auto-resume', inAuto);
    lbAuto.title = 'Clear Hyatt cookies and reload if requests are blocked.';
    const selCat = select(PTS_CATS, 'STANDARD_ROOM');
    const lbCat = labelled('Award type', selCat);
    const btnPts = el('button', 'hryv-btn', 'Load rates');
    const btnPtsReload = el('button', 'hryv-btn secondary', 'Refresh rates');
    controls.append(
      lbFind, labelled('Hotel code', inSpirit), lbRoom, lbCat, labelled('Start date', inStart),
      labelled('Days', inDays), lbLos, labelled('Adults', selAdults),
      lbConc, lbInterval, lbAuto, btnScan, btnStop, btnCsv, btnClear, btnPts, btnPtsReload, btnBackup
    );
    if (btnSettings) controls.append(btnSettings);
    const cashOnly = [lbRoom, lbLos, lbConc, lbInterval, lbAuto, btnScan, btnStop, btnCsv, btnClear];
    const ptsOnly = [lbCat, btnPts, btnPtsReload];
    ptsOnly.forEach(e => { e.style.display = 'none'; });

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
    [['', '3', 'Available'], ['hryv-empty', '0', 'Sold out'],
      ['hryv-pending', '·', 'Not checked'], ['hryv-err', '!', 'Request failed']].forEach(([cls, value, text]) => {
      const item = el('span'), sw = el('span', 'hryv-cell hryv-stock-key');
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
      'Results are cached for 6 hours; scans only check missing or expired dates. ' +
      'Background colors show standard room points tiers for the arrival night, not award availability. ' +
      '◆ marks a room found with a standard room award; ★ marks a standard suite. Unconfirmed rooms may still qualify for standard room awards.';
    const NOTE_PTS = 'Points rates and award availability are separate. Availability is checked for one-night stays. ' +
      'Click an available date to open Hyatt’s booking page. Results are cached for 6 hours; use Refresh rates to check again.';
    const note = el('div', 'hryv-note', NOTE_CASH);

    modal.append(head, controls, prog, status, ptsStatus, storeInfo, helperInfo, resumeBar, legend, cashTierLegend, ptsLegend, calendar, summary, tableWrap, note);
    document.body.appendChild(overlay);

    const cfg = () => ({
      spirit: inSpirit.value.trim().toLowerCase(),
      start: inStart.value || todayLocal(),
      n: Math.max(1, Math.min(400, parseInt(inDays.value, 10) || 365)),
      los: parseInt(selLos.value, 10),
      adults: parseInt(selAdults.value, 10),
      conc: parseInt(selConc.value, 10),
      interval: Math.max(0, Math.min(60, parseFloat(inInterval.value) || 0)),
      autoRecover: inAuto.checked,
    });
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
          Date.now() - x.ts < PTS_TTL_MS && x.start <= c.start && x.end >= end;
        let cached = kv.get(key);
        if (!force && !usable(cached)) cached = (await remoteGet(key)) || cached;
        if (!current()) return;
        if (!force && usable(cached)) {
          state.pts = { ...cached, spirit: c.spirit }; state.ptsErr = '';
          ptsStatus.textContent = 'Using cached points rates. Select Refresh rates to update.';
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
          : '';
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
      state.mode = m;
      tabCash.classList.toggle('on', m === 'cash');
      tabPts.classList.toggle('on', m === 'pts');
      const cash = m === 'cash';
      cashOnly.forEach(e => { e.style.display = cash ? '' : 'none'; });
      ptsOnly.forEach(e => { e.style.display = cash ? 'none' : ''; });
      [prog, status, storeInfo, helperInfo, legend, cashTierLegend].forEach(e => { e.style.display = cash ? '' : 'none'; });
      ptsLegend.style.display = cash ? 'none' : '';
      note.textContent = cash ? NOTE_CASH : NOTE_PTS;
      resumeBar.style.display = cash && state.cooldownMsg ? 'flex' : 'none';
      render();
      if (!cash && !state.pts && cfg().spirit) loadPoints(false);
    }

    function stdPoints(d) {
      const P = state.pts, c = cfg();
      const valid = P && P.spirit === c.spirit && P.adults === c.adults && Date.now() - P.ts < PTS_TTL_MS && d >= P.start && d <= P.end;
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
      let scanned = 0;
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
        if (!isFresh(rec)) {
          if (state.errors[d]) { stock.classList.add('hryv-err'); qtyLabel.textContent = '!'; cell.title = `${d} (${wd})\nRequest failed: ${state.errors[d]}`; }
          else { stock.classList.add('hryv-pending'); cell.title = `${d} (${wd})\nNot checked`; }
        } else {
          scanned++;
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
        summary.textContent = `${scanned}/${dates.length} dates checked. Select a room after scanning.`;
      } else {
        const info = stdSuiteInfo();
        const isStdSuite = info.set.has(room);
        const name = (state.cache.titles[room] ? `${room} · ${state.cache.titles[room]}` : room) + roomTag(room, info);
        const line = el('div');
        line.append(el('b', null, name), ` · ${scanned}/${dates.length} dates checked; ${count(avail.length, 'date')} available.`);
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
        if (!isFresh(rec)) return;
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
      status.textContent = `${state.running ? 'Scanning' : 'Done'}: ${state.done}/${state.total} dates` +
        (state.failed ? ` · ${state.failed} failed` : '') +
        (state.running ? ` · ${state.interval}s delay` : '') + eta + '.';
    }

    async function cooldown(c, probeDate, signal, onDay) {
      for (let k = 1; k <= COOLDOWN_TRIES; k++) {
        const at = new Date(Date.now() + COOLDOWN_MIN * 60000);
        resumeBar.style.display = 'flex';
        state.cooldownMsg = `Paused: Hyatt is blocking requests. ${count(state.done, 'date')} completed. ` +
          (state.recoveryError ? state.recoveryError + ' ' : '') +
          `Retry ${k}/${COOLDOWN_TRIES} at ${pad(at.getHours())}:${pad(at.getMinutes())}. ` +
          `Use the steps below to reset manually, or click Stop to cancel.`;
        setStatus();
        await sleepAbortable(COOLDOWN_MIN * 60000, signal);
        if (signal.aborted) return false;
        const t0 = performance.now();
        try {
          const res = await fetchDay(c.spirit, probeDate, c.los, c.adults, signal);
          await onDay(probeDate, res, null, performance.now() - t0);
          state.cooldownMsg = '';
          resumeBar.style.display = 'none';
          return true;
        } catch (e) {
          if (signal.aborted) return false;
        }
      }
      state.cooldownMsg = `Stopped: requests are still blocked after ${count(COOLDOWN_MIN * COOLDOWN_TRIES / 60, 'hour')}. ` +
        `Try Start scan later to check the remaining dates.`;
      return false;
    }

    const resumeSettings = () => ({
      ...cfg(), room: selRoom.value || state.room, lang: state.lang, recoveryFailures: state.recoveryFailures,
    });

    async function reloadAndResume(resetCookies, signal) {
      if (signal && signal.aborted) return false;
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
      const saved = await saveCacheNow(state.cacheKeyStr, state.cache);
      if (signal && signal.aborted) return false;
      const resumeSaved = await writeResume(resumeSettings());
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
        if (navigator.locks) {
          await navigator.locks.request('hryv:scan', { ifAvailable: true }, async lock => {
            if (!lock) { status.textContent = 'A scan is running in another Hyatt tab.'; return; }
            await runScan(!!options.auto);
          });
        } else await runScan(!!options.auto);
      } finally { state.starting = false; }
    }

    async function runScan(auto) {
      const c = cfg();
      if (!/^[a-z0-9]{5}$/.test(c.spirit)) { status.textContent = 'Find a hotel or enter a five-character hotel code.'; return; }
      const lockable = [inFind, inSpirit, inStart, inDays, selLos, selAdults, selConc, inInterval, inAuto];
      closeFind();
      Object.assign(state, {
        running: true, reloading: false, keepResume: false, ctrl: new AbortController(), done: 0, failed: 0, total: 0, tSum: 0,
        interval: c.interval, conc: c.conc, cooldownMsg: '', recoveryError: '',
      });
      if (!auto) state.recoveryFailures = 0;
      const signal = state.ctrl.signal;
      resumeBar.style.display = 'none';
      btnScan.disabled = true; btnStop.disabled = false;
      lockable.forEach(e => { e.disabled = true; });
      try {
        await writeResume(resumeSettings());
        if (signal.aborted) return;
        if (auto) {
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
          if (signal.aborted) return;
        }
        await reloadCache();
        if (signal.aborted) return;
        if (auto) loadPoints(false, true);
        const todo = datesOf(c).filter(d => !isFresh(state.cache.days[d]));
        const needsQuery = d => !isFresh(state.cache.days[d]);
        state.total = todo.length; state.cooldownMsg = '';
        setStatus();
        if (!todo.length) state.cooldownMsg = 'Done. All selected dates are cached.';
        let sinceSave = 0;
        const onDay = async (d, res, err, ms) => {
          if (signal.aborted) return;
          if (res) {
            state.cache.days[d] = { ts: Date.now(), r: res.rooms };
            for (const [code, title] of Object.entries(res.titles)) {
              state.cache.titles[code] = title;
            }
            if (res.currency) state.cache.currency = res.currency;
            delete state.errors[d];
            state.done++; state.tSum += ms;
            state.recoveryFailures = 0;
            refreshRoomOptions();
            kv.set(state.cacheKeyStr, state.cache);
            kv.set(RESUME_KEY, { ...resumeSettings(), ts: Date.now() });
            if (++sinceSave >= 10) {
              saveCache(state.cacheKeyStr, state.cache); writeResume(resumeSettings()); sinceSave = 0;
            }
            await kv.flush();
            if (platform) showStoreInfo();
          } else { state.errors[d] = err; state.failed++; }
          setStatus(); scheduleRender();
        };

        while (!signal.aborted) {
          const remaining = todo.filter(d => needsQuery(d) && !state.errors[d]);
          if (!remaining.length) break;
          const outcome = await scan({
            dates: remaining, spirit: c.spirit, los: c.los, adults: c.adults,
            concurrency: c.conc, interval: state.interval, signal, onDay,
          });
          if (outcome !== 'blocked' || signal.aborted) break;
          await saveCacheNow(state.cacheKeyStr, state.cache);
          if (signal.aborted) break;
          await writeResume(resumeSettings());
          if (signal.aborted) break;
          if (await reloadAndResume(true, signal)) return;
          if (signal.aborted) break;
          const next = todo.find(d => needsQuery(d) && !state.errors[d]);
          if (!next || !(await cooldown(c, next, signal, onDay))) break;
        }
      } catch (e) {
        if (!signal.aborted) state.cooldownMsg = 'Scan stopped: ' + (e.message || String(e));
      } finally {
        if (!state.reloading) {
          if (state.cacheKeyStr && state.cache) await saveCacheNow(state.cacheKeyStr, state.cache);
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
      const rows = [['date', 'weekday', 'room_code', 'room_name', 'rooms_left', 'lowest_rate', 'currency', 'is_standard_suite', 'std_room_points', 'std_room_points_tier', 'room_category', 'is_standard_room', 'standard_room_evidence_date']];
      datesOf(c).forEach(d => {
        const rec = state.cache.days[d];
        if (!isFresh(rec)) return;
        codes.forEach(code => {
          const v = rec.r[code];
          const sp = stdPoints(d);
          rows.push([d, WEEKDAYS[weekdayMon0(d)], code, titles[code], v ? v[0] : 0, v && v[1] != null ? v[1] : '', state.cache.currency,
            v && v.length >= 3 ? v[2] : '', sp && sp.pts != null ? sp.pts : '', sp ? sp.name : '',
            v && v[3] || '', info.standardRooms.has(code) ? 1 : info.set.has(code) ? 0 : '',
            info.standardRooms.has(code) ? info.proof.rooms[code].date : '']);
        });
      });
      const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `hyatt_${c.spirit}_${c.start}_${c.n}d_${c.los}n_${c.adults}a.csv`;
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
    btnCsv.addEventListener('click', exportCSV);
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
    btnPts.addEventListener('click', () => loadPoints(false));
    btnPtsReload.addEventListener('click', () => loadPoints(true));

    // Find hotel: the catalog is fetched on first search, and choosing a result fills Hotel code.
    let hotels = null, hotelIndex = [], hotelsLoading = null, hotelsFailedAt = 0, hotelsError = '';
    let findResults = [], findActive = -1, findTimer = 0;
    const hotelLang = () => (/^[a-z]{2}-[A-Z]{2}$/.test(state.lang) ? state.lang : 'en-US');
    const hotelDetail = h => [h[0], [h[2], h[4]].filter(Boolean).join(', '), h[6] && 'Category ' + h[6]].filter(Boolean).join(' · ');
    function useHotels(h) { hotels = h; hotelIndex = indexHotels(h.list); }
    function cachedHotels() {
      const lang = hotelLang();
      if (!validHotels(hotels, lang)) {
        const saved = kv.get(hotelsKey(lang));
        if (validHotels(saved, lang)) useHotels(saved);
      }
      return validHotels(hotels, lang);
    }
    function ensureHotels() {
      if (cachedHotels()) return Promise.resolve();
      if (hotelsLoading) return hotelsLoading;
      if (Date.now() - hotelsFailedAt < HOTELS_RETRY_MS) return Promise.reject(new Error(hotelsError));
      showFind([], 'Loading Hyatt’s hotel list…');
      hotelsLoading = fetchHotels(hotelLang()).then(h => { useHotels(h); kv.set(hotelsKey(h.lang), h); }, e => {
        hotelsFailedAt = Date.now(); hotelsError = e.message; throw e;
      }).finally(() => { hotelsLoading = null; });
      return hotelsLoading;
    }
    function highlightFind() {
      findList.querySelectorAll('.hryv-suggest-item').forEach((o, i) => {
        o.classList.toggle('on', i === findActive); o.setAttribute('aria-selected', String(i === findActive));
        if (i === findActive) o.scrollIntoView({ block: 'nearest' });
      });
      if (findActive >= 0) inFind.setAttribute('aria-activedescendant', 'hryv-opt-' + findActive);
      else inFind.removeAttribute('aria-activedescendant');
    }
    function showFind(results, message) {
      findResults = results; findActive = results.length ? 0 : -1;
      findList.replaceChildren();
      if (message) findList.append(el('div', 'hryv-suggest-msg', message));
      results.forEach((h, i) => {
        const opt = el('div', 'hryv-suggest-item'); opt.id = 'hryv-opt-' + i; opt.setAttribute('role', 'option');
        opt.append(el('b', null, h[1]), el('span', null, hotelDetail(h)));
        opt.addEventListener('click', () => pickHotel(h));
        findList.append(opt);
      });
      highlightFind();
      findList.hidden = !message && !results.length;
      inFind.setAttribute('aria-expanded', String(!findList.hidden));
    }
    function closeFind() {
      clearTimeout(findTimer);
      findList.hidden = true; inFind.setAttribute('aria-expanded', 'false'); inFind.removeAttribute('aria-activedescendant');
    }
    function syncFindName() {
      const code = inSpirit.value.trim().toLowerCase();
      const h = cachedHotels() ? hotels.list.find(x => x[0] === code) : null;
      inFind.value = h ? h[1] : '';
      inFind.title = h ? hotelDetail(h) : '';
    }
    function pickHotel(h) {
      closeFind();
      inFind.value = h[1]; inFind.title = hotelDetail(h);
      if (inSpirit.value.trim().toLowerCase() === h[0]) return;
      inSpirit.value = h[0];
      inSpirit.dispatchEvent(new Event('change'));
    }
    async function updateFind() {
      const q = inFind.value.trim();
      if (!q || inFind.disabled) { closeFind(); return; }
      let error = '';
      try { await ensureHotels(); } catch (e) { error = e.message; }
      // A newer keystroke has its own lookup; a blurred or locked box shows nothing.
      if (inFind.value.trim() !== q) return;
      if (document.activeElement !== inFind || inFind.disabled) { closeFind(); return; }
      if (error) { showFind([], `Hotel list unavailable (${error}). Enter the five-character code instead.`); return; }
      const results = searchHotels(hotelIndex, q);
      showFind(results, results.length ? '' : 'No matching hotel.');
    }
    inFind.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(updateFind, 150); });
    inFind.addEventListener('focus', () => inFind.select());
    inFind.addEventListener('blur', closeFind);
    // Keep focus in the input while a result is clicked or the list is scrolled.
    findList.addEventListener('mousedown', e => e.preventDefault());
    inFind.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!findResults.length || findList.hidden) return;
        e.preventDefault();
        findActive = (findActive + (e.key === 'ArrowDown' ? 1 : -1) + findResults.length) % findResults.length;
        highlightFind();
      } else if (e.key === 'Enter' && !findList.hidden && findResults[findActive]) {
        e.preventDefault(); pickHotel(findResults[findActive]);
      } else if (e.key === 'Escape' && !findList.hidden) {
        e.preventDefault(); closeFind();
      }
    });
    inSpirit.addEventListener('change', syncFindName);

    [inSpirit, selAdults].forEach(e => e.addEventListener('change', () => {
      state.pts = null; state.ptsErr = ''; refreshCatOptions();
      render();
      if (cfg().spirit) loadPoints(false);
    }));
    inDays.addEventListener('change', () => { if (cfg().spirit) loadPoints(false); });
    inStart.addEventListener('change', () => { if (cfg().spirit) loadPoints(false); });
    [inSpirit, selLos, selAdults].forEach(e => e.addEventListener('change', reloadCache));
    [inStart, inDays].forEach(e => e.addEventListener('change', render));
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
      setMode('cash');
      startScan({ auto: true });
    };
    window.addEventListener('pagehide', () => {
      if (!state.running || state.ctrl.signal.aborted) return;
      state.reloading = true;
      if (state.cacheKeyStr && state.cache) kv.set(state.cacheKeyStr, state.cache);
      kv.set(RESUME_KEY, { ...resumeSettings(), ts: Date.now() });
      state.ctrl.abort();
      if (pointsCtrl) pointsCtrl.abort();
    });
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
    if (resume) openUI(resume);
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
