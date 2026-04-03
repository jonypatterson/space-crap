# NearSat — API Migration: N2YO → CelesTrak + satellite.js

**Type:** Implementation Change  
**Affects:** `/api/satellite.js`, `package.json`, Vercel environment variables  
**Reason:** N2YO API is unreliable for production use. Replacing with CelesTrak (TLE data source) + satellite.js (position calculation library) for a self-contained, dependency-free approach.

---

## Summary of Change

Instead of calling the N2YO `/above` endpoint to get satellite positions, we will:

1. Fetch a bulk TLE dataset from CelesTrak and cache it in Vercel KV (refreshed every 2 hours)
2. Use the `satellite.js` npm library to compute real-time lat/lng/altitude for every satellite in the dataset using the SGP4 algorithm
3. Compare each satellite's current position to the user's location and return the nearest one

This means **no external API call is needed at request time** — positions are computed locally in the serverless function from cached orbital data. No N2YO API key is required.

---

## What to Remove

### Environment Variables
Remove this variable from Vercel dashboard and `.env.local`:
```
N2YO_API_KEY  ← DELETE THIS
```

### Dependencies
No packages to remove, but `@vercel/kv` is still required (keep it).

---

## What to Add

### New npm Dependency
```bash
npm install satellite.js
```

Update `package.json`:
```json
{
  "name": "nearsat",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@vercel/kv": "^1.0.0",
    "satellite.js": "^5.0.0"
  }
}
```

### No New Environment Variables
CelesTrak is fully public — no API key or login required.

---

## Full Replacement: `/api/satellite.js`

Replace the entire contents of `/api/satellite.js` with the following:

```js
import { kv } from '@vercel/kv';
import * as satellite from 'satellite.js';

// --- Config ---
const RATE_LIMIT = 10;
const RATE_WINDOW = 60; // seconds
const TLE_CACHE_KEY = 'celestrak:active_tle';
const TLE_CACHE_TTL = 7200; // 2 hours in seconds

// CelesTrak URL — "active" satellites only (filters out most debris)
// Swap for a different group if desired:
// https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle
const CELESTRAK_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

// -------------------------------------------------------------------
// Parse a raw TLE text blob into an array of satellite objects
// Each TLE file is 3 lines: name, line1, line2
// -------------------------------------------------------------------
function parseTLEs(rawText) {
  const lines = rawText.trim().split('\n').map(l => l.trim());
  const sats = [];

  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const tle1 = lines[i + 1];
    const tle2 = lines[i + 2];

    if (!tle1.startsWith('1 ') || !tle2.startsWith('2 ')) continue;

    try {
      const satrec = satellite.twoline2satrec(tle1, tle2);
      sats.push({ name, tle1, tle2, satrec });
    } catch {
      // Skip malformed TLEs
    }
  }

  return sats;
}

// -------------------------------------------------------------------
// Get TLE data — from KV cache if fresh, otherwise fetch from CelesTrak
// -------------------------------------------------------------------
async function getTLEs() {
  try {
    const cached = await kv.get(TLE_CACHE_KEY);
    if (cached) return parseTLEs(cached);
  } catch {
    // Cache miss or KV error — fall through to fetch
  }

  const response = await fetch(CELESTRAK_URL);
  if (!response.ok) throw new Error('Failed to fetch TLE data from CelesTrak');

  const rawText = await response.text();

  try {
    await kv.set(TLE_CACHE_KEY, rawText, { ex: TLE_CACHE_TTL });
  } catch {
    // Cache write failure is non-fatal
  }

  return parseTLEs(rawText);
}

// -------------------------------------------------------------------
// Calculate a satellite's current position using SGP4
// Returns { lat, lng, alt } or null if propagation fails
// -------------------------------------------------------------------
function getSatellitePosition(satrec, now) {
  const positionAndVelocity = satellite.propagate(satrec, now);
  const positionEci = positionAndVelocity.position;

  if (!positionEci || typeof positionEci === 'boolean') return null;

  const gmst = satellite.gstime(now);
  const geodetic = satellite.eciToGeodetic(positionEci, gmst);

  return {
    lat: satellite.degreesLat(geodetic.latitude),
    lng: satellite.degreesLong(geodetic.longitude),
    alt: geodetic.height, // km above Earth's surface
  };
}

// -------------------------------------------------------------------
// Calculate the angular distance (degrees) between two lat/lng points
// Used to find which satellite is "closest overhead"
// -------------------------------------------------------------------
function angularDistance(lat1, lng1, lat2, lng2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * (180 / Math.PI);
}

// -------------------------------------------------------------------
// Main handler
// -------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Validate lat/lng
  const { lat, lng } = req.query;
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  if (!lat || !lng || isNaN(userLat) || isNaN(userLng)) {
    return res.status(400).json({ error: 'Invalid or missing lat/lng parameters' });
  }

  // Rate limiting
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  const rateLimitKey = `ratelimit:${ip}`;

  try {
    const count = await kv.incr(rateLimitKey);
    if (count === 1) await kv.expire(rateLimitKey, RATE_WINDOW);
    if (count > RATE_LIMIT) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
    }
  } catch {
    // Non-fatal — allow request if KV is down
  }

  // Fetch and parse TLEs
  let satellites;
  try {
    satellites = await getTLEs();
  } catch (err) {
    console.error('TLE fetch error:', err);
    return res.status(502).json({ error: 'Could not retrieve satellite data. Try again shortly.' });
  }

  if (!satellites.length) {
    return res.status(200).json({ nearest: null });
  }

  // Compute positions and find the nearest satellite
  const now = new Date();
  let nearest = null;
  let nearestDistance = Infinity;

  for (const sat of satellites) {
    const pos = getSatellitePosition(sat.satrec, now);
    if (!pos) continue;

    // Only consider satellites above the horizon (altitude > 0)
    if (pos.alt < 0) continue;

    const dist = angularDistance(userLat, userLng, pos.lat, pos.lng);

    if (dist < nearestDistance) {
      nearestDistance = dist;
      nearest = {
        name: sat.name,
        lat: parseFloat(pos.lat.toFixed(4)),
        lng: parseFloat(pos.lng.toFixed(4)),
        alt: parseFloat(pos.alt.toFixed(2)),
        angularDistance: parseFloat(dist.toFixed(2)),
        tle1: sat.tle1,
        tle2: sat.tle2,
        // Extract NORAD ID from TLE line 1 (characters 3-7)
        noradId: sat.tle1.substring(2, 7).trim(),
        // Extract launch date year from TLE line 2 international designator
        launchYear: sat.tle1.substring(9, 11).trim(),
      };
    }
  }

  return res.status(200).json({ nearest });
}
```

---

## Frontend Changes

The response shape is almost identical to before. The only differences are:

| Field | N2YO version | New version |
|---|---|---|
| `satname` | `nearest.satname` | `nearest.name` |
| `satid` | `nearest.satid` | `nearest.noradId` |
| `satlat` | `nearest.satlat` | `nearest.lat` |
| `satlng` | `nearest.satlng` | `nearest.lng` |
| `satalt` | `nearest.satalt` | `nearest.alt` |
| `launchDate` | `nearest.launchDate` | `nearest.launchYear` (2-digit year only) |
| `angularDistance` | `nearest.angularDistance` | `nearest.angularDistance` (same) |

Update `public/index.html` to use the new field names above. Everything else in the frontend (fetch call URL, error handling, render logic) stays the same.

The N2YO tracking link in the frontend can stay — the NORAD ID format is unchanged:
```
https://www.n2yo.com/satellite/?s={nearest.noradId}
```

---

## CelesTrak Dataset Options

The default config uses the `active` group (all active satellites, ~8,000 objects). You can swap the `CELESTRAK_URL` constant to target a different group if you want faster results or a specific category:

| Group | URL parameter | Count (approx) |
|---|---|---|
| All active satellites | `GROUP=active` | ~8,000 |
| Space stations (ISS etc.) | `GROUP=stations` | ~30 |
| Starlink only | `GROUP=starlink` | ~6,000 |
| Weather satellites | `GROUP=weather` | ~200 |
| GPS | `GROUP=gps-ops` | ~50 |

Example to use stations only:
```js
const CELESTRAK_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle';
```

---

## Vercel KV Storage

No changes needed to KV setup. The same KV store is used for:
- Rate limiting keys (`ratelimit:{ip}`) — same as before
- TLE cache (`celestrak:active_tle`) — new, stores the raw TLE text blob

The TLE blob for the `active` group is approximately 1.5MB. This is within Vercel KV's free tier value size limit.

---

## Local Development

For local testing, ensure `.env.local` contains your KV credentials (N2YO key can be removed):

```
KV_REST_API_URL=your_kv_url
KV_REST_API_TOKEN=your_kv_token
```

Then run:
```bash
vercel dev
```

On first request, the function will fetch TLEs from CelesTrak and cache them. Subsequent requests within 2 hours will use the cache.

---

## Deployment

No changes to `vercel.json` or deployment process. Simply:

```bash
vercel --prod
```

Remove `N2YO_API_KEY` from Vercel environment variables dashboard after deploying — it is no longer used.
