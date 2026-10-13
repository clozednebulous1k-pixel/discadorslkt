import { C, fs, gravarEmLotes, lerVarios, agora } from './firebase.js'

function doc(snapshot) {
  if (!snapshot?.exists) return null
  return { id: snapshot.id, ...snapshot.data() }
}

function lista(snapshot) {
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
}

function porData(itens) {
  return [...itens].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

export async function createUser({ name, email, passwordHash }) {
  const existente = await findUserByEmail(email)
  if (existente) {
    const error = new Error('UNIQUE')
    throw error
  }
  const ref = C('users').doc()
  const user = { name, email, password_hash: passwordHash, created_at: agora() }
  await ref.set(user)
  return { id: ref.id, name, email, created_at: user.created_at }
}

export async function findUserByEmail(email) {
  const snap = await C('users').where('email', '==', email).limit(1).get()
  return snap.empty ? null : doc(snap.docs[0])
}

export async function createSession(token, userId) {
  await C('sessions').doc(token).set({ user_id: userId, created_at: agora() })
}

export async function getSessionUser(token) {
  if (!token) return null
  const session = await C('sessions').doc(token).get()
  if (!session.exists) return null
  const user = await C('users').doc(session.data().user_id).get()
  if (!user.exists) return null
  const data = user.data()
  return { id: user.id, name: data.name, email: data.email }
}

export async function deleteSession(token) {
  if (!token) return
  await C('sessions').doc(token).delete().catch(() => {})
}

export async function createChip(userId, name) {
  const ref = C('chips').doc()
  const chip = {
    user_id: userId,
    name,
    phone: null,
    status: 'connecting',
    last_error: null,
    qr: null,
    active: 1,
    created_at: agora()
  }
  await ref.set(chip)
  return { id: ref.id, ...chip }
}

export async function listChips(userId) {
  const snap = await C('chips').where('user_id', '==', userId).get()
  return porData(lista(snap))
}

export async function getChip(userId, id) {
  const snap = await C('chips').doc(String(id)).get()
  const chip = doc(snap)
  if (!chip || chip.user_id !== userId) return null
  return chip
}

export async function getChipById(id) {
  return doc(await C('chips').doc(String(id)).get())
}

export async function allActiveChips() {
  const snap = await C('chips').where('active', '==', 1).get()
  return lista(snap)
}

export async function updateChip(id, patch) {
  const data = {}
  if (patch.status !== undefined) data.status = patch.status
  if (patch.phone !== undefined) data.phone = patch.phone
  if (patch.lastError !== undefined) data.last_error = patch.lastError
  if (patch.active !== undefined) data.active = patch.active
  if (patch.qr !== undefined) data.qr = patch.qr
  if (!Object.keys(data).length) return
  await C('chips').doc(String(id)).set(data, { merge: true })
}

async function apagarConsulta(query) {
  const snap = await query.limit(200).get()
  if (snap.empty) return
  const lote = fs.batch()
  snap.docs.forEach((item) => lote.delete(item.ref))
  await lote.commit()
  if (snap.size === 200) await apagarConsulta(query)
}

async function apagarMensagens(chatId) {
  const ref = C('chats').doc(chatId).collection('messages')
  const snap = await ref.limit(200).get()
  if (snap.empty) return
  const lote = fs.batch()
  snap.docs.forEach((item) => lote.delete(item.ref))
  await lote.commit()
  if (snap.size === 200) await apagarMensagens(chatId)
}

export async function deleteChip(userId, id) {
  const chip = await getChip(userId, id)
  if (!chip) return false
  const campaigns = await C('campaigns').where('chip_id', '==', id).get()
  const lote = fs.batch()
  campaigns.docs.forEach((item) => {
    if (['running', 'paused'].includes(item.data().status)) {
      lote.set(item.ref, { status: 'cancelled', finished_at: agora() }, { merge: true })
    }
  })
  await lote.commit()
  const chats = await C('chats').where('chip_id', '==', id).get()
  for (const chat of chats.docs) {
    await apagarMensagens(chat.id)
    await chat.ref.delete()
  }
  await C('chips').doc(String(id)).delete()
  return true
}

export async function createList(userId, name) {
  const ref = C('lists').doc()
  const list = { user_id: userId, name, created_at: agora() }
  await ref.set(list)
  return { id: ref.id, ...list, total: 0 }
}

export async function listLists(userId) {
  const snap = await C('lists').where('user_id', '==', userId).get()
  const lists = porData(lista(snap))
  const contacts = await C('contacts').where('user_id', '==', userId).get()
  const totais = new Map()
  contacts.docs.forEach((item) => {
    const listId = item.data().list_id
    totais.set(listId, (totais.get(listId) || 0) + 1)
  })
  return lists.map((list) => ({ ...list, total: totais.get(list.id) || 0 }))
}

export async function getList(userId, id) {
  const list = doc(await C('lists').doc(String(id)).get())
  if (!list || list.user_id !== userId) return null
  return list
}

export async function deleteList(userId, id) {
  const list = await getList(userId, id)
  if (!list) return false
  await apagarConsulta(C('contacts').where('list_id', '==', id))
  await C('lists').doc(String(id)).delete()
  return true
}

export async function addContacts(listId, userId, contacts) {
  const refs = contacts.map((contact) => C('contacts').doc(`${listId}_${contact.phone}`))
  const atuais = refs.length ? await lerVarios(refs) : []
  const operacoes = []
  let added = 0
  atuais.forEach((snap, index) => {
    if (snap.exists) return
    added += 1
    const contact = contacts[index]
    operacoes.push((lote) => lote.set(refs[index], {
      list_id: listId,
      user_id: userId,
      name: contact.name || '',
      phone: contact.phone,
      created_at: agora()
    }))
  })
  await gravarEmLotes(operacoes)
  return { added, skipped: contacts.length - added }
}

export async function listContacts(userId, listId) {
  const list = await getList(userId, listId)
  if (!list) return null
  const snap = await C('contacts').where('list_id', '==', listId).get()
  const contacts = porData(lista(snap)).slice(0, 5000)
  return { list, contacts, total: snap.size }
}

export async function listContactRows(listId) {
  const snap = await C('contacts').where('list_id', '==', listId).get()
  return lista(snap).map((contact) => ({ name: contact.name, phone: contact.phone }))
}

export async function deleteContact(userId, contactId) {
  const ref = C('contacts').doc(String(contactId))
  const contact = doc(await ref.get())
  if (!contact || contact.user_id !== userId) return false
  await ref.delete()
  return true
}

export async function createCampaign({ userId, chip, list, name, message, intervalSec, contacts }) {
  const ref = C('campaigns').doc()
  const campaign = {
    user_id: userId,
    chip_id: chip.id,
    chip_name: chip.name,
    list_id: list.id,
    list_name: list.name,
    name,
    message,
    interval_sec: intervalSec,
    status: 'running',
    error: null,
    total: contacts.length,
    sent: 0,
    failed: 0,
    tick_at: null,
    created_at: agora(),
    finished_at: null
  }
  await ref.set(campaign)
  const operacoes = contacts.map((contact, index) => (lote) => lote.set(C('deliveries').doc(`${ref.id}_${index}`), {
    campaign_id: ref.id,
    user_id: userId,
    seq: index,
    contact_name: contact.name || '',
    phone: contact.phone,
    status: 'pending',
    error: null,
    sent_at: null
  }))
  await gravarEmLotes(operacoes)
  return { id: ref.id, ...campaign, deliveries: [] }
}

export async function listCampaigns(userId) {
  const snap = await C('campaigns').where('user_id', '==', userId).get()
  return porData(lista(snap))
}

export async function getCampaign(userId, id) {
  const campaign = doc(await C('campaigns').doc(String(id)).get())
  if (!campaign || campaign.user_id !== userId) return null
  const snap = await C('deliveries').where('campaign_id', '==', id).get()
  campaign.deliveries = lista(snap).sort((a, b) => b.seq - a.seq).slice(0, 200)
  return campaign
}

export async function getCampaignRaw(id) {
  return doc(await C('campaigns').doc(String(id)).get())
}

export async function setCampaignStatus(id, status, error = null) {
  const data = { status, error }
  if (status === 'done' || status === 'cancelled') data.finished_at = agora()
  await C('campaigns').doc(String(id)).set(data, { merge: true })
}

export async function claimTick(id) {
  const ref = C('campaigns').doc(String(id))
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    const data = snap.data()
    if (data.status !== 'running') return false
    const wait = Math.max(3, Number(data.interval_sec) || 8) * 1000
    const last = data.tick_at ? Date.parse(data.tick_at) : 0
    if (last && Date.now() - last < wait) return false
    tx.set(ref, { tick_at: new Date().toISOString() }, { merge: true })
    return true
  })
}

export async function nextPending(campaignId) {
  const snap = await C('deliveries').where('campaign_id', '==', campaignId).get()
  return lista(snap)
    .filter((item) => item.status === 'pending')
    .sort((a, b) => a.seq - b.seq)[0] || null
}

export async function markDelivery(id, campaignId, status, error) {
  const deliveryRef = C('deliveries').doc(String(id))
  const campaignRef = C('campaigns').doc(String(campaignId))
  await fs.runTransaction(async (tx) => {
    const campaign = (await tx.get(campaignRef)).data() || {}
    tx.set(deliveryRef, {
      status,
      error: error || null,
      sent_at: status === 'sent' ? agora() : null
    }, { merge: true })
    const patch = {}
    if (status === 'sent') patch.sent = Number(campaign.sent || 0) + 1
    if (status === 'failed') patch.failed = Number(campaign.failed || 0) + 1
    tx.set(campaignRef, patch, { merge: true })
  })
}

export async function runningCampaigns(userId) {
  const snap = await C('campaigns').where('user_id', '==', userId).get()
  return lista(snap).filter((item) => item.status === 'running')
}

export async function dashboard(userId) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const inicio = start.toISOString()
  const [chips, lists, contacts, campaigns, deliveries] = await Promise.all([
    C('chips').where('user_id', '==', userId).get(),
    C('lists').where('user_id', '==', userId).get(),
    C('contacts').where('user_id', '==', userId).get(),
    C('campaigns').where('user_id', '==', userId).get(),
    C('deliveries').where('user_id', '==', userId).get()
  ])
  const sentToday = deliveries.docs.filter((item) => {
    const data = item.data()
    return data.status === 'sent' && data.sent_at && data.sent_at >= inicio
  }).length
  return {
    chips: chips.size,
    connected: chips.docs.filter((item) => item.data().status === 'connected').length,
    contacts: contacts.size,
    lists: lists.size,
    sentToday,
    campaigns: campaigns.size,
    recent: porData(lista(campaigns)).slice(0, 5)
  }
}

function chatId(chipId, jid) {
  return `${chipId}__${String(jid).replace(/[^a-zA-Z0-9]/g, '_')}`
}

export async function saveChatMessage({ chipId, jid, name, fromMe, body, waId, at }) {
  if (!body || !jid) return
  const id = chatId(chipId, jid)
  const chatRef = C('chats').doc(id)
  const messageRef = waId
    ? chatRef.collection('messages').doc(String(waId))
    : chatRef.collection('messages').doc()
  await messageRef.set({
    chip_id: chipId,
    jid,
    from_me: Boolean(fromMe),
    body,
    wa_id: waId || null,
    created_at: at || agora()
  })
  await chatRef.set({
    chip_id: chipId,
    jid,
    name: name || null,
    last_message: body,
    last_at: at || agora()
  }, { merge: true })
}

export async function listChats(userId, chipId) {
  const chip = await getChip(userId, chipId)
  if (!chip) return null
  const snap = await C('chats').where('chip_id', '==', chipId).get()
  return lista(snap).sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || ''))).slice(0, 300)
}

export async function listMessages(userId, chipId, jid) {
  const chip = await getChip(userId, chipId)
  if (!chip) return null
  const snap = await C('chats').doc(chatId(chipId, jid)).collection('messages').orderBy('created_at').limitToLast(200).get()
  return lista(snap)
}
