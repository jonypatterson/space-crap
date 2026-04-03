# PRD: NearSat — Nearest Satellite Finder
**Version:** 1.0  
**Date:** 2026-04-03  
**Status:** Ready for Development

---

## 1. Overview

NearSat is a web application hosted on Vercel that detects the user's current location and displays the nearest satellite passing overhead at that exact moment in time, along with detailed information about it. The app is rate-limited to prevent API abuse and keeps all sensitive credentials server-side via Vercel Serverless Functions.

---

## 2. Goals

- Show the user the single nearest satellite above them right now
- Provide meaningful details about that satellite (name, type, altitude, speed, origin)
- Keep the N2YO API key secure (never exposed to the browser)
- Prevent abuse via IP-based rate limiting using Vercel KV
- Be fast, visually striking, and work on mobile and desktop

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JS (single `index.html`) |
| Backend | Vercel Serverless Functions (Node.js) |
| Rate Limiting | Vercel KV (Redis) |
| Satellite Data | N2YO REST API |
| Location | Browser Geolocation API |
| Hosting | Vercel (free tier) |
| Secrets | Vercel Environment Variables |

---

## 4. Project Structure

```
/nearsat
  /api
    satellite.js          ← Serverless function proxy + rate limiter
  /public
    index.html            ← Entire frontend (HTML + CSS + JS)
  .env.local              ← Local dev secrets (gitignored)
  .gitignore
  vercel.json             ← Vercel config
  package.json
  README.md
```

---

## 5. Environment Variables

These must be set in Vercel's dashboard under **Settings → Environment Variables**, and in `.env.local` for local development. They must NEVER be committed to git.

| Variable | Description |
|---|---|
| `N2YO_API_KEY` | API key from n2yo.com |
| `KV_REST_API_URL` | Provided by Vercel KV after setup |
| `KV_REST_API_TOKEN` | Provided by Vercel KV after setup |

---

## 6. API Design

### `GET /api/satellite?lat={lat}&lng={lng}`

**Purpose:** Proxies the N2YO `/above` endpoint and returns the nearest satellite.

**Request Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `lat` | float | Yes | User's latitude |
| `lng` | float | Yes | User's longitude |

**Rate Limiting:**
- 10 requests per IP address per 60 seconds
- Tracked via Vercel KV key: `ratelimit:{ip}`
- Exceeding the limit returns HTTP 429

**Success Response (200):**
```json
{
  "nearest": {
    "satname": "STARLINK-1234",
    "satid": 45678,
    "satalt": 550.2,
    "satlat": 54.2,
    "satlng": -6.1,
    "launchDate": "2020-01-07",
    "angularDistance": 4.3
  }
}
```

**Error Responses:**

| Code | Reason |
|---|---|
| 400 | Missing or invalid lat/lng |
| 429 | Rate limit exceeded |
| 500 | N2YO API failure or server error |

**Logic inside the function:**
1. Parse and validate `lat` and `lng` from query params
2. Extract IP from `x-forwarded-for` header
3. Increment a Redis counter for that IP; set 60s TTL on first hit
4. If counter > 10, return 429
5. Call N2YO `/above/{lat}/{lng}/0/90/0` (all satellites, 90° radius = entire sky)
6. From the returned list, find the satellite with the smallest `angularDistance` to the user
7. Return just that one satellite object

---

## 7. Frontend Behaviour

### Page Load
1. Show a loading state with a subtle animation
2. Call `navigator.geolocation.getCurrentPosition()`
3. If denied, show a friendly error asking the user to enable location access
4. On success, call `/api/satellite?lat=...&lng=...`
5. Display the result

### Displayed Data (per satellite)
- **Satellite Name** — e.g. "STARLINK-2571"
- **Altitude** — km above Earth's surface
- **Current Position** — lat/lng of the satellite itself
- **Angular Distance** — how many degrees away from directly overhead
- **NORAD ID** — with a link to `n2yo.com/satellite/?s={id}` for full tracking
- **Launch Date**
- **Category** — decoded from N2YO's category ID (see N2YO docs for category map)

### Refresh
- A "Check Again" button re-triggers the API call (subject to rate limit)
- Show the time the data was last fetched

### Error States
- Location denied → prompt to enable location in browser
- Rate limited → "Too many requests — try again in a moment"
- No satellites found → unlikely but handled gracefully
- API failure → generic error with retry button

---

## 8. Design Direction

The visual design should feel like a **dark space operations terminal** — not a toy, not corporate. Think deep navy/black backgrounds, monospaced data readouts, subtle grid lines, a single accent colour (electric cyan or amber), and crisp typography.

Key UI elements:
- Full-viewport dark background (near-black, not pure black)
- A central "card" or panel showing satellite details
- Satellite name in a large, bold display font
- Data fields displayed as label/value pairs in a clean monospace font
- A subtle animated element suggesting orbital movement (CSS only — a rotating ring, a pulsing dot, etc.)
- Mobile-first, fully responsive

No purple gradients. No generic sans-serif fonts. No stock icon libraries.

---

## 9. `vercel.json`

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" }
  ]
}
```

---

## 10. `package.json`

```json
{
  "name": "nearsat",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@vercel/kv": "^1.0.0"
  }
}
```

---

## 11. `.gitignore`

```
.env.local
node_modules/
.vercel/
```

---

## 12. Serverless Function — Full Implementation

**File: `/api/satellite.js`**

```js
import { kv } from '@vercel/kv';

const RATE_LIMIT = 10;
const RATE_WINDOW = 60; // seconds

export default async function handler(req, res) {
  // --- CORS headers ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- Validate input ---
  const { lat, lng } = req.query;
  if (!lat || !lng || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
    return res.status(400).json({ error: 'Invalid or missing lat/lng parameters' });
  }

  // --- Rate limiting ---
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  const key = `ratelimit:${ip}`;

  try {
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, RATE_WINDOW);
    }
    if (count > RATE_LIMIT) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
    }
  } catch (kvError) {
    // If KV fails, log but don't block the request
    console.error('KV error:', kvError);
  }

  // --- Fetch from N2YO ---
  const apiKey = process.env.N2YO_API_KEY;
  const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lng}/0/90/0/&apiKey=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to fetch satellite data' });
    }

    const data = await response.json();
    const satellites = data.above;

    if (!satellites || satellites.length === 0) {
      return res.status(200).json({ nearest: null });
    }

    // --- Find nearest satellite ---
    // N2YO returns angularDistance — find the smallest value
    const nearest = satellites.reduce((prev, curr) =>
      curr.angularDistance < prev.angularDistance ? curr : prev
    );

    return res.status(200).json({ nearest });
  } catch (err) {
    console.error('Satellite fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
```

---

## 13. Frontend — Full Implementation Spec

**File: `/public/index.html`**

This is a single self-contained HTML file. It must include:

### HTML Structure
```
<body>
  <header>         ← App name "NEARSAT" + tagline
  <main>
    <div#status>   ← Loading / error messages
    <div#result>   ← Satellite detail card (hidden until data loads)
      <h1>         ← Satellite name
      <div.data>   ← Grid of label/value pairs
      <a>          ← Link to N2YO tracking page
      <button>     ← "Check Again"
    </div>
    <div#orbital>  ← CSS animation of orbiting ring
  </main>
  <footer>         ← "Data via N2YO" attribution
</body>
```

### JavaScript Flow
```js
async function getNearestSatellite() {
  showLoading();
  const { lat, lng } = await getUserLocation();     // wraps geolocation in a Promise
  const data = await fetch(`/api/satellite?lat=${lat}&lng=${lng}`).then(r => r.json());
  if (data.error) showError(data.error);
  else renderSatellite(data.nearest);
}

function renderSatellite(sat) {
  // Populate name, altitude, lat/lng, NORAD ID, launch date, angular distance
  // Show the result card
  // Set "Last checked: HH:MM:SS"
}
```

### N2YO Category Map (decode category number to label)
```js
const CATEGORIES = {
  0: 'All', 1: 'Brightest', 2: 'ISS', 6: 'Weather',
  18: 'Amateur Radio', 22: 'GPS', 24: 'Galileo',
  32: 'Starlink', 52: 'OneWeb', 9: 'Debris', ...
};
```

---

## 14. Deployment Checklist

```
[ ] Create account at vercel.com
[ ] Create account at n2yo.com, generate API key
[ ] Run: npm install
[ ] Run: vercel login
[ ] Run: vercel link (create new project)
[ ] Add Vercel KV storage to the project (Storage tab in Vercel dashboard)
[ ] Add environment variables in Vercel dashboard:
      N2YO_API_KEY
      KV_REST_API_URL
      KV_REST_API_TOKEN
[ ] Add same vars to .env.local for local dev
[ ] Run: vercel dev  (test locally)
[ ] Run: vercel --prod  (deploy)
[ ] Visit your .vercel.app URL and test
```

---

## 15. Out of Scope (v1)

- User accounts or authentication
- History of past satellite lookups
- Push notifications for ISS passes
- 3D globe visualisation
- Multiple simultaneous satellite display
- Native mobile app

---

## 16. Possible v2 Features

- Show the top 5 nearest satellites, not just 1
- Filter by category (only show active satellites, exclude debris)
- "Notify me when ISS is overhead" — using Web Push API
- Embed a small live map showing satellite position
- Dark/light mode toggle
