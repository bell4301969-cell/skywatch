import { test } from "node:test";
import assert from "node:assert/strict";
import { aRespaldo, desdeRespaldo, fusionar, validarEstado } from "../public/pagos/calc.js";

const RC = "data:image/jpeg;base64,/9j/AAAA";

test("desdeRespaldo lee una exportación de la app de Hark", () => {
  const hark = {
    app: "Control de Pagos", name: "Préstamo carro", currency: "DOP", owed: 100000,
    payments: [
      { id: "p2", date: "2026-11-07", amount: 5000.5, receipt: RC },
      { id: "p1", date: "2026-10-01", amount: 2500 }
    ]
  };
  const r = desdeRespaldo(hark, 1000);
  assert.equal(r.state.nombre, "Préstamo carro");
  assert.equal(r.state.deuda, 10000000);
  assert.deepEqual(r.state.pagos.map((p) => [p.id, p.monto]), [["p2", 500050], ["p1", 250000]]);
  assert.deepEqual(r.recibos, { p2: RC });
});

test("desdeRespaldo rechaza archivos dañados y acepta el formato anterior", () => {
  assert.equal(desdeRespaldo(null), null);
  assert.equal(desdeRespaldo({ owed: -1, payments: [] }), null);
  assert.equal(desdeRespaldo({ owed: 10, payments: [{ date: "ayer", amount: 1 }] }), null);
  assert.equal(desdeRespaldo({ owed: 10, payments: [{ date: "2026-01-01", amount: 0 }] }), null);
  const viejo = desdeRespaldo({ deuda: 500, pagos: [{ id: "a", fecha: "2026-01-01", monto: 5 }] });
  assert.equal(viejo.state.deuda, 500);
  assert.deepEqual(viejo.recibos, {});
});

test("aRespaldo exporta en pesos, sin pagos borrados, con comprobantes", () => {
  const state = validarEstado({
    nombre: "Mi deuda", deuda: 10000000,
    pagos: [
      { id: "a", fecha: "2026-10-01", monto: 250000, creado: 1 },
      { id: "b", fecha: "2026-11-07", monto: 500000, creado: 2 },
      { id: "c", fecha: "2026-11-08", monto: 100, creado: 3, borrado: true }
    ]
  });
  const out = aRespaldo(state, { b: RC }, "2026-11-07T00:00:00.000Z");
  assert.deepEqual(out, {
    app: "Control de Pagos", name: "Mi deuda", exported: "2026-11-07T00:00:00.000Z", currency: "DOP", owed: 100000,
    payments: [{ id: "b", date: "2026-11-07", amount: 5000, receipt: RC }, { id: "a", date: "2026-10-01", amount: 2500 }]
  });
  const vuelta = desdeRespaldo(JSON.parse(JSON.stringify(out)), 5);
  assert.equal(vuelta.state.deuda, state.deuda);
  assert.deepEqual(vuelta.recibos, { b: RC });
});

test("fusionar conserva el nombre cambiado más recientemente", () => {
  const a = validarEstado({ nombre: "Viejo", nombreActualizado: 5, deuda: 0, pagos: [] });
  const b = validarEstado({ nombre: "Nuevo", nombreActualizado: 9, deuda: 0, pagos: [] });
  assert.equal(fusionar(a, b).nombre, "Nuevo");
  assert.equal(fusionar(b, a).nombre, "Nuevo");
  assert.equal(fusionar(a, validarEstado({ deuda: 0, pagos: [] })).nombre, "Viejo", "un dispositivo nuevo no pisa el nombre");
});
