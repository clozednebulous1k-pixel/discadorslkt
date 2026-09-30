import { state, api, esc, toast, acao, modal, carregarSessao, ehSupervisao, ehAdmin } from './core.js';
import {
  viewAtendimento, viewBusca, viewDevedor, viewAgenda, viewAcordos, viewDashboard, viewCarteiras,
  viewUsuarios, viewTabulacoes, viewRelatorios, viewConfig,
} from './views.js';

const app = document.getElementById('app');

const ROTAS = {
  atendimento: { titulo: 'Atendimento', ico: '🎧', view: viewAtendimento },
  busca: { titulo: 'Buscar devedor', ico: '🔎', view: viewBusca },
  agenda: { titulo: 'Agenda', ico: '📅', view: viewAgenda },
  acordos: { titulo: 'Acordos', ico: '🤝', view: viewAcordos },
  dashboard: { titulo: 'Painel', ico: '📊', view: viewDashboard, sup: true },
  carteiras: { titulo: 'Carteiras', ico: '🗂️', view: viewCarteiras, sup: true },
  relatorios: { titulo: 'Relatórios', ico: '📄', view: viewRelatorios, sup: true },
  usuarios: { titulo: 'Usuários', ico: '👥', view: viewUsuarios, admin: true },
  tabulacoes: { titulo: 'Tabulações', ico: '🏷️', view: viewTabulacoes, admin: true },
  config: { titulo: 'Configurações', ico: '⚙️', view: viewConfig, admin: true },
  devedor: { view: viewDevedor, oculta: true },
};

const podeVer = (r) => (!r.sup || ehSupervisao()) && (!r.admin || ehAdmin());

function telaLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login" id="fLogin">
        <div class="brand"><div class="logo" style="color:#fff">V</div><div><b>VirtuaNosso</b><small>CRM de Cobrança</small></div></div>
        <div class="campo"><label>Usuário</label><input name="login" autocomplete="username" required autofocus></div>
        <div class="campo"><label>Senha</label><input type="password" name="senha" autocomplete="current-password" required></div>
        <button class="btn primary lg">Entrar</button>
        <p class="muted" style="font-size:12px; margin-bottom:0">Teste: admin/admin123 · supervisor/super123 · operador1/123456</p>
      </form>
    </div>`;
  app.querySelector('#fLogin').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    acao(async () => {
      await api('POST', '/api/login', { login: f.login.value, senha: f.senha.value });
      await carregarSessao();
      montarLayout();
      const destino = ehSupervisao() ? '#/dashboard' : '#/atendimento';
      if (location.hash === destino) await rotear();
      else location.hash = destino;
    }, e.submitter);
  });
}

function montarLayout() {
  const u = state.usuario;
  const links = Object.entries(ROTAS).filter(([, r]) => !r.oculta && podeVer(r))
    .map(([k, r]) => `<a href="#/${k}" data-rota="${k}">${r.titulo}</a>`).join('');
  app.innerHTML = `
    <div class="layout">
      <header class="barra-titulo">
        <b>VirtuaNosso Cobrança</b>
        <span>${esc(state.config.empresa_nome || '')}</span>
        <span class="espaco"></span>
        <input id="buscaRapida" placeholder="CPF, telefone ou nome + Enter" autocomplete="off">
        <span>${esc(u.nome)} (${esc(u.perfil)}${u.ramal ? ` · ramal ${esc(u.ramal)}` : ''})</span>
        <button class="btn sm" id="minhaSenha">Senha</button>
        <button class="btn sm" id="sair">Sair</button>
      </header>
      <nav class="nav">${links}</nav>
      <main class="main" id="view"></main>
    </div>`;
  app.querySelector('#sair').addEventListener('click', () => acao(async () => {
    await api('POST', '/api/logout');
    state.usuario = null;
    state.atualId = null;
    state.timers.forEach(clearInterval);
    state.timers = [];
    if (location.hash === '#/login') telaLogin();
    else location.hash = '#/login';
  }));
  app.querySelector('#minhaSenha').addEventListener('click', alterarSenha);
  const busca = app.querySelector('#buscaRapida');
  busca.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !busca.value.trim()) return;
    acao(async () => {
      const q = busca.value.trim();
      const lista = await api('GET', `/api/devedores?${new URLSearchParams({ q })}`);
      busca.value = '';
      if (lista.length === 1) {
        location.hash = `#/devedor/${lista[0].id}`;
        return;
      }
      if (!lista.length) toast('Nenhum devedor encontrado.', 'erro');
      sessionStorage.setItem('buscaQ', q);
      if (location.hash === '#/busca') rotear();
      else location.hash = '#/busca';
    });
  });
}

function alterarSenha() {
  const m = modal('Alterar minha senha', `
    <div class="campo"><label>Senha atual</label><input type="password" id="sa"></div>
    <div class="campo"><label>Nova senha (mín. 6)</label><input type="password" id="sn"></div>`,
  { rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okS">Salvar</button>' });
  m.$('#okS').addEventListener('click', (e) => acao(async () => {
    await api('POST', '/api/minha-senha', { atual: m.$('#sa').value, nova: m.$('#sn').value });
    m.fechar();
    toast('Senha alterada.', 'ok');
  }, e.target));
}

async function rotear() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.atalhoF2 = null;

  const [, nome = '', arg] = location.hash.replace(/^#/, '').split('/');
  if (!state.usuario) {
    try {
      await carregarSessao();
    } catch {
      return telaLogin();
    }
    montarLayout();
  }
  if (nome === 'login') {
    location.hash = ehSupervisao() ? '#/dashboard' : '#/atendimento';
    return;
  }
  if (!document.getElementById('view')) montarLayout();
  const rota = ROTAS[nome];
  if (!rota || !podeVer(rota)) {
    location.hash = ehSupervisao() ? '#/dashboard' : '#/atendimento';
    return;
  }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === nome));
  const view = document.getElementById('view');
  view.innerHTML = '<div class="vazio">Carregando...</div>';
  try {
    await rota.view(view, arg);
  } catch (e) {
    view.innerHTML = `<div class="card vazio"><div class="grande">⚠️</div>${esc(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#/login' && !state.usuario) telaLogin();
  else rotear();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'F2' && state.atalhoF2) {
    e.preventDefault();
    state.atalhoF2();
  }
});

// Screen pop: o discador avisa o servidor qual devedor atendeu no ramal; a ficha abre automaticamente.
setInterval(async () => {
  if (!state.usuario?.ramal || document.hidden) return;
  try {
    const pop = await api('GET', '/api/operador/pop');
    if (!pop.devedor_id) return;
    state.atualId = pop.devedor_id;
    state.inicioAtendimento = Date.now();
    toast('📞 Chamada conectada - ficha do cliente aberta.', 'ok');
    if (location.hash === '#/atendimento') rotear();
    else location.hash = '#/atendimento';
  } catch { /* sessão expirada ou servidor fora: ignora */ }
}, 3000);

rotear();
