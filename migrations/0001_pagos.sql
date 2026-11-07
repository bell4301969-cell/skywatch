-- Control de Pagos: un libro de pagos por código de sincronización.
-- id = SHA-256 (hex) del código; data = estado JSON; version = control de concurrencia optimista.
CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
