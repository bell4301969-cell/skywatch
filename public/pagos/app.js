import { parseMonto, formatMonto, formatFecha, hoyISO, resumen, toCSV, validarEstado } from "./calc.js";

const KEY = "control-pagos-v1";
const $ = (id) => document.getElementById(id);

let state = cargar();

function cargar() {
  try {
    const s = validarEstado(JSON.parse(localStorage.getItem(KEY)));
    if (s) return s;
  } catch { /* almacenamiento no disponible o datos dañados */ }
  return { deuda: 0, pagos: [] };
}

function guardar() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    toast("No se pudo guardar en este navegador (modo privado o almacenamiento lleno).");
  }
}

function nuevoId() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- Render ----------
function render() {
  const r = resumen(state);

  if (r.excedente > 0) {
    $("hero-label").textContent = "Pagado de más (saldo a favor)";
    $("restante").textContent = formatMonto(r.excedente);
  } else {
    $("hero-label").textContent = r.deuda > 0 && r.restante === 0 ? "¡Deuda liquidada!" : "Saldo restante por pagar";
    $("restante").textContent = formatMonto(r.restante);
  }
  $("progress-fill").style.width = `${r.pct}%`;
  $("progress").setAttribute("aria-valuenow", r.pct.toFixed(1));
  $("progreso-txt").textContent = `${r.pct.toFixed(1)}% pagado de ${formatMonto(r.deuda)}`;

  $("deuda").textContent = formatMonto(r.deuda);
  $("pagado").textContent = formatMonto(r.pagado);
  $("ultimo").textContent = r.ultimo ? `hasta el último pago registrado (${formatFecha(r.ultimo)})` : "sin pagos registrados";
  $("total-foot").textContent = formatMonto(r.pagado);

  if (document.activeElement !== $("deuda-input")) {
    $("deuda-input").value = r.deuda ? (r.deuda % 100 ? (r.deuda / 100).toFixed(2) : String(r.deuda / 100)) : "";
  }

  const body = $("pagos-body");
  body.replaceChildren(...r.pagos.map((p) => {
    const tr = document.createElement("tr");
    const tdF = document.createElement("td");
    tdF.textContent = formatFecha(p.fecha);
    if (p.nota) {
      const n = document.createElement("span");
      n.className = "nota";
      n.textContent = p.nota;
      tdF.append(n);
    }
    const tdM = document.createElement("td");
    tdM.className = "r";
    tdM.textContent = formatMonto(p.monto);
    const tdA = document.createElement("td");
    tdA.className = "act";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "edit-btn";
    b.textContent = "Editar";
    b.setAttribute("aria-label", `Editar pago del ${formatFecha(p.fecha)} por ${formatMonto(p.monto)}`);
    b.addEventListener("click", () => abrirEditor(p.id));
    tdA.append(b);
    tr.append(tdF, tdM, tdA);
    return tr;
  }));
  $("empty").hidden = r.pagos.length > 0;
}

function mostrarError(id, input, msg) {
  const el = $(id);
  el.textContent = msg || "";
  el.hidden = !msg;
  if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
}

// ---------- Cantidad adeudada ----------
$("deuda-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("deuda-input");
  const v = parseMonto(input.value);
  if (v == null) return mostrarError("deuda-error", input, "Escribe una cantidad válida, por ejemplo 100000.");
  mostrarError("deuda-error", input, "");
  state.deuda = v;
  guardar();
  input.blur();
  render();
  toast(`Cantidad adeudada: ${formatMonto(v)}`);
});

// ---------- Registrar pago ----------
$("pago-fecha").value = hoyISO();
$("pago-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const fecha = $("pago-fecha").value;
  const montoIn = $("pago-monto");
  const monto = parseMonto(montoIn.value);
  if (!fecha) return mostrarError("pago-error", $("pago-fecha"), "Elige la fecha del depósito.");
  mostrarError("pago-error", $("pago-fecha"), "");
  if (monto == null || monto <= 0) return mostrarError("pago-error", montoIn, "Escribe un monto mayor que cero.");
  mostrarError("pago-error", montoIn, "");
  state.pagos.push({ id: nuevoId(), fecha, monto, nota: $("pago-nota").value.trim(), creado: Date.now() });
  guardar();
  montoIn.value = "";
  $("pago-nota").value = "";
  render();
  toast(`Pago de ${formatMonto(monto)} agregado`);
});

// ---------- Editar / eliminar ----------
const dlg = $("edit-dialog");
let editId = null;

function abrirEditor(id) {
  const p = state.pagos.find((x) => x.id === id);
  if (!p) return;
  editId = id;
  $("edit-fecha").value = p.fecha;
  $("edit-monto").value = p.monto % 100 ? (p.monto / 100).toFixed(2) : String(p.monto / 100);
  $("edit-nota").value = p.nota || "";
  mostrarError("edit-error", $("edit-monto"), "");
  dlg.showModal();
}

$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = state.pagos.find((x) => x.id === editId);
  if (!p) return dlg.close();
  const fecha = $("edit-fecha").value;
  const monto = parseMonto($("edit-monto").value);
  if (!fecha) return mostrarError("edit-error", $("edit-fecha"), "Elige la fecha del depósito.");
  if (monto == null || monto <= 0) return mostrarError("edit-error", $("edit-monto"), "Escribe un monto mayor que cero.");
  Object.assign(p, { fecha, monto, nota: $("edit-nota").value.trim() });
  guardar();
  dlg.close();
  render();
  toast("Pago actualizado");
});

$("edit-cancel").addEventListener("click", () => dlg.close());
$("edit-delete").addEventListener("click", () => {
  const p = state.pagos.find((x) => x.id === editId);
  if (!p || !confirm(`¿Eliminar el pago de ${formatMonto(p.monto)} del ${formatFecha(p.fecha)}?`)) return;
  const antes = state.pagos;
  state.pagos = state.pagos.filter((x) => x.id !== editId);
  guardar();
  dlg.close();
  render();
  toast("Pago eliminado", "Deshacer", () => { state.pagos = antes; guardar(); render(); });
});

// ---------- Menú ----------
const menuBtn = $("menu-btn");
const menu = $("menu");
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector("button").focus();
}
menuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { toggleMenu(false); menuBtn.focus(); } });

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

menu.addEventListener("click", (e) => {
  const action = e.target.closest("button")?.dataset.action;
  if (!action) return;
  toggleMenu(false);
  const fecha = hoyISO();
  if (action === "csv") descargar(`pagos-${fecha}.csv`, "﻿" + toCSV(state), "text/csv;charset=utf-8");
  if (action === "backup") descargar(`control-pagos-${fecha}.json`, JSON.stringify(state, null, 2), "application/json");
  if (action === "restore") $("restore-file").click();
  if (action === "reset" && confirm("¿Borrar la cantidad adeudada y todos los pagos? Esta acción no se puede deshacer.")) {
    state = { deuda: 0, pagos: [] };
    guardar();
    render();
    toast("Datos borrados");
  }
});

$("restore-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const s = validarEstado(JSON.parse(await file.text()));
    if (!s) throw new Error("formato");
    if (!confirm(`¿Reemplazar los datos actuales con el respaldo (${s.pagos.length} pagos)?`)) return;
    state = s;
    guardar();
    render();
    toast("Respaldo restaurado");
  } catch {
    toast("El archivo no es un respaldo válido de Control de Pagos.");
  }
});

// ---------- Aviso ----------
let toastTimer;
function toast(msg, accion, fn) {
  const t = $("toast");
  t.replaceChildren(document.createTextNode(msg));
  if (accion) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = accion;
    b.style.cssText = "margin-left:12px;background:none;border:0;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer";
    b.addEventListener("click", () => { fn(); t.hidden = true; });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, accion ? 6000 : 2500);
}

// Sincroniza si los datos cambian en otra pestaña.
window.addEventListener("storage", (e) => { if (e.key === KEY) { state = cargar(); render(); } });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
