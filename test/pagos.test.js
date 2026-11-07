import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMonto, formatMonto, formatFecha, resumen, toCSV, validarEstado } from "../public/pagos/calc.js";

test("parseMonto acepta formatos comunes", () => {
  assert.equal(parseMonto("100000"), 10000000);
  assert.equal(parseMonto("5,000"), 500000);
  assert.equal(parseMonto("1,234.56"), 123456);
  assert.equal(parseMonto("1.234,56"), 123456);
  assert.equal(parseMonto("US$ 5,000.5"), 500050);
  assert.equal(parseMonto("0.99"), 99);
  assert.equal(parseMonto(""), null);
  assert.equal(parseMonto("abc"), null);
});

test("formatMonto y formatFecha coinciden con el estilo de la app", () => {
  assert.equal(formatMonto(9500000), "US$95,000.00");
  assert.equal(formatMonto(500000), "US$5,000.00");
  assert.equal(formatMonto(7), "US$0.07");
  assert.equal(formatFecha("2026-11-07"), "07 nov de 2026");
});

test("resumen calcula saldo, porcentaje y último pago", () => {
  const r = resumen({
    deuda: 10000000,
    pagos: [
      { id: "a", fecha: "2026-11-07", monto: 500000, creado: 1 },
      { id: "b", fecha: "2026-10-01", monto: 100000, creado: 2 }
    ]
  });
  assert.equal(r.pagado, 600000);
  assert.equal(r.restante, 9400000);
  assert.equal(r.excedente, 0);
  assert.equal(r.pct, 6);
  assert.equal(r.ultimo, "2026-11-07");
  assert.deepEqual(r.pagos.map((p) => p.id), ["a", "b"]);
});

test("resumen maneja pagos de más y deuda cero", () => {
  const r = resumen({ deuda: 1000, pagos: [{ id: "a", fecha: "2026-01-01", monto: 1500, creado: 0 }] });
  assert.equal(r.restante, 0);
  assert.equal(r.excedente, 500);
  assert.equal(r.pct, 100);
  assert.equal(resumen({ deuda: 0, pagos: [] }).pct, 0);
});

test("toCSV escapa notas y añade totales", () => {
  const csv = toCSV({ deuda: 10000, pagos: [{ id: "a", fecha: "2026-01-01", monto: 2500, nota: 'cheque "1", banco', creado: 0 }] });
  assert.match(csv, /^Fecha,Monto,Nota\n2026-01-01,25\.00,"cheque ""1"", banco"/);
  assert.match(csv, /Saldo restante,75\.00$/);
});

test("validarEstado rechaza datos dañados", () => {
  assert.equal(validarEstado(null), null);
  assert.equal(validarEstado({ deuda: -1, pagos: [] }), null);
  assert.equal(validarEstado({ deuda: 1, pagos: [{ fecha: "ayer", monto: 1 }] }), null);
  assert.deepEqual(validarEstado({ deuda: 5, pagos: [] }), { deuda: 5, deudaActualizada: 0, pagos: [] });
});
