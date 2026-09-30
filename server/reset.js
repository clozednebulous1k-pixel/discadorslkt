import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'virtua.db');

for (const f of [base, `${base}-wal`, `${base}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
console.log('Banco apagado. Rode "npm start" para recriar com os dados de demonstração.');
