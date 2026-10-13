import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'

const sessionsDir = path.resolve(import.meta.dirname, '..', 'sessions')
fs.mkdirSync(sessionsDir, { recursive: true })

const logger = pino({ level: 'silent' })
const sockets = new Map()
const qrCodes = new Map()
const generation = new Map()
const retries = new Map()
let hooks = {
  onStatus() {},
  onMessage() {}
}
let baileysPromise

function sessionDir(chipId) {
  return path.join(sessionsDir, String(chipId))
}

async function loadBaileys() {
  if (!baileysPromise) baileysPromise = import('@whiskeysockets/baileys')
  return baileysPromise
}

async function waVersion(mod) {
  try {
    if (typeof mod.fetchLatestBaileysVersion === 'function') {
      return (await mod.fetchLatestBaileysVersion()).version
    }
    if (typeof mod.fetchLatestWaWebVersion === 'function') {
      return (await mod.fetchLatestWaWebVersion()).version
    }
  } catch (error) {
    console.warn('Não foi possível buscar a versão do WhatsApp:', error.message)
  }
  return undefined
}

function phoneFromUser(sock) {
  const id = sock.user?.id || ''
  return id.split('@')[0].split(':')[0] || null
}

function messageText(message) {
  if (!message) return ''
  let content = message
  const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'editedMessage']
  for (const key of wrappers) {
    if (content?.[key]?.message) content = content[key].message
  }
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    (content.imageMessage ? '[imagem]' : '') ||
    (content.videoMessage ? '[vídeo]' : '') ||
    (content.audioMessage ? '[áudio]' : '') ||
    (content.stickerMessage ? '[figurinha]' : '') ||
    (content.documentMessage ? '[documento]' : '') ||
    ''
  )
}

export function init(nextHooks) {
  hooks = nextHooks
}

export function getQr(chipId) {
  return qrCodes.get(chipId) || null
}

export function isConnected(chipId) {
  return Boolean(sockets.get(chipId)?.sock?.user)
}

export async function connectChip(chip, { fresh = false } = {}) {
  const gen = (generation.get(chip.id) || 0) + 1
  generation.set(chip.id, gen)
  if (fresh) retries.set(chip.id, 0)
  qrCodes.delete(chip.id)
  const previous = sockets.get(chip.id)
  sockets.delete(chip.id)
  if (previous?.sock) {
    try { previous.sock.end(undefined) } catch { /* encerra a sessão anterior */ }
  }
  hooks.onStatus(chip.id, { status: 'connecting', lastError: null, active: 1 })

  let mod
  try {
    mod = await loadBaileys()
  } catch (error) {
    hooks.onStatus(chip.id, { status: 'error', lastError: 'Falha ao carregar a conexão do WhatsApp' })
    console.error(error)
    return
  }
  if (generation.get(chip.id) !== gen) return

  const dir = sessionDir(chip.id)
  fs.mkdirSync(dir, { recursive: true })
  const { state, saveCreds } = await mod.useMultiFileAuthState(dir)
  const version = await waVersion(mod)
  if (generation.get(chip.id) !== gen) return
  const makeWASocket = mod.default?.makeWASocket || mod.makeWASocket || mod.default
  if (typeof makeWASocket !== 'function') {
    hooks.onStatus(chip.id, { status: 'error', lastError: 'Biblioteca do WhatsApp em formato inesperado' })
    return
  }
  let sock
  try {
    sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: mod.Browsers?.ubuntu?.('Disparo') || ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
      generateHighQualityLinkPreview: false
    })
  } catch (error) {
    console.error(error)
    hooks.onStatus(chip.id, { status: 'error', lastError: 'Não foi possível abrir a conexão' })
    return
  }
  sockets.set(chip.id, { sock })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    if (generation.get(chip.id) !== gen) return
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 })
        qrCodes.set(chip.id, dataUrl)
        hooks.onStatus(chip.id, { status: 'qr', lastError: null })
      } catch (error) {
        console.error(error)
      }
    }
    if (connection === 'open') {
      qrCodes.delete(chip.id)
      retries.delete(chip.id)
      hooks.onStatus(chip.id, {
        status: 'connected',
        phone: phoneFromUser(sock),
        lastError: null,
        active: 1
      })
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === mod.DisconnectReason?.loggedOut
      const restart = statusCode === mod.DisconnectReason?.restartRequired
      sockets.delete(chip.id)
      qrCodes.delete(chip.id)
      if (generation.get(chip.id) !== gen) return
      generation.set(chip.id, gen + 1)
      if (loggedOut) {
        fs.rmSync(dir, { recursive: true, force: true })
        hooks.onStatus(chip.id, { status: 'disconnected', active: 0, lastError: null, phone: null })
        return
      }
      const attempt = (retries.get(chip.id) || 0) + (restart ? 0 : 1)
      retries.set(chip.id, attempt)
      if (!restart && attempt > 6) {
        hooks.onStatus(chip.id, {
          status: 'error',
          lastError: 'A conexão caiu várias vezes. Gere o QR de novo.'
        })
        return
      }
      hooks.onStatus(chip.id, { status: 'connecting', lastError: null })
      setTimeout(() => {
        if (generation.get(chip.id) !== gen + 1) return
        connectChip(chip).catch((error) => console.error(error))
      }, restart ? 800 : 3000)
    }
  })

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const message of messages || []) {
      const jid = message.key?.remoteJid || ''
      if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) continue
      const body = messageText(message.message)
      if (!body) continue
      const at = message.messageTimestamp
        ? new Date(Number(message.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString()
      hooks.onMessage({
        chipId: chip.id,
        jid,
        name: message.pushName || null,
        fromMe: Boolean(message.key.fromMe),
        body,
        waId: message.key.id || null,
        at
      })
    }
  })
}

export async function disconnectChip(chipId) {
  generation.set(chipId, (generation.get(chipId) || 0) + 1)
  const entry = sockets.get(chipId)
  sockets.delete(chipId)
  qrCodes.delete(chipId)
  if (entry?.sock) {
    try {
      await entry.sock.logout()
    } catch {
      try { entry.sock.end(undefined) } catch { /* sessão já encerrada */ }
    }
  }
  fs.rmSync(sessionDir(chipId), { recursive: true, force: true })
}

export async function removeChipSession(chipId) {
  await disconnectChip(chipId)
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function sendText(chipId, phone, text) {
  const sock = sockets.get(chipId)?.sock
  if (!sock?.user) throw new Error('Chip desconectado')
  const lookup = await withTimeout(sock.onWhatsApp(String(phone)), 20000, 'Tempo esgotado ao consultar o número')
  const hit = Array.isArray(lookup) ? lookup.find((item) => item?.exists) : null
  if (!hit?.jid) throw new Error('Número sem WhatsApp')
  const sent = await withTimeout(sock.sendMessage(hit.jid, { text }), 30000, 'Tempo esgotado no envio')
  return { jid: hit.jid, waId: sent?.key?.id || null }
}

export async function sendToJid(chipId, jid, text) {
  const sock = sockets.get(chipId)?.sock
  if (!sock?.user) throw new Error('Chip desconectado')
  const sent = await withTimeout(sock.sendMessage(jid, { text }), 30000, 'Tempo esgotado no envio')
  return { jid, waId: sent?.key?.id || null }
}
