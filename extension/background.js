// ============================================================
// Academia Job Alert — background.js (Service Worker)
// Relays results from offscreen.js's polling loop, triggers
// alerts, and runs a 1-min heartbeat alarm to resurrect the
// offscreen document if Chrome ever kills it.
// ============================================================

const HEARTBEAT_ALARM = 'academia_heartbeat';
const JOBS_URL = 'https://writers.academia-research.com/index.php?r=order/index';

// How many consecutive empty polls before we warn the user that
// detection may be silently broken (logged out / layout changed).
const EMPTY_POLL_WARNING_THRESHOLD = 12;

// ── On install: set defaults and start the engine ───────────
chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    enabled: true,
    intervalSeconds: 5,
    soundEnabled: true,
    overlayEnabled: true,
    knownJobIds: [],
    lastCheck: null,
    newJobCount: 0,
    claimCount: 0,
    consecutiveEmpty: 0
  };
  const existing = await chrome.storage.local.get(Object.keys(defaults));
  const merged = { ...defaults, ...existing };
  await chrome.storage.local.set(merged);
});

// ── On browser start: ensure the offscreen polling engine is running.
chrome.runtime.onStartup.addListener(async () => {
  await startPollingIfEnabled();
});

chrome.runtime.onInstalled.addListener(async () => {
  await startPollingIfEnabled();
});

// ── Ensure offscreen document exists ────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['DOM_PARSER'],
    justification: 'Poll Academia job listings, parse HTML, and play alert sounds'
  });
}

async function startPollingIfEnabled() {
  const { enabled, intervalSeconds } = await chrome.storage.local.get(['enabled', 'intervalSeconds']);
  if (!enabled) return;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'START_POLLING', intervalSeconds: intervalSeconds || 10 }).catch(() => {});
}

async function stopPolling() {
  chrome.runtime.sendMessage({ type: 'STOP_POLLING' }).catch(() => {});
}

// ── Process a batch of parsed jobs from offscreen.js ────────
async function processJobsResult(jobs) {
  await chrome.storage.local.set({ lastCheck: new Date().toISOString() });

  if (jobs.length === 0) {
    const { consecutiveEmpty } = await chrome.storage.local.get('consecutiveEmpty');
    const count = (consecutiveEmpty || 0) + 1;
    await chrome.storage.local.set({ consecutiveEmpty: count });
    if (count === EMPTY_POLL_WARNING_THRESHOLD) {
      chrome.notifications.create('possible_layout_change', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Academia Job Alert — Nothing Detected',
        message: "No orders seen in a while. Check that you're still logged in — the site layout may also have changed.",
        priority: 1
      });
    }
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.storage.local.set({ consecutiveEmpty: 0 });

  const { knownJobIds } = await chrome.storage.local.get('knownJobIds');
  const knownSet = new Set(knownJobIds || []);
  const newJobs = jobs.filter(job => !knownSet.has(job.id));

  await chrome.storage.local.set({ knownJobIds: jobs.map(j => j.id) });

  if (newJobs.length > 0) {
    await triggerAlerts(newJobs);
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Trigger all alert channels ───────────────────────────────
async function triggerAlerts(newJobs) {
  const { soundEnabled, overlayEnabled } = await chrome.storage.local.get(['soundEnabled', 'overlayEnabled']);

  // 1. Badge
  chrome.action.setBadgeText({ text: String(newJobs.length) });
  chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });

  // 2. OS notification
  const firstJob = newJobs[0];
  const detail = [firstJob.price, firstJob.deadline].filter(Boolean).join(' · ') || 'New order available';
  chrome.notifications.create(`job_${firstJob.id}_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `🚨 ${newJobs.length} NEW ORDER${newJobs.length > 1 ? 'S' : ''} — ACT NOW!`,
    message: `"${firstJob.title}"`,
    contextMessage: `${detail} — 60s to claim!`,
    priority: 2,
    requireInteraction: true
  });

  // 3. Overlay + tab focus — this is the actual claim surface, so it gets
  // top priority. Query tabs once and reuse it, and don't let anything
  // else (sound, storage writes) sit in front of it.
  const tabsPromise = chrome.tabs.query({ url: 'https://writers.academia-research.com/*' });

  // 4. Sound via offscreen document — fire-and-forget. Previously this was
  // awaited before the overlay was dispatched, so a cold offscreen
  // document could delay the on-page alert behind audio setup.
  if (soundEnabled) {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: 'PLAY_SOUND', volume: 1.0 }))
      .catch(e => console.warn('Sound failed:', e));
  }

  const tabs = await tabsPromise;
  if (overlayEnabled) {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'NEW_JOBS', jobs: newJobs }).catch(() => {});
    }
  }
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  }

  // 5. Log count — not on the critical path, don't block on it
  chrome.storage.local.get('newJobCount').then(({ newJobCount }) => {
    chrome.storage.local.set({ newJobCount: (newJobCount || 0) + newJobs.length });
  });
}

// ── Login reminder ────────────────────────────────────────────
async function notifyLoginRequired() {
  chrome.notifications.create('login_required', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Academia Job Alert — Login Required',
    message: 'Please log in to academia-research.com to continue monitoring.',
    priority: 1
  });
}

// ── Notification click ────────────────────────────────────────
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  const tabs = await chrome.tabs.query({ url: 'https://writers.academia-research.com/*' });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: JOBS_URL });
  }
});

// ── Quick-claim keyboard shortcut (Alt+Shift+C) ───────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-claim') return;
  const tabs = await chrome.tabs.query({ url: 'https://writers.academia-research.com/*' });
  if (tabs.length > 0) {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_CLAIM' }).catch(() => {});
  }
});

// ── Messages from offscreen.js, content.js, and popup.js ─────
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {

  if (msg.type === 'JOBS_RESULT') {
    processJobsResult(msg.jobs || []);
    return false;
  }
  if (msg.type === 'LOGIN_REQUIRED') {
    notifyLoginRequired();
    return false;
  }
  if (msg.type === 'FETCH_ERROR') {
    console.warn('Academia fetch failed:', msg.status || msg.error);
    return false;
  }

  if (msg.type === 'CLAIM_OPENED') {
    chrome.storage.local.get('claimCount').then(({ claimCount }) => {
      chrome.storage.local.set({ claimCount: (claimCount || 0) + 1 });
    });
    chrome.action.setBadgeText({ text: '' });
    return false;
  }
  if (msg.type === 'CLAIM_RESULT') {
    chrome.notifications.create(`claim_result_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: msg.ok ? '✅ Job Claimed' : '⚠️ Claim May Have Failed',
      message: msg.title ? `"${msg.title}"` : 'Order claim attempt',
      contextMessage: msg.text || '',
      priority: msg.ok ? 1 : 2
    });
    return false;
  }

  if (msg.type === 'CHECK_NOW') {
    await startPollingIfEnabled();
    await new Promise(resolve => setTimeout(resolve, 400));
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }).catch(() => {});
      }
      sendResponse({ success: true });
    }).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (msg.type === 'UPDATE_INTERVAL') {
    chrome.storage.local.set({ intervalSeconds: msg.intervalSeconds || 5 }).catch(() => {});
    await startPollingIfEnabled();
    sendResponse({ success: true });
    return false;
  }
  if (msg.type === 'TOGGLE_ENABLED') {
    chrome.storage.local.set({ enabled: !!msg.enabled }).catch(() => {});
    chrome.action.setBadgeText({ text: '' });
    if (msg.enabled) {
      await startPollingIfEnabled();
    } else {
      stopPolling();
    }
    sendResponse({ success: true });
    return false;
  }
});
