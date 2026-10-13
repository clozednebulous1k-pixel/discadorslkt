import * as db from './db.js'
import * as wa from './whatsapp.js'

const running = new Set()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function applyTemplate(message, delivery) {
  const nome = delivery.contact_name || ''
  const primeiro = nome.trim().split(/\s+/)[0] || ''
  return message
    .replaceAll('{nome}', nome)
    .replaceAll('{primeiro}', primeiro)
    .replaceAll('{telefone}', delivery.phone)
}

function shouldPause(message) {
  return /desconectado|connection closed|timed out|tempo esgotado|rate|logout|forbidden|blocked|conexão/i.test(message)
}

async function work(campaignId) {
  while (true) {
    const campaign = db.getCampaignRaw(campaignId)
    if (!campaign || campaign.status !== 'running') return
    const delivery = db.nextPending(campaignId)
    if (!delivery) {
      db.setCampaignStatus(campaignId, 'done', null)
      return
    }
    try {
      await wa.sendText(
        campaign.chip_id,
        delivery.phone,
        applyTemplate(campaign.message, delivery)
      )
      db.markDelivery(delivery.id, 'sent', null)
    } catch (error) {
      const message = error?.message || 'Falha no envio'
      db.markDelivery(delivery.id, 'failed', message)
      if (shouldPause(message)) {
        db.setCampaignStatus(campaignId, 'paused', message)
        return
      }
    }
    const fresh = db.getCampaignRaw(campaignId)
    if (!fresh || fresh.status !== 'running') return
    await sleep(Math.max(3, fresh.interval_sec) * 1000)
  }
}

export function kick(campaignId) {
  if (running.has(campaignId)) return
  running.add(campaignId)
  work(campaignId)
    .catch((error) => {
      console.error(error)
      db.setCampaignStatus(campaignId, 'paused', error.message || 'Falha no disparo')
    })
    .finally(() => running.delete(campaignId))
}

export function resumeRunning() {
  for (const campaign of db.runningCampaigns()) kick(campaign.id)
}
