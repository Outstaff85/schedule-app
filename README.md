# 📅 Schedule Manager

Employee scheduling, attendance tracking and salary calculation app.

## 🚀 Features

- Weekly schedule management with drag & drop
- Client management with GPS geolocation
- Worker punch in/out with GPS verification
- Real-time sync to Google Sheets
- Salary calculation
- PWA — installable on phone
- Offline support with auto-sync

## 📁 Files

| File | Description |
|------|-------------|
| `schedule-manager.html` | Main app — schedule, clients, admin, dashboard |
| `worker-punch.html` | Worker clock in/out (mobile) |
| `service-worker.js` | PWA offline caching |
| `manifest.json` | PWA manifest for schedule-manager |
| `manifest-punch.json` | PWA manifest for worker-punch |
| `icon-192.png` | App icon 192×192 |
| `icon-512.png` | App icon 512×512 |
| `google-apps-script.js` | Google Sheets backend (paste into Apps Script) |

## ⚙️ Setup

### 1. Google Sheets
1. Create a new Google Sheet named `Schedule Manager DB`
2. Open **Extensions → Apps Script**
3. Paste contents of `google-apps-script.js`
4. Deploy as Web App → copy the URL
5. Replace `GS_URL` in both HTML files with your URL

### 2. Deploy to Netlify
Push all files to this GitHub repo — Netlify auto-deploys on every push.

### 3. Install as App (PWA)
- **Android:** Open site in Chrome → Install App
- **iPhone:** Open in Safari → Share → Add to Home Screen

## 🔗 Worker Links

Each worker gets a personal punch link:
```
https://your-site.netlify.app/worker-punch.html?worker=NAME&token=TOKEN
```

Generate tokens in Schedule Manager → Edit Worker → Copy Link 🔗
