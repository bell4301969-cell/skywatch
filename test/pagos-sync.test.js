import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { fusionar, validarEstado, generarCodigo, normalizarCodigo } from "../public/pagos/calc.js";

// D1 en memoria: entiende solo las sentencias que usa src/pagos.js.
function fakeD1({ onSelect } = {}) {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...a) { this.args = a; return this; },
        async first() {
          assert.match(sql, /^SELECT data, version, updated_at FROM ledgers WHERE id = \?1$/);
          const r = rows.get(this.args[0]);
          const copia = r ? { ...r } : null;
          if (onSelect) await onSelect(rows, this.args[0]);
          return copia;
        },
        async run() {
          const a = this.args || [];
          let changes = 0;
          if (sql.startsWith("CREATE TABLE")) changes = 0;
          else if (sql.startsWith("INSERT")) {
            if (!rows.has(a[0])) { rows.set(a[0], { data: a[1], version: 1, updated_at: a[2] }); changes = 1; }
          } else if (sql.startsWith("UPDATE")) {
            const r = rows.get(a[2]);
            if (r && r.version === a[3]) { rows.set(a[2], { data: a[0], version: r.version + 1, updated_at: a[1] }); changes = 1; }
          } else if (sql.startsWith("DELETE")) {
            changes = rows.delete(a[0]) ? 1 : 0;
          } else throw new Error(`SQL inesperado: ${sql}`);
          return { meta: { changes } };
        }
      };
    }
  };
}

const CODE = "ABCD-EFGH-JKLM-NPQR";
const ctx = { waitUntil: () => {} };
const call = (env, method, body, code = CODE) => worker.fetch(new Request("https://x/api/pagos", {
  method,
  headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined
}), { ...env, ASSETS: { fetch: async () => new Response("asset") } }, ctx);

const pago = (id, monto, t, extra = {}) => ({ id, fecha: "2026-11-07", monto, nota: "", creado: t, actualizado: t, ...extra });

test("fusionar: gana el cambio más reciente de cada pago y de la deuda", () => {
  const a = { deuda: 100, deudaActualizada: 5, pagos: [pago("x", 10, 1), pago("y", 20, 2, { actualizado: 9 })] };
  const b = { deuda: 200, deudaActualizada: 7, pagos: [pago("x", 15, 1, { actualizado: 3 }), pago("y", 20, 2, { actualizado: 4, borrado: true }), pago("z", 5, 6)] };
  const m = fusionar(a, b);
  assert.equal(m.deuda, 200);
  assert.deepEqual(m.pagos.map((p) => [p.id, p.monto, !!p.borrado]), [["x", 15, false], ["y", 20, false], ["z", 5, false]]);
  assert.deepEqual(fusionar(b, a), m, "es conmutativa");
});

test("fusionar: ante empate el borrado gana; estado heredado sin marcas de tiempo", () => {
  const m = fusionar({ deuda: 0, deudaActualizada: 0, pagos: [pago("x", 1, 3)] }, { deuda: 0, deudaActualizada: 0, pagos: [pago("x", 1, 3, { borrado: true })] });
  assert.equal(m.pagos[0].borrado, true);
  const viejo = validarEstado({ deuda: 500, pagos: [{ id: "a", fecha: "2026-01-01", monto: 5, creado: 2 }] });
  assert.equal(viejo.deudaActualizada, 0);
  assert.equal(viejo.pagos[0].actualizado, 2);
  assert.equal(fusionar({ deuda: 0, deudaActualizada: 0, pagos: [] }, viejo).deuda, 500, "un dispositivo vacío no borra la deuda");
});

test("códigos de sincronización", () => {
  const c = generarCodigo();
  assert.match(c, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
  assert.equal(normalizarCodigo(c.toLowerCase().replace(/-/g, " ")), c);
  assert.equal(normalizarCodigo("abcd efgh jklm npqr"), CODE);
  assert.equal(normalizarCodigo("ABCD-EFGH-JKLM-NPQ0"), null, "0 no está en el alfabeto");
  assert.equal(normalizarCodigo("ABCD"), null);
});

test("API: sin D1 o sin código válido", async () => {
  assert.equal((await call({}, "GET")).status, 503);
  assert.equal((await call({ DB: fakeD1() }, "GET", null, "nope")).status, 401);
  assert.equal((await call({ DB: fakeD1() }, "PATCH")).status, 405);
});

test("API: crear, leer, fusionar desde dos dispositivos y borrar", async () => {
  const DB = fakeD1();
  assert.equal((await call({ DB }, "GET")).status, 404);

  const a = { deuda: 10000000, deudaActualizada: 1, pagos: [pago("p1", 500000, 10)] };
  let res = await call({ DB }, "PUT", { state: a });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 1);
  assert.equal(DB.rows.size, 1);
  const [id] = DB.rows.keys();
  assert.match(id, /^[0-9a-f]{64}$/, "se guarda el hash, no el código");
  assert.ok(!JSON.stringify([...DB.rows]).includes(CODE));

  // Otro dispositivo sin el primer pago añade uno nuevo: el resultado tiene ambos.
  const b = { deuda: 0, deudaActualizada: 0, pagos: [pago("p2", 100000, 20)] };
  res = await call({ DB }, "PUT", { state: b });
  const body = await res.json();
  assert.equal(body.version, 2);
  assert.equal(body.state.deuda, 10000000);
  assert.deepEqual(body.state.pagos.map((p) => p.id), ["p1", "p2"]);

  // Reenviar lo mismo no crea versión nueva.
  res = await call({ DB }, "PUT", { state: body.state });
  assert.equal((await res.json()).version, 2);

  res = await call({ DB }, "GET");
  assert.equal((await res.json()).state.pagos.length, 2);

  assert.equal((await call({ DB }, "DELETE")).status, 200);
  assert.equal((await call({ DB }, "GET")).status, 404);
});

test("API: rechaza datos no válidos", async () => {
  const DB = fakeD1();
  assert.equal((await call({ DB }, "PUT", { state: { deuda: -5, pagos: [] } })).status, 400);
  assert.equal((await call({ DB }, "PUT", { nada: 1 })).status, 400);
  const dup = { deuda: 1, pagos: [pago("a", 1, 1), pago("a", 2, 1)] };
  assert.equal((await call({ DB }, "PUT", { state: dup })).status, 400);
  assert.equal(DB.rows.size, 0);
});

test("API: una escritura concurrente se vuelve a fusionar en lugar de perderse", async () => {
  let interferir = true;
  const DB = fakeD1({
    async onSelect(rows, id) {
      // Justo después de que el Worker lea, otro dispositivo escribe un pago.
      if (!interferir || !rows.has(id)) return;
      interferir = false;
      const r = rows.get(id);
      const s = JSON.parse(r.data);
      s.pagos.push(pago("otro", 7, 30));
      rows.set(id, { data: JSON.stringify(s), version: r.version + 1, updated_at: 0 });
    }
  });
  interferir = false;
  await call({ DB }, "PUT", { state: { deuda: 100, deudaActualizada: 1, pagos: [pago("p1", 1, 1)] } });
  interferir = true;
  const res = await call({ DB }, "PUT", { state: { deuda: 100, deudaActualizada: 1, pagos: [pago("p2", 2, 2)] } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.state.pagos.map((p) => p.id).sort(), ["otro", "p1", "p2"]);
  assert.equal(body.version, 3);
});
