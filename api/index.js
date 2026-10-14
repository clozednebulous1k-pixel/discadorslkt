import { app, boot } from '../server/index.js'

export default async function handler(req, res) {
  await boot()
  const partes = req.query?.path
  if (Array.isArray(partes) && !String(req.url || '').startsWith('/api/')) {
    const bruto = String(req.url || '/')
    const busca = bruto.includes('?') ? bruto.slice(bruto.indexOf('?')) : ''
    req.url = `/api/${partes.join('/')}${busca}`
  }
  return app(req, res)
}
