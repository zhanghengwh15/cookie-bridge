(function () {
  'use strict';

  const NS = '__cookieBridge';
  if (window[NS + '_hooked']) return;
  window[NS + '_hooked'] = true;

  const SKIP_LS_KEYS = new Set(['customPaths','shedePaths','pathNode','tianweiPaths','menudata','eModel','lowCodePaths']);

  function post(op, detail) {
    window.postMessage({ [NS]: true, op, ...detail }, '*');
  }

  const _setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    _setItem.call(this, k, v);
    if (!SKIP_LS_KEYS.has(k)) post('set', { k, v });
  };

  const _removeItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (k) {
    _removeItem.call(this, k);
    if (!SKIP_LS_KEYS.has(k)) post('remove', { k });
  };

  const _clear = Storage.prototype.clear;
  Storage.prototype.clear = function () {
    _clear.call(this);
    post('clear', {});
  };

  // 响应 content.js 的全量读取请求
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data[NS] !== true || data.op !== 'getAll') return;

    const all = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (SKIP_LS_KEYS.has(k)) continue;
      all[k] = localStorage.getItem(k);
    }
    post('getAllResponse', { all, reqId: data.reqId });
  });
})();
