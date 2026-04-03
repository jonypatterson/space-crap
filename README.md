# NEARSAT — Nearest Satellite Overhead

A web app that detects your location and shows the nearest satellite passing overhead right now. Built with a dot-matrix LED display aesthetic.

## Tech Stack

- **Frontend:** HTML, CSS, Vanilla JS (single `index.html`)
- **Backend:** Vercel Serverless Functions (Node.js)
- **Rate Limiting:** Vercel KV (Redis)
- **Satellite Data:** [N2YO REST API](https://www.n2yo.com/api/)
- **Location:** Browser Geolocation API

## Setup

### 1. Get an N2YO API Key

1. Create a free account at [n2yo.com](https://www.n2yo.com/api/)
2. Copy your API key from the dashboard

### 2. Install Dependencies

```sh
npm install
```

### 3. Set Up Vercel

```sh
vercel login
vercel link   # create/link a new project
```

### 4. Add Upstash Redis

1. Go to your project in the [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to **Storage** → browse the Marketplace for **Upstash Redis**
3. Connect it to your project — this auto-provisions `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

### 5. Set Environment Variables

Add these in the Vercel Dashboard under **Settings → Environment Variables**:

- `N2YO_API_KEY` — your N2YO API key

The Upstash Redis variables are auto-added when you connect the store.

For local development, create `.env.local`:

```
N2YO_API_KEY=your_key_here
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token
```

### 6. Run Locally

```sh
vercel dev
```

### 7. Deploy

```sh
vercel --prod
```

## Rate Limiting

- 10 requests per IP per 60 seconds
- Enforced via Upstash Redis
- Returns HTTP 429 when exceeded

## API

### `GET /api/satellite?lat={lat}&lng={lng}`

Returns the nearest satellite overhead. See `satellite-finder-PRD.md` for full API docs.
