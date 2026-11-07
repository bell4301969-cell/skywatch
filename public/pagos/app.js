import {
  parseMonto, formatMonto, formatFecha, hoyISO, resumen, toCSV, validarEstado,
  fusionar, generarCodigo, normalizarCodigo
} from "./calc.js";

const KEY = "control-pagos-v1";
const SYNC_KEY = "control-pagos-sync";
const $ = (id) => document.getElementById(id);

let state = cargar();

function vacio() {
  return { deuda: 0, deudaActualizada: 0, pagos: [] };
}

function cargar() {
  try {
    const s = validarEstado(JSON.parse(localStorage.getItem(KEY)));
    if (s) return s;
  } catch { /* almacenamiento no disponible o datos dañados */ }
  return vacio();
}

function persistir() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    toast("No se pudo guardar en este navegador (modo privado o almacenamiento lleno).");
  }
}

// Guarda un cambio hecho por el usuario y lo envía a la nube si hay sincronización.
function guardar() {
  persistir();
  sync.programar();
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
    $("deuda-input").value = r.deuda ? montoEditable(r.deuda) : "";
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

function montoEditable(cents) {
  return cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100);
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
  state.deudaActualizada = Date.now();
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
  const ahora = Date.now();
  state.pagos.push({ id: nuevoId(), fecha, monto, nota: $("pago-nota").value.trim(), creado: ahora, actualizado: ahora });
  guardar();
  montoIn.value = "";
  $("pago-nota").value = "";
  render();
  toast(`Pago de ${formatMonto(monto)} agregado`);
});

// ---------- Editar / eliminar ----------
const dlg = $("edit-dialog");
let editId = null;
const buscar = (id) => state.pagos.find((x) => x.id === id && !x.borrado);

function abrirEditor(id) {
  const p = buscar(id);
  if (!p) return;
  editId = id;
  $("edit-fecha").value = p.fecha;
  $("edit-monto").value = montoEditable(p.monto);
  $("edit-nota").value = p.nota || "";
  mostrarError("edit-error", $("edit-monto"), "");
  dlg.showModal();
}

$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = buscar(editId);
  if (!p) return dlg.close();
  const fecha = $("edit-fecha").value;
  const monto = parseMonto($("edit-monto").value);
  if (!fecha) return mostrarError("edit-error", $("edit-fecha"), "Elige la fecha del depósito.");
  if (monto == null || monto <= 0) return mostrarError("edit-error", $("edit-monto"), "Escribe un monto mayor que cero.");
  Object.assign(p, { fecha, monto, nota: $("edit-nota").value.trim(), actualizado: Date.now() });
  guardar();
  dlg.close();
  render();
  toast("Pago actualizado");
});

$("edit-cancel").addEventListener("click", () => dlg.close());
$("edit-delete").addEventListener("click", () => {
  const p = buscar(editId);
  if (!p || !confirm(`¿Eliminar el pago de ${formatMonto(p.monto)} del ${formatFecha(p.fecha)}?`)) return;
  // Se marca como borrado (en vez de quitarlo) para que el borrado llegue a los demás dispositivos.
  p.borrado = true;
  p.actualizado = Date.now();
  guardar();
  dlg.close();
  render();
  const id = p.id;
  toast("Pago eliminado", "Deshacer", () => {
    // Buscar de nuevo: una sincronización intermedia puede haber sustituido el objeto.
    const q = state.pagos.find((x) => x.id === id);
    if (!q) return;
    delete q.borrado;
    q.actualizado = Date.now();
    guardar();
    render();
  });
});

// Sustituye todo el contenido (restaurar respaldo o borrar todo) de forma que se propague al sincronizar.
function reemplazarCon(nuevo) {
  const ahora = Date.now();
  const nuevosIds = new Set(nuevo.pagos.filter((p) => !p.borrado).map((p) => p.id));
  const pagos = state.pagos.filter((p) => !nuevosIds.has(p.id)).map((p) => ({ ...p, borrado: true, actualizado: ahora }));
  for (const p of nuevo.pagos) if (!p.borrado) pagos.push({ ...p, actualizado: ahora });
  state = { deuda: nuevo.deuda, deudaActualizada: ahora, pagos };
  guardar();
  render();
}

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
  if (action === "sync") abrirSync();
  if (action === "csv") descargar(`pagos-${fecha}.csv`, "﻿" + toCSV(state), "text/csv;charset=utf-8");
  if (action === "backup") {
    const limpio = { deuda: state.deuda, pagos: state.pagos.filter((p) => !p.borrado) };
    descargar(`control-pagos-${fecha}.json`, JSON.stringify(limpio, null, 2), "application/json");
  }
  if (action === "restore") $("restore-file").click();
  if (action === "reset") {
    const extra = sync.codigo ? " También se borrarán en los demás dispositivos sincronizados." : "";
    if (!confirm(`¿Borrar la cantidad adeudada y todos los pagos?${extra} Esta acción no se puede deshacer.`)) return;
    reemplazarCon(vacio());
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
    const n = s.pagos.filter((p) => !p.borrado).length;
    if (!confirm(`¿Reemplazar los datos actuales con el respaldo (${n} pagos)?`)) return;
    reemplazarCon(s);
    toast("Respaldo restaurado");
  } catch {
    toast("El archivo no es un respaldo válido de Control de Pagos.");
  }
});

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
          persistir();
          render();
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
    if (unirse) {
      // Comprobar que el código existe antes de vincular, para avisar si está mal escrito.
      await this.pedir("GET", null, codigo);
    }
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
function abrirSync(codigoPrefill) {
  mostrarError("sync-error", $("sync-join-input"), "");
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
  mostrarError("sync-error", null, "");
  try {
    await sync.activar(generarCodigo(), { unirse: false });
    renderSync();
    toast("Sincronización activada. Usa el código en tus otros dispositivos.");
  } catch (err) {
    sync.desvincular();
    mostrarError("sync-error", null, err.message || "No se pudo activar la sincronización.");
  }
}));

$("sync-join").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("sync-join-input");
  const codigo = normalizarCodigo(input.value);
  if (!codigo) return mostrarError("sync-error", input, "El código tiene 16 caracteres, por ejemplo ABCD-EFGH-JKLM-NPQR.");
  conBoton(e.submitter || $("sync-join-btn"), async () => {
    mostrarError("sync-error", input, "");
    try {
      await sync.activar(codigo, { unirse: true });
      input.value = "";
      renderSync();
      toast("Dispositivo vinculado. Los datos se han combinado.");
    } catch (err) {
      sync.desvincular();
      mostrarError("sync-error", input, err.status === 404
        ? "No hay datos con ese código. Revisa que esté bien escrito."
        : err.message || "No se pudo vincular.");
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
    mostrarError("sync-error", null, `No se pudo eliminar: ${err.message}`);
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

// Disparadores de sincronización.
window.addEventListener("online", () => sync.sincronizar());
window.addEventListener("offline", () => { if (sync.codigo) sync.marcar("pendiente", "Sin conexión. Se sincronizará al reconectar."); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync.sincronizar(); });
setInterval(() => {
  if (document.visibilityState === "visible") sync.sincronizar();
}, 60000);
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
    b.className = "toast-btn";
    b.addEventListener("click", () => { fn(); t.hidden = true; });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, accion ? 6000 : 2500);
}

// Si los datos cambian en otra pestaña, recargarlos.
window.addEventListener("storage", (e) => {
  if (e.key === KEY) { state = cargar(); render(); }
  if (e.key === SYNC_KEY) { sync.cargar(); renderSync(); }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

sync.cargar();
render();
renderSync();
leerEnlace();
sync.sincronizar();
