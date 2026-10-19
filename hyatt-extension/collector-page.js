// Runs inside a www.hyatt.com page (added as a Playwright init script). The requests and parsing
// mirror fetchDay, fetchPoints, roomProofSamples/fetchRoomProof and fetchHotels in
// hyatt-room-year.user.js so the extension reads collector data unchanged. Keep them in sync.
// Every function resolves to { ok: true, ... } or { ok: false, status, blocked, error }; none throws.
globalThis.hryvCollector = (() => {
  const API = '/shop/service/rooms/roomrates/';
  const PTS_CHUNK = 70;
  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (s, n) => { const d = fromISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
  const failure = (status, error) => ({ ok: false, status, error, blocked: status === 0 || status === 403 || status === 429 });
  let requests = 0;

  async function getJSON(url) {
    let r, text;
    requests++;
    try {
      r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include', signal: AbortSignal.timeout(30000) });
      text = await r.text();
    } catch (e) { return failure(-1, 'Network error: ' + e.message); }
    if (r.status === 403 || r.status === 429) return failure(r.status, 'HTTP ' + r.status);
    if (!r.ok) return failure(r.status, 'HTTP ' + r.status);
    if (!text) return failure(0, 'Empty response');
    try { return { ok: true, status: r.status, j: JSON.parse(text) }; }
    catch { return failure(0, 'Unexpected response; Hyatt may have blocked the request'); }
  }

  async function cash(spirit, checkin, los, adults) {
    const res = await getJSON(`${API}${encodeURIComponent(spirit)}?checkinDate=${checkin}&checkoutDate=${addDays(checkin, los)}` +
      `&rooms=1&adults=${adults}&kids=0&rate=Standard&rateFilter=standard`);
    if (!res.ok) return res;
    const rooms = {}, titles = {};
    let currency = '';
    for (const [code, v] of Object.entries(res.j.roomRates || {})) {
      const stex = (v.ratePlans || []).some(rp => rp && rp.stexCashAvailable) ? 1 : 0;
      rooms[code] = [v.roomQuantity ?? 0, v.lowestCashRate ?? v.lowestPublicRate ?? null, stex,
        typeof v.roomCategory === 'string' ? v.roomCategory : null];
      titles[code] = (v.roomType && v.roomType.title) || code;
      if (v.currencyCode) currency = v.currencyCode;
    }
    return { ok: true, rooms, titles, currency };
  }

  async function points(spirit, start, n, adults) {
    const end = addDays(start, n - 1);
    const prices = {};
    let hotelCategory = '';
    for (let s0 = start; s0 <= end; s0 = addDays(s0, PTS_CHUNK)) {
      let e0 = addDays(s0, PTS_CHUNK - 1);
      if (e0 > end) e0 = end;
      let res = await getJSON(`/explore-hotels/service/avail?spiritCode=${spirit}&startDate=${s0}&endDate=${e0}`);
      // As in the extension, a first chunk that fails or has no rates is retried from the next day.
      if ((!res.ok && !res.blocked || res.ok && !res.j.roomCategories) && s0 === start && s0 < e0) {
        res = await getJSON(`/explore-hotels/service/avail?spiritCode=${spirit}&startDate=${addDays(s0, 1)}&endDate=${e0}`);
      }
      // Unlike the extension, a failed chunk fails the calendar, so a partial one never replaces a complete one.
      if (!res.ok) return res.blocked ? res : failure(res.status, `points rates ${s0}–${e0}: ${res.error}`);
      if (!res.j.roomCategories) continue;
      for (const [cat, days] of Object.entries(res.j.roomCategories)) {
        prices[cat] = prices[cat] || {};
        for (const [d, v] of Object.entries(days || {})) {
          prices[cat][d] = [v.pointsLevel || '', v.pointsValue ?? null, v.pointsCash ? (v.pointsCash.pointsValue ?? null) : null];
        }
      }
      if (res.j.hotelCategory) hotelCategory = String(res.j.hotelCategory).trim();
    }
    const avail = {};
    let info = '';
    const res = await getJSON(`/explore-hotels/service/avail/days?spiritCode=${spirit}&startDate=${start}&endDate=${end}` +
      `&numAdults=${adults}&numChildren=0&roomQuantity=1&los=1&isMock=false`);
    if (!res.ok && res.blocked) return res;
    if (res.ok) {
      info = res.j.responseInfo || '';
      for (const [d, cats] of Object.entries(res.j.days || {})) {
        for (const c of Object.keys(cats || {})) (avail[c] = avail[c] || {})[d] = 1;
      }
    }
    // availOk is false when the availability request failed, so an empty `avail` is not mistaken for sold out.
    return { ok: true, value: { ts: Date.now(), spirit, start, end, adults, prices, avail, hotelCategory, info, availOk: res.ok } };
  }

  // Standard room evidence for the ◆ label; cashDays is the collector's cash cache for the hotel.
  function proofSamples(P, cashDays) {
    const available = Object.keys(P.avail.STANDARD_ROOM || {}).filter(d => d >= P.start && d <= P.end).sort();
    if (available.length) return { dates: [...new Set([available[0], available.at(-1)])], source: 'calendar' };
    const priced = Object.keys(P.prices.STANDARD_ROOM || {}).filter(d => d >= P.start && d <= P.end).sort();
    const dates = [priced[Math.min(2, priced.length - 1)] || P.start];
    const codes = rec => Object.entries(rec?.r || {}).filter(([, v]) => v[0] > 0 && v[2] !== 1).map(([code]) => code);
    const covered = new Set(codes(cashDays[dates[0]]));
    const recent = Object.entries(cashDays).filter(([d]) => d >= P.start && d <= P.end).sort(([a], [b]) => a.localeCompare(b));
    while (dates.length < 3) {
      const ranked = recent.filter(([d]) => !dates.includes(d)).map(([d, rec]) => {
        const unseen = codes(rec).filter(code => !covered.has(code));
        return { d, unseen, score: unseen.length };
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
  async function proof(P, cashDays) {
    const samples = proofSamples(P, cashDays || {});
    const result = { version: 2, ts: Date.now(), rooms: {}, dates: [], error: '', sampleSource: samples.source };
    for (const date of samples.dates) {
      const res = await getJSON(`${API}${encodeURIComponent(P.spirit)}?checkinDate=${date}&checkoutDate=${addDays(date, 1)}` +
        `&rooms=1&adults=${P.adults}&kids=0&rate=Standard&rateFilter=woh`);
      if (!res.ok) { if (res.blocked) return res; result.error = res.error; break; }
      if (!res.j.roomRates) { result.error = 'No valid room data returned by the award request'; break; }
      result.dates.push(date);
      for (const [code, room] of Object.entries(res.j.roomRates)) {
        const plan = (room.ratePlans || []).find(p => p && p.id === 'LPRM' && p.ratePlanCategory === 'POINTS' && Number(p.points) > 0);
        if (plan) result.rooms[code] = { date, plan: plan.id, category: plan.ratePlanCategory, points: plan.points };
      }
    }
    return { ok: true, value: result };
  }

  // Entries: [code, name, city, province, country, brand, category, slug, countryKey, subRegionKey, latitude, longitude].
  async function hotels(lang) {
    let r, html;
    requests++;
    try {
      r = await fetch(`/${lang}/explore-hotels`, { headers: { Accept: 'text/html' }, credentials: 'include', signal: AbortSignal.timeout(120000) });
      html = await r.text();
    } catch (e) { return failure(-1, 'Network error: ' + e.message); }
    if (!r.ok) return failure(r.status, 'HTTP ' + r.status);
    const m = /window\.STORE\s*=\s*\{/.exec(html);
    if (!m) return failure(0, 'hotel list not found; Hyatt may have blocked the request');
    const begin = m.index + m[0].length - 1;
    let depth = 0, inString = false, end = -1;
    for (let i = begin; i < html.length; i++) {
      const ch = html.charCodeAt(i);
      if (inString) { if (ch === 92) i++; else if (ch === 34) inString = false; }
      else if (ch === 34) inString = true;
      else if (ch === 123) depth++;
      else if (ch === 125 && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return failure(0, 'hotel list is incomplete');
    let store;
    try { store = JSON.parse(html.slice(begin, end).replace(/new Date\(("(?:[^"\\]|\\.)*"|-?\d+)\)/g, '$1')); }
    catch (e) { return failure(0, 'hotel list could not be parsed: ' + e.message); }
    const list = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (typeof o.spiritCode !== 'string') { Object.values(o).forEach(walk); return; }
      if (!/^[a-z0-9]{5}$/.test(o.spiritCode) || o.propertyType !== 'HYATT' || o.booking?.isExternal || o.openStatus === 'NOT_BOOKABLE') return;
      const loc = o.location || {}, geo = loc.geolocation || {};
      list.push([o.spiritCode, String(o.name || o.spiritCode), loc.city || '', loc.stateProvince?.label || '',
        loc.country?.label || '', o.brand?.label || '', o.awardCategory?.key || '',
        String(o.url || '').split('/').pop().replace(/^[a-z0-9]{5}-/, '').replace(/-/g, ' '),
        loc.country?.key || '', loc.subRegion?.key || '',
        Number.isFinite(geo.latitude) ? geo.latitude : null, Number.isFinite(geo.longitude) ? geo.longitude : null]);
    })(store.properties);
    return list.length ? { ok: true, list } : failure(0, 'hotel list is empty');
  }

  // Each result also reports how many requests it made, so the collector can pace by request.
  const counted = fn => async (...args) => {
    const before = requests;
    const result = await fn(...args);
    return { ...result, requests: requests - before };
  };
  return { cash: counted(cash), points: counted(points), proof: counted(proof), hotels: counted(hotels) };
})();
