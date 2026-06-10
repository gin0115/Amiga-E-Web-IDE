// The Disk Box: persistent in-browser storage for the user's Amiga images
// and build artifacts. IndexedDB-backed (multi-GB quota in modern browsers,
// survives reloads; navigator.storage.persist() requested for durability).
//
// Categories: 'rom' | 'disk' (ADF) | 'hdf' | 'bin' | 'source'
// API (all Promise-based):
//   DiskBox.put(category, name, bytes)        store/overwrite
//   DiskBox.get(category, name) -> Uint8Array|null
//   DiskBox.list() -> [{category, name, size, when}]
//   DiskBox.remove(category, name)
//   DiskBox.usage() -> {usage, quota}

(function () {
  'use strict';

  var DB_NAME = 'amiga-ide-diskbox';
  var STORE = 'images';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () { /* best effort */ });
    }
    return dbPromise;
  }

  function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }

  window.DiskBox = {
    put: async function (category, name, bytes) {
      var db = await open();
      var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return new Promise(function (resolve, reject) {
        var req = tx(db, 'readwrite').put({
          key: category + '/' + name,
          category: category,
          name: name,
          size: data.byteLength,
          when: Date.now(),
          data: data,
        });
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { reject(req.error); };
      });
    },

    get: async function (category, name) {
      var db = await open();
      return new Promise(function (resolve, reject) {
        var req = tx(db, 'readonly').get(category + '/' + name);
        req.onsuccess = function () {
          resolve(req.result ? new Uint8Array(req.result.data) : null);
        };
        req.onerror = function () { reject(req.error); };
      });
    },

    list: async function () {
      var db = await open();
      return new Promise(function (resolve, reject) {
        var out = [];
        var req = tx(db, 'readonly').openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) { resolve(out); return; }
          var v = cur.value;
          out.push({ category: v.category, name: v.name, size: v.size, when: v.when });
          cur.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
    },

    remove: async function (category, name) {
      var db = await open();
      return new Promise(function (resolve, reject) {
        var req = tx(db, 'readwrite').delete(category + '/' + name);
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { reject(req.error); };
      });
    },

    usage: async function () {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0 };
      }
      return { usage: 0, quota: 0 };
    },
  };
})();
