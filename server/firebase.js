import crypto from 'node:crypto'
import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

function credenciais() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim()
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1)
    }
    const json = JSON.parse(raw)
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: String(json.private_key || '').replace(/\\n/g, '\n')
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const chave = process.env.FIREBASE_PRIVATE_KEY
  if (!projectId || !clientEmail || !chave) {
    throw new Error('Credenciais do Firebase ausentes. Confira as variáveis na Vercel.')
  }
  return { projectId, clientEmail, privateKey: chave.replace(/\\n/g, '\n') }
}

let banco = null

function iniciar() {
  if (banco) return banco
  const emulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
  const cred = emulador ? null : credenciais()
  const app = getApps()[0] || initializeApp(emulador
    ? { projectId: process.env.FIREBASE_PROJECT_ID || 'demo-disparo' }
    : { credential: cert(cred) })
  banco = getFirestore(app)
  try {
    banco.settings({ ignoreUndefinedProperties: true })
  } catch { /* a instância já foi configurada */ }
  return banco
}

export const fs = new Proxy({}, {
  get(_target, prop) {
    const real = iniciar()
    const value = real[prop]
    return typeof value === 'function' ? value.bind(real) : value
  }
})

export const C = (nome) => fs.collection(nome)

export async function gravarEmLotes(operacoes) {
  for (let i = 0; i < operacoes.length; i += 400) {
    const lote = fs.batch()
    for (const operacao of operacoes.slice(i, i + 400)) operacao(lote)
    await lote.commit()
  }
}

export async function lerVarios(refs) {
  const out = []
  for (let i = 0; i < refs.length; i += 300) {
    if (!refs.slice(i, i + 300).length) continue
    out.push(...await fs.getAll(...refs.slice(i, i + 300)))
  }
  return out
}

export function agora() {
  return new Date().toISOString()
}

export function tokenSeguro() {
  return crypto.randomBytes(32).toString('hex')
}
