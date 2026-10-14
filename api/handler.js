import { app, boot } from '../server/index.js'

export default async function handler(req, res) {
  await boot()
  return app(req, res)
}
