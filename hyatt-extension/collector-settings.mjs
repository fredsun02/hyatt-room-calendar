// Settings for background collection, shared by collector-host.js and the options page.
export const COLLECTOR_SETTINGS = 'collector:settings';
export const COLLECTOR_STATUS = 'collector:status';
export const COLLECTOR_DEFAULTS = {
  enabled: false, countries: ['CN', 'HK', 'MO', 'TW', 'JP'], hotels: [], interval: 5, horizon: 365,
  adults: 1, nights: 1, lang: 'zh-CN',
};
