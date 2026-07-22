// ============================================================
// Academia Job Alert — content.js
// Injected into Academia pages. Shows urgent alert overlay and
// provides a one-click/one-keypress path to claim it faster.
// ============================================================

let activeOverlay = null;
let countdownInterval = null;

// ── Listen for new job alerts / quick-claim shortcut from background.js ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'NEW_JOBS' && msg.jobs && msg.jobs.length > 0) {
    showJobAlert(msg.jobs);
  }
  if (msg.type === 'TRIGGER_CLAIM') {
    const btn = document.getElementById('aja-claim-btn');
    if (btn) btn.click();
  }
});

// ── Best-effort: on the page the claim link opens, look for a flash
// message reporting whether the order was actually claimed. This is
// best-effort — it depends on the site rendering a recognizable
// success/failure banner, which we can't verify without the live site. ──
detectClaimResult();

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
        ${jobs.length > 1 ? `<a href="https://writers.academia-research.com/index.php?r=order/available" target="_blank" class="aja-all-btn">View All (${jobs.length})</a>` : ''}
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
