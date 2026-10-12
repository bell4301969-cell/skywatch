import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { buildForecastUrl, parseCoords } from "../src/worker.js";

// Minimal stand-ins for the Workers runtime globals the module uses.
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) { const r = cacheStore.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { cacheStore.set(req.url, res.clone()); }
  }
};
const ctx = { waitUntil: (p) => p };
const env = { ASSETS: { fetch: async () => new Response("asset") } };
let upstream;

beforeEach(() => {
  cacheStore.clear();
  upstream = [];
});

function mockFetch(body, status = 200) {
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

const call = (path, cf) => {
  const req = new Request(`https://skywatch.example${path}`);
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  return worker.fetch(req, env, ctx);
};

test("parseCoords validates and rounds", () => {
  assert.deepEqual(parseCoords(new URL("https://x/?lat=51.50735&lon=-0.12776")), { lat: 51.51, lon: -0.13 });
  assert.throws(() => parseCoords(new URL("https://x/?lat=91&lon=0")), /valid coordinates/);
  assert.throws(() => parseCoords(new URL("https://x/?lat=abc&lon=0")), /valid coordinates/);
  assert.throws(() => parseCoords(new URL("https://x/?lon=0")), /required/);
});

test("forecast URL requests current, nowcast, 48h hourly and 7 days", () => {
  const url = new URL(buildForecastUrl({ lat: 1, lon: 2 }, "imperial"));
  assert.equal(url.searchParams.get("forecast_hours"), "48");
  assert.equal(url.searchParams.get("forecast_days"), "7");
  assert.equal(url.searchParams.get("forecast_minutely_15"), "8");
  assert.equal(url.searchParams.get("temperature_unit"), "fahrenheit");
  assert.match(url.searchParams.get("current"), /weather_code/);
  assert.match(url.searchParams.get("daily"), /temperature_2m_max/);
});

test("non-API paths are served from static assets", async () => {
  const res = await call("/");
  assert.equal(await res.text(), "asset");
});

test("/api/weather proxies Open-Meteo and caches at the edge", async () => {
  mockFetch({ current: { temperature_2m: 12 } });
  const first = await (await call("/api/weather?lat=10&lon=20&units=metric")).json();
  assert.equal(first.current.temperature_2m, 12);
  assert.equal(first.units, "metric");
  assert.ok(first.fetchedAt);
  await call("/api/weather?lat=10&lon=20&units=metric");
  assert.equal(upstream.length, 1, "second request should be served from cache");
});

test("/api/weather rejects bad coordinates", async () => {
  const res = await call("/api/weather?lat=999&lon=0");
  assert.equal(res.status, 400);
});

test("upstream failures become 502", async () => {
  mockFetch({ error: true }, 500);
  const res = await call("/api/weather?lat=1&lon=1");
  assert.equal(res.status, 502);
});

test("/api/geocode normalises results", async () => {
  mockFetch({ results: [{ name: "Paris", admin1: "Île-de-France", country_code: "FR", latitude: 48.85, longitude: 2.35 }] });
  const body = await (await call("/api/geocode?q=paris")).json();
  assert.deepEqual(body.results[0], { name: "Paris", region: "Île-de-France", country: "FR", lat: 48.85, lon: 2.35 });
  const empty = await (await call("/api/geocode?q=p")).json();
  assert.deepEqual(empty.results, []);
});

test("/api/locate uses Cloudflare geolocation", async () => {
  const body = await (await call("/api/locate", { latitude: "40.71", longitude: "-74.01", city: "New York", region: "New York", country: "US" })).json();
  assert.equal(body.name, "New York");
  assert.equal(body.lat, 40.71);
});

test("/api/radar flattens past and nowcast frames", async () => {
  mockFetch({ host: "https://tilecache.rainviewer.com", radar: { past: [{ time: 1, path: "/a" }], nowcast: [{ time: 2, path: "/b" }] } });
  const body = await (await call("/api/radar")).json();
  assert.equal(body.frames.length, 2);
  assert.equal(body.nowcastStart, 1);
});
