// ============================================================
// offscreen.js — Runs in an offscreen document.
// Has full DOM access: DOMParser, Audio, setInterval, fetch.
//
// Chrome clamps chrome.alarms to a 1-minute minimum period for
// installed extensions, so the actual sub-minute polling loop
// lives here instead (offscreen documents aren't torn down on
// the same idle timer as the service worker). background.js
// only relays results/alerts and runs a 1-min heartbeat alarm
// to restart this loop if the offscreen document ever dies.
// ============================================================

const BASE_URL = 'https://writers.academia-research.com';
const JOBS_URL = 'https://writers.academia-research.com/index.php?r=order/available';

let pollTimer = null;
let currentIntervalSeconds = 10;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'PLAY_SOUND') {
    try {
      const audio = new Audio(chrome.runtime.getURL('sounds/alert.mp3'));
      audio.volume = msg.volume || 1.0;
      audio.play().catch(e => console.warn('Audio play failed:', e));
    } catch (e) {
      console.warn('Sound error:', e);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'START_POLLING') {
    currentIntervalSeconds = msg.intervalSeconds || 10;
    startPolling();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STOP_POLLING') {
    stopPolling();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POLL_NOW') {
    pollOnce();
    sendResponse({ ok: true });
    return true;
  }
});

function startPolling() {
  stopPolling();
  pollOnce();
  pollTimer = setInterval(pollOnce, Math.max(1, currentIntervalSeconds) * 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Core: fetch + parse, then hand results to background.js ───
async function pollOnce() {
  try {
    const response = await fetch(JOBS_URL, {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache'
      }
    });

    if (response.status === 401 || response.status === 403) {
      chrome.runtime.sendMessage({ type: 'LOGIN_REQUIRED' }).catch(() => {});
      return;
    }
    if (!response.ok) {
      chrome.runtime.sendMessage({ type: 'FETCH_ERROR', status: response.status }).catch(() => {});
      return;
    }

    const html = await response.text();

    if (html.includes('account/login') || html.includes('I forgot my password')) {
      chrome.runtime.sendMessage({ type: 'LOGIN_REQUIRED' }).catch(() => {});
      return;
    }

    const jobs = extractJobsFromHTML(html);
    chrome.runtime.sendMessage({ type: 'JOBS_RESULT', jobs }).catch(() => {});
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'FETCH_ERROR', error: err.message }).catch(() => {});
  }
}

// ── HTML parser — full DOM available here ────────────────────
function extractJobsFromHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Prefer a scoped container when one exists so we don't pick up
  // unrelated data-id/data-key/li elements from nav bars, ads, etc.
  const scope = doc.querySelector(
    '#available-orders, .available-orders, [id*="available" i], [class*="available-order" i], [class*="order-list" i], [class*="orders-list" i]'
  ) || doc;

  const jobs = [];
  const seenIds = new Set();

  const pushJob = (id, title, deadline, price, url) => {
    if (!id || seenIds.has(id)) return;
    if (!title || title.trim().length < 2) return;
    seenIds.add(id);
    jobs.push({ id: String(id), title: title.trim(), deadline: (deadline || '').trim(), price: (price || '').trim(), url });
  };

  const isNoise = (el) => !!el.closest(
    'nav, header, footer, .navbar, .menu, .sidebar, [class*="footer" i], [class*="header" i]'
  );

  // Strategy 1: elements with data-id / data-order-id / data-key
  scope.querySelectorAll('[data-id], [data-order-id], [data-key]').forEach(el => {
    if (isNoise(el)) return;
    const rawId = el.dataset.id || el.dataset.orderId || el.dataset.key;
    if (!rawId) return;
    const title = el.querySelector('.topic, .title, .subject, h4, h3, h5, td:nth-child(2)')?.textContent?.trim()
                || el.textContent.trim().substring(0, 80);
    const deadline = el.querySelector('.deadline, .due, [class*="deadline"], [class*="due"]')?.textContent?.trim() || '';
    const price    = el.querySelector('.price, .budget, .pay, [class*="price"], [class*="pay"]')?.textContent?.trim() || '';
    const link     = el.querySelector('a')?.getAttribute('href') || '';
    const url      = resolveUrl(link);
    // Prefer an order id parsed out of the link — stable across re-renders,
    // unlike some data-key values that can be regenerated per page load.
    const id = extractOrderIdFromUrl(url) || rawId;
    pushJob(id, title, deadline, price, url);
  });
  if (jobs.length > 0) return jobs;

  // Strategy 2: table rows
  scope.querySelectorAll('table tbody tr').forEach((row) => {
    if (isNoise(row)) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return;
    const title = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim();
    const deadline = cells[2]?.textContent?.trim() || '';
    const price    = cells[3]?.textContent?.trim() || cells[cells.length - 1]?.textContent?.trim() || '';
    const link = row.querySelector('a')?.getAttribute('href') || '';
    const url  = resolveUrl(link);
    // Index-based fallback ids broke as soon as the list reordered (every
    // row would look "new"). Prefer an id from the link, then a real DOM
    // id, then a content hash — never the row's position in the table.
    const id = extractOrderIdFromUrl(url) || row.id || row.dataset.id || hashString(`${title}|${price}`);
    pushJob(id, title, deadline, price, url);
  });
  if (jobs.length > 0) return jobs;

  // Strategy 3: card/list elements (dropped the old `li[class]` selector —
  // it matched any styled list item anywhere on the page, including nav menus)
  scope.querySelectorAll('.order, .job, .task, div[class*="order" i], div[class*="job" i]').forEach((card) => {
    if (isNoise(card)) return;
    const title = card.querySelector('h3,h4,h5,.title,.topic,.subject')?.textContent?.trim()
                || card.textContent.trim().substring(0, 80);
    const link = card.querySelector('a')?.getAttribute('href') || '';
    const url  = resolveUrl(link);
    const id = extractOrderIdFromUrl(url) || card.id || card.dataset.id || hashString(title);
    pushJob(id, title, '', '', url);
  });

  return jobs;
}

function extractOrderIdFromUrl(url) {
  if (!url) return null;
  const patterns = [
    /[?&](?:order_?id|id|oid)=(\d+)/i,
    /\/order\/(\d+)/i,
    /\/(\d{4,})(?:[/?]|$)/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return 'h' + (h >>> 0).toString(36);
}

function resolveUrl(link) {
  if (!link) return JOBS_URL;
  if (link.startsWith('http')) return link;
  return BASE_URL + '/' + link.replace(/^\//, '');
}

async function startup() {
  try {
    const data = await chrome.storage.local.get(['enabled', 'intervalSeconds']);
    const enabled = data.enabled !== false;
    currentIntervalSeconds = data.intervalSeconds || 10;
    if (enabled) {
      startPolling();
    }
  } catch (e) {
    console.warn('Offscreen startup failed:', e);
  }
}

startup();
