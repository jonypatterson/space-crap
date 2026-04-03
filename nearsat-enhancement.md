# NearSat — Data & UI Enhancement

**Type:** Feature Enhancement  
**Affects:** `/api/satellite.js`, `/public/index.html`  
**Reason:** Switch to CelesTrak JSON format for richer data, add cached SATCAT lookup for country/size/status, and improve the UI with more fields while keeping the existing dark terminal aesthetic.

---

## Part 1 — Backend Changes (`/api/satellite.js`)

### 1.1 — Switch to JSON format

Change the CelesTrak URL from TLE text to JSON so each object includes `OBJECT_TYPE`, full `OBJECT_ID`, and all orbital parameters:

```js
// BEFORE
const CELESTRAK_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

// AFTER
const CELESTRAK_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=full-catalog&FORMAT=json';
```

### 1.2 — Update the TLE parser for JSON

Replace the `parseTLEs()` text-parsing function entirely. JSON needs no line-by-line parsing:

```js
// REMOVE the old parseTLEs() function entirely and replace with:

function parseSatellites(jsonData) {
  const sats = [];

  for (const obj of jsonData) {
    const tle1 = obj.TLE_LINE1;
    const tle2 = obj.TLE_LINE2;

    if (!tle1 || !tle2) continue;

    try {
      const satrec = satellite.twoline2satrec(tle1, tle2);
      sats.push({
        name:           obj.OBJECT_NAME,
        objectId:       obj.OBJECT_ID      || null,   // e.g. "1998-067A"
        objectType:     obj.OBJECT_TYPE    || 'UNKNOWN', // PAYLOAD / ROCKET BODY / DEBRIS / UNKNOWN
        noradId:        String(obj.NORAD_CAT_ID),
        epoch:          obj.EPOCH          || null,
        inclination:    obj.INCLINATION    || null,   // degrees
        eccentricity:   obj.ECCENTRICITY   || null,
        meanMotion:     obj.MEAN_MOTION    || null,   // orbits per day
        revAtEpoch:     obj.REV_AT_EPOCH   || null,   // total orbits completed
        bstar:          obj.BSTAR          || null,   // drag coefficient
        satrec,
        tle1,
        tle2,
      });
    } catch {
      // Skip malformed entries
    }
  }

  return sats;
}
```

### 1.3 — Update getTLEs() to parse JSON

```js
async function getTLEs() {
  try {
    const cached = await kv.get(TLE_CACHE_KEY);
    if (cached) return parseSatellites(JSON.parse(cached));
  } catch {
    // Cache miss — fall through
  }

  const response = await fetch(CELESTRAK_URL);
  if (!response.ok) throw new Error('Failed to fetch data from CelesTrak');

  const jsonData = await response.json();

  try {
    await kv.set(TLE_CACHE_KEY, JSON.stringify(jsonData), { ex: TLE_CACHE_TTL });
  } catch {
    // Non-fatal
  }

  return parseSatellites(jsonData);
}
```

### 1.4 — Add SATCAT lookup with caching

Add this new function after `getTLEs()`. It fetches country, launch date, size and status for a given NORAD ID. Results are cached in KV for 24 hours so repeat lookups are instant:

```js
async function getSatcatInfo(noradId) {
  const cacheKey = `satcat:${noradId}`;

  // Try cache first
  try {
    const cached = await kv.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss
  }

  try {
    const url = `https://celestrak.org/satcat/records.php?CATNR=${noradId}&FORMAT=json`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const record = Array.isArray(data) ? data[0] : data;

    if (!record) return null;

    const satcat = {
      country:    record.COUNTRY    || null,  // e.g. "US", "CN", "CIS"
      launchDate: record.LAUNCH_DATE || null, // e.g. "2024-01-15"
      decayDate:  record.DECAY_DATE  || null, // null if still in orbit
      size:       record.RCS_SIZE    || null, // SMALL / MEDIUM / LARGE
      status:     record.OPS_STATUS_CODE || null, // "+" = active, "-" = inactive
    };

    // Cache for 24 hours
    try {
      await kv.set(cacheKey, JSON.stringify(satcat), { ex: 86400 });
    } catch {
      // Non-fatal
    }

    return satcat;
  } catch {
    return null;
  }
}
```

### 1.5 — Update the main handler to run both in parallel

In the main `handler` function, after finding the nearest satellite, fire the SATCAT lookup in parallel with any remaining work:

```js
  // After finding `nearest` satellite, enrich with SATCAT data
  if (nearest) {
    // Run SATCAT lookup (uses cache if available — very fast)
    const satcat = await getSatcatInfo(nearest.noradId);

    if (satcat) {
      nearest.country    = satcat.country;
      nearest.launchDate = satcat.launchDate;
      nearest.decayDate  = satcat.decayDate;
      nearest.size       = satcat.size;
      nearest.status     = satcat.status;
    }

    // Derive extra fields from what we already have
    nearest.orbitalPeriod = nearest.meanMotion
      ? parseFloat((1440 / nearest.meanMotion).toFixed(1))
      : null; // minutes per orbit

    nearest.speed = nearest.meanMotion
      ? parseFloat(((nearest.meanMotion * 2 * Math.PI * (6371 + nearest.alt)) / 1440).toFixed(2))
      : null; // km/s (approximate)
  }

  return res.status(200).json({ nearest });
```

### 1.6 — Full response shape after changes

The API will now return:

```json
{
  "nearest": {
    "name":           "QIANFAN-90",
    "objectId":       "2024-207G",
    "objectType":     "PAYLOAD",
    "noradId":        "63176",
    "epoch":          "2025-03-28T10:22:14",
    "lat":            55.3,
    "lng":            -8.1,
    "alt":            1068.5,
    "angularDistance": 1.1,
    "inclination":    60.0,
    "eccentricity":   0.001,
    "meanMotion":     13.89,
    "orbitalPeriod":  103.7,
    "speed":          7.34,
    "revAtEpoch":     1420,
    "bstar":          0.000214,
    "country":        "CN",
    "launchDate":     "2024-11-06",
    "decayDate":      null,
    "size":           "SMALL",
    "status":         "+"
  }
}
```

---

## Part 2 — UI Changes (`/public/index.html`)

### 2.1 — Fix broken fields

These two fields are currently broken and must be fixed:

| Field | Old (broken) | New (fixed) |
|---|---|---|
| LAUNCHED | `nearest.launchYear` (2-digit) | `nearest.launchDate` (full date, e.g. `2024-11-06`) |
| DESIGNATOR | Was blank | `nearest.objectId` (e.g. `2024-207G`) |

### 2.2 — Add these new data rows

Add the following rows to the data panel in this order, grouped by section with a subtle divider line between groups:

**Group 1 — Identity (already shown, keep these)**
- NORAD ID
- DESIGNATOR — now fixed with `objectId`
- OBJECT TYPE — new: value from `objectType`, colour-coded (see 2.3)
- COUNTRY — new: decoded from country code (see country map below)

**Group 2 — Position (already shown, keep these)**
- ALTITUDE
- POSITION
- ANGULAR DIST

**Group 3 — Orbital mechanics (all new)**
- SPEED — `nearest.speed` + `KM/S`
- ORBITAL PERIOD — `nearest.orbitalPeriod` + `MIN`
- INCLINATION — `nearest.inclination` + `°`
- ECCENTRICITY — `nearest.eccentricity` (4 decimal places)
- TOTAL ORBITS — `nearest.revAtEpoch` (formatted with commas)

**Group 4 — Classification (all new)**
- LAUNCHED — now using full `launchDate`
- SIZE — `nearest.size` (SMALL / MEDIUM / LARGE)
- STATUS — decoded from `nearest.status` (see 2.4)
- DATA AGE — calculated from `nearest.epoch` to now, e.g. `2.3 HRS`

### 2.3 — Colour-code OBJECT TYPE

The OBJECT TYPE value should use a different colour depending on type, to make junk vs real satellites visually obvious at a glance. Use inline style or a CSS class:

```
PAYLOAD      → existing green  (#00ff9d or current green)
ROCKET BODY  → amber/orange    (#f0a500)
DEBRIS       → red/warning     (#ff4444)
UNKNOWN      → dim grey        (#666)
```

### 2.4 — Decode status and country codes

Add these two helper functions in the frontend JS:

```js
function decodeStatus(code) {
  const map = {
    '+': 'ACTIVE',
    '-': 'INACTIVE',
    'P': 'PARTIALLY ACTIVE',
    'B': 'BACKUP',
    'S': 'SPARE',
    'X': 'EXTENDED MISSION',
    'D': 'DECAYING',
    '?': 'UNKNOWN',
  };
  return map[code] || 'UNKNOWN';
}

function decodeCountry(code) {
  const map = {
    'US':  'UNITED STATES',
    'CN':  'CHINA',
    'CIS': 'RUSSIA',
    'FR':  'FRANCE',
    'ESA': 'ESA',
    'UK':  'UNITED KINGDOM',
    'IN':  'INDIA',
    'J':   'JAPAN',
    'ISS': 'INTL SPACE STATION',
    'AB':  'ARAB LEAGUE',
  };
  return map[code] || code || 'UNKNOWN';
}
```

### 2.5 — Add a type badge below the satellite name

Directly below the satellite name (currently `QIANFAN-90` in green), add a small badge showing the object type. This replaces having it buried in the data rows — it should be immediately obvious what you're looking at.

```
[ QIANFAN-90 ]        ← existing green name
  ◈ PAYLOAD           ← new badge, colour-coded per 2.3, smaller font
```

Style it as a small pill or tag — same monospace font, slightly smaller, with a left glyph (◈ for payload, ⚠ for debris, ◉ for rocket body).

### 2.6 — Add a subtle section divider between field groups

Between each group of fields, add a horizontal rule using a thin 1px line in a very low-opacity version of the existing border colour. This breaks up the data visually without adding noise. Example CSS:

```css
.divider {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  margin: 10px 0;
}
```

### 2.7 — Update the footer attribution

Change `DATA VIA N2YO.COM` to `DATA VIA CELESTRAK.ORG` since we've fully migrated away from N2YO.

### 2.8 — Show a decay warning if applicable

If `nearest.decayDate` is not null, show a warning row at the top of the data panel in amber:

```
⚠ REENTRY PREDICTED: 2025-06-12
```

This is rare but very cool when it happens — it means the object you're looking at is actively falling out of orbit.

---

## Part 3 — Suggested Aesthetic Additions

These are optional improvements that keep the existing dark terminal look but add more life to it.

### 3.1 — Animate the satellite name on load

When new data arrives, have the satellite name "type in" character by character (typewriter effect). This reinforces the terminal aesthetic and draws the eye to the most important piece of info. Pure CSS/JS, no library needed:

```js
function typewriterEffect(element, text, speed = 40) {
  element.textContent = '';
  let i = 0;
  const timer = setInterval(() => {
    element.textContent += text[i];
    i++;
    if (i >= text.length) clearInterval(timer);
  }, speed);
}
```

### 3.2 — Colour-code altitude

Rather than always showing altitude in white, tint it based on orbital zone:

```
< 600 km   → green  (very low — likely decaying soon)
600–2000   → white  (normal LEO)
2000–35786 → amber  (MEO)
> 35786    → cyan   (GEO)
```

### 3.3 — Pulsing dot next to STATUS

If status is ACTIVE, show a small pulsing green dot `●` before the value using a CSS keyframe animation. If INACTIVE or DEBRIS, show a static dim dot. Simple but effective.

```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}
.status-active::before {
  content: '● ';
  color: #00ff9d;
  animation: pulse 2s infinite;
}
```

### 3.4 — Show DATA AGE with a subtle warning if stale

If the orbital data is more than 48 hours old (from `epoch`), tint the DATA AGE value amber to indicate the position calculation may be less accurate. Add a tooltip or asterisk:

```
DATA AGE    3.2 HRS        ← normal, white
DATA AGE    61.4 HRS ⚠     ← stale, amber
```

### 3.5 — scanline / CRT overlay (subtle)

Add a very subtle CSS scanline overlay on top of the whole card using a repeating-linear-gradient pseudo-element. Keeps it looking like a real terminal screen. Opacity should be very low (0.03–0.05) so it doesn't interfere with readability:

```css
.card::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0px,
    transparent 2px,
    rgba(0,0,0,0.03) 2px,
    rgba(0,0,0,0.03) 4px
  );
  pointer-events: none;
  border-radius: inherit;
}
```

---

## Summary of All New Fields in the UI

| Field | Source | Notes |
|---|---|---|
| OBJECT TYPE | `objectType` | Colour-coded, also shown as badge |
| COUNTRY | `country` | Decoded to full name |
| SPEED | Calculated | km/s |
| ORBITAL PERIOD | Calculated | minutes |
| INCLINATION | `inclination` | degrees |
| ECCENTRICITY | `eccentricity` | 4dp |
| TOTAL ORBITS | `revAtEpoch` | formatted |
| SIZE | `size` | SMALL / MEDIUM / LARGE |
| STATUS | `status` | Decoded + pulsing dot |
| DATA AGE | `epoch` | Calculated from now, warning if stale |
| REENTRY WARNING | `decayDate` | Only shown if not null |

Existing fields that are fixed:
- LAUNCHED → now shows full date from `launchDate`
- DESIGNATOR → now shows `objectId` correctly
