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
    const campaign = await db.getCampaignRaw(campaignId)
    if (!campaign || campaign.status !== 'running') return
    const delivery = await db.nextPending(campaignId)
    if (!delivery) {
      await db.setCampaignStatus(campaignId, 'done', null)
      return
    }
    try {
      await wa.sendText(campaign.chip_id, delivery.phone, applyTemplate(campaign.message, delivery))
      await db.markDelivery(delivery.id, campaignId, 'sent', null)
    } catch (error) {
      const message = error?.message || 'Falha no envio'
      await db.markDelivery(delivery.id, campaignId, 'failed', message)
      if (shouldPause(message)) {
        await db.setCampaignStatus(campaignId, 'paused', message)
        return
      }
    }
    const fresh = await db.getCampaignRaw(campaignId)
    if (!fresh || fresh.status !== 'running') return
    await sleep(Math.max(3, fresh.interval_sec) * 1000)
  }
}

export function kick(campaignId) {
  if (running.has(campaignId)) return
  running.add(campaignId)
  work(campaignId)
    .catch(async (error) => {
      console.error(error)
      await db.setCampaignStatus(campaignId, 'paused', error.message || 'Falha no disparo')
    })
    .finally(() => running.delete(campaignId))
}

export async function tick(userId) {
  const campaigns = await db.runningCampaigns(userId)
  for (const campaign of campaigns) {
    const chip = await db.getChipById(campaign.chip_id)
    if (!chip?.active) continue
    if (!wa.isConnected(chip.id)) {
      if (!wa.isPending(chip.id)) wa.connectChip(chip).catch((error) => console.error(error))
      continue
    }
    if (!(await db.claimTick(campaign.id))) continue
    const delivery = await db.nextPending(campaign.id)
    if (!delivery) {
      await db.setCampaignStatus(campaign.id, 'done', null)
      continue
    }
    try {
      await wa.sendText(chip.id, delivery.phone, applyTemplate(campaign.message, delivery))
      await db.markDelivery(delivery.id, campaign.id, 'sent', null)
    } catch (error) {
      const message = error?.message || 'Falha no envio'
      await db.markDelivery(delivery.id, campaign.id, 'failed', message)
      if (shouldPause(message)) await db.setCampaignStatus(campaign.id, 'paused', message)
    }
  }
}

export async function resumeRunning() {
  const chips = await db.allActiveChips()
  const users = [...new Set(chips.map((chip) => chip.user_id))]
  for (const userId of users) {
    const campaigns = await db.runningCampaigns(userId)
    for (const campaign of campaigns) kick(campaign.id)
  }
}
