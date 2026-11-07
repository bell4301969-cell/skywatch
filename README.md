# Skywatch Live

A real-time weather app that runs on **Cloudflare Workers**. It shows:

- **Live conditions**: temperature, feels-like, wind and gusts, humidity, dew point, pressure, UV, visibility, cloud cover, sunrise and sunset. Data refreshes automatically every 5 minutes and whenever you come back to the tab.
- **2-hour nowcast**: precipitation in 15-minute steps.
- **Hourly forecast**: the next 48 hours, with a temperature curve, rain chance and wind.
- **7-day forecast**: daily highs and lows on a shared scale, with details for each day (rain, wind, UV, sunrise and sunset).
- **Satellite & radar map** (Leaflet):
  - *True colour*: GOES-East and GOES-West GeoColor, or Himawari visible imagery, picking the satellite that covers your location. It is a 2-hour loop with a frame every 10 minutes.
  - *Infrared*: clean longwave IR from the same satellite, so clouds show day and night.
  - *Radar*: the RainViewer precipitation radar mosaic for the last ~2 hours.
  - *Daily*: global VIIRS true-colour mosaics for the past 7 days.
  - Click anywhere on the map to load the forecast for that spot.
- Place search, precise GPS location, °C/°F toggle and installable PWA. When you have not chosen a place, the app uses Cloudflare's IP geolocation (`request.cf`) for a first guess.

## Control de Pagos (`/pagos/`)

A second, standalone app served from the same Worker at `/pagos/` (Spanish UI). It tracks the payoff of a single debt:

- **Saldo restante por pagar**: the remaining balance, with a progress bar and the percentage paid.
- **Cantidad adeudada**: set or change the total owed; every payment is subtracted from it.
- **Registrar un pago**: deposit date (defaults to today), amount and an optional note.
- **Pagos registrados**: table of payments (newest first) with **Editar** to change or delete one (with undo), and the running total.
- Overpayment shows as *saldo a favor*. Amounts are stored in cents to avoid rounding errors.
- Menu (⋯): export to CSV, download/restore a JSON backup, erase everything.
- Data stays on the device (`localStorage`); the app works offline and can be installed as a PWA.

Files: `public/pagos/` (`calc.js` holds the pure logic, tested in `test/pagos.test.js`).

## Architecture

```
public/          static app (served by Workers Static Assets)
  index.html, app.js, styles.css, sw.js, manifest.webmanifest, icons/
src/worker.js    API Worker; upstream responses are cached in Cloudflare's edge cache
test/            unit tests for the Worker (node --test)
wrangler.jsonc   Worker + assets config (only /api/* runs the Worker)
```

| Endpoint | Upstream | Edge cache |
|---|---|---|
| `GET /api/weather?lat=&lon=&units=metric\|imperial` | Open-Meteo forecast | 5 min |
| `GET /api/geocode?q=` | Open-Meteo geocoding | 24 h |
| `GET /api/reverse?lat=&lon=` | OpenStreetMap Nominatim | 7 days |
| `GET /api/radar` | RainViewer frame list | 2 min |
| `GET /api/locate` | Cloudflare `request.cf` | none |

The browser loads satellite tiles directly from NASA GIBS (WMS). Radar tiles come from RainViewer and base-map labels from CARTO. None of the services needs an API key.

## Develop & deploy

```sh
npm install
npm run dev      # http://localhost:8787
npm test
npx wrangler login
npm run deploy   # publishes to https://skywatch.<your-subdomain>.workers.dev
```

## Coverage notes

- NASA GIBS carries geostationary imagery only from GOES-East, GOES-West and Himawari. Europe, Africa, the Middle East and India therefore have no 10-minute satellite loop. In those places the map shows the VIIRS daily mosaic, and the Radar view still works.
- Radar coverage depends on national radar networks, and RainViewer's free tiles stop at zoom level 7.
