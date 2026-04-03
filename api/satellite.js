import { kv } from '@vercel/kv';
import * as satellite from 'satellite.js';

// --- Config ---
const RATE_LIMIT = 10;
const RATE_WINDOW = 60; // seconds
const TLE_CACHE_KEY = 'celestrak:active_tle';
const TLE_CACHE_TTL = 7200; // 2 hours in seconds

const CELESTRAK_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=full-catalog&FORMAT=json';

// -------------------------------------------------------------------
// Parse CelesTrak JSON into satellite objects
// -------------------------------------------------------------------
function parseSatellites(jsonData) {
  const sats = [];

  for (const obj of jsonData) {
    const tle1 = obj.TLE_LINE1;
    const tle2 = obj.TLE_LINE2;

    if (!tle1 || !tle2) continue;

    try {
      const satrec = satellite.twoline2satrec(tle1, tle2);
      sats.push({
        name:         obj.OBJECT_NAME,
        objectId:     obj.OBJECT_ID      || null,
        objectType:   obj.OBJECT_TYPE    || 'UNKNOWN',
        noradId:      String(obj.NORAD_CAT_ID),
        epoch:        obj.EPOCH          || null,
        inclination:  obj.INCLINATION    || null,
        eccentricity: obj.ECCENTRICITY   || null,
        meanMotion:   obj.MEAN_MOTION    || null,
        revAtEpoch:   obj.REV_AT_EPOCH   || null,
        bstar:        obj.BSTAR          || null,
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

// -------------------------------------------------------------------
// Get satellite data — from KV cache if fresh, otherwise fetch
// -------------------------------------------------------------------
async function getTLEs() {
  try {
    const cached = await kv.get(TLE_CACHE_KEY);
    if (cached) return parseSatellites(JSON.parse(cached));
  } catch {
    // Cache miss or KV error — fall through to fetch
  }

  const response = await fetch(CELESTRAK_URL);
  if (!response.ok) throw new Error('Failed to fetch data from CelesTrak');

  const jsonData = await response.json();

  try {
    await kv.set(TLE_CACHE_KEY, JSON.stringify(jsonData), { ex: TLE_CACHE_TTL });
  } catch {
    // Cache write failure is non-fatal
  }

  return parseSatellites(jsonData);
}

// -------------------------------------------------------------------
// SATCAT lookup with caching
// -------------------------------------------------------------------
async function getSatcatInfo(noradId) {
  const cacheKey = `satcat:${noradId}`;

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
      country:    record.COUNTRY     || null,
      launchDate: record.LAUNCH_DATE || null,
      decayDate:  record.DECAY_DATE  || null,
      size:       record.RCS_SIZE    || null,
      status:     record.OPS_STATUS_CODE || null,
    };

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

// -------------------------------------------------------------------
// Calculate a satellite's current position using SGP4
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
// Angular distance (degrees) between two lat/lng points
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
        objectId: sat.objectId,
        objectType: sat.objectType,
        noradId: sat.noradId,
        epoch: sat.epoch,
        lat: parseFloat(pos.lat.toFixed(4)),
        lng: parseFloat(pos.lng.toFixed(4)),
        alt: parseFloat(pos.alt.toFixed(2)),
        angularDistance: parseFloat(dist.toFixed(2)),
        inclination: sat.inclination,
        eccentricity: sat.eccentricity,
        meanMotion: sat.meanMotion,
        revAtEpoch: sat.revAtEpoch,
        bstar: sat.bstar,
        tle1: sat.tle1,
        tle2: sat.tle2,
      };
    }
  }

  // Enrich with SATCAT data
  if (nearest) {
    const satcat = await getSatcatInfo(nearest.noradId);

    if (satcat) {
      nearest.country    = satcat.country;
      nearest.launchDate = satcat.launchDate;
      nearest.decayDate  = satcat.decayDate;
      nearest.size       = satcat.size;
      nearest.status     = satcat.status;
    }

    // Derived fields
    nearest.orbitalPeriod = nearest.meanMotion
      ? parseFloat((1440 / nearest.meanMotion).toFixed(1))
      : null;

    nearest.speed = nearest.meanMotion
      ? parseFloat(((nearest.meanMotion * 2 * Math.PI * (6371 + nearest.alt)) / 1440).toFixed(2))
      : null;
  }

  return res.status(200).json({ nearest });
}
