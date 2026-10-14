import crypto from 'node:crypto'
import path from 'node:path'
import express from 'express'
import bcrypt from 'bcryptjs'
import * as db from './db.js'
import * as wa from './whatsapp.js'
import * as campaigns from './campaigns.js'
import { normalizePhone, formatPhone } from './phone.js'

const app = express()
const port = Number(process.env.PORT || 3000)
const publicDir = path.resolve(import.meta.dirname, '..', 'public')

app.use(express.json({ limit: '4mb' }))
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store')
  }
  next()
})

function parseCookies(req) {
  const header = req.headers.cookie || ''
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

function cookie(value, maxAge) {
  const secure = process.env.VERCEL ? '; Secure' : ''
  return `sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function setSession(res, token) {
  res.setHeader('Set-Cookie', cookie(token, 60 * 60 * 24 * 30))
}

function clearSession(res) {
  res.setHeader('Set-Cookie', cookie('', 0))
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

async function auth(req, res, next) {
  try {
    const user = await db.getSessionUser(parseCookies(req).sid || '')
    if (!user) return res.status(401).json({ error: 'Faça login para continuar' })
    req.user = user
    next()
  } catch (error) {
    next(error)
  }
}

function isDirectJid(jid) {
  return /^[\d]+(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.test(jid)
}

function cleanName(value, label, max = 80) {
  const name = String(value || '').trim()
  if (!name) return { error: `Informe ${label}` }
  if (name.length > max) return { error: `${label} deve ter no máximo ${max} caracteres` }
  return { name }
}

function parseContactText(text) {
  const rows = []
  const invalid = []
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^nome\b/i.test(line) && /telefone|phone|numero|número|celular/i.test(line)) continue
    const parts = line.split(/[;,|\t]/).map((part) => part.trim()).filter(Boolean)
    let name = ''
    let phoneSource = parts[0] || ''
    if (parts.length > 1) {
      const firstIsPhone = normalizePhone(parts[0]) && !normalizePhone(parts[1])
      if (firstIsPhone) {
        phoneSource = parts[0]
        name = parts.slice(1).join(' ')
      } else {
        name = parts[0]
        phoneSource = parts[1]
      }
    }
    const phone = normalizePhone(phoneSource)
    if (!phone) {
      invalid.push(line)
      continue
    }
    rows.push({ name: name.slice(0, 80), phone })
  }
  return { rows, invalid }
}

function ensureChip(chip) {
  if (!chip?.active || chip.status === 'disconnected') return
  if (wa.isConnected(chip.id) || wa.isPending(chip.id)) return
  wa.connectChip(chip).catch((error) => console.error(error))
}

app.get('/api/health', asyncRoute(async (req, res) => {
  try {
    const { C } = await import('./firebase.js')
    await C('users').limit(1).get()
    res.json({ ok: true, firebase: true })
  } catch (error) {
    res.status(500).json({ ok: false, firebase: false, error: error.message })
  }
}))

app.get('/api/me', asyncRoute(async (req, res) => {
  const user = await db.getSessionUser(parseCookies(req).sid || '')
  res.json({ user: user || null })
}))

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = cleanName(req.body?.name, 'o nome')
  if (name.error) return res.status(400).json({ error: name.error })
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email.includes('@') || email.length > 120) return res.status(400).json({ error: 'E-mail inválido' })
  if (password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres' })
  try {
    const user = await db.createUser({
      name: name.name,
      email,
      passwordHash: await bcrypt.hash(password, 10)
    })
    const token = crypto.randomBytes(32).toString('hex')
    await db.createSession(token, user.id)
    setSession(res, token)
    res.json({ user })
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado' })
    }
    throw error
  }
}))

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = await db.findUserByEmail(email)
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' })
  }
  const token = crypto.randomBytes(32).toString('hex')
  await db.createSession(token, user.id)
  setSession(res, token)
  res.json({ user: { id: user.id, name: user.name, email: user.email } })
}))

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = parseCookies(req).sid
  if (token) await db.deleteSession(token)
  clearSession(res)
  res.json({ ok: true })
}))

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  res.json(await db.dashboard(req.user.id))
}))

app.get('/api/chips', auth, asyncRoute(async (req, res) => {
  const chips = await db.listChips(req.user.id)
  chips.forEach(ensureChip)
  res.json(chips.map((chip) => ({
    ...chip,
    phoneLabel: formatPhone(chip.phone),
    qr: chip.status === 'qr' ? (wa.getQr(chip.id) || chip.qr || null) : null
  })))
}))

app.post('/api/chips', auth, asyncRoute(async (req, res) => {
  const name = cleanName(req.body?.name, 'o nome do chip')
  if (name.error) return res.status(400).json({ error: name.error })
  const chip = await db.createChip(req.user.id, name.name)
  wa.connectChip(chip, { fresh: true }).catch(async (error) => {
    console.error(error)
    await db.updateChip(chip.id, { status: 'error', lastError: 'Não foi possível iniciar a conexão' })
  })
  res.status(201).json(chip)
}))

app.post('/api/chips/:id/connect', auth, asyncRoute(async (req, res) => {
  const chip = await db.getChip(req.user.id, req.params.id)
  if (!chip) return res.status(404).json({ error: 'Chip não encontrado' })
  await db.updateChip(chip.id, { active: 1, status: 'connecting', lastError: null, qr: null })
  wa.connectChip({ ...chip, active: 1 }, { fresh: true }).catch((error) => console.error(error))
  res.json({ ok: true })
}))

app.post('/api/chips/:id/disconnect', auth, asyncRoute(async (req, res) => {
  const chip = await db.getChip(req.user.id, req.params.id)
  if (!chip) return res.status(404).json({ error: 'Chip não encontrado' })
  await wa.disconnectChip(chip.id)
  await db.updateChip(chip.id, { status: 'disconnected', active: 0, lastError: null, qr: null })
  res.json({ ok: true })
}))

app.delete('/api/chips/:id', auth, asyncRoute(async (req, res) => {
  const chip = await db.getChip(req.user.id, req.params.id)
  if (!chip) return res.status(404).json({ error: 'Chip não encontrado' })
  await wa.removeChipSession(chip.id)
  await db.deleteChip(req.user.id, chip.id)
  res.json({ ok: true })
}))

app.get('/api/lists', auth, asyncRoute(async (req, res) => {
  res.json(await db.listLists(req.user.id))
}))

app.post('/api/lists', auth, asyncRoute(async (req, res) => {
  const name = cleanName(req.body?.name, 'o nome da lista')
  if (name.error) return res.status(400).json({ error: name.error })
  res.status(201).json(await db.createList(req.user.id, name.name))
}))

app.delete('/api/lists/:id', auth, asyncRoute(async (req, res) => {
  if (!(await db.deleteList(req.user.id, req.params.id))) {
    return res.status(404).json({ error: 'Lista não encontrada' })
  }
  res.json({ ok: true })
}))

app.get('/api/lists/:id/contacts', auth, asyncRoute(async (req, res) => {
  const result = await db.listContacts(req.user.id, req.params.id)
  if (!result) return res.status(404).json({ error: 'Lista não encontrada' })
  result.contacts = result.contacts.map((contact) => ({
    ...contact,
    phoneLabel: formatPhone(contact.phone)
  }))
  res.json(result)
}))

app.post('/api/lists/:id/contacts', auth, asyncRoute(async (req, res) => {
  const list = await db.getList(req.user.id, req.params.id)
  if (!list) return res.status(404).json({ error: 'Lista não encontrada' })
  let parsed
  if (typeof req.body?.text === 'string') parsed = parseContactText(req.body.text)
  else {
    const phone = normalizePhone(req.body?.phone)
    if (!phone) return res.status(400).json({ error: 'Telefone inválido. Use DDD + número.' })
    const name = String(req.body?.name || '').trim().slice(0, 80)
    parsed = { rows: [{ name, phone }], invalid: [] }
  }
  if (!parsed.rows.length) {
    return res.status(400).json({ error: 'Nenhum telefone válido encontrado', invalid: parsed.invalid.slice(0, 10) })
  }
  if (parsed.rows.length > 20000) return res.status(400).json({ error: 'Limite de 20.000 contatos por importação' })
  const result = await db.addContacts(list.id, req.user.id, parsed.rows)
  res.json({ ...result, invalid: parsed.invalid.length })
}))

app.delete('/api/contacts/:id', auth, asyncRoute(async (req, res) => {
  if (!(await db.deleteContact(req.user.id, req.params.id))) {
    return res.status(404).json({ error: 'Contato não encontrado' })
  }
  res.json({ ok: true })
}))

app.get('/api/campaigns', auth, asyncRoute(async (req, res) => {
  if (process.env.VERCEL) await campaigns.tick(req.user.id)
  res.json(await db.listCampaigns(req.user.id))
}))

app.get('/api/campaigns/:id', auth, asyncRoute(async (req, res) => {
  const campaign = await db.getCampaign(req.user.id, req.params.id)
  if (!campaign) return res.status(404).json({ error: 'Disparo não encontrado' })
  campaign.deliveries = campaign.deliveries.map((delivery) => ({
    ...delivery,
    phoneLabel: formatPhone(delivery.phone)
  }))
  res.json(campaign)
}))

app.post('/api/campaigns', auth, asyncRoute(async (req, res) => {
  const name = cleanName(req.body?.name, 'o nome do disparo')
  if (name.error) return res.status(400).json({ error: name.error })
  const message = String(req.body?.message || '').trim()
  if (!message) return res.status(400).json({ error: 'Escreva a mensagem' })
  if (message.length > 4000) return res.status(400).json({ error: 'A mensagem passa de 4.000 caracteres' })
  const intervalSec = Number(req.body?.intervalSec)
  if (!Number.isInteger(intervalSec) || intervalSec < 3 || intervalSec > 180) {
    return res.status(400).json({ error: 'O intervalo deve ficar entre 3 e 180 segundos' })
  }
  const chip = await db.getChip(req.user.id, req.body?.chipId)
  if (!chip) return res.status(400).json({ error: 'Selecione um chip' })
  if (chip.status !== 'connected' && !wa.isConnected(chip.id)) {
    return res.status(400).json({ error: 'O chip precisa estar conectado' })
  }
  const list = await db.getList(req.user.id, req.body?.listId)
  if (!list) return res.status(400).json({ error: 'Selecione uma lista' })
  const contacts = await db.listContactRows(list.id)
  if (!contacts.length) return res.status(400).json({ error: 'A lista não tem contatos' })
  const campaign = await db.createCampaign({
    userId: req.user.id,
    chip,
    list,
    name: name.name,
    message,
    intervalSec,
    contacts
  })
  if (process.env.VERCEL) ensureChip(chip)
  else campaigns.kick(campaign.id)
  res.status(201).json(campaign)
}))

app.post('/api/campaigns/:id/pause', auth, asyncRoute(async (req, res) => {
  const campaign = await db.getCampaign(req.user.id, req.params.id)
  if (!campaign) return res.status(404).json({ error: 'Disparo não encontrado' })
  if (campaign.status === 'running') await db.setCampaignStatus(campaign.id, 'paused', null)
  res.json(await db.getCampaign(req.user.id, campaign.id))
}))

app.post('/api/campaigns/:id/resume', auth, asyncRoute(async (req, res) => {
  const campaign = await db.getCampaign(req.user.id, req.params.id)
  if (!campaign) return res.status(404).json({ error: 'Disparo não encontrado' })
  if (campaign.status === 'cancelled' || campaign.status === 'done') {
    return res.status(400).json({ error: 'Esse disparo já foi encerrado' })
  }
  const chip = await db.getChip(req.user.id, campaign.chip_id)
  if (!chip || (chip.status !== 'connected' && !wa.isConnected(chip.id))) {
    return res.status(400).json({ error: 'Conecte o chip antes de retomar' })
  }
  await db.setCampaignStatus(campaign.id, 'running', null)
  if (process.env.VERCEL) ensureChip(chip)
  else campaigns.kick(campaign.id)
  res.json(await db.getCampaign(req.user.id, campaign.id))
}))

app.post('/api/campaigns/:id/cancel', auth, asyncRoute(async (req, res) => {
  const campaign = await db.getCampaign(req.user.id, req.params.id)
  if (!campaign) return res.status(404).json({ error: 'Disparo não encontrado' })
  if (campaign.status === 'running' || campaign.status === 'paused') {
    await db.setCampaignStatus(campaign.id, 'cancelled', null)
  }
  res.json(await db.getCampaign(req.user.id, campaign.id))
}))

app.get('/api/chips/:id/chats', auth, asyncRoute(async (req, res) => {
  const chip = await db.getChip(req.user.id, req.params.id)
  if (!chip) return res.status(404).json({ error: 'Chip não encontrado' })
  ensureChip(chip)
  res.json(await db.listChats(req.user.id, chip.id))
}))

app.get('/api/chips/:id/messages', auth, asyncRoute(async (req, res) => {
  const jid = String(req.query.jid || '')
  if (!isDirectJid(jid)) return res.status(400).json({ error: 'Conversa inválida' })
  const messages = await db.listMessages(req.user.id, req.params.id, jid)
  if (!messages) return res.status(404).json({ error: 'Chip não encontrado' })
  res.json(messages)
}))

app.post('/api/chips/:id/send', auth, asyncRoute(async (req, res) => {
  const chip = await db.getChip(req.user.id, req.params.id)
  if (!chip) return res.status(404).json({ error: 'Chip não encontrado' })
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'Escreva a mensagem' })
  if (text.length > 4000) return res.status(400).json({ error: 'A mensagem passa de 4.000 caracteres' })
  const jid = String(req.body?.jid || '')
  if (!isDirectJid(jid)) return res.status(400).json({ error: 'Conversa inválida' })
  if (!wa.isConnected(chip.id)) {
    ensureChip(chip)
    return res.status(400).json({ error: 'Chip reconectando. Tente de novo em alguns segundos.' })
  }
  const sent = await wa.sendToJid(chip.id, jid, text)
  await db.saveChatMessage({
    chipId: chip.id,
    jid,
    name: null,
    fromMe: true,
    body: text,
    waId: sent.waId,
    at: new Date().toISOString()
  })
  res.json({ ok: true })
}))

app.use(express.static(publicDir))

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return next(error)
  const message = String(error.message || '')
  let publico = 'Erro interno. Tente de novo.'
  if (/Firebase|credential|FIREBASE|PERMISSION|UNAUTHENTICATED|service account/i.test(message)) {
    publico = 'O Firebase não conectou. Confira as variáveis na Vercel.'
  }
  res.status(500).json({ error: publico, detalhe: message })
})

export async function boot() {
  if (globalThis.__disparoBoot) return globalThis.__disparoBoot
  globalThis.__disparoBoot = (async () => {
    wa.init({
      onStatus(chipId, patch) {
        db.updateChip(chipId, patch).catch((error) => console.error(error))
      },
      onMessage(message) {
        db.saveChatMessage(message).catch((error) => console.error(error))
      }
    })
    if (!process.env.VERCEL) {
      const chips = await db.allActiveChips()
      chips.forEach((chip, index) => {
        setTimeout(() => {
          wa.connectChip(chip).catch((error) => console.error(error))
        }, index * 1200)
      })
      await campaigns.resumeRunning()
    }
  })()
  return globalThis.__disparoBoot
}

export { app }

if (!process.env.VERCEL) {
  boot().then(() => {
    app.listen(port, () => {
      console.log(`Disparo em http://localhost:${port}`)
    })
  }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
