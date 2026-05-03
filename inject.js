(function () {
  'use strict';

  const NS = '__cookieBridge';
  if (window[NS + '_hooked']) return;
  window[NS + '_hooked'] = true;

  function post(op, detail) {
    window.postMessage({ [NS]: true, op, ...detail }, '*');
  }

  const _setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    _setItem.call(this, k, v);
    post('set', { k, v });
  };

  const _removeItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (k) {
    _removeItem.call(this, k);
    post('remove', { k });
  };

  const _clear = Storage.prototype.clear;
  Storage.prototype.clear = function () {
    _clear.call(this);
    post('clear', {});
  };
})();
