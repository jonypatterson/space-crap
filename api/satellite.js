import { kv } from '@vercel/kv';
import * as satellite from 'satellite.js';

// --- Config ---
const RATE_LIMIT = 30;
const RATE_WINDOW = 60; // seconds
const TLE_CACHE_KEY = 'celestrak:active_tle';
const TLE_CACHE_TTL = 7200; // 2 hours in seconds

// TLE text format is ~1.7MB vs 6.3MB for JSON — fits in Vercel's limits
const CELESTRAK_TLE_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

// -------------------------------------------------------------------
// Parse TLE text into lightweight satellite objects for bulk search
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
// Get TLE data — from KV cache if fresh, otherwise fetch
// -------------------------------------------------------------------
async function getTLEs() {
  try {
    const cached = await kv.get(TLE_CACHE_KEY);
    if (cached) return parseTLEs(cached);
  } catch {
    // Cache miss or KV error — fall through to fetch
  }

  const response = await fetch(CELESTRAK_TLE_URL);
  if (!response.ok) throw new Error('Failed to fetch data from CelesTrak');

  const rawText = await response.text();

  try {
    await kv.set(TLE_CACHE_KEY, rawText, { ex: TLE_CACHE_TTL });
  } catch {
    // Cache write failure is non-fatal
  }

  return parseTLEs(rawText);
}

// -------------------------------------------------------------------
// Fetch rich JSON metadata for a single satellite by NORAD ID
// -------------------------------------------------------------------
async function getGPData(noradId) {
  const cacheKey = `gp:${noradId}`;

  try {
    const cached = await kv.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {}

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=json`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const obj = Array.isArray(data) ? data[0] : data;
    if (!obj) return null;

    const gpData = {
      objectId:     obj.OBJECT_ID    || null,
      objectType:   obj.OBJECT_TYPE  || 'UNKNOWN',
      epoch:        obj.EPOCH        || null,
      inclination:  obj.INCLINATION  || null,
      eccentricity: obj.ECCENTRICITY || null,
      meanMotion:   obj.MEAN_MOTION  || null,
      revAtEpoch:   obj.REV_AT_EPOCH || null,
      bstar:        obj.BSTAR        || null,
    };

    try {
      await kv.set(cacheKey, JSON.stringify(gpData), { ex: TLE_CACHE_TTL });
    } catch {}

    return gpData;
  } catch {
    return null;
  }
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

    // Map SATCAT short codes to friendly names
    const typeMap = { 'PAY': 'WORKING SATELLITE', 'R/B': 'SPENT ROCKET', 'DEB': 'JUNK', 'UNK': 'UNKNOWN' };

    const satcat = {
      objectType: typeMap[record.OBJECT_TYPE] || record.OBJECT_TYPE || null,
      country:    record.OWNER       || null,
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
// Infer mission/use from satellite name
// -------------------------------------------------------------------
function inferMission(name) {
  if (!name) return null;
  const n = name.toUpperCase();

  if (n.includes('STARLINK'))  return 'INTERNET';
  if (n.includes('ONEWEB'))    return 'INTERNET';
  if (n.includes('KUIPER'))    return 'INTERNET';
  if (n.includes('IRIDIUM'))   return 'COMMUNICATIONS';
  if (n.includes('INTELSAT'))  return 'COMMUNICATIONS';
  if (n.includes('SES'))       return 'COMMUNICATIONS';
  if (n.includes('TDRS'))      return 'COMMUNICATIONS';
  if (n.includes('ORBCOMM'))   return 'COMMUNICATIONS';
  if (n.includes('GLOBALSTAR')) return 'COMMUNICATIONS';
  if (n.includes('INMARSAT'))  return 'COMMUNICATIONS';
  if (n.includes('EUTELSAT'))  return 'COMMUNICATIONS';
  if (n.includes('VIASAT'))    return 'COMMUNICATIONS';
  if (n.includes('GPS'))       return 'NAVIGATION';
  if (n.includes('NAVSTAR'))   return 'NAVIGATION';
  if (n.includes('GLONASS'))   return 'NAVIGATION';
  if (n.includes('GALILEO'))   return 'NAVIGATION';
  if (n.includes('BEIDOU'))    return 'NAVIGATION';
  if (n.includes('NOAA'))      return 'WEATHER';
  if (n.includes('GOES'))      return 'WEATHER';
  if (n.includes('METEOSAT'))  return 'WEATHER';
  if (n.includes('METOP'))     return 'WEATHER';
  if (n.includes('FENGYUN'))   return 'WEATHER';
  if (n.includes('HIMAWARI'))  return 'WEATHER';
  if (n.includes('SUOMI'))     return 'WEATHER';
  if (n.includes('DMSP'))      return 'WEATHER';
  if (n.includes('LANDSAT'))   return 'EARTH OBSERVATION';
  if (n.includes('SENTINEL'))  return 'EARTH OBSERVATION';
  if (n.includes('WORLDVIEW')) return 'EARTH OBSERVATION';
  if (n.includes('PLANET'))    return 'EARTH OBSERVATION';
  if (n.includes('DOVE'))      return 'EARTH OBSERVATION';
  if (n.includes('FLOCK'))     return 'EARTH OBSERVATION';
  if (n.includes('SKYSAT'))    return 'EARTH OBSERVATION';
  if (n.includes('ICEYE'))     return 'EARTH OBSERVATION';
  if (n.includes('CAPELLA'))   return 'EARTH OBSERVATION';
  if (n.includes('YAOGAN'))    return 'RECONNAISSANCE';
  if (n.includes('USA '))      return 'MILITARY';
  if (n.includes('NROL'))      return 'MILITARY';
  if (n.includes('COSMOS'))    return 'MILITARY';
  if (n.includes('KOSMOS'))    return 'MILITARY';
  if (n.includes('QIANFAN'))   return 'INTERNET';
  if (n.includes('HUBBLE'))    return 'SPACE TELESCOPE';
  if (n.includes('JWST'))      return 'SPACE TELESCOPE';
  if (n.includes('CHANDRA'))   return 'SPACE TELESCOPE';
  if (n.includes('ISS'))       return 'SPACE STATION';
  if (n.includes('ZARYA'))     return 'SPACE STATION';
  if (n.includes('TIANHE'))    return 'SPACE STATION';
  if (n.includes('CSS'))       return 'SPACE STATION';
  if (n.includes('SPACEBEE'))  return 'IOT';
  if (n.includes('LEMUR'))     return 'WEATHER';
  if (n.includes('HAWK'))      return 'SIGNALS INTELLIGENCE';
  if (n.includes('UMBRA'))     return 'EARTH OBSERVATION';

  // Amateur radio
  if (n.includes('CUPID'))     return 'AMATEUR RADIO';
  if (n.includes('AMSAT'))     return 'AMATEUR RADIO';
  if (n.includes('OSCAR'))     return 'AMATEUR RADIO';
  if (n.includes('FUNCUBE'))   return 'AMATEUR RADIO';
  if (n.includes('CUBESAT'))   return 'AMATEUR RADIO';
  if (n.includes('FOX-1'))     return 'AMATEUR RADIO';
  if (n.includes('UVSQ-SAT')) return 'AMATEUR RADIO';
  if (n.includes('TEVEL'))     return 'AMATEUR RADIO';
  if (n.includes('GREENCUBE')) return 'AMATEUR RADIO';
  if (n.includes('JY1SAT'))    return 'AMATEUR RADIO';
  if (n.includes('HAMSAT'))    return 'AMATEUR RADIO';
  if (n.includes('STRAND'))    return 'AMATEUR RADIO';
  if (n.includes('ESHAIL'))    return 'AMATEUR RADIO';
  if (n.includes('QO-100'))    return 'AMATEUR RADIO';
  if (n.includes('SAUDISAT'))  return 'AMATEUR RADIO';
  if (n.includes('PCSAT'))     return 'AMATEUR RADIO';
  if (n.includes('DIWATA'))    return 'EARTH OBSERVATION';
  if (n.includes('SWARM'))     return 'IOT';
  if (n.includes('KEPLER'))    return 'IOT';
  if (n.includes('ASTRA'))     return 'COMMUNICATIONS';
  if (n.includes('TELESAT'))   return 'COMMUNICATIONS';
  if (n.includes('O3B'))       return 'INTERNET';
  if (n.includes('CBERS'))     return 'EARTH OBSERVATION';
  if (n.includes('RESOURCESAT')) return 'EARTH OBSERVATION';
  if (n.includes('CARTOSAT'))  return 'EARTH OBSERVATION';
  if (n.includes('OCEANSAT'))  return 'EARTH OBSERVATION';
  if (n.includes('SARAL'))     return 'EARTH OBSERVATION';
  if (n.includes('ASTROSAT'))  return 'SPACE TELESCOPE';

  return null;
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
        noradId: sat.tle1.substring(2, 7).trim(),
        lat: parseFloat(pos.lat.toFixed(4)),
        lng: parseFloat(pos.lng.toFixed(4)),
        alt: parseFloat(pos.alt.toFixed(2)),
        angularDistance: parseFloat(dist.toFixed(2)),
        tle1: sat.tle1,
        tle2: sat.tle2,
      };
    }
  }

  // Enrich nearest with rich metadata from individual lookups
  if (nearest) {
    const [gpData, satcat] = await Promise.all([
      getGPData(nearest.noradId),
      getSatcatInfo(nearest.noradId),
    ]);

    if (gpData) {
      nearest.objectId     = gpData.objectId;
      nearest.objectType   = gpData.objectType;
      nearest.epoch        = gpData.epoch;
      nearest.inclination  = gpData.inclination;
      nearest.eccentricity = gpData.eccentricity;
      nearest.meanMotion   = gpData.meanMotion;
      nearest.revAtEpoch   = gpData.revAtEpoch;
      nearest.bstar        = gpData.bstar;
    }

    if (satcat) {
      nearest.objectType = satcat.objectType || nearest.objectType;
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

    // Infer mission/use from satellite name
    nearest.mission = inferMission(nearest.name);
  }

  return res.status(200).json({ nearest });
}
