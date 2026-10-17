export const isBackupKey = key => /^hryv:(?:[a-z0-9]{5}\|[1-4]\|[1-7]|pts\|[a-z0-9]{5}\|[1-4]|auto-recover)$/.test(key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
const timestamp = value => Number.isFinite(value) && value > 0 && value <= Date.now() + 600000;
function safeTree(value, depth = 0) {
  if (depth > 14) throw new Error('Backup nesting limit exceeded');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsupported field in backup');
    safeTree(item, depth + 1);
  }
}
export function validateBackup(input) {
  if (!plain(input) || input.format !== 'hryv-backup' || input.version !== 1 || !plain(input.entries)) throw new Error('Select a JSON file created by Export backup.');
  const entries = Object.entries(input.entries);
  if (entries.length > 2000) throw new Error('Too many backup entries');
  safeTree(input);
  for (const [key, value] of entries) {
    if (!isBackupKey(key)) throw new Error('Unsupported backup entry: ' + key);
    if (key === 'hryv:auto-recover') {
      if (typeof value !== 'boolean') throw new Error('Invalid auto-resume setting');
      continue;
    }
    if (!plain(value)) throw new Error('Invalid cache entry: ' + key);
    if (key.startsWith('hryv:pts|')) {
      const [, hotel, adults] = key.split('|');
      if (!timestamp(value.ts) || value.spirit !== hotel || value.adults !== Number(adults) ||
          !date(value.start) || !date(value.end) || !plain(value.prices) || !plain(value.avail)) throw new Error('Invalid points entry: ' + key);
      for (const days of Object.values(value.prices)) {
        if (!plain(days) || Object.entries(days).some(([d, price]) => !date(d) || !Array.isArray(price) || price.length < 2)) throw new Error('Invalid points dates');
      }
      for (const days of Object.values(value.avail)) if (!plain(days)) throw new Error('Invalid award availability');
      if (value.standardRoomProof && (!plain(value.standardRoomProof.rooms) || !Array.isArray(value.standardRoomProof.dates))) throw new Error('Invalid room verification data');
    } else {
      if (!plain(value.days) || !plain(value.titles) || Object.keys(value.days).length > 5000 ||
          Object.values(value.titles).some(title => typeof title !== 'string')) throw new Error('Invalid room data: ' + key);
      for (const [d, record] of Object.entries(value.days)) {
        if (!date(d) || !plain(record) || !timestamp(record.ts) || !plain(record.r) ||
            Object.values(record.r).some(room => !Array.isArray(room) || room.length < 2 || !Number.isFinite(room[0]) || room[0] < 0)) throw new Error('Invalid room date: ' + d);
      }
    }
  }
  return structuredClone(input.entries);
}
export function mergeBackup(current, imported) {
  const result = {};
  for (const [key, incoming] of Object.entries(imported)) {
    const existing = current[key];
    if (incoming?.days && existing?.days) {
      const merged = { ...existing, titles: { ...incoming.titles, ...existing.titles },
        currency: existing.currency || incoming.currency || '', days: { ...existing.days } };
      for (const [d, record] of Object.entries(incoming.days)) if (!merged.days[d] || record.ts > merged.days[d].ts) merged.days[d] = record;
      result[key] = merged;
    } else if (key.startsWith('hryv:pts|') && existing?.ts >= incoming.ts) result[key] = existing;
    else result[key] = incoming;
  }
  return result;
}
