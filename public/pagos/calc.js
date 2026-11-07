// Lógica pura de Control de Pagos (sin DOM) para poder probarla con node --test.
// Todos los importes se guardan en centavos (enteros) para evitar errores de coma flotante.

// Convierte el texto que escribe el usuario en centavos. Acepta "100000", "1,234.56",
// "1.234,56", "US$ 5,000" y similares. Devuelve null si no es un número válido.
export function parseMonto(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/[^\d.,]/g, "");
  if (!s) return null;
  // El último separador es decimal solo si le siguen 1 o 2 dígitos; si no, es de miles.
  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let intPart = s;
  let decPart = "";
  if (last !== -1 && s.length - last - 1 <= 2) {
    intPart = s.slice(0, last);
    decPart = s.slice(last + 1);
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(decPart) || (intPart === "" && decPart === "")) return null;
  const cents = Number(intPart || "0") * 100 + Number((decPart + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatMonto(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const ent = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}US$${ent}.${String(abs % 100).padStart(2, "0")}`;
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];

export function formatFecha(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MESES[m - 1]} de ${y}`;
}

export function hoyISO(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function activos(state) {
  return state.pagos.filter((p) => !p.borrado);
}

export function resumen(state) {
  const pagos = activos(state).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.creado - b.creado);
  const pagado = pagos.reduce((t, p) => t + p.monto, 0);
  const deuda = state.deuda;
  const diff = deuda - pagado;
  return {
    deuda,
    pagado,
    restante: Math.max(0, diff),
    excedente: Math.max(0, -diff),
    pct: deuda > 0 ? Math.min(100, (pagado / deuda) * 100) : 0,
    ultimo: pagos.length ? pagos[pagos.length - 1].fecha : null,
    pagos: pagos.reverse() // más recientes primero
  };
}

export function toCSV(state) {
  const rows = [["Fecha", "Monto", "Nota"]];
  for (const p of activos(state).sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    rows.push([p.fecha, (p.monto / 100).toFixed(2), p.nota || ""]);
  }
  const r = resumen(state);
  rows.push(
    [],
    ["Cantidad adeudada", (r.deuda / 100).toFixed(2)],
    ["Total pagado", (r.pagado / 100).toFixed(2)],
    ["Saldo restante", (r.restante / 100).toFixed(2)]
  );
  const esc = (c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((row) => row.map(esc).join(",")).join("\n");
}

export const MAX_PAGOS = 5000;

// Valida y normaliza un estado leído de localStorage, de un respaldo importado o del servidor.
// Los pagos borrados se conservan como "lápidas" (borrado: true) para que el borrado se
// propague al sincronizar; cada pago y la deuda llevan su hora de última modificación.
export function validarEstado(obj) {
  if (!obj || typeof obj !== "object" || !Number.isSafeInteger(obj.deuda) || obj.deuda < 0 || !Array.isArray(obj.pagos)) return null;
  if (obj.pagos.length > MAX_PAGOS) return null;
  const pagos = [];
  const vistos = new Set();
  for (const p of obj.pagos) {
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.fecha) || !Number.isSafeInteger(p.monto) || p.monto <= 0) return null;
    const id = String(p.id || Math.random().toString(36).slice(2)).slice(0, 64);
    if (vistos.has(id)) return null;
    vistos.add(id);
    const creado = Number(p.creado) || 0;
    const pago = { id, fecha: p.fecha, monto: p.monto, nota: String(p.nota || "").slice(0, 200), creado, actualizado: Number(p.actualizado) || creado };
    if (p.borrado) pago.borrado = true;
    pagos.push(pago);
  }
  return { deuda: obj.deuda, deudaActualizada: Number(obj.deudaActualizada) || 0, pagos };
}

// Fusiona dos copias del mismo libro: gana el cambio más reciente de cada pago y de la deuda.
// Es conmutativa, así que da igual qué dispositivo sincronice primero.
export function fusionar(a, b) {
  const deudaDeB = b.deudaActualizada > a.deudaActualizada ||
    (b.deudaActualizada === a.deudaActualizada && b.deuda > a.deuda);
  const porId = new Map();
  for (const p of [...a.pagos, ...b.pagos]) {
    const actual = porId.get(p.id);
    if (!actual || gana(p, actual)) porId.set(p.id, p);
  }
  return {
    deuda: deudaDeB ? b.deuda : a.deuda,
    deudaActualizada: Math.max(a.deudaActualizada, b.deudaActualizada),
    pagos: [...porId.values()].sort((x, y) => x.creado - y.creado || (x.id < y.id ? -1 : 1))
  };
}

function gana(p, q) {
  if (p.actualizado !== q.actualizado) return p.actualizado > q.actualizado;
  if (!!p.borrado !== !!q.borrado) return !!p.borrado; // ante empate, el borrado gana
  return JSON.stringify(p) > JSON.stringify(q); // desempate determinista
}

// Código de sincronización: 16 caracteres sin letras ambiguas (80 bits), en grupos de 4.
const ALFABETO = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generarCodigo(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(16);
  let c = "";
  for (let i = 0; i < 16; i++) c += ALFABETO[bytes[i] % 32];
  return c.match(/.{4}/g).join("-");
}

export function normalizarCodigo(text) {
  const s = String(text || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length !== 16 || [...s].some((ch) => !ALFABETO.includes(ch))) return null;
  return s.match(/.{4}/g).join("-");
}
