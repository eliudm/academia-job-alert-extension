// popup.js — Settings panel logic

const keys = ['enabled', 'intervalSeconds', 'soundEnabled', 'overlayEnabled', 'lastCheck', 'newJobCount', 'claimCount'];

async function loadSettings() {
  const data = await chrome.storage.local.get(keys);

  document.getElementById('enabled-toggle').checked = data.enabled !== false;
  document.getElementById('sound-toggle').checked = data.soundEnabled !== false;
  document.getElementById('overlay-toggle').checked = data.overlayEnabled !== false;

  // Interval buttons
  const interval = data.intervalSeconds || 10;
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.seconds) === interval);
  });

  // Status
  const lastCheck = data.lastCheck ? new Date(data.lastCheck).toLocaleTimeString() : 'Never';
  document.getElementById('last-check').textContent = lastCheck;
  document.getElementById('job-count').textContent = data.newJobCount || 0;
  document.getElementById('claim-count').textContent = data.claimCount || 0;

  // Status line
  const statusEl = document.getElementById('status-line');
  if (data.enabled === false) {
    statusEl.textContent = 'Monitoring OFF';
    statusEl.style.color = '#ff4444';
  } else {
    statusEl.textContent = `Active — checking every ${interval}s`;
    statusEl.style.color = '#00CC66';
  }
}

// Toggle enabled
document.getElementById('enabled-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ enabled });
  chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED', enabled });
  loadSettings();
});

// Sound toggle
document.getElementById('sound-toggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ soundEnabled: e.target.checked });
});

// Overlay toggle
document.getElementById('overlay-toggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ overlayEnabled: e.target.checked });
});

// Interval buttons
document.querySelectorAll('.interval-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const seconds = parseInt(btn.dataset.seconds);
    await chrome.storage.local.set({ intervalSeconds: seconds });
    chrome.runtime.sendMessage({ type: 'UPDATE_INTERVAL', intervalSeconds: seconds });
    document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadSettings();
  });
});

// Check Now button
document.getElementById('check-now-btn').addEventListener('click', async () => {
  const btn = document.getElementById('check-now-btn');
  btn.textContent = 'Checking...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'CHECK_NOW' }, () => {
    setTimeout(() => {
      btn.textContent = '⚡ Check Now';
      btn.disabled = false;
      loadSettings();
    }, 1500);
  });
});

// Clear cache
document.getElementById('clear-cache-btn').addEventListener('click', async () => {
  if (confirm('Clear job cache? Next check will treat all current jobs as new.')) {
    await chrome.storage.local.set({ knownJobIds: [], newJobCount: 0 });
    chrome.action.setBadgeText({ text: '' });
    loadSettings();
  }
});

// Load on open
loadSettings();

// Refresh every 2 seconds while popup is open
setInterval(loadSettings, 2000);
