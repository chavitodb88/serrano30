const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '../../storage');
const DB_PATH = path.join(STORAGE_DIR, 'data.db');

// Crear directorios de storage si no existen
const dirs = ['uploads', 'processed', 'exports'].map((d) => path.join(STORAGE_DIR, d));
[STORAGE_DIR, ...dirs].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const db = new Database(DB_PATH);

// WAL mode para mejor rendimiento concurrente
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    analyzed_at DATETIME,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL UNIQUE,
    finca_registral TEXT,
    registro_propiedad TEXT,
    idufir TEXT,
    referencia_catastral TEXT,
    metros_cuadrados REAL,
    valor_tasacion REAL,
    acreedor_hipoteca TEXT,
    principal_hipotecario REAL,
    interes_ordinario TEXT,
    intereses_moratorios TEXT,
    tipo_dominio TEXT,
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    document_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
