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

export function resumen(state) {
  const pagos = [...state.pagos].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.creado - b.creado);
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
  for (const p of [...state.pagos].sort((a, b) => a.fecha.localeCompare(b.fecha))) {
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

// Valida y normaliza un estado leído de localStorage o de un respaldo importado.
export function validarEstado(obj) {
  if (!obj || typeof obj !== "object" || !Number.isSafeInteger(obj.deuda) || obj.deuda < 0 || !Array.isArray(obj.pagos)) return null;
  const pagos = [];
  for (const p of obj.pagos) {
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.fecha) || !Number.isSafeInteger(p.monto) || p.monto <= 0) return null;
    pagos.push({
      id: String(p.id || Math.random().toString(36).slice(2)),
      fecha: p.fecha,
      monto: p.monto,
      nota: String(p.nota || "").slice(0, 200),
      creado: Number(p.creado) || 0
    });
  }
  return { deuda: obj.deuda, pagos };
}
