(function () {
  'use strict';

  const NS = '__cookieBridge';

  function readAll() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return out;
  }

  // 向 MAIN world 的 inject.js 请求全量 localStorage（ISOLATED world 读不到页面的 localStorage）
  function requestFullFromInject() {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const handler = (e) => {
        if (e.source !== window) return;
        const data = e.data;
        if (!data || data[NS] !== true) return;
        if (data.op === 'getAllResponse' && data.reqId === reqId) {
          window.removeEventListener('message', handler);
          resolve(data.all || {});
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ [NS]: true, op: 'getAll', reqId }, '*');
      // 超时 fallback：读 ISOLATED world 自己的 localStorage（大概率是空的，但总比卡住强）
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(readAll());
      }, 3000);
    });
  }

  function sendLsUpdate(op, extra) {
    const payload = {
      type: 'lsUpdate',
      op,
      hostname: location.hostname,
      ...extra,
    };
    console.log('[CookieBridge CS] 发送', payload);
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      console.error('[CookieBridge CS] chrome.runtime.sendMessage 不可用');
      return;
    }
    chrome.runtime.sendMessage(payload)
      .then(res => console.log('[CookieBridge CS] 发送成功', op, res))
      .catch(err => console.error('[CookieBridge CS] 发送失败', op, err));
  }

  // ① 页面 load 时读全量
  window.addEventListener('load', async () => {
    console.log('[CookieBridge CS] load 事件触发');
    const all = await requestFullFromInject();
    sendLsUpdate('full', { all });
  });

  // ② 监听 background 的全量读取请求
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'requestFullLs') {
      requestFullFromInject().then(all => {
        sendResponse({ all });
      });
      return true;
    }
  });

  // ③ 监听 inject.js 的 postMessage
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data[NS] !== true) return;

    switch (data.op) {
      case 'set':
        sendLsUpdate('set', { k: data.k, v: data.v });
        break;
      case 'remove':
        sendLsUpdate('remove', { k: data.k });
        break;
      case 'clear':
        sendLsUpdate('clear', {});
        break;
    }
  });

  // ③ 监听 storage 事件（其他 tab 改了）
  window.addEventListener('storage', (e) => {
    if (e.key === null) {
      sendLsUpdate('clear', {});
    } else if (e.newValue === null) {
      sendLsUpdate('remove', { k: e.key });
    } else {
      sendLsUpdate('set', { k: e.key, v: e.newValue });
    }
  });

  // ④ 150s 兜底轮询
  setInterval(async () => {
    const all = await requestFullFromInject();
    sendLsUpdate('full', { all });
  }, 150_000);

  // ⑤ 脚本注入时若页面已加载完成，立即补发一次全量
  // （动态注册 content script 时不会触发 load 事件）
  console.log('[CookieBridge CS] 注入完成, readyState=', document.readyState, 'hostname=', location.hostname);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    console.log('[CookieBridge CS] 页面已加载，立即发送全量');
    requestFullFromInject().then(all => sendLsUpdate('full', { all }));
  }
})();
