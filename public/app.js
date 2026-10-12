// Skywatch Live front end: renders live conditions, a 2-hour nowcast, 48-hour hourly and
// 7-day forecasts from the Worker API, plus an animated satellite / radar map.

const REFRESH_MS = 5 * 60 * 1000;
const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi";
const GIBS_ATTR = '<a href="https://www.earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>';
const CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';

// Geostationary satellites in NASA GIBS, refreshed every 10 minutes.
const SATELLITES = [
  { name: "GOES-East", lon: -75.2, geocolor: "GOES-East_ABI_GeoColor", infrared: "GOES-East_ABI_Band13_Clean_Infrared" },
  { name: "GOES-West", lon: -137.2, geocolor: "GOES-West_ABI_GeoColor", infrared: "GOES-West_ABI_Band13_Clean_Infrared" },
  { name: "Himawari", lon: 140.7, geocolor: "Himawari_AHI_Band3_Red_Visible_1km", infrared: "Himawari_AHI_Band13_Clean_Infrared" }
];
const DAILY_LAYER = "VIIRS_SNPP_CorrectedReflectance_TrueColor";

// WMO weather interpretation codes → label and day/night icon.
const WEATHER = {
  0: ["Clear sky", "☀️", "🌙"], 1: ["Mainly clear", "🌤️", "🌙"], 2: ["Partly cloudy", "⛅", "☁️"], 3: ["Overcast", "☁️", "☁️"],
  45: ["Fog", "🌫️", "🌫️"], 48: ["Freezing fog", "🌫️", "🌫️"],
  51: ["Light drizzle", "🌦️", "🌧️"], 53: ["Drizzle", "🌦️", "🌧️"], 55: ["Heavy drizzle", "🌧️", "🌧️"],
  56: ["Freezing drizzle", "🌧️", "🌧️"], 57: ["Heavy freezing drizzle", "🌧️", "🌧️"],
  61: ["Light rain", "🌦️", "🌧️"], 63: ["Rain", "🌧️", "🌧️"], 65: ["Heavy rain", "🌧️", "🌧️"],
  66: ["Freezing rain", "🌧️", "🌧️"], 67: ["Heavy freezing rain", "🌧️", "🌧️"],
  71: ["Light snow", "🌨️", "🌨️"], 73: ["Snow", "🌨️", "🌨️"], 75: ["Heavy snow", "❄️", "❄️"], 77: ["Snow grains", "🌨️", "🌨️"],
  80: ["Light showers", "🌦️", "🌧️"], 81: ["Showers", "🌧️", "🌧️"], 82: ["Violent showers", "⛈️", "⛈️"],
  85: ["Snow showers", "🌨️", "🌨️"], 86: ["Heavy snow showers", "❄️", "❄️"],
  95: ["Thunderstorm", "⛈️", "⛈️"], 96: ["Thunderstorm with hail", "⛈️", "⛈️"], 99: ["Severe thunderstorm with hail", "⛈️", "⛈️"]
};
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
};

const state = {
  place: store.get("skywatch.place", null),
  units: store.get("skywatch.units", "metric"),
  data: null,
  mode: store.get("skywatch.mode", "geocolor")
};

// ---------- helpers ----------

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function describe(code, isDay = 1) {
  const w = WEATHER[code] || ["Unknown", "🌡️", "🌡️"];
  return { label: w[0], icon: isDay ? w[1] : w[2] };
}

// Open-Meteo returns location-local times without an offset ("2026-10-12T14:00").
// Treat them as UTC wall-clock values and always format in UTC so the browser's zone never interferes.
function localDate(s) {
  const [d, t = "00:00"] = s.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, day, hh, mm));
}
const fmt = (date, opts) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...opts }).format(date);
const hourLabel = (s) => fmt(localDate(s), { hour: "numeric" });
const timeLabel = (s) => fmt(localDate(s), { hour: "numeric", minute: "2-digit" });

function u() {
  const imperial = state.data?.units === "imperial";
  return { temp: imperial ? "°F" : "°C", wind: imperial ? "mph" : "km/h", precip: imperial ? "in" : "mm", imperial };
}
const deg = (v) => (v == null ? "--" : `${Math.round(v)}°`);
const compass = (d) => COMPASS[Math.round(((d % 360) / 22.5)) % 16];
const windArrow = (d) => `<span class="arrow" style="transform:rotate(${(d + 180) % 360}deg)" aria-hidden="true">↑</span>`;

function uvLabel(uv) {
  if (uv == null) return "--";
  const v = Math.round(uv);
  const level = uv < 3 ? "Low" : uv < 6 ? "Moderate" : uv < 8 ? "High" : uv < 11 ? "Very high" : "Extreme";
  return `${v} · ${level}`;
}

function visibilityLabel(m) {
  if (m == null) return "--";
  if (u().imperial) return `${(m / 1609.34).toFixed(m < 16000 ? 1 : 0)} mi`;
  return m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`;
}

function showError(msg) {
  const el = $("error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ---------- weather ----------

async function loadWeather() {
  if (!state.place) return;
  const { lat, lon } = state.place;
  try {
    state.data = await api(`/api/weather?lat=${lat}&lon=${lon}&units=${state.units}`);
    showError("");
    render();
  } catch (err) {
    showError(`Couldn't load the forecast: ${err.message}. Retrying automatically.`);
  }
}

function render() {
  const d = state.data;
  const p = state.place;
  $("place").textContent = p.name;
  const nowLocal = new Date(Date.now() + d.utc_offset_seconds * 1000);
  $("place-sub").textContent = [
    [p.region, p.country].filter(Boolean).join(", "),
    `${fmt(nowLocal, { weekday: "long", hour: "numeric", minute: "2-digit" })} local time`
  ].filter(Boolean).join(" · ");
  document.title = `${Math.round(d.current.temperature_2m)}° ${p.name} · Skywatch Live`;
  renderNow(d);
  renderNowcast(d);
  renderHourly(d);
  renderDaily(d);
  updateUpdated();
}

function renderNow(d) {
  const c = d.current;
  const today = d.daily;
  const w = describe(c.weather_code, c.is_day);
  const units = u();
  $("now-icon").textContent = w.icon;
  $("now-temp").textContent = `${Math.round(c.temperature_2m)}${units.temp}`;
  $("now-cond").textContent = w.label;
  $("now-feels").textContent = `Feels like ${deg(c.apparent_temperature)} · H ${deg(today.temperature_2m_max[0])} L ${deg(today.temperature_2m_min[0])}`;

  const stats = [
    ["Wind", `${windArrow(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} ${units.wind} ${compass(c.wind_direction_10m)}`],
    ["Gusts", `${Math.round(c.wind_gusts_10m)} ${units.wind}`],
    ["Humidity", `${Math.round(c.relative_humidity_2m)}%`],
    ["Dew point", deg(c.dew_point_2m)],
    ["Pressure", `${Math.round(c.pressure_msl)} hPa`],
    ["UV index", uvLabel(c.uv_index)],
    ["Visibility", visibilityLabel(c.visibility)],
    ["Cloud cover", `${Math.round(c.cloud_cover)}%`],
    ["Precipitation", `${c.precipitation} ${units.precip}`],
    ["Sunrise", timeLabel(today.sunrise[0])],
    ["Sunset", timeLabel(today.sunset[0])]
  ];
  $("stats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

function renderNowcast(d) {
  const m = d.minutely_15;
  const values = (m?.precipitation || []).slice(0, 8);
  const times = (m?.time || []).slice(0, 8);
  const max = Math.max(u().imperial ? 0.04 : 1, ...values);
  $("nowcast-bars").innerHTML = values.map((v, i) => {
    const h = v > 0 ? Math.max(8, (v / max) * 100) : 4;
    return `<div class="bar" title="${esc(timeLabel(times[i]))}: ${v} ${u().precip}">
      <div class="fill ${v > 0 ? "" : "dry"}" style="height:${h}%"></div>
      <div class="lbl">${i % 2 === 0 ? esc(timeLabel(times[i])) : "&nbsp;"}</div></div>`;
  }).join("");

  const firstWet = values.findIndex((v) => v > 0);
  let text;
  if (!values.length) text = "Nowcast unavailable for this location.";
  else if (firstWet === -1) text = "No precipitation expected.";
  else if (firstWet === 0) {
    const dryAt = values.findIndex((v) => v === 0);
    text = dryAt === -1 ? "Precipitation continuing." : `Precipitation easing around ${timeLabel(times[dryAt])}.`;
  } else text = `Precipitation likely from around ${timeLabel(times[firstWet])}.`;
  $("nowcast-text").textContent = text;
}

function renderHourly(d) {
  const h = d.hourly;
  const n = h.time.length;
  const colW = 64;
  const temps = h.temperature_2m;
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const span = hi - lo || 1;
  const y = (t) => 50 - ((t - lo) / span) * 36; // 14..50 within the 70px band, leaving room for labels
  const pts = temps.map((t, i) => [i * colW + colW / 2, y(t)]);
  const path = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yy.toFixed(1)}`).join("");
  const units = u();

  const cols = h.time.map((t, i) => {
    const w = describe(h.weather_code[i], h.is_day[i]);
    const dayStart = i > 0 && t.endsWith("T00:00");
    const label = i === 0 ? "Now" : dayStart ? fmt(localDate(t), { weekday: "short" }) : hourLabel(t);
    const pp = h.precipitation_probability[i];
    return `<div class="hour${dayStart ? " day-start" : ""}" title="${esc(w.label)}, wind ${Math.round(h.wind_speed_10m[i])} ${units.wind} ${compass(h.wind_direction_10m[i])}">
      <span class="t">${esc(label)}</span>
      <span class="ic" aria-label="${esc(w.label)}">${w.icon}</span>
      <span></span>
      <span class="p">${pp != null && pp >= 10 ? `💧${pp}%` : ""}</span>
      <span class="w">${windArrow(h.wind_direction_10m[i])} ${Math.round(h.wind_speed_10m[i])}</span>
    </div>`;
  }).join("");

  const labels = pts.map(([x, yy], i) => `<circle cx="${x}" cy="${yy}" r="3"/><text x="${x}" y="${yy - 9}">${Math.round(temps[i])}°</text>`).join("");
  $("hourly").innerHTML = `<div class="hourly-track" style="width:${n * colW}px">
    ${cols}
    <svg class="hourly-svg" width="${n * colW}" viewBox="0 0 ${n * colW} 70" aria-hidden="true"><path d="${path}"/>${labels}</svg>
  </div>`;
}

function renderDaily(d) {
  const dd = d.daily;
  const units = u();
  const weekLo = Math.min(...dd.temperature_2m_min), weekHi = Math.max(...dd.temperature_2m_max);
  const span = weekHi - weekLo || 1;
  const pct = (t) => ((t - weekLo) / span) * 100;
  const current = d.current.temperature_2m;

  $("daily").innerHTML = dd.time.map((t, i) => {
    const w = describe(dd.weather_code[i], 1);
    const date = localDate(t);
    const name = i === 0 ? "Today" : fmt(date, { weekday: "short", day: "numeric" });
    const lo = dd.temperature_2m_min[i], hi = dd.temperature_2m_max[i];
    const pp = dd.precipitation_probability_max[i];
    const marker = i === 0 ? `<i style="left:${pct(Math.min(Math.max(current, weekLo), weekHi))}%" title="Now"></i>` : "";
    return `<li><details>
      <summary>
        <span class="dname">${esc(name)}</span>
        <span class="ic" aria-label="${esc(w.label)}">${w.icon}</span>
        <span class="pp">${pp != null && pp >= 10 ? `💧${pp}%` : ""}</span>
        <span class="lo">${deg(lo)}</span>
        <span class="range"><span style="left:${pct(lo)}%;right:${100 - pct(hi)}%"></span>${marker}</span>
        <span class="hi">${deg(hi)}</span>
      </summary>
      <div class="day-detail">
        <div><b>Conditions</b>${esc(w.label)}</div>
        <div><b>Precipitation</b>${dd.precipitation_sum[i]} ${units.precip}${pp != null ? ` (${pp}%)` : ""}</div>
        <div><b>Max wind</b>${windArrow(dd.wind_direction_10m_dominant[i])} ${Math.round(dd.wind_speed_10m_max[i])} ${units.wind} ${compass(dd.wind_direction_10m_dominant[i])}</div>
        <div><b>UV max</b>${uvLabel(dd.uv_index_max[i])}</div>
        <div><b>Sunrise</b>${timeLabel(dd.sunrise[i])}</div>
        <div><b>Sunset</b>${timeLabel(dd.sunset[i])}</div>
      </div>
    </details></li>`;
  }).join("");
}

function updateUpdated() {
  if (!state.data) return;
  const mins = Math.floor((Date.now() - new Date(state.data.fetchedAt).getTime()) / 60000);
  $("updated").textContent = mins < 1 ? "Live · updated just now" : `Live · updated ${mins} min ago`;
}

// ---------- location ----------

function setPlace(place) {
  state.place = place;
  store.set("skywatch.place", place);
  map.centerOn(place);
  map.setPlace(place);
  loadWeather();
}

async function placeFromCoords(lat, lon) {
  try {
    const r = await api(`/api/reverse?lat=${lat}&lon=${lon}`);
    return { ...r, lat, lon };
  } catch {
    return { lat, lon, name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, region: "", country: "" };
  }
}

function locateMe() {
  if (!navigator.geolocation) return showError("Geolocation isn't available in this browser.");
  $("locate").disabled = true;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    $("locate").disabled = false;
    setPlace(await placeFromCoords(+pos.coords.latitude.toFixed(4), +pos.coords.longitude.toFixed(4)));
  }, (err) => {
    $("locate").disabled = false;
    showError(`Couldn't get your location: ${err.message}`);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
}

function setupSearch() {
  const input = $("search-input"), list = $("search-results");
  let results = [], active = -1, timer, seq = 0;

  const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); };
  const choose = (r) => { input.value = ""; close(); input.blur(); setPlace(r); };
  const paint = () => {
    list.innerHTML = results.length
      ? results.map((r, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}"><strong>${esc(r.name)}</strong> <span class="muted">${esc([r.region, r.country].filter(Boolean).join(", "))}</span></li>`).join("")
      : `<li class="muted" aria-disabled="true">No places found</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { results: r } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        results = r; active = r.length ? 0 : -1; paint();
      } catch { /* ignore transient search errors */ }
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !results.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % results.length; paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + results.length) % results.length; paint(); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  $("search").addEventListener("submit", (e) => { e.preventDefault(); if (results[active]) choose(results[active]); });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choose(results[+li.dataset.i]); }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
}

// ---------- satellite / radar map ----------

const map = (() => {
  const m = L.map("map", { worldCopyJump: true, zoomControl: true, minZoom: 2, maxZoom: 10 }).setView([20, 0], 4);
  m.createPane("labels");
  m.getPane("labels").style.zIndex = 450;
  m.getPane("labels").style.pointerEvents = "none";

  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const cartoBase = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`, { attribution: CARTO_ATTR, subdomains: "abcd", maxZoom: 19 });
  const labels = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", { pane: "labels", subdomains: "abcd", maxZoom: 19, opacity: 0.9 });
  let dailyBase = null;
  const marker = L.circleMarker([0, 0], { radius: 7, color: "#fff", weight: 2, fillColor: "#f08a24", fillOpacity: 1 });

  let frames = [], index = 0, timer = null, place = null, loadedMode = null, built = 0;

  const isoMinute = (d) => d.toISOString().slice(0, 16) + ":00Z";
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const lonDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  const gibs = (layer, time, opts = {}) => L.tileLayer.wms(GIBS_WMS, {
    layers: layer, format: "image/png", transparent: true, version: "1.3.0",
    TIME: time, tileSize: 512, attribution: GIBS_ATTR, opacity: 0, ...opts
  });

  // Best geostationary satellite for the location: closest sub-satellite longitude within the usable disk.
  function satelliteFor(p) {
    if (!p || Math.abs(p.lat) > 70) return null;
    const best = SATELLITES.map((s) => ({ s, dist: lonDist(p.lon, s.lon) })).sort((a, b) => a.dist - b.dist)[0];
    return best.dist <= 68 ? best.s : null;
  }

  function stop() {
    clearInterval(timer); timer = null;
    $("play-icon").setAttribute("d", "M7 4l13 8-13 8z");
    $("play").setAttribute("aria-label", "Play animation");
  }
  function play() {
    if (frames.length < 2) return;
    $("play-icon").setAttribute("d", "M6 4h4v16H6zM14 4h4v16h-4z");
    $("play").setAttribute("aria-label", "Pause animation");
    let hold = 0;
    timer = setInterval(() => {
      if (index === frames.length - 1 && hold++ < 3) return; // linger on the latest frame
      hold = 0;
      show((index + 1) % frames.length);
    }, 450);
  }

  function show(i) {
    if (!frames.length) return;
    frames[index]?.layer.setOpacity(0);
    index = Math.max(0, Math.min(i, frames.length - 1));
    frames[index].layer.setOpacity(frames[index].opacity);
    $("frame").value = index;
    $("frame-time").textContent = frames[index].label;
  }

  function clearFrames() {
    stop();
    frames.forEach((f) => m.removeLayer(f.layer));
    frames = []; index = 0;
  }

  function setFrames(list) {
    clearFrames();
    frames = list;
    frames.forEach((f) => f.layer.addTo(m));
    $("frame").max = Math.max(0, frames.length - 1);
    $("frame").disabled = frames.length < 2;
    $("play").disabled = frames.length < 2;
    show(frames.length - 1);
  }

  const timeFmt = (d) => new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(d);

  function ensureDailyBase() {
    const yesterday = new Date(Date.now() - 86400000);
    if (!dailyBase) dailyBase = gibs(DAILY_LAYER, isoDay(yesterday), { opacity: 1, tileSize: 256 });
    if (!m.hasLayer(dailyBase)) dailyBase.addTo(m);
  }

  async function build(mode) {
    const token = ++built;
    const note = $("map-note");
    if (mode === "radar") {
      if (dailyBase) m.removeLayer(dailyBase);
      cartoBase.addTo(m);
      labels.remove();
      try {
        const r = await api("/api/radar");
        if (token !== built) return;
        setFrames(r.frames.map((f, i) => ({
          layer: L.tileLayer(`${r.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { maxNativeZoom: 7, maxZoom: 10, opacity: 0, attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>' }),
          opacity: 0.8,
          label: `${timeFmt(new Date(f.time * 1000))}${i >= r.nowcastStart ? " (forecast)" : ""}`
        })));
        note.textContent = "Precipitation radar mosaic for the past ~2 hours, updated every 10 minutes. Coverage depends on local radar networks.";
      } catch (err) {
        setFrames([]);
        note.textContent = `Radar unavailable: ${err.message}`;
      }
      return;
    }

    m.removeLayer(cartoBase);
    ensureDailyBase();
    labels.addTo(m);

    if (mode === "daily") {
      const days = [];
      for (let i = 7; i >= 1; i--) {
        const day = new Date(Date.now() - i * 86400000);
        days.push({ layer: gibs(DAILY_LAYER, isoDay(day), { tileSize: 256 }), opacity: 1, label: new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(day) });
      }
      setFrames(days);
      note.textContent = "Daily true-colour mosaic from the VIIRS instrument on Suomi NPP (one image per day, global, up to ~375 m detail).";
      return;
    }

    const sat = satelliteFor(place);
    if (!sat) {
      setFrames([]);
      $("frame-time").textContent = "Daily view";
      note.textContent = "No NASA GIBS geostationary coverage here (GOES-East, GOES-West and Himawari cover the Americas, Pacific and East Asia/Oceania). Showing yesterday's VIIRS daily mosaic — try the Radar or Daily views.";
      return;
    }
    // GIBS publishes geostationary imagery every 10 minutes with roughly 20–40 minutes of latency.
    const step = 10 * 60 * 1000;
    const latest = Math.floor((Date.now() - 40 * 60 * 1000) / step) * step;
    const list = [];
    for (let i = 11; i >= 0; i--) {
      const t = new Date(latest - i * step);
      list.push({ layer: gibs(sat[mode], isoMinute(t)), opacity: 1, label: timeFmt(t) });
    }
    setFrames(list);
    note.textContent = mode === "geocolor"
      ? `${sat.name} ${sat.name === "Himawari" ? "visible imagery" : "GeoColor (true colour by day, infrared clouds over city lights by night)"} — last 2 hours, every 10 minutes.`
      : `${sat.name} clean longwave infrared (10.3 µm): brighter = colder, higher cloud tops. Works day and night — last 2 hours, every 10 minutes.`;
  }

  function setMode(mode) {
    state.mode = mode;
    store.set("skywatch.mode", mode);
    document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    loadedMode = mode;
    build(mode);
  }

  $("frame").addEventListener("input", (e) => { stop(); show(+e.target.value); });
  $("play").addEventListener("click", () => (timer ? stop() : play()));
  document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  m.on("click", (e) => {
    const lat = +e.latlng.lat.toFixed(4), lon = +L.Util.wrapNum(e.latlng.lng, [-180, 180], true).toFixed(4);
    const btn = L.DomUtil.create("button");
    btn.type = "button";
    btn.textContent = "Show forecast here";
    btn.onclick = async () => { m.closePopup(); setPlace(await placeFromCoords(lat, lon)); };
    const box = L.DomUtil.create("div");
    box.innerHTML = `<div>${lat.toFixed(2)}, ${lon.toFixed(2)}</div>`;
    box.appendChild(btn);
    L.popup().setLatLng(e.latlng).setContent(box).openOn(m);
  });

  return {
    centerOn(p) { m.setView([p.lat, p.lon], Math.max(m.getZoom(), 5)); },
    setPlace(p) {
      const satChanged = satelliteFor(p) !== satelliteFor(place);
      place = p;
      marker.setLatLng([p.lat, p.lon]).bindTooltip(p.name).addTo(m);
      if (loadedMode !== state.mode || satChanged) setMode(state.mode);
    },
    refresh() { if (place) build(state.mode); }
  };
})();

// ---------- boot ----------

function setUnits(units) {
  state.units = units;
  store.set("skywatch.units", units);
  document.querySelectorAll("[data-units]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.units === units)));
  loadWeather();
}

async function boot() {
  document.querySelectorAll("[data-units]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.units === state.units));
    b.addEventListener("click", () => setUnits(b.dataset.units));
  });
  $("locate").addEventListener("click", locateMe);
  $("refresh").addEventListener("click", () => { loadWeather(); map.refresh(); });
  setupSearch();

  if (!state.place) {
    try { state.place = await api("/api/locate"); } catch { state.place = { lat: 51.5074, lon: -0.1278, name: "London", region: "England", country: "GB" }; }
  }
  map.centerOn(state.place);
  map.setPlace(state.place);
  await loadWeather();

  // Keep everything live: forecast every 5 minutes, imagery every 10, and on returning to the tab.
  setInterval(loadWeather, REFRESH_MS);
  setInterval(() => map.refresh(), 2 * REFRESH_MS);
  setInterval(updateUpdated, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.data && Date.now() - new Date(state.data.fetchedAt).getTime() > REFRESH_MS) {
      loadWeather(); map.refresh();
    }
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
