// API de sincronización de Control de Pagos, guardada en Cloudflare D1.
//
// Cada libro de pagos se identifica con un código secreto que solo conocen los dispositivos
// vinculados. El cliente lo envía en la cabecera "Authorization: Bearer <código>"; en D1 se guarda
// solo su hash SHA-256, así que la base de datos no revela los códigos.
//
//   GET    /api/pagos   devuelve { state, version, updatedAt }, o 404 si el código no tiene datos
//   PUT    /api/pagos   body { state }: fusiona con lo guardado y devuelve el resultado
//   DELETE /api/pagos   borra el libro de la nube (los dispositivos conservan su copia local)

import { validarEstado, fusionar, normalizarCodigo } from "../public/pagos/calc.js";

const MAX_BODY = 512 * 1024;
const MAX_INTENTOS = 5;

// Igual que migrations/0001_pagos.sql. Se ejecuta una vez por instancia del Worker para que la
// sincronización funcione aunque no se hayan aplicado las migraciones tras el primer deploy.
const ESQUEMA = "CREATE TABLE IF NOT EXISTS ledgers (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)";
let esquemaListo = null;

export async function handlePagos(request, env) {
  if (!env.DB) return json({ error: "Sincronización no configurada (falta la base de datos D1)" }, 503);

  const codigo = normalizarCodigo((request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!codigo) return json({ error: "Código de sincronización no válido" }, 401);
  const id = await sha256(codigo);
  esquemaListo ||= env.DB.prepare(ESQUEMA).run().catch((e) => { esquemaListo = null; throw e; });
  await esquemaListo;

  switch (request.method) {
    case "GET": {
      const row = await leer(env.DB, id);
      if (!row) return json({ error: "No hay datos para este código" }, 404);
      return json({ state: JSON.parse(row.data), version: row.version, updatedAt: row.updated_at });
    }
    case "PUT": {
      const entrante = await leerCuerpo(request);
      if (!entrante) return json({ error: "Datos no válidos" }, 400);
      // Lectura-fusión-escritura con control de versión: si otro dispositivo escribió entre medias,
      // se vuelve a leer y fusionar en lugar de pisar sus cambios.
      for (let i = 0; i < MAX_INTENTOS; i++) {
        const row = await leer(env.DB, id);
        const ahora = Date.now();
        if (!row) {
          const res = await env.DB.prepare(
            "INSERT INTO ledgers (id, data, version, updated_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(id) DO NOTHING"
          ).bind(id, JSON.stringify(entrante), ahora).run();
          if (res.meta.changes === 1) return json({ state: entrante, version: 1, updatedAt: ahora });
          continue;
        }
        const guardado = validarEstado(JSON.parse(row.data)) || { deuda: 0, deudaActualizada: 0, pagos: [] };
        const fusion = fusionar(guardado, entrante);
        if (fusion.pagos.length > 5000) return json({ error: "Demasiados pagos" }, 413);
        const data = JSON.stringify(fusion);
        if (data === row.data) return json({ state: fusion, version: row.version, updatedAt: row.updated_at });
        const res = await env.DB.prepare(
          "UPDATE ledgers SET data = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4"
        ).bind(data, ahora, id, row.version).run();
        if (res.meta.changes === 1) return json({ state: fusion, version: row.version + 1, updatedAt: ahora });
      }
      return json({ error: "Demasiados cambios simultáneos; inténtalo de nuevo" }, 409);
    }
    case "DELETE": {
      await env.DB.prepare("DELETE FROM ledgers WHERE id = ?1").bind(id).run();
      return json({ ok: true });
    }
    default:
      return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT, DELETE" });
  }
}

function leer(db, id) {
  return db.prepare("SELECT data, version, updated_at FROM ledgers WHERE id = ?1").bind(id).first();
}

async function leerCuerpo(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    return validarEstado(JSON.parse(text).state);
  } catch {
    return null;
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  });
}
