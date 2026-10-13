import { C } from './firebase.js'

function seguro(nome) {
  return String(nome).replace(/[\/:#]/g, '_')
}

export async function useFirestoreAuthState(chipId) {
  const { initAuthCreds, BufferJSON, proto } = await import('@whiskeysockets/baileys')
  const credRef = C('wa_auth').doc(String(chipId))
  const keys = credRef.collection('keys')

  async function readData(file) {
    const snap = file === 'creds'
      ? await credRef.get()
      : await keys.doc(seguro(file)).get()
    if (!snap.exists || !snap.data()?.json) return null
    return JSON.parse(snap.data().json, BufferJSON.reviver)
  }

  async function writeData(file, data) {
    const json = JSON.stringify(data, BufferJSON.replacer)
    const ref = file === 'creds' ? credRef : keys.doc(seguro(file))
    await ref.set({ json })
  }

  async function removeData(file) {
    const ref = file === 'creds' ? credRef : keys.doc(seguro(file))
    await ref.delete().catch(() => {})
  }

  const creds = (await readData('creds')) || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            data[id] = value
          }))
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const file = `${category}-${id}.json`
              tasks.push(value ? writeData(file, value) : removeData(file))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  }
}

async function apagarColecao(ref) {
  const snap = await ref.limit(200).get()
  if (snap.empty) return
  const lote = ref.firestore.batch()
  snap.docs.forEach((doc) => lote.delete(doc.ref))
  await lote.commit()
  if (snap.size === 200) await apagarColecao(ref)
}

export async function clearAuth(chipId) {
  const credRef = C('wa_auth').doc(String(chipId))
  await apagarColecao(credRef.collection('keys'))
  await credRef.delete().catch(() => {})
}
