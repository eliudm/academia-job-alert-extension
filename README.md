# Academia Job Alert

A Chrome extension (Manifest V3) that watches [writers.academia-research.com](https://writers.academia-research.com) for new orders and alerts you the moment one appears, with a fast path to claim it.

## Features

- **Background polling** — checks the order list on a real timer (as low as 3s), running in an offscreen document so it isn't subject to Chrome's 1-minute minimum alarm period.
- **Multi-channel alerts** — extension badge, OS notification, alert sound, and an on-page overlay with a 60-second claim countdown.
- **One-keypress claim** — press `Enter` while the overlay is showing, or `Alt+Shift+C` from anywhere on the tab, to jump straight to the order.
- **Best-effort claim result detection** — after you claim, it looks for a success/failure banner on the resulting page and notifies you of the outcome.
- **Self-monitoring** — warns you if it stops seeing any orders for a long stretch (likely logged out, or the site layout changed) so failures aren't silent.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Log in to `writers.academia-research.com` in a normal tab — the extension polls using your existing session cookie, it doesn't handle login itself.

## Configuration

Click the extension icon to open the popup:

- **Polling speed** — 3s / 5s / 10s / 30s. Lower is faster but sends more requests to the site.
- **Sound Alert** / **Page Overlay** — toggle individual alert channels.
- **Check Now** — force an immediate poll.
- **Clear Cache** — forget which orders have already been seen, so the next check treats everything currently listed as new.

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker. Relays results, fires notifications/badge/overlay, runs a 1-minute heartbeat to restart polling if the offscreen document ever dies. |
| `offscreen.js` | Holds the actual polling timer (`setInterval`) and the HTML parser (`DOMParser`), since service workers can't reliably keep sub-minute timers alive. |
| `content.js` | Injected into the site. Renders the alert overlay, listens for the claim shortcut, and does best-effort detection of claim success/failure. |
| `popup/` | Settings UI. |

## Known limitations

- The claim-result detection looks for common flash-message class names (`.alert-success`, `.alert-danger`, etc.). It's a best-effort guess, not verified against the live site's markup — treat the notification it produces as a hint, not a guarantee.
- Parsing the order list uses a few fallback strategies since the site's markup isn't documented; if the site changes its layout, the "no jobs detected for a while" warning should surface it.
