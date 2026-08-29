// ============================================================
// Academia Job Alert — content.js
// Injected into Academia pages. Shows urgent alert overlay and
// provides a one-click/one-keypress path to claim it faster.
// ============================================================

let activeOverlay = null;
let countdownInterval = null;
let scanTimer = null;
let pageObserver = null;
let seenJobIds = new Set();

// ── Listen for new job alerts / quick-claim shortcut from background.js ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'NEW_JOBS' && msg.jobs && msg.jobs.length > 0) {
    showJobAlert(msg.jobs);
  }
  if (msg.type === 'TRIGGER_CLAIM') {
    const btn = document.getElementById('aja-claim-btn');
    if (btn) btn.click();
  }
  if (msg.type === 'SCAN_NOW') {
    schedulePageScan({ delayMs: 40, source: 'manual' });
  }
});

// ── Best-effort: on the page the claim link opens, look for a flash
// message reporting whether the order was actually claimed. This is
// best-effort — it depends on the site rendering a recognizable
// success/failure banner, which we can't verify without the live site. ──
detectClaimResult();
initializePageWatcher();

function initializePageWatcher() {
  if (!document.body) return;

  if (!pageObserver) {
    pageObserver = new MutationObserver(() => schedulePageScan({ delayMs: 140, source: 'mutation' }));
    pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedulePageScan({ delayMs: 120, source: 'visibility' });
    }
  });

  window.addEventListener('focus', () => schedulePageScan({ delayMs: 120, source: 'focus' }));
  window.addEventListener('pageshow', () => schedulePageScan({ delayMs: 120, source: 'pageshow' }));

  schedulePageScan({ delayMs: 80, source: 'startup' });
}

function schedulePageScan({ delayMs = 120, source = 'scan' } = {}) {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scanPageForJobs({ source }), delayMs);
}

function scanPageForJobs({ source = 'scan' } = {}) {
  console.log(`[AJA] content-script scan (source=${source}) on ${location.href}`);
  const jobs = extractJobsFromDOM(document);
  console.log(`[AJA] content-script extracted ${jobs.length} job(s)`, jobs);
  if (!jobs.length) {
    chrome.runtime.sendMessage({ type: 'JOBS_RESULT', jobs: [] }).catch(() => {});
    return;
  }

  const newJobs = jobs.filter(job => !seenJobIds.has(job.id));
  newJobs.forEach(job => seenJobIds.add(job.id));
  chrome.runtime.sendMessage({ type: 'JOBS_RESULT', jobs }).catch(() => {});
}

// A real orders-list container has many descendants (rows, buttons, text).
// Selectors like [id*="available" i] also match small count/badge elements
// (e.g. <span id="available-order-new" class="b-count">0</span> — a nav
// badge showing the order count), which would wrongly confine every
// extraction strategy to that badge's near-empty subtree. Reject anything
// that looks like a badge/counter rather than an actual list.
const isBadgeLikeScope = (el) => {
  if (!el) return false;
  if (/\b(count|badge)\b/i.test(el.className || '')) return true;
  return el.querySelectorAll('*').length < 5;
};

function extractJobsFromDOM(doc) {
  // #orderList is the real, confirmed container (a Yii pjax fragment —
  // data-pjax-container — that gets refreshed in place when the order
  // list changes) — trust it unconditionally, even if it looks sparse
  // in an empty-orders state. The looser selectors below are unverified
  // fallbacks and still need the badge/counter heuristic applied.
  let scopeMatch = doc.querySelector('#orderList, [data-pjax-container]');
  if (!scopeMatch) {
    scopeMatch = doc.querySelector(
      '#available-orders, .available-orders, [id*="available" i], [class*="available-order" i], [class*="order-list" i], [class*="orders-list" i]'
    );
    if (isBadgeLikeScope(scopeMatch)) {
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

  const s1Candidates = scope.querySelectorAll('[data-id], [data-order-id], [data-key]');
  s1Candidates.forEach((el) => {
    if (isNoise(el)) return;
    const rawId = el.dataset.id || el.dataset.orderId || el.dataset.key;
    if (!rawId) return;
    const title = el.querySelector('.topic, .title, .subject, h4, h3, h5, td:nth-child(2)')?.textContent?.trim()
      || el.textContent.trim().substring(0, 80);
    const deadline = el.querySelector('.deadline, .due, [class*="deadline"], [class*="due"]')?.textContent?.trim() || '';
    const price = el.querySelector('.price, .budget, .pay, [class*="price"], [class*="pay"]')?.textContent?.trim() || '';
    const link = el.querySelector('a')?.getAttribute('href') || '';
    const url = resolveUrl(link);
    const id = extractOrderIdFromUrl(url) || rawId;
    pushJob(id, title, deadline, price, url);
  });
  console.log(`[AJA] strategy 1 (data-id/data-order-id/data-key): ${s1Candidates.length} candidate(s), ${jobs.length} accepted`);

  if (jobs.length > 0) return jobs;

  const s2Candidates = scope.querySelectorAll('table tbody tr');
  s2Candidates.forEach((row) => {
    if (isNoise(row)) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return;
    const title = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim();
    const deadline = cells[2]?.textContent?.trim() || '';
    const price = cells[3]?.textContent?.trim() || cells[cells.length - 1]?.textContent?.trim() || '';
    const link = row.querySelector('a')?.getAttribute('href') || '';
    const url = resolveUrl(link);
    const id = extractOrderIdFromUrl(url) || row.id || row.dataset.id || hashString(`${title}|${price}`);
    pushJob(id, title, deadline, price, url);
  });
  console.log(`[AJA] strategy 2 (table rows): ${s2Candidates.length} candidate(s), ${jobs.length} accepted`);

  if (jobs.length > 0) return jobs;

  const s3Candidates = scope.querySelectorAll('.order, .job, .task, div[class*="order" i], div[class*="job" i]');
  s3Candidates.forEach((card) => {
    if (isNoise(card)) return;
    const title = card.querySelector('h3,h4,h5,.title,.topic,.subject')?.textContent?.trim()
      || card.textContent.trim().substring(0, 80);
    const link = card.querySelector('a')?.getAttribute('href') || '';
    const url = resolveUrl(link);
    const id = extractOrderIdFromUrl(url) || card.id || card.dataset.id || hashString(title);
    pushJob(id, title, '', '', url);
  });
  console.log(`[AJA] strategy 3 (.order/.job/.task cards): ${s3Candidates.length} candidate(s), ${jobs.length} accepted`);

  if (jobs.length > 0) return jobs;

  // Last-resort fallback: generic order links inside list rows/cards, for
  // layouts where the site uses plain links instead of explicit
  // order/job classes or data attributes.
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
  if (!link) return 'https://writers.academia-research.com/index.php?r=order/index';
  if (link.startsWith('http')) return link;
  return 'https://writers.academia-research.com/' + link.replace(/^\//, '');
}

function detectClaimResult() {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem('aja_claim_pending') || 'null');
  } catch (e) {
    pending = null;
  }
  if (!pending || (Date.now() - pending.ts) > 30000) return;
  sessionStorage.removeItem('aja_claim_pending');

  const check = () => {
    const success = document.querySelector('.alert-success, [class*="alert-success" i], [class*="flash-success" i]');
    const failure = document.querySelector('.alert-danger, .alert-warning, [class*="alert-danger" i], [class*="alert-warning" i], [class*="flash-error" i]');
    if (success) {
      chrome.runtime.sendMessage({ type: 'CLAIM_RESULT', ok: true, title: pending.title, text: success.textContent.trim().substring(0, 150) });
      return true;
    }
    if (failure) {
      chrome.runtime.sendMessage({ type: 'CLAIM_RESULT', ok: false, title: pending.title, text: failure.textContent.trim().substring(0, 150) });
      return true;
    }
    return false;
  };

  if (!check()) {
    // Flash messages can render slightly after document_idle on some pages
    setTimeout(check, 1500);
  }
}

function markClaimPending(job) {
  try {
    sessionStorage.setItem('aja_claim_pending', JSON.stringify({ title: job.title, ts: Date.now() }));
  } catch (e) { /* ignore */ }
  chrome.runtime.sendMessage({ type: 'CLAIM_OPENED', job }).catch(() => {});
}

// ── Build and show the alert overlay ────────────────────────
function showJobAlert(jobs) {
  // Remove any existing overlay
  if (activeOverlay) {
    activeOverlay.remove();
    clearInterval(countdownInterval);
  }

  const firstJob = jobs[0];
  let secondsLeft = 60;

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'academia-job-alert-overlay';
  overlay.innerHTML = `
    <div class="aja-backdrop"></div>
    <div class="aja-card">
      <div class="aja-header">
        <span class="aja-pulse"></span>
        <span class="aja-title">🚨 NEW JOB ALERT</span>
        <button class="aja-close" id="aja-close-btn">✕</button>
      </div>
      <div class="aja-body">
        <div class="aja-job-count">${jobs.length} new job${jobs.length > 1 ? 's' : ''} posted!</div>
        <div class="aja-job-title">${escapeHtml(firstJob.title)}</div>
        ${firstJob.price ? `<div class="aja-job-poster">💰 ${escapeHtml(firstJob.price)}</div>` : ''}
        ${firstJob.deadline ? `<div class="aja-job-poster">⏰ Deadline: ${escapeHtml(firstJob.deadline)}</div>` : ''}
        ${jobs.length > 1 ? `<div class="aja-more">+${jobs.length - 1} more job${jobs.length - 1 > 1 ? 's' : ''}</div>` : ''}
      </div>
      <div class="aja-countdown-section">
        <div class="aja-countdown-label">TIME TO CLAIM</div>
        <div class="aja-countdown" id="aja-countdown">60</div>
        <div class="aja-countdown-bar-track">
          <div class="aja-countdown-bar" id="aja-countdown-bar"></div>
        </div>
      </div>
      <div class="aja-footer">
        <a href="${firstJob.url}" target="_blank" class="aja-claim-btn" id="aja-claim-btn">
          ⚡ CLAIM NOW <span class="aja-kbd">Enter</span>
        </a>
        ${jobs.length > 1 ? `<a href="https://writers.academia-research.com/index.php?r=order/index" target="_blank" class="aja-all-btn">View All (${jobs.length})</a>` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  activeOverlay = overlay;

  // Countdown timer
  const countdownEl = document.getElementById('aja-countdown');
  const barEl = document.getElementById('aja-countdown-bar');

  countdownInterval = setInterval(() => {
    secondsLeft--;
    if (countdownEl) countdownEl.textContent = secondsLeft;
    if (barEl) barEl.style.width = `${(secondsLeft / 60) * 100}%`;

    // Color urgency: green → yellow → red
    if (secondsLeft <= 10) {
      if (countdownEl) countdownEl.style.color = '#FF0000';
      if (barEl) barEl.style.background = '#FF0000';
    } else if (secondsLeft <= 20) {
      if (countdownEl) countdownEl.style.color = '#FF9500';
      if (barEl) barEl.style.background = '#FF9500';
    }

    if (secondsLeft <= 0) {
      clearInterval(countdownInterval);
      dismissOverlay('expired');
    }
  }, 1000);

  // Close button
  document.getElementById('aja-close-btn').addEventListener('click', () => {
    dismissOverlay('manual');
  });

  // Claim button: record that a claim was opened, for the badge/count
  // and for the best-effort result detector on the destination page.
  document.getElementById('aja-claim-btn').addEventListener('click', () => {
    markClaimPending(firstJob);
  });

  // One-keypress claim while the alert is up
  document.addEventListener('keydown', onOverlayKeydown);

  // Auto-scroll to top of page to see overlay
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function onOverlayKeydown(e) {
  if (!activeOverlay) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const btn = document.getElementById('aja-claim-btn');
    if (btn) btn.click();
  }
}

function dismissOverlay(reason) {
  clearInterval(countdownInterval);
  document.removeEventListener('keydown', onOverlayKeydown);
  if (activeOverlay) {
    activeOverlay.classList.add('aja-fade-out');
    setTimeout(() => {
      if (activeOverlay) {
        activeOverlay.remove();
        activeOverlay = null;
      }
    }, 400);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
