// Control de Pagos: copia de la app de Hark, con sincronización opcional en Cloudflare D1.
// El estado (importes en centavos, pagos borrados como "lápidas") vive en calc.js; las capturas de
// los comprobantes se guardan aparte, solo en este dispositivo, porque son demasiado grandes para sincronizar.
import {
  parseMonto, formatMonto, formatFecha, hoyISO, resumen, toCSV, validarEstado, fusionar,
  generarCodigo, normalizarCodigo, limpiarNombre, aRespaldo, desdeRespaldo, esRecibo
} from "./calc.js";

const KEY = "control-pagos-v1";
const RC_KEY = "control-pagos-rc";
const SYNC_KEY = "control-pagos-sync";
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const IMG_ERR = "No se pudo leer la imagen. Prueba con otra captura.";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let state = cargar();
let recibos = cargarRecibos();
let editing = null;   // id del pago que se está editando en la tabla
let editDraft = null; // comprobante en edición (data URL o null)
let pendingRc = null; // comprobante del pago nuevo

function vacio(nombre) {
  return { nombre: limpiarNombre(nombre), nombreActualizado: 0, deuda: 0, deudaActualizada: 0, pagos: [] };
}

function cargar() {
  try {
    const s = validarEstado(JSON.parse(localStorage.getItem(KEY)));
    if (s) return s;
  } catch { /* almacenamiento no disponible o datos dañados */ }
  return vacio();
}

function cargarRecibos() {
  try {
    const r = JSON.parse(localStorage.getItem(RC_KEY));
    if (r && typeof r === "object") {
      return Object.fromEntries(Object.entries(r).filter(([, v]) => esRecibo(v)));
    }
  } catch { /* sin comprobantes */ }
  return {};
}

const esCuota = (e) => e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);

function persistir() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    toast(esCuota(e)
      ? "No hay espacio suficiente en este dispositivo para guardar todo. Exporta tus datos y quita algunos comprobantes."
      : "No se pudo guardar en este navegador (modo privado o almacenamiento lleno).");
  }
}

function guardarRecibos() {
  // Quitar los comprobantes de pagos que ya no existen.
  const vivos = new Set(state.pagos.filter((p) => !p.borrado).map((p) => p.id));
  for (const id of Object.keys(recibos)) if (!vivos.has(id)) delete recibos[id];
  try {
    localStorage.setItem(RC_KEY, JSON.stringify(recibos));
    return true;
  } catch (e) {
    alert(esCuota(e)
      ? "No hay espacio suficiente en este dispositivo para guardar todo. Exporta tus datos y quita algunos comprobantes."
      : "No se pudo guardar el comprobante en este navegador.");
    return false;
  }
}

// Guarda un cambio hecho por el usuario y lo envía a la nube si hay sincronización.
function guardar() {
  persistir();
  sync.programar();
}

function nuevoId() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const buscar = (id) => state.pagos.find((x) => x.id === id && !x.borrado);

function montoEditable(cents) {
  return cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100);
}

// Reduce la imagen a 1280 px como máximo en su lado largo, JPEG calidad 0.7.
function downscale(file, cb) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 1280 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    let out = null;
    try { out = c.toDataURL("image/jpeg", 0.7); } catch { out = null; }
    cb(out);
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}

// Achica el texto hasta que quepa en su caja.
function fit(el, max, min) {
  el.style.fontSize = max + "px";
  let size = max;
  while (el.scrollWidth > el.clientWidth && size > min) { size -= 1; el.style.fontSize = size + "px"; }
}
function fitAll() {
  if ($("view-pagos").hidden) return;
  fit($("remain"), 52, 22);
  fit($("owed-fig"), 22, 12);
  fit($("paid-fig"), 22, 12);
}

function applyName() {
  $("app-name").textContent = state.nombre;
  document.title = state.nombre;
  $("title-btn").setAttribute("aria-label", "Cambiar nombre: " + state.nombre);
}

function editRcHTML(src) {
  if (!src) return '<button type="button" class="x-btn x-btn--sm x-btn--ghost x-addrc" style="margin:0" data-a="eadd">+ Comprobante</button>';
  return '<div class="x-rcprev"><button type="button" class="x-thumb" data-a="eview" aria-label="Ver comprobante"><img src="' + esc(src) + '" alt=""></button>' +
    '<button type="button" class="x-btn x-btn--sm x-btn--ghost" data-a="erepl">Reemplazar</button>' +
    '<button type="button" class="x-btn x-btn--sm x-btn--ghost" data-a="erem">Quitar</button></div>';
}

// ---------- Render ----------
function render() {
  const r = resumen(state);
  const big = $("remain");
  if (r.restante === 0 && (r.deuda > 0 || r.pagado > 0)) {
    big.textContent = "Pagado por completo";
    big.classList.add("is-done");
  } else {
    big.textContent = formatMonto(r.restante);
    big.classList.remove("is-done");
  }
  const ex = $("excess");
  ex.hidden = r.excedente === 0;
  ex.textContent = r.excedente ? "Excedente pagado: " + formatMonto(r.excedente) : "";
  const pct = r.deuda > 0 ? r.pct : (r.pagado > 0 ? 100 : 0);
  $("bar-fill").style.width = pct + "%";
  $("bar").setAttribute("aria-valuenow", pct.toFixed(1));
  $("pct").textContent = pct.toFixed(1) + "% pagado de " + formatMonto(r.deuda);
  $("owed-fig").textContent = formatMonto(r.deuda);
  $("paid-fig").textContent = formatMonto(r.pagado);
  $("foot-total").textContent = formatMonto(r.pagado);
  if (document.activeElement !== $("owed-input")) $("owed-input").value = r.deuda ? montoEditable(r.deuda) : "";

  let html = "";
  if (!r.pagos.length) html = '<tr><td colspan="3" class="x-empty">Aún no hay pagos registrados.</td></tr>';
  for (const p of r.pagos) {
    const id = esc(p.id);
    if (p.id === editing) {
      html += '<tr class="x-edit"><td colspan="3"><div class="x-editbox" data-id="' + id + '">' +
        '<div class="x-grid2" style="margin:0">' +
        '<label class="x-field"><span>Fecha del depósito</span><input class="x-input" type="date" data-f="date" value="' + esc(p.fecha) + '"></label>' +
        '<label class="x-field"><span>Monto del pago</span><input class="x-input" inputmode="decimal" autocomplete="off" data-f="amount" value="' + montoEditable(p.monto) + '"></label></div>' +
        '<label class="x-field"><span>Nota · opcional</span><input class="x-input" maxlength="200" autocomplete="off" data-f="nota" value="' + esc(p.nota || "") + '"></label>' +
        '<div class="x-field"><span>Comprobante (captura del recibo)</span><div data-rc>' + editRcHTML(editDraft) + '</div></div>' +
        '<div class="x-row"><button type="button" class="x-btn x-btn--sm" data-a="save">Guardar</button>' +
        '<button type="button" class="x-btn x-btn--sm x-btn--ghost" data-a="cancel">Cancelar</button>' +
        '<button type="button" class="x-btn x-btn--sm x-btn--del" data-a="delete" data-id="' + id + '">Eliminar</button></div>' +
        '<p class="x-error" data-err></p></div></td></tr>';
    } else {
      const rc = recibos[p.id]
        ? '<button type="button" class="x-thumb" data-a="view" data-id="' + id + '" aria-label="Ver comprobante del ' + esc(formatFecha(p.fecha)) + '"><img src="' + esc(recibos[p.id]) + '" alt=""></button>'
        : '<label for="rc-file" tabindex="0" class="x-btn x-btn--sm x-btn--ghost x-addrc" data-a="addrc" data-id="' + id + '">+ Comprobante</label>';
      const nota = p.nota ? '<span class="x-nota">' + esc(p.nota) + "</span>" : "";
      html += "<tr><td><div>" + esc(formatFecha(p.fecha)) + "</div>" + nota + rc + '</td><td class="x-amt">' + formatMonto(p.monto) +
        '</td><td class="x-act"><div class="x-acts"><button type="button" class="x-btn x-btn--sm x-btn--ghost" data-a="edit" data-id="' + id + '">Editar</button>' +
        '<button type="button" class="x-btn x-btn--sm x-btn--del" data-a="delete" data-id="' + id + '">Eliminar</button></div></td></tr>';
    }
  }
  $("rows").innerHTML = html;

  const conRc = r.pagos.filter((p) => recibos[p.id]);
  let g;
  if (!conRc.length) g = '<div class="x-card x-rempty">Aún no hay comprobantes.</div>';
  else {
    g = '<div class="x-rgrid">' + conRc.map((p) =>
      '<button type="button" class="x-rcard" data-id="' + esc(p.id) + '" aria-label="Comprobante de ' + formatMonto(p.monto) + " del " + esc(formatFecha(p.fecha)) + '">' +
      '<img src="' + esc(recibos[p.id]) + '" alt=""><div><b>' + formatMonto(p.monto) + "</b><small>" + esc(formatFecha(p.fecha)) + "</small></div></button>"
    ).join("") + "</div>";
  }
  $("rec-grid").innerHTML = g;
  $("rec-count").textContent = conRc.length
    ? conRc.length + (conRc.length === 1 ? " comprobante" : " comprobantes") + ", del más reciente al más antiguo."
    : "";
  $("rec-count").hidden = !conRc.length;
  applyName();
  fitAll();
}

// ---------- Cantidad adeudada ----------
$("owed-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("owed-input");
  const v = parseMonto(inp.value);
  $("owed-ok").textContent = "";
  if (v == null || v <= 0) {
    inp.classList.add("is-error");
    $("owed-err").textContent = "Ingresa una cantidad mayor que 0.";
    return;
  }
  inp.classList.remove("is-error");
  $("owed-err").textContent = "";
  state.deuda = v;
  state.deudaActualizada = Date.now();
  guardar();
  inp.blur();
  render();
  $("owed-ok").textContent = "Cantidad guardada.";
  setTimeout(() => { $("owed-ok").textContent = ""; }, 2000);
});

// ---------- Registrar un pago ----------
$("pay-date").value = hoyISO();
$("pay-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amt = $("pay-amt"), dt = $("pay-date"), v = parseMonto(amt.value);
  let err = "";
  amt.classList.remove("is-error");
  dt.classList.remove("is-error");
  if (!dt.value) { dt.classList.add("is-error"); err = "Elige la fecha del depósito."; }
  if (v == null || v <= 0) { amt.classList.add("is-error"); err = "El monto debe ser mayor que 0."; }
  $("pay-err").textContent = err;
  if (err) return;
  const ahora = Date.now();
  const id = nuevoId();
  state.pagos.push({ id, fecha: dt.value, monto: v, nota: "", creado: ahora, actualizado: ahora });
  if (pendingRc) {
    recibos[id] = pendingRc;
    guardarRecibos();
  }
  guardar();
  amt.value = "";
  dt.value = hoyISO();
  pendingRc = null;
  showPayRc();
  render();
  toast("Pago de " + formatMonto(v) + " agregado");
});

// ---------- Comprobante del nuevo pago ----------
function showPayRc() {
  $("pay-rc-prev").hidden = !pendingRc;
  $("pay-attach").hidden = !!pendingRc;
  $("pay-rc-img").src = pendingRc || BLANK;
  $("pay-rc-hint").textContent = "";
}
// Las etiquetas que abren el selector también responden a Enter y Espacio.
document.addEventListener("keydown", (e) => {
  const l = e.target.closest && e.target.closest("label.x-btn[for]");
  if (l && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); l.click(); }
});
$("pay-attach").addEventListener("click", () => {
  $("pay-file").value = "";
  $("pay-rc-hint").textContent = "Elige una captura de tu galería…";
});
$("pay-rc-remove").addEventListener("click", () => { pendingRc = null; showPayRc(); $("pay-attach").focus(); });
$("pay-file").addEventListener("change", function () {
  const f = this.files && this.files[0];
  if (!f) return;
  const btn = $("pay-attach");
  $("pay-rc-hint").textContent = "Procesando la imagen…";
  btn.classList.add("is-busy");
  downscale(f, (data) => {
    btn.classList.remove("is-busy");
    $("pay-rc-hint").textContent = "";
    if (!data) { alert(IMG_ERR); return; }
    pendingRc = data;
    showPayRc();
  });
});

// ---------- Comprobante de un pago existente (fila o edición) ----------
let rcTarget = null;
function pickReceipt(target) {
  rcTarget = target;
  $("rc-file").value = "";
  $("rc-file").click();
}
$("rc-file").addEventListener("change", function () {
  const f = this.files && this.files[0], t = rcTarget;
  rcTarget = null;
  if (!f || !t) return;
  downscale(f, (data) => {
    if (!data) { alert(IMG_ERR); return; }
    if (t.mode === "edit") {
      if (editing !== t.id) return;
      editDraft = data;
      const slot = $("rows").querySelector(".x-editbox [data-rc]");
      if (slot) slot.innerHTML = editRcHTML(editDraft);
    } else {
      if (!buscar(t.id)) return;
      const antes = recibos[t.id];
      recibos[t.id] = data;
      if (!guardarRecibos()) { if (antes) recibos[t.id] = antes; else delete recibos[t.id]; }
      render();
    }
  });
});

// ---------- Visor a pantalla completa ----------
const viewer = $("viewer");
let viewId = null;
function openViewer(id, src, readOnly) {
  const p = buscar(id);
  if (!p) return;
  const s = src || recibos[id];
  if (!s) return;
  viewId = id;
  $("v-img").src = s;
  $("v-img").alt = "Comprobante del pago del " + formatFecha(p.fecha);
  $("v-amt").textContent = formatMonto(p.monto);
  $("v-date").textContent = formatFecha(p.fecha);
  $("v-repl").hidden = !!readOnly;
  $("v-rem").hidden = !!readOnly;
  viewer.showModal();
  $("v-close").focus();
}
viewer.addEventListener("close", () => { $("v-img").src = BLANK; viewId = null; });
$("v-close").addEventListener("click", () => viewer.close());
$("v-repl").addEventListener("click", () => { const id = viewId; viewer.close(); pickReceipt({ mode: "row", id }); });
$("v-rem").addEventListener("click", () => {
  if (!recibos[viewId] || !confirm("¿Quitar este comprobante?")) return;
  delete recibos[viewId];
  guardarRecibos();
  viewer.close();
  render();
});
$("rec-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (b) openViewer(b.getAttribute("data-id"));
});

// ---------- Pestañas ----------
function setTab(t) {
  const rec = t === "rec";
  $("view-pagos").hidden = rec;
  $("view-rec").hidden = !rec;
  for (const [id, on] of [["tab-pagos", !rec], ["tab-rec", rec]]) {
    const el = $(id);
    el.classList.toggle("is-active", on);
    if (on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  fitAll();
}
$("tab-pagos").addEventListener("click", () => setTab("pagos"));
$("tab-rec").addEventListener("click", () => setTab("rec"));

// ---------- Nombre de la app ----------
const nameDlg = $("name-dialog");
function openName() {
  setMenu(false);
  $("name-input").value = state.nombre;
  nameDlg.returnValue = "";
  nameDlg.showModal();
  $("name-input").focus();
  $("name-input").select();
}
$("title-btn").addEventListener("click", openName);
$("m-rename").addEventListener("click", openName);
$("name-cancel").addEventListener("click", () => nameDlg.close("cancel"));
nameDlg.addEventListener("close", () => {
  if (nameDlg.returnValue !== "ok") return;
  const n = limpiarNombre($("name-input").value);
  if (n === state.nombre) return;
  state.nombre = n;
  state.nombreActualizado = Date.now();
  guardar();
  applyName();
});

// ---------- Eliminar ----------
const delDlg = $("del-dialog");
let pendingDel = null;
function removePayment(id) {
  const p = buscar(id);
  if (!p) return;
  // Se marca como borrado (en vez de quitarlo) para que el borrado llegue a los demás dispositivos.
  p.borrado = true;
  p.actualizado = Date.now();
  if (editing === id) { editing = null; editDraft = null; }
  const rc = recibos[id];
  guardar();
  guardarRecibos();
  render();
  toast("Pago eliminado", "Deshacer", () => {
    // Buscar de nuevo: una sincronización intermedia puede haber sustituido el objeto.
    const q = state.pagos.find((x) => x.id === id);
    if (!q) return;
    delete q.borrado;
    q.actualizado = Date.now();
    if (rc) recibos[id] = rc;
    guardar();
    guardarRecibos();
    render();
  });
}
function askDelete(id) {
  const p = buscar(id);
  if (!p) return;
  pendingDel = id;
  $("del-msg").textContent = "¿Eliminar este pago de " + formatMonto(p.monto) + " del " + formatFecha(p.fecha) + "?";
  delDlg.returnValue = "";
  delDlg.showModal();
}
delDlg.addEventListener("close", () => {
  const id = pendingDel;
  pendingDel = null;
  if (delDlg.returnValue === "ok" && id) removePayment(id);
});

// ---------- Tabla: editar, guardar, eliminar ----------
$("rows").addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const a = b.getAttribute("data-a");
  if (a === "view") { openViewer(b.getAttribute("data-id")); return; }
  if (a === "addrc") {
    // La etiqueta abre el selector por sí misma; aquí solo se marca el pago destino.
    rcTarget = { mode: "row", id: b.getAttribute("data-id") };
    $("rc-file").value = "";
    b.textContent = "Elige una imagen…";
    setTimeout(() => { if (b.isConnected) b.textContent = "+ Comprobante"; }, 2500);
    return;
  }
  if (a === "eadd" || a === "erepl") { pickReceipt({ mode: "edit", id: editing }); return; }
  if (a === "eview") { openViewer(editing, editDraft, true); return; }
  if (a === "erem") {
    editDraft = null;
    const slot = b.closest("[data-rc]");
    slot.innerHTML = editRcHTML(null);
    slot.querySelector("button")?.focus();
    return;
  }
  if (a === "edit") {
    editing = b.getAttribute("data-id");
    editDraft = recibos[editing] || null;
    render();
    $("rows").querySelector('[data-f="amount"]')?.focus();
    return;
  }
  if (a === "delete") { askDelete(b.getAttribute("data-id")); return; }
  const box = b.closest(".x-editbox");
  if (!box) return;
  const id = box.getAttribute("data-id");
  if (a === "cancel") { editing = null; editDraft = null; render(); return; }
  if (a === "save") {
    const d = box.querySelector('[data-f="date"]'), m = box.querySelector('[data-f="amount"]');
    const v = parseMonto(m.value), err = box.querySelector("[data-err]");
    d.classList.remove("is-error");
    m.classList.remove("is-error");
    if (!d.value) { d.classList.add("is-error"); err.textContent = "Elige una fecha."; return; }
    if (v == null || v <= 0) { m.classList.add("is-error"); err.textContent = "El monto debe ser mayor que 0."; return; }
    const p = buscar(id);
    if (p) {
      Object.assign(p, { fecha: d.value, monto: v, nota: box.querySelector('[data-f="nota"]').value.trim().slice(0, 200), actualizado: Date.now() });
      const antes = recibos[id];
      if (editDraft) recibos[id] = editDraft; else delete recibos[id];
      if (!guardarRecibos()) { if (antes) recibos[id] = antes; else delete recibos[id]; }
      guardar();
    }
    editing = null;
    editDraft = null;
    render();
  }
});
$("rows").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.matches(".x-editbox input")) return;
  e.preventDefault();
  e.target.closest(".x-editbox").querySelector('[data-a="save"]').click();
});

// ---------- Menú ----------
const menu = $("menu"), mbtn = $("menu-btn");
function setMenu(open) {
  menu.hidden = !open;
  mbtn.setAttribute("aria-expanded", open ? "true" : "false");
}
mbtn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

$("m-export").addEventListener("click", () => {
  setMenu(false);
  descargar("control-de-pagos-" + hoyISO() + ".json", JSON.stringify(aRespaldo(state, recibos), null, 2), "application/json");
});

$("m-csv").addEventListener("click", () => {
  setMenu(false);
  descargar("pagos-" + hoyISO() + ".csv", "﻿" + toCSV(state), "text/csv;charset=utf-8");
});

// Sustituye todo el contenido (importar o borrar todo) de forma que se propague al sincronizar.
function reemplazarCon(nuevo, nuevosRecibos) {
  const ahora = Date.now();
  const nuevosIds = new Set(nuevo.pagos.filter((p) => !p.borrado).map((p) => p.id));
  const pagos = state.pagos.filter((p) => !nuevosIds.has(p.id)).map((p) => ({ ...p, borrado: true, actualizado: ahora }));
  for (const p of nuevo.pagos) if (!p.borrado) pagos.push({ ...p, actualizado: ahora });
  state = { nombre: nuevo.nombre, nombreActualizado: ahora, deuda: nuevo.deuda, deudaActualizada: ahora, pagos };
  recibos = { ...nuevosRecibos };
  editing = null;
  editDraft = null;
  guardar();
  guardarRecibos();
  render();
}

$("import-file").addEventListener("change", async function () {
  setMenu(false);
  const file = this.files && this.files[0];
  if (!file) return;
  const input = this;
  let r = null;
  try { r = desdeRespaldo(JSON.parse(await file.text())); } catch { r = null; }
  input.value = "";
  if (!r) { alert("El archivo no tiene un formato válido."); return; }
  reemplazarCon(r.state, r.recibos);
  alert("Datos importados.");
});

$("m-clear").addEventListener("click", () => {
  setMenu(false);
  const extra = sync.codigo ? " También se borrarán en los demás dispositivos sincronizados." : "";
  if (!confirm("¿Borrar todos los datos? Se eliminarán la cantidad adeudada, todos los pagos y sus comprobantes." + extra)) return;
  reemplazarCon(vacio(state.nombre), {});
  $("owed-input").value = "";
});

$("m-sync").addEventListener("click", () => { setMenu(false); abrirSync(); });

// ---------- Sincronización con la nube (Cloudflare D1) ----------
const sync = {
  codigo: null,
  ultima: 0,        // hora de la última sincronización correcta
  estado: "off",    // off | sincronizando | ok | pendiente | error
  mensaje: "",
  enCurso: null,
  otraVez: false,
  timer: null,

  cargar() {
    try {
      const s = JSON.parse(localStorage.getItem(SYNC_KEY));
      this.codigo = normalizarCodigo(s?.codigo);
      this.ultima = Number(s?.ultima) || 0;
    } catch { /* sin sincronización */ }
    this.estado = this.codigo ? "pendiente" : "off";
  },

  guardarConfig() {
    try {
      if (this.codigo) localStorage.setItem(SYNC_KEY, JSON.stringify({ codigo: this.codigo, ultima: this.ultima }));
      else localStorage.removeItem(SYNC_KEY);
    } catch { /* sin almacenamiento */ }
  },

  async pedir(method, body, codigo = this.codigo) {
    const res = await fetch("/api/pagos", {
      method,
      headers: { authorization: `Bearer ${codigo}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  // Envía el estado local; el servidor lo fusiona con lo que haya y devuelve el resultado.
  async sincronizar() {
    if (!this.codigo) return;
    if (this.enCurso) { this.otraVez = true; return this.enCurso; }
    if (!navigator.onLine) return this.marcar("pendiente", "Sin conexión. Se sincronizará al reconectar.");
    this.marcar("sincronizando");
    this.enCurso = (async () => {
      try {
        const data = await this.pedir("PUT", { state });
        const remoto = validarEstado(data.state);
        if (remoto) {
          // Fusionar de nuevo por si el usuario cambió algo mientras viajaba la petición.
          state = fusionar(state, remoto);
          if (editing && !buscar(editing)) { editing = null; editDraft = null; }
          persistir();
          // No redibujar la tabla mientras se edita un pago, para no perder lo escrito.
          if (!editing) render();
        }
        this.ultima = Date.now();
        this.guardarConfig();
        this.marcar("ok");
      } catch (err) {
        this.marcar(navigator.onLine ? "error" : "pendiente",
          navigator.onLine ? `No se pudo sincronizar: ${err.message}` : "Sin conexión. Se sincronizará al reconectar.");
      } finally {
        this.enCurso = null;
        if (this.otraVez) { this.otraVez = false; this.sincronizar(); }
      }
    })();
    return this.enCurso;
  },

  programar() {
    if (!this.codigo) return;
    this.marcar("pendiente");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sincronizar(), 600);
  },

  marcar(estado, mensaje = "") {
    this.estado = estado;
    this.mensaje = mensaje;
    renderSync();
  },

  async activar(codigo, { unirse }) {
    // Al unirse, comprobar que el código existe antes de vincular, para avisar si está mal escrito.
    if (unirse) await this.pedir("GET", null, codigo);
    this.codigo = codigo;
    this.ultima = 0;
    this.guardarConfig();
    await this.sincronizar();
    if (this.estado === "error") throw new Error(this.mensaje);
  },

  desvincular() {
    this.codigo = null;
    this.ultima = 0;
    clearTimeout(this.timer);
    this.guardarConfig();
    this.marcar("off");
  }
};

function haceCuanto(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(ms).toLocaleString("es");
}

function textoEstado() {
  switch (sync.estado) {
    case "sincronizando": return "Sincronizando…";
    case "ok": return `Sincronizado · ${haceCuanto(sync.ultima)}`;
    case "pendiente": return sync.mensaje || "Cambios pendientes de sincronizar";
    case "error": return "Error de sincronización · toca para ver";
    default: return "";
  }
}

function renderSync() {
  const chip = $("sync-chip");
  chip.hidden = sync.estado === "off";
  chip.dataset.estado = sync.estado;
  $("sync-chip-text").textContent = textoEstado();
  const on = !!sync.codigo;
  $("sync-off").hidden = on;
  $("sync-on").hidden = !on;
  if (on) {
    $("sync-code").textContent = sync.codigo;
    $("sync-status").textContent = sync.estado === "error" ? sync.mensaje : textoEstado();
  }
}

const syncDlg = $("sync-dialog");
function syncError(msg, input) {
  $("sync-error").textContent = msg || "";
  if (input) input.classList.toggle("is-error", !!msg);
}
function abrirSync(codigoPrefill) {
  syncError("", $("sync-join-input"));
  if (codigoPrefill && !sync.codigo) $("sync-join-input").value = codigoPrefill;
  renderSync();
  if (!syncDlg.open) syncDlg.showModal();
}

$("sync-chip").addEventListener("click", () => abrirSync());
$("sync-close").addEventListener("click", () => syncDlg.close());

async function conBoton(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

$("sync-create").addEventListener("click", (e) => conBoton(e.currentTarget, async () => {
  syncError("");
  try {
    await sync.activar(generarCodigo(), { unirse: false });
    renderSync();
    toast("Sincronización activada. Usa el código en tus otros dispositivos.");
  } catch (err) {
    sync.desvincular();
    syncError(err.message || "No se pudo activar la sincronización.");
  }
}));

$("sync-join").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("sync-join-input");
  const codigo = normalizarCodigo(input.value);
  if (!codigo) return syncError("El código tiene 16 caracteres, por ejemplo ABCD-EFGH-JKLM-NPQR.", input);
  conBoton(e.submitter || $("sync-join-btn"), async () => {
    syncError("", input);
    try {
      await sync.activar(codigo, { unirse: true });
      input.value = "";
      renderSync();
      toast("Dispositivo vinculado. Los datos se han combinado.");
    } catch (err) {
      sync.desvincular();
      syncError(err.status === 404
        ? "No hay datos con ese código. Revisa que esté bien escrito."
        : err.message || "No se pudo vincular.", input);
    }
  });
});

$("sync-now").addEventListener("click", (e) => conBoton(e.currentTarget, () => sync.sincronizar()));

async function copiar(texto, aviso) {
  try {
    await navigator.clipboard.writeText(texto);
    toast(aviso);
  } catch {
    prompt("Copia este texto:", texto);
  }
}
$("sync-copy").addEventListener("click", () => copiar(sync.codigo, "Código copiado"));
$("sync-copy-link").addEventListener("click", () => {
  // El código va en el fragmento (#), que el navegador nunca envía al servidor.
  const url = new URL(location.href);
  url.hash = `codigo=${sync.codigo}`;
  copiar(url.href, "Enlace copiado. Ábrelo en el otro dispositivo.");
});

$("sync-unlink").addEventListener("click", () => {
  if (!confirm("¿Dejar de sincronizar este dispositivo? Los datos se quedan en este dispositivo y en la nube.")) return;
  sync.desvincular();
  toast("Este dispositivo ya no se sincroniza");
});

$("sync-delete").addEventListener("click", (e) => conBoton(e.currentTarget, async () => {
  if (!confirm("¿Eliminar los datos de la nube? Los dispositivos vinculados dejarán de sincronizar, pero cada uno conserva su copia local.")) return;
  try {
    await sync.pedir("DELETE");
    sync.desvincular();
    toast("Datos eliminados de la nube");
  } catch (err) {
    syncError(`No se pudo eliminar: ${err.message}`);
  }
}));

// Enlace de vinculación: .../pagos/#codigo=XXXX-XXXX-XXXX-XXXX
function leerEnlace() {
  const m = location.hash.match(/codigo=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  const codigo = normalizarCodigo(m[1]);
  if (!codigo) return toast("El enlace de sincronización no es válido.");
  if (sync.codigo === codigo) return toast("Este dispositivo ya está vinculado a ese código.");
  if (sync.codigo) return toast("Este dispositivo ya sincroniza con otro código. Desvincúlalo primero.");
  abrirSync(codigo);
}

window.addEventListener("online", () => sync.sincronizar());
window.addEventListener("offline", () => { if (sync.codigo) sync.marcar("pendiente", "Sin conexión. Se sincronizará al reconectar."); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync.sincronizar(); });
setInterval(() => { if (document.visibilityState === "visible") sync.sincronizar(); }, 60000);
setInterval(renderSync, 30000); // actualiza el "hace X min"

// ---------- Aviso ----------
let toastTimer;
function toast(msg, accion, fn) {
  const t = $("toast");
  t.replaceChildren(document.createTextNode(msg));
  if (accion) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = accion;
    b.addEventListener("click", () => { fn(); t.hidden = true; });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, accion ? 6000 : 2500);
}

// Si los datos cambian en otra pestaña, recargarlos.
window.addEventListener("storage", (e) => {
  if (e.key === KEY) { state = cargar(); if (!editing) render(); }
  if (e.key === RC_KEY) { recibos = cargarRecibos(); if (!editing) render(); }
  if (e.key === SYNC_KEY) { sync.cargar(); renderSync(); }
});

window.addEventListener("resize", fitAll);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

sync.cargar();
render();
renderSync();
leerEnlace();
sync.sincronizar();
