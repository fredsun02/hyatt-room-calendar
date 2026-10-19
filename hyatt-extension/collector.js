// Background collection in your own Chrome. Runs only in the pinned tab opened by collector-host.js and
// mirrors the scheduler in collector/collector.py: missing points calendars first, then missing cash dates
// (nearest first), then whatever is most overdue for its refresh interval. Requests go through
// collector-page.js (hryvCollector), results to hryv-store through the background. A block backs off;
// cookies are never cleared, because this is your own browser session.
(async () => {
  if (window !== window.top || globalThis.__hryvCollectorRunning) return;
  const hello = await chrome.runtime.sendMessage({ type: 'HRYV_COLLECTOR', action: 'hello' }).catch(() => null);
  if (!hello?.active) return;
  globalThis.__hryvCollectorRunning = true;

  const S = hello.settings;
  const C = globalThis.hryvCollector;
  const HOUR = 3600000, DAY = 24 * HOUR;
  const POINTS_EVERY = 24 * HOUR;
  const TIERS = [[30, 24 * HOUR], [120, 72 * HOUR], [Infinity, 168 * HOUR]];
  const CATALOG_EVERY = 7 * DAY, VISIT_EVERY = 45 * 60000, FLUSH_EVERY = 60000;
  const TASK_RETRY = HOUR, POISON_RETRY = 6 * HOUR, KEEP_PAST_DAYS = 30;
  const BACKOFF_FIRST = 5 * 60000, BACKOFF_MAX = 2 * HOUR, ERRORS_BEFORE_PAUSE = 5;
  const STATE = 'collector:state', SCHEDULE = 'collector:schedule', STATUS = 'collector:status', HEARTBEAT = 'collector:heartbeat';
  const interval = Math.max(1, Number(S.interval) || 5) * 1000;
  const horizon = Math.max(1, Math.min(400, Number(S.horizon) || 365));
  const countries = new Set((S.countries || []).map(c => String(c).toUpperCase()));
  const extra = new Set((S.hotels || []).map(c => String(c).toLowerCase()));
  const cashKey = code => `hryv:${code}|${S.adults}|${S.nights}`;
  const pointsKey = code => `hryv:pts|${code}|${S.adults}`;
  const pad = n => String(n).padStart(2, '0');
  // Calendar arithmetic on local noon, so a daylight-saving change never skips or repeats a date.
  const localDay = offset => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  let running = true, restart = false, lastBeat = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('collector:settings' in changes)) return;
    // Turning collection off stops it; other changes take effect after saving and reloading this tab.
    running = false;
    restart = !!changes['collector:settings'].newValue?.enabled;
  });
  const heartbeat = () => {
    if (Date.now() - lastBeat < 60000) return;
    lastBeat = Date.now();
    chrome.storage.local.set({ [HEARTBEAT]: lastBeat });
  };
  // Hidden tabs throttle timers; the background's timer is not throttled.
  const tick = ms => chrome.runtime.sendMessage({ type: 'HRYV_COLLECTOR', action: 'sleep', ms })
    .catch(() => new Promise(resolve => setTimeout(resolve, ms)));
  async function sleep(ms) {
    const end = Date.now() + ms;
    while (running && Date.now() < end) { heartbeat(); await tick(Math.min(240000, end - Date.now())); }
  }
  async function store(method, key, body) {
    const r = await chrome.runtime.sendMessage({ type: 'HRYV_STORE', method, key, body });
    if (method === 'GET' && r?.status === 404) return null;
    if (!r?.ok) throw new Error(r?.error || (r?.status ? `hryv-store HTTP ${r.status}` : 'hryv-store is not connected'));
    return r.data;
  }

  const saved = await chrome.storage.local.get([STATE, SCHEDULE]);
  // state.deferred (task id -> ms) keeps tasks set aside across the regular page reloads; state.hours counts
  // requests per hour for the last day.
  const state = { blocks: 0, backoffUntil: 0, lastBlocked: '', errorsInRow: 0, deferred: {}, hours: {}, tasks: 0, ...(saved[STATE] || {}) };
  const schedule = { cash: {}, points: {}, ...(saved[SCHEDULE] || {}) };
  const pending = {};               // hotel -> { titles, currency, days } waiting to be written
  const deferred = state.deferred;
  let hotels = [], lastFlush = Date.now(), lastScheduleSave = Date.now(), lastStatus = 0, message = 'Starting', navigating = false;

  const saveState = () => chrome.storage.local.set({ [STATE]: state });
  function status(text, force) {
    if (text) message = text;
    if (Date.now() - lastStatus < 5000 && !force) return;
    lastStatus = Date.now();
    const now = Date.now(), hour = Math.floor(now / HOUR);
    const days = Array.from({ length: horizon }, (_, i) => localDay(i));
    const every = days.map((_, i) => TIERS.find(([limit]) => i < limit)[1]);
    let fresh = 0;
    for (const [code] of hotels) days.forEach((d, i) => { const ts = schedule.cash[code]?.[d]; if (ts && now - ts < every[i]) fresh++; });
    chrome.storage.local.set({ [STATUS]: {
      updatedAt: now, message, hotels: hotels.length, tasks: state.tasks,
      requestsLast24h: Object.entries(state.hours).reduce((sum, [h, n]) => sum + (hour - h < 24 ? n : 0), 0),
      cashUpToDate: [fresh, hotels.length * horizon], pointsUpToDate: [hotels.filter(([c]) => now - (schedule.points[c] || 0) < POINTS_EVERY).length, hotels.length],
      blocks: state.blocks, backoffUntil: state.backoffUntil > now ? state.backoffUntil : null,
    } });
  }
  const counted = res => {
    const hour = Math.floor(Date.now() / HOUR);
    state.hours[hour] = (state.hours[hour] || 0) + (res.requests || 0);
    for (const h of Object.keys(state.hours)) if (hour - h >= 24) delete state.hours[h];
    return res;
  };

  async function saveSchedule() {
    const oldest = localDay(-KEEP_PAST_DAYS), now = Date.now();
    for (const seen of Object.values(schedule.cash)) for (const d of Object.keys(seen)) if (d < oldest) delete seen[d];
    for (const [id, until] of Object.entries(deferred)) if (until <= now) delete deferred[id];
    await chrome.storage.local.set({ [SCHEDULE]: schedule, [STATE]: state });
    lastScheduleSave = now;
  }

  async function flush() {
    const oldest = localDay(-KEEP_PAST_DAYS);
    for (const [code, add] of Object.entries(pending)) {
      const remote = (await store('GET', cashKey(code))) || { titles: {}, currency: '', days: {} };
      remote.days = remote.days || {}; remote.titles = remote.titles || {};
      for (const [d, rec] of Object.entries(add.days)) if (!remote.days[d] || rec.ts > (remote.days[d].ts || 0)) remote.days[d] = rec;
      for (const [k, t] of Object.entries(add.titles)) remote.titles[k] ||= t;
      remote.currency ||= add.currency;
      for (const d of Object.keys(remote.days)) if (d < oldest) delete remote.days[d];
      await store('PUT', cashKey(code), remote);
      delete pending[code];
    }
    // The schedule is about 2 MB for a large scope, so it is saved every five minutes and before reloads.
    if (Date.now() - lastScheduleSave > 5 * 60000) await saveSchedule();
    lastFlush = Date.now();
  }

  async function visit() {
    // Opening a hotel page like a visitor keeps the session current; the new page restarts this script.
    await flush();
    await saveSchedule();
    const code = hotels.length ? hotels[Math.floor(Math.random() * hotels.length)][0] : 'shaum';
    const day = localDay(14 + Math.floor(Math.random() * 46));
    const next = new Date(Date.parse(day + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
    running = false;
    navigating = true;
    location.assign(`/${S.lang}/shop/rooms/${code}?checkinDate=${day}&checkoutDate=${next}&rooms=1&adults=${S.adults}`);
  }

  async function loadCatalog() {
    const key = `hryv:hotels|${S.lang}`;
    const cached = (await chrome.storage.local.get(key))[key];
    let list = cached?.list?.[0]?.length >= 10 && Date.now() - cached.ts < CATALOG_EVERY ? cached.list : null;
    if (!list) {
      const res = counted(await C.hotels(S.lang));
      if (res.ok) { list = res.list; await chrome.storage.local.set({ [key]: { ts: Date.now(), lang: S.lang, list } }); }
      else if (cached?.list?.[0]?.length >= 10) list = cached.list;
      else return res;
    }
    // A scope code is a country (JP) or a sub-region (CN-ML for mainland China).
    hotels = list.filter(h => extra.has(h[0]) || countries.has((h[8] || '').toUpperCase()) ||
      countries.has((h[9] || '').toUpperCase())).sort((a, b) => a[0].localeCompare(b[0]));
    // Pick up results already in hryv-store (for example from your own scans) for hotels new to the schedule.
    for (const [code] of hotels) {
      if (schedule.cash[code]) continue;
      const cash = await store('GET', cashKey(code));
      schedule.cash[code] = Object.fromEntries(Object.entries(cash?.days || {}).map(([d, r]) => [d, r.ts || 0]));
      // A short calendar from a city or single-hotel scan does not count as this hotel's points calendar.
      const P = await store('GET', pointsKey(code));
      schedule.points[code] = P?.start <= localDay(0) && P.end >= localDay(horizon - 1) ? P.ts || 0 : 0;
    }
    schedule.catalogAt = Date.now();
    await saveSchedule();
    return { ok: true };
  }

  function nextTask() {
    const now = Date.now();
    const days = Array.from({ length: horizon }, (_, i) => localDay(i));
    const every = days.map((_, i) => TIERS.find(([limit]) => i < limit)[1]);
    let best = [1, null];
    for (const [code] of hotels) {
      if (!(deferred[`points|${code}`] > now)) {
        const last = schedule.points[code] || 0;
        const score = last ? (now - last) / POINTS_EVERY : 2e6;
        if (score > best[0]) best = [score, ['points', code, null]];
      }
      const seen = schedule.cash[code] || {};
      days.forEach((d, i) => {
        const score = seen[d] ? (now - seen[d]) / every[i] : 1e6 - i;
        if (score > best[0] && !(deferred[`cash|${code}|${d}`] > now)) best = [score, ['cash', code, d]];
      });
    }
    return best[1];
  }
  const taskId = ([kind, code, day]) => kind === 'points' ? `points|${code}` : `cash|${code}|${day}`;

  async function runPoints(code) {
    const res = counted(await C.points(code, localDay(-1), horizon + 3, S.adults));
    if (!res.ok) return res;
    const P = res.value;
    if (!Object.keys(P.prices).length) return { ok: false, status: 200, error: 'empty points calendar' };
    const cash = await store('GET', cashKey(code));
    const recent = Object.fromEntries(Object.entries(cash?.days || {}).filter(([, r]) => Date.now() - r.ts < 7 * DAY));
    const proof = counted(await C.proof(P, recent));
    if (proof.blocked) return proof;
    if (proof.ok) P.standardRoomProof = { ...proof.value, source: 'collector' };
    P.source = 'collector';
    P.availVerified = P.availOk;
    delete P.availOk;
    await store('PUT', pointsKey(code), P);
    schedule.points[code] = P.ts;
    return { ok: true };
  }
  async function runCash(code, day) {
    const res = counted(await C.cash(code, day, S.nights, S.adults));
    if (!res.ok) return res;
    const ts = Date.now();
    const add = pending[code] ||= { titles: {}, currency: '', days: {} };
    add.days[day] = { ts, r: res.rooms };
    Object.assign(add.titles, res.titles);
    add.currency = res.currency || add.currency;
    (schedule.cash[code] ||= {})[day] = ts;
    return res;
  }

  async function backoff(task, res) {
    const id = task ? taskId(task) : 'page';
    if (id === state.lastBlocked && id !== 'page') deferred[id] = Date.now() + POISON_RETRY;
    state.lastBlocked = id;
    state.blocks++;
    const wait = Math.min(BACKOFF_FIRST * 2 ** (state.blocks - 1), BACKOFF_MAX) * (0.9 + Math.random() * 0.3);
    state.backoffUntil = Date.now() + wait;
    await saveState();
    await flush().catch(() => {});
    const until = new Date(state.backoffUntil);
    status(`Paused: Hyatt is blocking requests (${res.error}). Retrying at ${pad(until.getHours())}:${pad(until.getMinutes())}.`, true);
    await sleep(wait);
    if (running) await visit();
  }

  // Main loop ----------------------------------------------------------------------------------
  try {
    heartbeat();
    if (state.backoffUntil > Date.now()) {
      status('Paused after a block; waiting before the next request.', true);
      await sleep(state.backoffUntil - Date.now());
    }
    const nav = performance.getEntriesByType('navigation')[0];
    if (running && [403, 429].includes(nav?.responseStatus)) await backoff(null, { error: `page HTTP ${nav.responseStatus}` });
    while (running) {
      try {
        if (!hotels.length || Date.now() - (schedule.catalogAt || 0) > CATALOG_EVERY) {
          const res = await loadCatalog();
          if (!res.ok) { await (res.blocked ? backoff(null, res) : sleep(10 * 60000)); continue; }
          if (!hotels.length) { status('No hotels match the countries and hotel codes in Settings.', true); await sleep(10 * 60000); continue; }
        }
        if (Date.now() - performance.timeOrigin > VISIT_EVERY) { await visit(); break; }
        if ((await navigator.locks.query()).held.some(l => l.name === 'hryv:scan')) {
          status('Paused while you run a scan.', true);
          await sleep(60000);
          continue;
        }
        const task = nextTask();
        if (!task) { await flush(); status('Up to date. Waiting for the next refresh.', true); await sleep(60000); continue; }
        const [kind, code, day] = task;
        const res = await (kind === 'points' ? runPoints(code) : runCash(code, day));
        state.tasks++;
        if (res.ok) {
          if (state.blocks || state.backoffUntil || state.lastBlocked) Object.assign(state, { blocks: 0, backoffUntil: 0, lastBlocked: '' }), await saveState();
          state.errorsInRow = 0;
          status(`Collecting: ${kind} ${code}${day ? ' ' + day : ''}`);
        } else if (res.blocked) {
          await backoff(task, res);
          continue;
        } else {
          deferred[taskId(task)] = Date.now() + TASK_RETRY;
          state.errorsInRow++;
          await saveState();
          status(`Request failed for ${code}${day ? ' ' + day : ''}: ${res.error}`);
          if (state.errorsInRow >= ERRORS_BEFORE_PAUSE) await sleep(Math.min(BACKOFF_FIRST * 2 ** (state.errorsInRow - ERRORS_BEFORE_PAUSE), HOUR));
        }
        if (Date.now() - lastFlush > FLUSH_EVERY) await flush();
        await sleep(interval * Math.max(1, res.requests || 1) * (0.7 + Math.random() * 0.6));
      } catch (e) {
        // hryv-store unreachable or another unexpected error: report it and try again later.
        status(`Waiting: ${e.message}`, true);
        await sleep(60000);
      }
    }
  } finally {
    await flush().catch(() => {});
    if (!navigating) await saveSchedule().catch(() => {});
    if (restart) location.reload();
    else if (!navigating) status('Stopped.', true);
  }
})();
