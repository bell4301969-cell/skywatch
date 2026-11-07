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

A second, standalone app served from the same Worker at `/pagos/` (Spanish UI). It is a clone of the "Control de Pagos" app built on Hark (same layout, colours, typography, texts and behaviour) and tracks the payoff of a single debt in Dominican pesos (RD$):

- **Saldo restante por pagar**: the remaining balance in large serif type, with a progress bar and the percentage paid. It shows *Pagado por completo* once the debt is paid off, and any *Excedente pagado* (overpayment).
- **Cantidad adeudada / Total pagado** cards, and a form to set the total owed. Every payment is subtracted from it.
- **Registrar un pago**: deposit date (defaults to today), amount and an optional **comprobante**: a screenshot of the receipt, downscaled on the device to 1280 px JPEG.
- **Pagos registrados**: newest first, with each receipt thumbnail (or *+ Comprobante*), inline **Editar** (date, amount, note, replace or remove the receipt) and **Eliminar** with a confirmation dialog and undo.
- **Comprobantes** tab: a grid of every receipt, opening in a full-screen viewer with *Reemplazar* and *Quitar*.
- Tap the title to rename the app. Menu (⋯): *Cambiar nombre*, *Exportar datos (JSON)* / *Importar datos* (the same format as the Hark app, receipts included, so a Hark export imports directly; old backups also work), *Exportar a CSV*, *Sincronización…* and *Borrar todo*.
- Amounts are stored in cents to avoid rounding errors.
- Data is kept on the device (`localStorage`); the app works offline and can be installed as a PWA. Receipt images are stored separately and only on each device. They are never synced, so the sync payload stays small.
- **Sincronización (Cloudflare D1)**, optional, from ⋯ → *Sincronización…*:
  - *Activar en este dispositivo* creates a secret 16-character code (e.g. `ABCD-EFGH-JKLM-NPQR`, 80 bits). Any device that enters the code, or opens the *Copiar enlace* link (`/pagos/#codigo=…`; the code stays in the URL fragment and is never sent in a request URL), shares the same ledger.
  - The Worker merges per payment, keeping the most recent change. Deletes are kept as tombstones so they propagate. Edits made offline on two devices are merged, not overwritten. Writes use optimistic versioning, so simultaneous syncs re-merge instead of losing data.
  - Syncs run after every change, on load, when the tab becomes visible, on reconnect and every 60 s.
  - D1 stores only the SHA-256 of the code. Anyone with the code can read and change that ledger, so treat it like a password.

Files: `public/pagos/` (`calc.js` holds the pure logic shared with the Worker), `src/pagos.js` (sync API), `migrations/0001_pagos.sql`; tests in `test/pagos*.test.js`. The app name is synced too: the most recent rename wins.

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
| `GET\|PUT\|DELETE /api/pagos` (header `Authorization: Bearer <código>`) | Cloudflare D1 (`DB`) | none |

The browser loads satellite tiles directly from NASA GIBS (WMS). Radar tiles come from RainViewer and base-map labels from CARTO. None of the services needs an API key.

## Develop & deploy

```sh
npm install
npm run dev      # http://localhost:8787
npm test
npx wrangler login
npm run deploy   # publishes to https://skywatch.<your-subdomain>.workers.dev
```

The `DB` binding has no `database_id`, so recent Wrangler 4 releases create the `skywatch-pagos` D1 database automatically on the first `npm run deploy`. If yours does not, or you prefer to create it yourself, run `npx wrangler d1 create skywatch-pagos` and add the printed `database_id` to the binding. The Worker creates the `ledgers` table on first use. You can also apply the schema explicitly with `npx wrangler d1 migrations apply skywatch-pagos --remote` (or `--local` for `npm run dev`, which uses a local D1 in `.wrangler/`).

## Coverage notes

- NASA GIBS carries geostationary imagery only from GOES-East, GOES-West and Himawari. Europe, Africa, the Middle East and India therefore have no 10-minute satellite loop. In those places the map shows the VIIRS daily mosaic, and the Radar view still works.
- Radar coverage depends on national radar networks, and RainViewer's free tiles stop at zoom level 7.
