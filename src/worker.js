// Skywatch Live — Cloudflare Worker.
// Serves the static app from ./public and exposes a small JSON API that proxies
// free upstream weather services, caching responses at Cloudflare's edge.
//
//   GET /api/locate                     best-guess location of the visitor (from Cloudflare's request.cf)
//   GET /api/weather?lat=&lon=&units=   current conditions, 15-min nowcast, 48h hourly and 7-day forecast
//   GET /api/geocode?q=                 place search
//   GET /api/reverse?lat=&lon=          place name for a coordinate
//   GET /api/radar                      latest precipitation radar frames (RainViewer)

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE = "https://nominatim.openstreetmap.org/reverse";
const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
const USER_AGENT = "SkywatchLive/1.0 (+https://github.com/bell4301969-cell/skywatch)";

const CURRENT_VARS = [
  "temperature_2m", "relative_humidity_2m", "apparent_temperature", "is_day", "precipitation",
  "weather_code", "cloud_cover", "pressure_msl", "wind_speed_10m", "wind_direction_10m",
  "wind_gusts_10m", "dew_point_2m", "uv_index", "visibility"
];
const HOURLY_VARS = [
  "temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation",
  "weather_code", "wind_speed_10m", "wind_direction_10m", "relative_humidity_2m", "uv_index", "is_day"
];
const DAILY_VARS = [
  "weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
  "precipitation_probability_max", "wind_speed_10m_max", "wind_direction_10m_dominant",
  "sunrise", "sunset", "uv_index_max"
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    try {
      switch (url.pathname) {
        case "/api/locate": return locate(request);
        case "/api/weather": return await weather(url, ctx);
        case "/api/geocode": return await geocode(url, ctx);
        case "/api/reverse": return await reverse(url, ctx);
        case "/api/radar": return await radar(ctx);
        default: return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      return json({ error: "Upstream service unavailable" }, 502);
    }
  }
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store"
    }
  });
}

export function parseCoords(url) {
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!url.searchParams.has("lat") || !url.searchParams.has("lon") ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, "lat and lon are required and must be valid coordinates");
  }
  // ~1 km precision keeps the edge cache effective without changing the forecast.
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

// Fetch JSON from an upstream, caching the response in Cloudflare's edge cache for `ttl` seconds.
async function cachedJson(upstream, ttl, ctx) {
  const cache = caches.default;
  const key = new Request(upstream, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const res = await fetch(upstream, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) throw new HttpError(502, `Upstream returned ${res.status}`);
  const body = await res.text();
  ctx.waitUntil(cache.put(key, new Response(body, {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` }
  })));
  return JSON.parse(body);
}

function locate(request) {
  const cf = request.cf || {};
  const lat = Number(cf.latitude), lon = Number(cf.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    // Local dev or unknown: fall back to London.
    return json({ lat: 51.5074, lon: -0.1278, name: "London", region: "England", country: "GB", approximate: true });
  }
  return json({
    lat, lon,
    name: cf.city || "Your location",
    region: cf.region || "",
    country: cf.country || "",
    approximate: true
  });
}

export function buildForecastUrl({ lat, lon }, units) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: CURRENT_VARS.join(","),
    minutely_15: "precipitation",
    forecast_minutely_15: "8",
    hourly: HOURLY_VARS.join(","),
    forecast_hours: "48",
    daily: DAILY_VARS.join(","),
    forecast_days: "7",
    timezone: "auto"
  });
  if (units === "imperial") {
    params.set("temperature_unit", "fahrenheit");
    params.set("wind_speed_unit", "mph");
    params.set("precipitation_unit", "inch");
  } else {
    params.set("wind_speed_unit", "kmh");
  }
  return `${OPEN_METEO}?${params}`;
}

async function weather(url, ctx) {
  const coords = parseCoords(url);
  const units = url.searchParams.get("units") === "imperial" ? "imperial" : "metric";
  // Open-Meteo refreshes current conditions every 15 minutes; 5 minutes keeps us close to real time.
  const data = await cachedJson(buildForecastUrl(coords, units), 300, ctx);
  return json({ ...data, units, fetchedAt: new Date().toISOString() }, 200, 60);
}

async function geocode(url, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ results: [] });
  if (q.length > 100) throw new HttpError(400, "Query too long");
  const params = new URLSearchParams({ name: q, count: "8", language: "en", format: "json" });
  const data = await cachedJson(`${GEOCODE}?${params}`, 86400, ctx);
  const results = (data.results || []).map((r) => ({
    name: r.name,
    region: r.admin1 || "",
    country: r.country_code || r.country || "",
    lat: r.latitude,
    lon: r.longitude
  }));
  return json({ results }, 200, 3600);
}

async function reverse(url, ctx) {
  const { lat, lon } = parseCoords(url);
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", zoom: "10", "accept-language": "en" });
  const data = await cachedJson(`${REVERSE}?${params}`, 86400 * 7, ctx);
  const a = data.address || {};
  return json({
    lat, lon,
    name: a.city || a.town || a.village || a.hamlet || a.municipality || a.county || data.name || "Selected location",
    region: a.state || a.region || "",
    country: (a.country_code || "").toUpperCase()
  }, 200, 86400);
}

async function radar(ctx) {
  const data = await cachedJson(RAINVIEWER, 120, ctx);
  const frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])].map((f) => ({ time: f.time, path: f.path }));
  return json({ host: data.host, frames, nowcastStart: data.radar?.past?.length ?? frames.length }, 200, 60);
}
