const PAGES = [
  ['painel', 'Painel'],
  ['chips', 'Chips'],
  ['contatos', 'Contatos'],
  ['disparos', 'Disparos'],
  ['conversas', 'Conversas']
]

const STATUS = {
  connected: 'Conectado',
  connecting: 'Conectando',
  qr: 'Aguardando QR',
  disconnected: 'Desconectado',
  error: 'Falhou',
  running: 'Enviando',
  paused: 'Pausado',
  done: 'Concluído',
  cancelled: 'Cancelado',
  pending: 'Na fila',
  sent: 'Enviado',
  failed: 'Falhou'
}

const state = {
  user: null,
  page: 'painel',
  navOpen: false,
  authMode: 'login',
  dashboard: null,
  chips: [],
  lists: [],
  activeListId: null,
  contacts: [],
  contactTotal: 0,
  campaigns: [],
  openCampaign: null,
  showComposer: false,
  chats: [],
  messages: [],
  activeChipId: null,
  activeJid: null
}

const app = document.getElementById('app')

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]))
}

function toast(message, type = 'ok') {
  const el = document.createElement('div')
  el.className = `toast ${type === 'err' ? 'err' : ''}`
  el.textContent = message
  document.getElementById('toasts').appendChild(el)
  setTimeout(() => el.remove(), 3800)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && path !== '/api/me' && !path.startsWith('/api/auth')) {
    state.user = null
    render()
  }
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir')
  return data
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS[status] || status)}</span>`
}

function progress(item) {
  const total = Number(item.total) || 0
  const done = Number(item.sent || 0) + Number(item.failed || 0)
  const pct = total ? Math.round((done / total) * 100) : 0
  return `<div class="progress" title="${done}/${total}"><span style="width:${pct}%"></span></div>`
}

function previewText(template) {
  return String(template || '')
    .replaceAll('{nome}', 'Maria Silva')
    .replaceAll('{primeiro}', 'Maria')
    .replaceAll('{telefone}', '5511999999999')
}

function logo() {
  return `<span class="logo" aria-hidden="true">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M4 12L20 5L13 20L11 13L4 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  </span>`
}

function authView() {
  const register = state.authMode === 'register'
  return `<section class="auth">
    <div class="auth-brand">
      <div class="brand-mark">${logo()} Disparo</div>
      <div>
        <h1>Cadastre o chip e dispare pelo WhatsApp.</h1>
        <p>Painel para conectar seu número, organizar listas e acompanhar cada envio e resposta.</p>
        <div class="brand-points">
          <span>QR Code do seu chip</span>
          <span>Listas e disparos</span>
          <span>Conversas no mesmo lugar</span>
        </div>
      </div>
    </div>
    <div class="auth-panel">
      <form class="card auth-card" data-form="auth">
        <h2>${register ? 'Criar conta' : 'Entrar'}</h2>
        <p class="lead">${register ? 'A conta fica só nesta máquina.' : 'Acesse o painel do disparo.'}</p>
        ${register ? `<label class="field"><span>Nome</span><input name="name" required maxlength="80" /></label>` : ''}
        <label class="field"><span>E-mail</span><input name="email" type="email" required autocomplete="username" /></label>
        <label class="field"><span>Senha</span><input name="password" type="password" required minlength="6" autocomplete="${register ? 'new-password' : 'current-password'}" /></label>
        <button class="btn full" type="submit">${register ? 'Criar conta' : 'Entrar'}</button>
        <p class="switch">${register ? 'Já tem conta?' : 'Primeira vez?'}
          <button class="linkish" type="button" data-action="auth-mode">${register ? 'Entrar' : 'Criar conta'}</button>
        </p>
      </form>
    </div>
  </section>`
}

function shell(title, body, extraClass = '') {
  const initial = esc((state.user.name || '?').slice(0, 1).toUpperCase())
  return `<div class="shell">
    <aside class="sidebar ${state.navOpen ? 'open' : ''}">
      <div class="brand-mark">${logo()} Disparo</div>
      <nav class="side-nav">
        ${PAGES.map(([id, label]) => `<button type="button" data-page="${id}" class="${state.page === id ? 'active' : ''}">${label}</button>`).join('')}
      </nav>
      <div class="side-user">
        <div class="avatar">${initial}</div>
        <div>
          <strong>${esc(state.user.name)}</strong>
          <button type="button" data-action="logout">Sair</button>
        </div>
      </div>
    </aside>
    <section class="main">
      <header class="topbar">
        <div class="row">
          <button class="menu" type="button" data-action="menu">Menu</button>
          <h1>${esc(title)}</h1>
        </div>
        <span class="muted">${esc(state.user.email)}</span>
      </header>
      <div class="${extraClass}">${body}</div>
    </section>
  </div>`
}

function painelView() {
  const data = state.dashboard || { chips: 0, connected: 0, contacts: 0, sentToday: 0, recent: [] }
  const rows = data.recent.length
    ? data.recent.map((item) => `<tr>
        <td>${esc(item.name)}</td>
        <td>${esc(item.chip_name)}</td>
        <td>${badge(item.status)}</td>
        <td>${item.sent || 0}/${item.total || 0}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="empty">Nenhum disparo ainda. Conecte um chip, monte uma lista e envie a primeira mensagem.</td></tr>`
  return shell('Painel', `<div class="content">
    <div class="stats">
      <article class="card stat"><span>Chips conectados</span><strong>${data.connected}/${data.chips}</strong></article>
      <article class="card stat"><span>Contatos</span><strong>${data.contacts}</strong></article>
      <article class="card stat"><span>Enviadas hoje</span><strong>${data.sentToday}</strong></article>
      <article class="card stat"><span>Disparos</span><strong>${data.campaigns || 0}</strong></article>
    </div>
    <h2 class="section-title">Últimos disparos</h2>
    <div class="card table-wrap"><table>
      <thead><tr><th>Nome</th><th>Chip</th><th>Status</th><th>Enviadas</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`)
}

function chipCards() {
  if (!state.chips.length) {
    return `<div class="card panel empty">Nenhum chip cadastrado. Dê um nome e gere o QR para conectar o WhatsApp.</div>`
  }
  return `<div class="chips">${state.chips.map((chip) => `<article class="card chip">
    <header>
      <div>
        <h3>${esc(chip.name)}</h3>
        <p class="muted">${esc(chip.phoneLabel || 'Número ainda não identificado')}</p>
      </div>
      ${badge(chip.status)}
    </header>
    ${chip.status === 'qr' && chip.qr ? `<div class="qr"><img alt="QR Code do WhatsApp" src="${chip.qr}" /><p class="hint">No celular: WhatsApp, Aparelhos conectados, Conectar aparelho.</p></div>` : ''}
    ${chip.status === 'qr' && !chip.qr ? `<p class="hint">Gerando o QR...</p>` : ''}
    ${chip.last_error ? `<p class="hint">${esc(chip.last_error)}</p>` : ''}
    <div class="row">
      ${chip.status === 'connected' ? '' : `<button class="btn" type="button" data-action="connect-chip" data-id="${chip.id}">${chip.status === 'qr' ? 'Atualizar QR' : 'Gerar QR'}</button>`}
      ${chip.status === 'connected' || chip.status === 'qr' || chip.status === 'connecting' ? `<button class="btn secondary" type="button" data-action="disconnect-chip" data-id="${chip.id}">Desconectar</button>` : ''}
      <button class="btn danger" type="button" data-action="delete-chip" data-id="${chip.id}">Excluir</button>
    </div>
  </article>`).join('')}</div>`
}

function chipsView() {
  return shell('Chips', `<div class="content">
    <form class="card composer" data-form="chip">
      <div class="row">
        <label class="field" style="flex:1; margin:0"><span>Nome do chip</span><input name="name" required maxlength="80" placeholder="Comercial, suporte, loja..." /></label>
        <button class="btn" type="submit" style="align-self:end">Cadastrar chip</button>
      </div>
    </form>
    <div id="chip-board">${chipCards()}</div>
  </div>`)
}

function contactsView() {
  const lists = state.lists.length
    ? state.lists.map((list) => `<button type="button" class="list-btn ${list.id === state.activeListId ? 'active' : ''}" data-action="select-list" data-id="${list.id}">
        <strong>${esc(list.name)}</strong><span>${list.total || 0} contatos</span>
      </button>`).join('')
    : `<p class="empty">Crie a primeira lista.</p>`
  const rows = state.contacts.length
    ? state.contacts.map((contact) => `<tr>
        <td>${esc(contact.name || '—')}</td>
        <td>${esc(contact.phoneLabel || contact.phone)}</td>
        <td><button class="btn danger" type="button" data-action="delete-contact" data-id="${contact.id}">Excluir</button></td>
      </tr>`).join('')
    : `<tr><td colspan="3" class="empty">Essa lista ainda não tem contatos.</td></tr>`
  return shell('Contatos', `<div class="content"><div class="split">
    <div class="card panel">
      <form data-form="list">
        <label class="field"><span>Nova lista</span><input name="name" required maxlength="80" placeholder="Clientes de outubro" /></label>
        <button class="btn full" type="submit">Criar lista</button>
      </form>
      <div style="margin-top:12px">${lists}</div>
    </div>
    <div>
      ${state.activeListId ? `<div class="card composer">
        <form data-form="contact" class="grid-2">
          <label class="field"><span>Nome</span><input name="name" maxlength="80" /></label>
          <label class="field"><span>Telefone</span><input name="phone" required placeholder="11999999999" /></label>
          <button class="btn" type="submit">Adicionar</button>
        </form>
        <form data-form="import" style="margin-top:8px">
          <label class="field"><span>Importar lista</span>
            <textarea name="text" placeholder="Maria, 11999999999&#10;João, 21988887777"></textarea>
          </label>
          <div class="row">
            <button class="btn secondary" type="submit">Importar</button>
            <label class="btn secondary">Arquivo CSV<input id="csv-file" type="file" accept=".csv,.txt,text/plain" hidden /></label>
          </div>
          <p class="hint">Uma pessoa por linha: nome e telefone, separados por vírgula. Também aceita só o número.</p>
        </form>
        <div class="row" style="justify-content:space-between">
          <p class="hint">${state.contactTotal} contato(s) nesta lista.</p>
          <button class="btn danger" type="button" data-action="delete-list" data-id="${state.activeListId}">Excluir lista</button>
        </div>
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>Nome</th><th>Telefone</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : `<div class="card panel empty">Selecione ou crie uma lista.</div>`}
    </div>
  </div></div>`)
}

function campaignForm() {
  if (!state.showComposer) return ''
  const chips = state.chips.filter((chip) => chip.status === 'connected')
  return `<form class="card composer" data-form="campaign">
    <div class="grid-2">
      <label class="field"><span>Nome do disparo</span><input name="name" required maxlength="80" placeholder="Aviso de entrega" /></label>
      <label class="field"><span>Intervalo entre envios (segundos)</span><input name="intervalSec" type="number" min="3" max="180" value="8" required /></label>
      <label class="field"><span>Chip</span><select name="chipId" required>
        ${chips.map((chip) => `<option value="${chip.id}">${esc(chip.name)} · ${esc(chip.phoneLabel || 'conectado')}</option>`).join('') || '<option value="">Nenhum chip conectado</option>'}
      </select></label>
      <label class="field"><span>Lista</span><select name="listId" required>
        ${state.lists.map((list) => `<option value="${list.id}">${esc(list.name)} (${list.total || 0})</option>`).join('') || '<option value="">Nenhuma lista</option>'}
      </select></label>
    </div>
    <label class="field"><span>Mensagem</span>
      <textarea id="message" name="message" required maxlength="4000" placeholder="Olá {primeiro}, tudo bem?"></textarea>
    </label>
    <p class="hint">Variáveis: {nome}, {primeiro} e {telefone}. Envie só para quem autorizou o recebimento.</p>
    <div class="preview" id="preview">A prévia aparece aqui.</div>
    <div class="row" style="margin-top:12px">
      <button class="btn" type="submit">Iniciar disparo</button>
      <button class="btn secondary" type="button" data-action="toggle-campaign">Fechar</button>
    </div>
  </form>`
}

function campaignRows() {
  if (!state.campaigns.length) return `<tr><td colspan="6" class="empty">Nenhum disparo criado.</td></tr>`
  return state.campaigns.map((item) => `<tr>
    <td>${esc(item.name)}<div class="muted">${fmtDate(item.created_at)}</div></td>
    <td>${esc(item.chip_name)}</td>
    <td>${esc(item.list_name)}</td>
    <td>${badge(item.status)}<div style="margin-top:6px">${progress(item)}</div><div class="muted">${item.sent || 0} enviadas · ${item.failed || 0} falhas</div></td>
    <td class="row">
      <button class="btn secondary" type="button" data-action="open-campaign" data-id="${item.id}">Ver</button>
      ${item.status === 'running' ? `<button class="btn secondary" type="button" data-action="pause" data-id="${item.id}">Pausar</button>` : ''}
      ${item.status === 'paused' ? `<button class="btn" type="button" data-action="resume" data-id="${item.id}">Retomar</button>` : ''}
      ${item.status === 'running' || item.status === 'paused' ? `<button class="btn danger" type="button" data-action="cancel" data-id="${item.id}">Cancelar</button>` : ''}
    </td>
  </tr>`).join('')
}

function campaignDetail() {
  const item = state.openCampaign
  if (!item) return ''
  const rows = (item.deliveries || []).map((delivery) => `<tr>
    <td>${esc(delivery.contact_name || '—')}</td>
    <td>${esc(delivery.phoneLabel || delivery.phone)}</td>
    <td>${badge(delivery.status)}</td>
    <td>${esc(delivery.error || fmtDate(delivery.sent_at))}</td>
  </tr>`).join('') || `<tr><td colspan="4" class="empty">Sem registros ainda.</td></tr>`
  return `<div class="card table-wrap" style="margin-top:16px">
    <div class="panel"><strong>${esc(item.name)}</strong><p class="hint">${esc(item.error || 'Últimos contatos deste disparo.')}</p></div>
    <table><thead><tr><th>Nome</th><th>Telefone</th><th>Status</th><th>Detalhe</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`
}

function disparosView() {
  return shell('Disparos', `<div class="content">
    <div class="page-head">
      <p class="hint">O chip envia uma mensagem por vez, com o intervalo que você escolher.</p>
      <button class="btn" type="button" data-action="toggle-campaign">${state.showComposer ? 'Fechar' : 'Novo disparo'}</button>
    </div>
    <div id="campaign-form">${campaignForm()}</div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Disparo</th><th>Chip</th><th>Lista</th><th>Progresso</th><th></th></tr></thead>
      <tbody id="campaign-table">${campaignRows()}</tbody>
    </table></div>
    <div id="campaign-detail">${campaignDetail()}</div>
  </div>`)
}

function chatItems() {
  if (!state.chats.length) return `<p class="empty">As conversas aparecem aqui quando alguém escrever ou quando um disparo for enviado.</p>`
  return state.chats.map((chat) => `<button type="button" class="chat-item ${chat.jid === state.activeJid ? 'active' : ''}" data-action="select-chat" data-jid="${esc(chat.jid)}">
    <strong>${esc(chat.name || chat.jid.split('@')[0])}</strong>
    <span>${esc(chat.last_message || '')}</span>
  </button>`).join('')
}

function messageItems() {
  if (!state.messages.length) return `<p class="empty">Nenhuma mensagem nesta conversa.</p>`
  return state.messages.map((message) => `<div class="bubble ${message.from_me ? 'me' : ''}">${esc(message.body)}<time>${fmtDate(message.created_at)}</time></div>`).join('')
}

function conversasView() {
  const chips = state.chips.map((chip) => `<button type="button" class="chip-mini ${chip.id === state.activeChipId ? 'active' : ''}" data-action="select-chip-chat" data-id="${chip.id}">
    <strong>${esc(chip.name)}</strong><span>${esc(STATUS[chip.status] || chip.status)}</span>
  </button>`).join('') || `<p class="empty">Cadastre um chip para conversar.</p>`
  const active = state.chats.find((chat) => chat.jid === state.activeJid)
  return shell('Conversas', `<div class="inbox">
    <div class="inbox-col">
      <div class="inbox-head"><strong>Chips</strong></div>
      ${chips}
    </div>
    <div class="inbox-col">
      <div class="inbox-head"><strong>Conversas</strong></div>
      <div id="chat-list">${chatItems()}</div>
    </div>
    <div class="thread">
      <div class="thread-head"><strong>${esc(active?.name || (state.activeJid ? state.activeJid.split('@')[0] : 'Selecione uma conversa'))}</strong></div>
      <div id="thread">${messageItems()}</div>
      <form class="reply" data-form="reply">
        <input name="text" placeholder="Escreva uma resposta" ${state.activeJid ? '' : 'disabled'} maxlength="4000" />
        <button class="btn" type="submit" ${state.activeJid ? '' : 'disabled'}>Enviar</button>
      </form>
    </div>
  </div>`, '')
}

function render() {
  if (!state.user) {
    app.innerHTML = authView()
    return
  }
  const views = { painel: painelView, chips: chipsView, contatos: contactsView, disparos: disparosView, conversas: conversasView }
  app.innerHTML = (views[state.page] || painelView)()
  if (state.page === 'conversas') {
    const thread = document.getElementById('thread')
    if (thread) thread.scrollTop = thread.scrollHeight
    state.messageMarker = state.messages.at(-1)?.id || 0
  }
  state.chipSig = state.chips.map((chip) => `${chip.id}:${chip.status}:${chip.phone}:${chip.last_error}:${(chip.qr || '').slice(-80)}`).join('|')
  state.campaignSig = state.campaigns.map((item) => `${item.id}:${item.status}:${item.sent}:${item.failed}:${item.total}`).join('|')
}

async function loadContacts() {
  const data = await api(`/api/lists/${state.activeListId}/contacts`)
  state.contacts = data.contacts
  state.contactTotal = data.total
}

async function loadPage() {
  if (state.page === 'painel') state.dashboard = await api('/api/dashboard')
  if (state.page === 'chips') state.chips = await api('/api/chips')
  if (state.page === 'contatos') {
    state.lists = await api('/api/lists')
    if (!state.lists.some((list) => list.id === state.activeListId)) state.activeListId = state.lists[0]?.id || null
    if (state.activeListId) await loadContacts()
    else {
      state.contacts = []
      state.contactTotal = 0
    }
  }
  if (state.page === 'disparos') {
    const [campaigns, chips, lists] = await Promise.all([
      api('/api/campaigns'),
      api('/api/chips'),
      api('/api/lists')
    ])
    state.campaigns = campaigns
    state.chips = chips
    state.lists = lists
    if (state.openCampaign) {
      try { state.openCampaign = await api(`/api/campaigns/${state.openCampaign.id}`) } catch { state.openCampaign = null }
    }
  }
  if (state.page === 'conversas') {
    state.chips = await api('/api/chips')
    if (!state.chips.some((chip) => chip.id === state.activeChipId)) {
      state.activeChipId = (state.chips.find((chip) => chip.status === 'connected') || state.chips[0])?.id || null
      state.activeJid = null
      state.messages = []
    }
    state.chats = state.activeChipId ? await api(`/api/chips/${state.activeChipId}/chats`) : []
    if (state.activeJid && !state.chats.some((chat) => chat.jid === state.activeJid)) {
      state.activeJid = null
      state.messages = []
    }
    if (state.activeChipId && state.activeJid) {
      const query = new URLSearchParams({ jid: state.activeJid })
      state.messages = await api(`/api/chips/${state.activeChipId}/messages?${query}`)
    }
  }
}

async function show(page) {
  state.page = page
  state.navOpen = false
  if (location.hash !== `#/${page}`) location.hash = `#/${page}`
  await loadPage()
  render()
}

async function boot() {
  const me = await api('/api/me')
  state.user = me.user
  if (state.user) {
    const page = location.hash.replace('#/', '')
    state.page = PAGES.some(([id]) => id === page) ? page : 'painel'
    if (location.hash !== `#/${state.page}`) location.hash = `#/${state.page}`
    await loadPage()
  }
  render()
}

document.addEventListener('click', async (event) => {
  const menuButton = event.target.closest('[data-page]')
  if (menuButton) {
    show(menuButton.dataset.page).catch((error) => toast(error.message, 'err'))
    return
  }
  const button = event.target.closest('[data-action]')
  if (!button) return
  const action = button.dataset.action
  const id = button.dataset.id
  try {
    if (action === 'auth-mode') {
      state.authMode = state.authMode === 'login' ? 'register' : 'login'
      render()
    } else if (action === 'menu') {
      state.navOpen = !state.navOpen
      document.querySelector('.sidebar')?.classList.toggle('open', state.navOpen)
    } else if (action === 'logout') {
      await api('/api/auth/logout', { method: 'POST', body: {} })
      state.user = null
      render()
    } else if (action === 'connect-chip') {
      await api(`/api/chips/${id}/connect`, { method: 'POST', body: {} })
      await loadPage()
      render()
    } else if (action === 'disconnect-chip') {
      await api(`/api/chips/${id}/disconnect`, { method: 'POST', body: {} })
      await loadPage()
      render()
    } else if (action === 'delete-chip') {
      if (!confirm('Excluir este chip e remover a sessão do WhatsApp?')) return
      await api(`/api/chips/${id}`, { method: 'DELETE' })
      await loadPage()
      render()
    } else if (action === 'select-list') {
      state.activeListId = id
      await loadContacts()
      render()
    } else if (action === 'delete-list') {
      if (!confirm('Excluir esta lista e os contatos dela?')) return
      await api(`/api/lists/${id}`, { method: 'DELETE' })
      state.activeListId = null
      await loadPage()
      render()
    } else if (action === 'delete-contact') {
      await api(`/api/contacts/${id}`, { method: 'DELETE' })
      await loadContacts()
      state.lists = await api('/api/lists')
      render()
    } else if (action === 'toggle-campaign') {
      state.showComposer = !state.showComposer
      render()
    } else if (action === 'open-campaign') {
      state.openCampaign = await api(`/api/campaigns/${id}`)
      const slot = document.getElementById('campaign-detail')
      if (slot) slot.innerHTML = campaignDetail()
      else render()
    } else if (action === 'pause' || action === 'resume' || action === 'cancel') {
      if (action === 'cancel' && !confirm('Cancelar este disparo? O que falta não será enviado.')) return
      await api(`/api/campaigns/${id}/${action}`, { method: 'POST', body: {} })
      await loadPage()
      render()
    } else if (action === 'select-chip-chat') {
      state.activeChipId = id
      state.activeJid = null
      state.messages = []
      state.chats = await api(`/api/chips/${id}/chats`)
      render()
    } else if (action === 'select-chat') {
      state.activeJid = button.dataset.jid
      const query = new URLSearchParams({ jid: state.activeJid })
      state.messages = await api(`/api/chips/${state.activeChipId}/messages?${query}`)
      render()
    }
  } catch (error) {
    toast(error.message, 'err')
  }
})

document.addEventListener('submit', async (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return
  event.preventDefault()
  const submit = form.querySelector('button[type="submit"]')
  if (submit) submit.disabled = true
  const body = Object.fromEntries(new FormData(form).entries())
  try {
    if (form.dataset.form === 'auth') {
      const path = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login'
      const result = await api(path, { method: 'POST', body })
      state.user = result.user
      await show('painel')
      toast(state.authMode === 'register' ? 'Conta criada.' : 'Login feito.')
      state.authMode = 'login'
    } else if (form.dataset.form === 'chip') {
      await api('/api/chips', { method: 'POST', body })
      form.reset()
      await loadPage()
      render()
      toast('Chip cadastrado. Escaneie o QR quando ele aparecer.')
    } else if (form.dataset.form === 'list') {
      const list = await api('/api/lists', { method: 'POST', body })
      state.activeListId = list.id
      await loadPage()
      render()
    } else if (form.dataset.form === 'contact') {
      await api(`/api/lists/${state.activeListId}/contacts`, { method: 'POST', body })
      await loadPage()
      render()
    } else if (form.dataset.form === 'import') {
      const result = await api(`/api/lists/${state.activeListId}/contacts`, { method: 'POST', body: { text: body.text } })
      await loadPage()
      render()
      toast(`${result.added} adicionados, ${result.skipped} repetidos, ${result.invalid} inválidos.`)
    } else if (form.dataset.form === 'campaign') {
      body.intervalSec = Number(body.intervalSec)
      await api('/api/campaigns', { method: 'POST', body })
      state.showComposer = false
      await loadPage()
      render()
      toast('Disparo iniciado.')
    } else if (form.dataset.form === 'reply') {
      await api(`/api/chips/${state.activeChipId}/send`, {
        method: 'POST',
        body: { jid: state.activeJid, text: body.text }
      })
      const query = new URLSearchParams({ jid: state.activeJid })
      state.messages = await api(`/api/chips/${state.activeChipId}/messages?${query}`)
      state.chats = await api(`/api/chips/${state.activeChipId}/chats`)
      form.reset()
      const thread = document.getElementById('thread')
      const list = document.getElementById('chat-list')
      if (thread && list) {
        thread.innerHTML = messageItems()
        list.innerHTML = chatItems()
        thread.scrollTop = thread.scrollHeight
      } else render()
    }
  } catch (error) {
    toast(error.message, 'err')
  } finally {
    if (submit) submit.disabled = false
  }
})

document.addEventListener('input', (event) => {
  if (event.target.id !== 'message') return
  const preview = document.getElementById('preview')
  if (preview) preview.textContent = previewText(event.target.value) || 'A prévia aparece aqui.'
})

document.addEventListener('change', async (event) => {
  if (event.target.id !== 'csv-file') return
  const file = event.target.files?.[0]
  if (!file) return
  const text = await file.text()
  const area = document.querySelector('form[data-form="import"] textarea')
  if (area) area.value = text
})

window.addEventListener('hashchange', () => {
  if (!state.user) return
  const page = location.hash.replace('#/', '')
  if (!PAGES.some(([id]) => id === page) || page === state.page) return
  show(page).catch((error) => toast(error.message, 'err'))
})

setInterval(async () => {
  if (!state.user || document.hidden) return
  try {
    if (state.page === 'chips') {
      state.chips = await api('/api/chips')
      const board = document.getElementById('chip-board')
      const sig = state.chips.map((chip) => `${chip.id}:${chip.status}:${chip.phone}:${chip.last_error}:${(chip.qr || '').slice(-80)}`).join('|')
      if (board && sig !== state.chipSig) {
        state.chipSig = sig
        board.innerHTML = chipCards()
      }
    } else if (state.page === 'disparos') {
      state.campaigns = await api('/api/campaigns')
      const table = document.getElementById('campaign-table')
      const sig = state.campaigns.map((item) => `${item.id}:${item.status}:${item.sent}:${item.failed}:${item.total}`).join('|')
      if (table && sig !== state.campaignSig) {
        state.campaignSig = sig
        table.innerHTML = campaignRows()
      }
      if (state.openCampaign) {
        state.openCampaign = await api(`/api/campaigns/${state.openCampaign.id}`)
        const detail = document.getElementById('campaign-detail')
        if (detail) detail.innerHTML = campaignDetail()
      }
    } else if (state.page === 'conversas' && state.activeChipId) {
      state.chats = await api(`/api/chips/${state.activeChipId}/chats`)
      const list = document.getElementById('chat-list')
      if (list && document.activeElement?.tagName !== 'INPUT') list.innerHTML = chatItems()
      if (state.activeJid) {
        const query = new URLSearchParams({ jid: state.activeJid })
        state.messages = await api(`/api/chips/${state.activeChipId}/messages?${query}`)
        const thread = document.getElementById('thread')
        const marker = state.messages.at(-1)?.id || 0
        if (thread && document.activeElement?.tagName !== 'INPUT' && marker !== state.messageMarker) {
          const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140
          thread.innerHTML = messageItems()
          if (nearBottom) thread.scrollTop = thread.scrollHeight
          state.messageMarker = marker
        }
      }
    }
  } catch { /* a próxima atualização tenta de novo */ }
}, 2500)

boot().catch((error) => toast(error.message, 'err'))
