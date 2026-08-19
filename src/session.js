'use strict';

/** Oddiy xotiradagi sessiya (bitta process uchun yetarli) */
const store = new Map();

const get = (key) => store.get(String(key)) || {};
const set = (key, patch) => {
  const merged = { ...get(key), ...patch };
  store.set(String(key), merged);
  return merged;
};
const clear = (key) => store.delete(String(key));

module.exports = { get, set, clear };
