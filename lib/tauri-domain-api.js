const TAURI_BASE = 'http://127.0.0.1:8765/api/domains';
const DEFAULT_TIMEOUT_MS = 2500;

function withTimeout(ms = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/**
 * GET /api/domains
 * @returns {Promise<Array<{id:number,domainName:string,urls:string|null,description:string|null,createdAt:string,updatedAt:string}>>}
 */
export async function fetchDomains() {
  const t = withTimeout();
  try {
    const res = await fetch(TAURI_BASE, { signal: t.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'unknown error');
    return Array.isArray(json.data) ? json.data : [];
  } finally {
    t.done();
  }
}

/**
 * POST /api/domains
 * @param {string} domainName
 * @param {string[]} [urls]
 * @param {string} [description]
 * @returns {Promise<{exists:boolean, domain?:object}>}
 */
export async function createDomain(domainName, urls, description) {
  const body = { domainName };
  if (Array.isArray(urls) && urls.length > 0) {
    body.urls = JSON.stringify(urls);
  }
  if (description) {
    body.description = description;
  }
  const t = withTimeout();
  try {
    const res = await fetch(TAURI_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (res.status === 409) {
      return { exists: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) {
      if (json.message && /exist/i.test(json.message)) {
        return { exists: true };
      }
      throw new Error(json.message || 'unknown error');
    }
    return { exists: false, domain: json.data };
  } finally {
    t.done();
  }
}

/**
 * 解析 Domain.urls (JSON 数组字符串) 中第一个 URL，失败时返回 null。
 * @param {string|null|undefined} urlsJson
 * @returns {string|null}
 */
export function pickPrimaryUrl(urlsJson) {
  if (!urlsJson) return null;
  try {
    const arr = JSON.parse(urlsJson);
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'string') {
      return arr[0];
    }
  } catch { /* ignore */ }
  return null;
}
