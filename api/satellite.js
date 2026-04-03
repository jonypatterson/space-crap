import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60; // seconds

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Validate input
  const { lat, lng } = req.query;
  if (!lat || !lng || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
    return res.status(400).json({ error: 'Invalid or missing lat/lng parameters' });
  }

  // Rate limiting via Upstash Redis
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  const key = `ratelimit:${ip}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_WINDOW);
    }
    if (count > RATE_LIMIT) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
    }
  } catch (kvError) {
    // If Redis fails, log but don't block the request
    console.error('Redis error:', kvError);
  }

  // Fetch from N2YO — all satellites within 90° radius (entire visible sky)
  const apiKey = process.env.N2YO_API_KEY;
  const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lng}/0/90/0/?apiKey=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.error('N2YO error:', response.status, text);
      return res.status(502).json({ error: 'Failed to fetch satellite data' });
    }

    const data = await response.json();
    console.log('N2YO response keys:', Object.keys(data));
    const satellites = data.above;

    if (!satellites || satellites.length === 0) {
      return res.status(200).json({ nearest: null });
    }

    // Find the satellite with the smallest angular distance to the user
    const nearest = satellites.reduce((prev, curr) =>
      curr.angularDistance < prev.angularDistance ? curr : prev
    );

    return res.status(200).json({ nearest });
  } catch (err) {
    console.error('Satellite fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
