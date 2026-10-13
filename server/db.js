import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dataDir = path.resolve(import.meta.dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })

const db = new DatabaseSync(path.join(dataDir, 'app.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chips (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'connecting',
    last_error TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(list_id, phone)
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    chip_id INTEGER,
    chip_name TEXT NOT NULL,
    list_id INTEGER,
    list_name TEXT NOT NULL,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    interval_sec INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    sent_at TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY,
    chip_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    name TEXT,
    last_message TEXT,
    last_at TEXT,
    UNIQUE(chip_id, jid)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    chip_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    body TEXT NOT NULL,
    wa_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_wa
    ON chat_messages(chip_id, wa_id) WHERE wa_id IS NOT NULL;
`)

function now() {
  return new Date().toISOString()
}

function one(sql, ...params) {
  return db.prepare(sql).get(...params)
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params)
}

function run(sql, ...params) {
  return db.prepare(sql).run(...params)
}

export function createUser({ name, email, passwordHash }) {
  const result = run(
    'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    name,
    email,
    passwordHash,
    now()
  )
  return findUserById(Number(result.lastInsertRowid))
}

export function findUserByEmail(email) {
  return one('SELECT * FROM users WHERE email = ?', email)
}

export function findUserById(id) {
  return one('SELECT id, name, email, created_at FROM users WHERE id = ?', id)
}

export function createSession(token, userId) {
  run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, now())
}

export function getSessionUser(token) {
  return one(
    `SELECT u.id, u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
    token
  )
}

export function deleteSession(token) {
  run('DELETE FROM sessions WHERE token = ?', token)
}

export function createChip(userId, name) {
  const result = run(
    'INSERT INTO chips (user_id, name, status, active, created_at) VALUES (?, ?, ?, 1, ?)',
    userId,
    name,
    'connecting',
    now()
  )
  return getChip(userId, Number(result.lastInsertRowid))
}

export function listChips(userId) {
  return all('SELECT * FROM chips WHERE user_id = ? ORDER BY id DESC', userId)
}

export function getChip(userId, id) {
  return one('SELECT * FROM chips WHERE id = ? AND user_id = ?', id, userId)
}

export function getChipById(id) {
  return one('SELECT * FROM chips WHERE id = ?', id)
}

export function allActiveChips() {
  return all('SELECT * FROM chips WHERE active = 1')
}

export function updateChip(id, patch) {
  const current = getChipById(id)
  if (!current) return
  run(
    'UPDATE chips SET status = ?, phone = ?, last_error = ?, active = ? WHERE id = ?',
    patch.status ?? current.status,
    patch.phone === undefined ? current.phone : patch.phone,
    patch.lastError === undefined ? current.last_error : patch.lastError,
    patch.active === undefined ? current.active : patch.active,
    id
  )
}

export function deleteChip(userId, id) {
  const chip = getChip(userId, id)
  if (!chip) return false
  run(`UPDATE campaigns SET status = 'cancelled', finished_at = ? WHERE chip_id = ? AND status IN ('running', 'paused')`, now(), id)
  run('DELETE FROM chat_messages WHERE chip_id = ?', id)
  run('DELETE FROM chats WHERE chip_id = ?', id)
  run('DELETE FROM chips WHERE id = ? AND user_id = ?', id, userId)
  return true
}

export function createList(userId, name) {
  const result = run(
    'INSERT INTO lists (user_id, name, created_at) VALUES (?, ?, ?)',
    userId,
    name,
    now()
  )
  return getList(userId, Number(result.lastInsertRowid))
}

export function listLists(userId) {
  return all(
    `SELECT l.*, (SELECT COUNT(*) FROM contacts c WHERE c.list_id = l.id) AS total
     FROM lists l WHERE l.user_id = ? ORDER BY l.id DESC`,
    userId
  )
}

export function getList(userId, id) {
  return one('SELECT * FROM lists WHERE id = ? AND user_id = ?', id, userId)
}

export function deleteList(userId, id) {
  const list = getList(userId, id)
  if (!list) return false
  run('DELETE FROM contacts WHERE list_id = ?', id)
  run('DELETE FROM lists WHERE id = ? AND user_id = ?', id, userId)
  return true
}

export function addContacts(listId, contacts) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO contacts (list_id, name, phone, created_at) VALUES (?, ?, ?, ?)'
  )
  let added = 0
  db.exec('BEGIN')
  try {
    for (const contact of contacts) {
      const result = insert.run(listId, contact.name || '', contact.phone, now())
      added += Number(result.changes)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { added, skipped: contacts.length - added }
}

export function listContacts(userId, listId) {
  const list = getList(userId, listId)
  if (!list) return null
  const contacts = all(
    'SELECT * FROM contacts WHERE list_id = ? ORDER BY id DESC LIMIT 5000',
    listId
  )
  const total = one('SELECT COUNT(*) AS total FROM contacts WHERE list_id = ?', listId).total
  return { list, contacts, total }
}

export function listContactRows(listId) {
  return all('SELECT name, phone FROM contacts WHERE list_id = ? ORDER BY id', listId)
}

export function deleteContact(userId, contactId) {
  const contact = one(
    `SELECT c.id FROM contacts c
     JOIN lists l ON l.id = c.list_id
     WHERE c.id = ? AND l.user_id = ?`,
    contactId,
    userId
  )
  if (!contact) return false
  run('DELETE FROM contacts WHERE id = ?', contactId)
  return true
}

export function createCampaign({ userId, chip, list, name, message, intervalSec, contacts }) {
  const result = run(
    `INSERT INTO campaigns
      (user_id, chip_id, chip_name, list_id, list_name, name, message, interval_sec, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    userId,
    chip.id,
    chip.name,
    list.id,
    list.name,
    name,
    message,
    intervalSec,
    now()
  )
  const campaignId = Number(result.lastInsertRowid)
  const insert = db.prepare(
    'INSERT INTO deliveries (campaign_id, contact_name, phone, status) VALUES (?, ?, ?, ?)'
  )
  db.exec('BEGIN')
  try {
    for (const contact of contacts) {
      insert.run(campaignId, contact.name || '', contact.phone, 'pending')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return getCampaign(userId, campaignId)
}

export function listCampaigns(userId) {
  return all(
    `SELECT c.*,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id) AS total,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id AND d.status = 'sent') AS sent,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id AND d.status = 'failed') AS failed
     FROM campaigns c
     WHERE c.user_id = ?
     ORDER BY c.id DESC`,
    userId
  )
}

export function getCampaign(userId, id) {
  const campaign = one(
    `SELECT c.*,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id) AS total,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id AND d.status = 'sent') AS sent,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id AND d.status = 'failed') AS failed
     FROM campaigns c
     WHERE c.id = ? AND c.user_id = ?`,
    id,
    userId
  )
  if (!campaign) return null
  campaign.deliveries = all(
    'SELECT * FROM deliveries WHERE campaign_id = ? ORDER BY id DESC LIMIT 200',
    id
  )
  return campaign
}

export function getCampaignRaw(id) {
  return one('SELECT * FROM campaigns WHERE id = ?', id)
}

export function setCampaignStatus(id, status, error = null) {
  const finished = status === 'done' || status === 'cancelled' ? now() : null
  run(
    'UPDATE campaigns SET status = ?, error = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?',
    status,
    error,
    finished,
    id
  )
}

export function nextPending(campaignId) {
  return one(
    `SELECT * FROM deliveries
     WHERE campaign_id = ? AND status = 'pending'
     ORDER BY id LIMIT 1`,
    campaignId
  )
}

export function markDelivery(id, status, error) {
  run(
    'UPDATE deliveries SET status = ?, error = ?, sent_at = ? WHERE id = ?',
    status,
    error,
    status === 'sent' ? now() : null,
    id
  )
}

export function runningCampaigns() {
  return all(`SELECT id FROM campaigns WHERE status = 'running'`)
}

export function dashboard(userId) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const sentToday = one(
    `SELECT COUNT(*) AS total
     FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id
     WHERE c.user_id = ? AND d.status = 'sent' AND d.sent_at >= ?`,
    userId,
    start.toISOString()
  ).total
  return {
    chips: one('SELECT COUNT(*) AS total FROM chips WHERE user_id = ?', userId).total,
    connected: one(`SELECT COUNT(*) AS total FROM chips WHERE user_id = ? AND status = 'connected'`, userId).total,
    contacts: one(
      `SELECT COUNT(*) AS total FROM contacts c
       JOIN lists l ON l.id = c.list_id WHERE l.user_id = ?`,
      userId
    ).total,
    lists: one('SELECT COUNT(*) AS total FROM lists WHERE user_id = ?', userId).total,
    sentToday,
    campaigns: one('SELECT COUNT(*) AS total FROM campaigns WHERE user_id = ?', userId).total,
    recent: listCampaigns(userId).slice(0, 5)
  }
}

export function saveChatMessage({ chipId, jid, name, fromMe, body, waId, at }) {
  if (!body || !jid) return
  if (waId) {
    run(
      `INSERT OR IGNORE INTO chat_messages (chip_id, jid, from_me, body, wa_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      chipId,
      jid,
      fromMe ? 1 : 0,
      body,
      waId,
      at
    )
  } else {
    run(
      `INSERT INTO chat_messages (chip_id, jid, from_me, body, wa_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      chipId,
      jid,
      fromMe ? 1 : 0,
      body,
      at
    )
  }
  run(
    `INSERT INTO chats (chip_id, jid, name, last_message, last_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chip_id, jid) DO UPDATE SET
       name = COALESCE(excluded.name, chats.name),
       last_message = excluded.last_message,
       last_at = excluded.last_at`,
    chipId,
    jid,
    name || null,
    body,
    at
  )
}

export function listChats(userId, chipId) {
  const chip = getChip(userId, chipId)
  if (!chip) return null
  return all(
    'SELECT * FROM chats WHERE chip_id = ? ORDER BY last_at DESC LIMIT 300',
    chipId
  )
}

export function listMessages(userId, chipId, jid) {
  const chip = getChip(userId, chipId)
  if (!chip) return null
  return all(
    `SELECT * FROM chat_messages
     WHERE chip_id = ? AND jid = ?
     ORDER BY id DESC LIMIT 200`,
    chipId,
    jid
  ).reverse()
}
