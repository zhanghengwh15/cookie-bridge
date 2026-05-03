const STORAGE_KEY = 'sites';

/**
 * @returns {Promise<Array<{url:string,hostname:string,enabled:boolean,addedAt:number}>>}
 */
export async function getSites() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data.sites || [];
}

/**
 * @param {string} url
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
export async function addSite(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: false, error: 'URL 格式错误' };
  }
  if (!hostname) {
    return { ok: false, error: '无法解析 hostname' };
  }

  const sites = await getSites();
  if (sites.some(s => s.hostname === hostname)) {
    return { ok: false, error: '该域名已存在' };
  }

  sites.push({ url, hostname, enabled: true, addedAt: Date.now() });
  await chrome.storage.local.set({ sites });
  return { ok: true };
}

/**
 * @param {string} hostname
 */
export async function removeSite(hostname) {
  const sites = await getSites();
  const next = sites.filter(s => s.hostname !== hostname);
  await chrome.storage.local.set({ sites: next });
}

/**
 * @param {string} hostname
 * @param {boolean} enabled
 */
export async function setEnabled(hostname, enabled) {
  const sites = await getSites();
  const idx = sites.findIndex(s => s.hostname === hostname);
  if (idx >= 0) {
    sites[idx].enabled = enabled;
    await chrome.storage.local.set({ sites });
  }
}

/**
 * @param {(sites:Array)=>void} cb
 * @returns {()=>void} unsubscribe
 */
export function onChanged(cb) {
  const listener = (changes) => {
    if (changes.sites) {
      cb(changes.sites.newValue || []);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
