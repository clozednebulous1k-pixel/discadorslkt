import './tz.js';
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function credenciais() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const j = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    return { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key };
  }
  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: chave } = process.env;
  if (!projectId || !clientEmail || !chave) {
    throw new Error('Credenciais do Firebase ausentes. Defina FIREBASE_SERVICE_ACCOUNT ou '
      + 'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY (veja o README).');
  }
  return { projectId, clientEmail, privateKey: chave.replace(/\\n/g, '\n') };
}

const emulador = !!process.env.FIRESTORE_EMULATOR_HOST;
const cred = emulador ? null : credenciais();
const app = getApps()[0] || initializeApp(emulador
  ? { projectId: process.env.FIREBASE_PROJECT_ID || 'demo-virtuanosso' }
  : { credential: cert(cred) });

export const fs = getFirestore(app);
if (!globalThis.__firestoreConfigurado) {
  fs.settings({ ignoreUndefinedProperties: true });
  globalThis.__firestoreConfigurado = true;
}
export { FieldValue };

export const SEGREDO = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(cred?.privateKey || 'emulador-local').digest('hex');

export const C = (nome) => fs.collection(nome);

export function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(senha), salt, 64).toString('hex')}`;
}

export function verificarSenha(senha, armazenado) {
  const [salt, hash] = String(armazenado || '').split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(senha), salt, 64), Buffer.from(hash, 'hex'));
}

/** Grava operações em lotes de até 400 (limite do Firestore é 500 por lote). */
export async function gravarEmLotes(operacoes) {
  for (let i = 0; i < operacoes.length; i += 400) {
    const lote = fs.batch();
    for (const op of operacoes.slice(i, i + 400)) op(lote);
    await lote.commit();
  }
}

export async function lerVarios(refs) {
  const out = [];
  for (let i = 0; i < refs.length; i += 300) out.push(...await fs.getAll(...refs.slice(i, i + 300)));
  return out;
}
