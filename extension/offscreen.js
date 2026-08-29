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
const JOBS_URL = 'https://writers.academia-research.com/index.php?r=order/index';

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
    console.log(`[AJA] polling ${JOBS_URL}`);
    const response = await fetch(JOBS_URL, {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache'
      }
    });

    console.log(`[AJA] response status=${response.status} ok=${response.ok} finalUrl=${response.url}`);

    if (response.status === 401 || response.status === 403) {
      console.warn('[AJA] treated as logged out (401/403)');
      chrome.runtime.sendMessage({ type: 'LOGIN_REQUIRED' }).catch(() => {});
      return;
    }
    if (!response.ok) {
      chrome.runtime.sendMessage({ type: 'FETCH_ERROR', status: response.status }).catch(() => {});
      return;
    }

    // fetch() follows redirects automatically — if the session was invalid,
    // Yii-style apps 302 the request to the login controller, and
    // response.url reflects that final landing URL. This is a much more
    // reliable "are we actually logged out" signal than searching the page
    // text for login-related words: many app layouts embed a hidden
    // "session expired, log back in" modal on every page (logged in or
    // not), which made the old text-based check misfire as logged-out on
    // the real, logged-in orders page and skip extraction entirely.
    const redirectedToLogin = /[?&]r=(account|site)%2F(login|auth)|[?&]r=(account|site)\/(login|auth)/i.test(response.url);
    if (redirectedToLogin) {
      console.warn(`[AJA] treated as logged out (redirected to ${response.url})`);
      chrome.runtime.sendMessage({ type: 'LOGIN_REQUIRED' }).catch(() => {});
      return;
    }

    const html = await response.text();
    console.log(`[AJA] fetched ${html.length} chars of HTML`);

    const jobs = extractJobsFromHTML(html);
    console.log(`[AJA] extracted ${jobs.length} job(s)`, jobs);
    chrome.runtime.sendMessage({ type: 'JOBS_RESULT', jobs }).catch(() => {});
  } catch (err) {
    console.error('[AJA] poll failed:', err);
    chrome.runtime.sendMessage({ type: 'FETCH_ERROR', error: err.message }).catch(() => {});
  }
}

// ── HTML parser — full DOM available here ────────────────────
function extractJobsFromHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // #orderList is the real, confirmed container (a Yii pjax fragment —
  // data-pjax-container — that gets refreshed in place when the order
  // list changes) — trust it unconditionally, even if it looks sparse in
  // an empty-orders state. The looser selectors below are unverified
  // fallbacks: they also match small count/badge elements (e.g.
  // <span id="available-order-new" class="b-count">0</span> — a nav badge
  // showing the order count), so they still need the badge/counter
  // heuristic applied to avoid confining every strategy to that near-empty
  // subtree.
  let scopeMatch = doc.querySelector('#orderList, [data-pjax-container]');
  if (!scopeMatch) {
    scopeMatch = doc.querySelector(
      '#available-orders, .available-orders, [id*="available" i], [class*="available-order" i], [class*="order-list" i], [class*="orders-list" i]'
    );
    if (scopeMatch && (/\b(count|badge)\b/i.test(scopeMatch.className || '') || scopeMatch.querySelectorAll('*').length < 5)) {
      console.log(`[AJA] rejected scope <${scopeMatch.tagName.toLowerCase()} id="${scopeMatch.id}" class="${scopeMatch.className}"> — looks like a count/badge, not a list`);
      scopeMatch = null;
    }
  }
  const scope = scopeMatch || doc;
  console.log(scopeMatch
    ? `[AJA] scoped to <${scopeMatch.tagName.toLowerCase()} id="${scopeMatch.id}" class="${scopeMatch.className}">`
    : '[AJA] no scoped container matched — searching whole document');

  const jobs = [];
  const seenIds = new Set();

  const pushJob = (id, title, deadline, price, url) => {
    if (!id || seenIds.has(id)) return;
    if (!title || title.trim().length < 2) return;
    seenIds.add(id);
    jobs.push({ id: String(id), title: title.trim(), deadline: (deadline || '').trim(), price: (price || '').trim(), url });
  };

  // [role="alert"] / .b-order-danger etc. are static warning banners (e.g.
  // "you have a suspended order") — their class happens to contain "order"
  // too, so without this they'd be picked up as fake jobs by the
  // class*="order" card strategy the moment the page has one showing.
  const isNoise = (el) => !!el.closest(
    'nav, header, footer, .navbar, .menu, .sidebar, [class*="footer" i], [class*="header" i], .pagination, .dropdown, .modal, [role="alert"], [class*="disclaimer" i], [class*="danger" i], [class*="warning" i]'
  );

  // Requires an actual order id in the URL (not just the word "order"
  // anywhere) — otherwise this matches generic page links like a
  // breadcrumb or "back to available orders" link, which produces one
  // fake, stable "job" that short-circuits real detection forever.
  const looksLikeOrderLink = (url) => {
    if (!url) return false;
    const normalized = url.toLowerCase();
    return /\/order\/\d+/.test(normalized) || /[?&](?:order_?id|oid)=\d+/.test(normalized);
  };

  const extractTitleFromContainer = (container, fallbackLink) => {
    const heading = container.querySelector('h1, h2, h3, h4, h5, .title, .topic, .subject, .name, .order-title, .job-title');
    const headingText = heading?.textContent?.trim();
    if (headingText) return headingText;
    const fallbackText = (fallbackLink?.textContent || container.textContent || '').trim();
    return fallbackText.replace(/\s+/g, ' ').substring(0, 140);
  };

  // Strategy 1: elements with data-id / data-order-id / data-key
  const s1Candidates = scope.querySelectorAll('[data-id], [data-order-id], [data-key]');
  s1Candidates.forEach(el => {
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
  console.log(`[AJA] strategy 1 (data-id/data-order-id/data-key): ${s1Candidates.length} candidate(s), ${jobs.length} accepted`);
  if (jobs.length > 0) return jobs;

  // Strategy 2: table rows
  const s2Candidates = scope.querySelectorAll('table tbody tr');
  s2Candidates.forEach((row) => {
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
  console.log(`[AJA] strategy 2 (table rows): ${s2Candidates.length} candidate(s), ${jobs.length} accepted`);
  if (jobs.length > 0) return jobs;

  // Strategy 3: card/list elements (dropped the old `li[class]` selector —
  // it matched any styled list item anywhere on the page, including nav menus)
  const s3Candidates = scope.querySelectorAll('.order, .job, .task, div[class*="order" i], div[class*="job" i]');
  s3Candidates.forEach((card) => {
    if (isNoise(card)) return;
    const title = card.querySelector('h3,h4,h5,.title,.topic,.subject')?.textContent?.trim()
                || card.textContent.trim().substring(0, 80);
    const link = card.querySelector('a')?.getAttribute('href') || '';
    const url  = resolveUrl(link);
    const id = extractOrderIdFromUrl(url) || card.id || card.dataset.id || hashString(title);
    pushJob(id, title, '', '', url);
  });
  console.log(`[AJA] strategy 3 (.order/.job/.task cards): ${s3Candidates.length} candidate(s), ${jobs.length} accepted`);
  if (jobs.length > 0) return jobs;

  // Strategy 4 (last resort): generic order links inside list rows/cards.
  // This catches layouts where the site uses plain links instead of
  // explicit order/job classes or data attributes.
  const s4Candidates = scope.querySelectorAll('a[href], button[data-href]');
  s4Candidates.forEach((link) => {
    const href = link.getAttribute('href') || link.getAttribute('data-href') || '';
    if (!looksLikeOrderLink(href)) return;
    const container = link.closest('li, tr, td, article, section, div, span');
    if (!container || isNoise(container)) return;
    const title = extractTitleFromContainer(container, link);
    const url = resolveUrl(href);
    const id = extractOrderIdFromUrl(url) || link.id || link.dataset.id || hashString(`${title}|${url}`);
    pushJob(id, title, '', '', url);
  });
  console.log(`[AJA] strategy 4 (generic order/job links): ${s4Candidates.length} total link(s) scanned, ${jobs.length} accepted`);

  if (jobs.length === 0) {
    console.warn('[AJA] no strategy matched anything — dumping first 500 chars of scope HTML for inspection:');
    console.warn(scope.innerHTML ? scope.innerHTML.substring(0, 500) : '(scope has no innerHTML — was the whole document)');
  }

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
