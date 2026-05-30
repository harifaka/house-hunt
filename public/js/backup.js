/**
 * House Hunt — Client-side localStorage backup
 * Provides offline resilience by caching key data locally.
 * If the server is unavailable, users still see their last-known data.
 */
(function() {
  'use strict';

  var STORAGE_PREFIX = 'hh_';
  var BACKUP_VERSION = 1;

  // --- Utility ---

  function isStorageAvailable() {
    try {
      var test = '__storage_test__';
      localStorage.setItem(test, '1');
      localStorage.removeItem(test);
      return true;
    } catch (_e) {
      return false;
    }
  }

  if (!isStorageAvailable()) return;

  function getKey(key) {
    return STORAGE_PREFIX + key;
  }

  function save(key, data) {
    try {
      localStorage.setItem(getKey(key), JSON.stringify({
        v: BACKUP_VERSION,
        ts: Date.now(),
        data: data
      }));
    } catch (_e) {
      // Storage full or blocked — silently ignore
    }
  }

  function load(key) {
    try {
      var raw = localStorage.getItem(getKey(key));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.v === BACKUP_VERSION) return parsed.data;
      return null;
    } catch (_e) {
      return null;
    }
  }

  function remove(key) {
    try { localStorage.removeItem(getKey(key)); } catch (_e) { /* ignore */ }
  }

  // --- Quiz answer backup ---

  function backupQuizAnswer(houseId, questionId, optionId, notes) {
    var answers = load('quiz_' + houseId) || {};
    answers[questionId] = { optionId: optionId, notes: notes || '', ts: Date.now() };
    save('quiz_' + houseId, answers);
  }

  function getQuizBackup(houseId) {
    return load('quiz_' + houseId);
  }

  function clearQuizBackup(houseId) {
    remove('quiz_' + houseId);
  }

  // --- Calculator backup ---

  function backupCalculator(type, data) {
    save('calc_' + type, data);
  }

  function getCalculatorBackup(type) {
    return load('calc_' + type);
  }

  // --- House list cache ---

  function backupHouseList(houses) {
    save('houses', houses);
  }

  function getHouseListBackup() {
    return load('houses');
  }

  // --- Settings cache ---

  function backupSettings(settings) {
    save('settings', settings);
  }

  function getSettingsBackup() {
    return load('settings');
  }

  // --- Export/Restore all data ---

  function exportAllData() {
    var allData = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        allData[key] = localStorage.getItem(key);
      }
    }
    return JSON.stringify(allData, null, 2);
  }

  function importAllData(jsonStr) {
    try {
      var allData = JSON.parse(jsonStr);
      Object.keys(allData).forEach(function(key) {
        if (key.startsWith(STORAGE_PREFIX)) {
          localStorage.setItem(key, allData[key]);
        }
      });
      return true;
    } catch (_e) {
      return false;
    }
  }

  function clearAllData() {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
    keys.forEach(function(k) { localStorage.removeItem(k); });
  }

  // --- Expose global API ---

  window.HouseHuntBackup = {
    backupQuizAnswer: backupQuizAnswer,
    getQuizBackup: getQuizBackup,
    clearQuizBackup: clearQuizBackup,
    backupCalculator: backupCalculator,
    getCalculatorBackup: getCalculatorBackup,
    backupHouseList: backupHouseList,
    getHouseListBackup: getHouseListBackup,
    backupSettings: backupSettings,
    getSettingsBackup: getSettingsBackup,
    exportAllData: exportAllData,
    importAllData: importAllData,
    clearAllData: clearAllData
  };

  // --- Auto-backup: intercept quiz saves ---

  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function(url, options) {
      var result = originalFetch.apply(this, arguments);

      // Intercept quiz answer submissions for backup (only on success)
      if (options && options.method === 'POST' && typeof url === 'string') {
        var quizMatch = url.match(/\/quiz\/([^/]+)\/answer\/([^/]+)/);
        if (quizMatch && options.body) {
          result.then(function(response) {
            if (response && response.ok) {
              try {
                var body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                backupQuizAnswer(quizMatch[1], quizMatch[2], body.option_id || body.optionId, body.notes);
              } catch (_e) { /* ignore parse errors */ }
            }
          }).catch(function() { /* ignore network errors */ });
        }
      }

      return result;
    };
  }
})();
