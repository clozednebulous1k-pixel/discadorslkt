export const state = {
  usuario: null,
  config: {},
  carteiras: [],
  tabulacoes: [],
  atualId: null,        // devedor em atendimento na fila
  inicioAtendimento: null,
  timers: [],           // intervalos da tela atual (limpos ao trocar de tela)
};

export async function api(metodo, url, corpo) {
  const opts = { method: metodo, headers: {} };
  if (corpo !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(corpo);
  }
  const r = await fetch(url, opts);
  const json = (r.headers.get('content-type') || '').includes('json');
  const dados = json ? await r.json() : await r.text();
  if (r.status === 401 && url !== '/api/login') {
    state.usuario = null;
    location.hash = '#/login';
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  if (!r.ok) throw new Error((json && dados.erro) || `Erro ${r.status}`);
  return dados;
}

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const moeda = (v) => fmtBRL.format(Number(v) || 0);
export const num = (v) => new Intl.NumberFormat('pt-BR').format(Number(v) || 0);
export const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1).replace('.', ',')}%` : '0%');

export function data(v) {
  if (!v) return '';
  const [a, m, d] = String(v).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
export function dataHora(v) {
  if (!v) return '';
  return `${data(v)} ${String(v).slice(11, 16)}`;
}
export function hoje(offsetDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function doc(v) {
  const s = String(v ?? '');
  if (s.length === 11) return s.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (s.length === 14) return s.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return s;
}
export function fone(v) {
  const s = String(v ?? '');
  if (s.length === 11) return s.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (s.length === 10) return s.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return s;
}
export function duracao(seg) {
  seg = Math.max(0, Math.floor(seg || 0));
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const CORES_STATUS = {
  ABERTO: 'azul', SEM_CONTATO: 'amarelo', EM_ACORDO: 'verde', QUITADO: 'verde', ENCERRADO: '',
  ABERTA: 'azul', PAGA: 'verde', CANCELADA: '', ATRASADA: 'vermelho',
  ATIVO: 'azul', QUEBRADO: 'vermelho', CANCELADO: '', CPC: 'verde', INVALIDO: 'vermelho',
  SEM_CONTATO_T: '', CONTATO: 'azul', PROMESSA: 'amarelo', ACORDO: 'verde', RECUSA: 'vermelho',
};
const ROTULOS = {
  ABERTO: 'Em aberto', SEM_CONTATO: 'Sem contato', EM_ACORDO: 'Em acordo', QUITADO: 'Quitado', ENCERRADO: 'Encerrado',
  ABERTA: 'Aberta', PAGA: 'Paga', CANCELADA: 'Cancelada', ATRASADA: 'Atrasada', ATIVO: 'Ativo', QUEBRADO: 'Quebrado',
  CANCELADO: 'Cancelado', CPC: 'CPC', INVALIDO: 'Inválido', CONTATO: 'Contato', PROMESSA: 'Promessa', ACORDO: 'Acordo',
  RECUSA: 'Recusa', EM_ACORDO_D: 'Em acordo',
};
export const rotulo = (s) => ROTULOS[s] || s;
export const badge = (s, texto) => `<span class="badge ${CORES_STATUS[s] || ''}">${esc(texto || rotulo(s))}</span>`;

export function toast(msg, tipo = '') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), tipo === 'erro' ? 6000 : 3500);
}

/** Executa uma ação assíncrona mostrando o erro em toast; desabilita o botão enquanto roda. */
export async function acao(fn, botao) {
  if (botao) botao.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'erro');
    return undefined;
  } finally {
    if (botao) botao.disabled = false;
  }
}

export function modal(titulo, corpoHtml, { rodape = '', largura } = {}) {
  const fundo = document.createElement('div');
  fundo.className = 'modal-fundo';
  fundo.innerHTML = `
    <div class="modal" ${largura ? `style="width:min(${largura}px,100%)"` : ''}>
      <header><h2>${esc(titulo)}</h2><button class="btn ghost sm" data-fechar>✕</button></header>
      <div class="corpo">${corpoHtml}</div>
      ${rodape ? `<footer>${rodape}</footer>` : ''}
    </div>`;
  const fechar = () => fundo.remove();
  fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(); });
  fundo.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', fechar));
  document.body.appendChild(fundo);
  const primeiro = fundo.querySelector('input, select, textarea');
  if (primeiro) primeiro.focus();
  return { el: fundo, fechar, $: (s) => fundo.querySelector(s), $$: (s) => [...fundo.querySelectorAll(s)] };
}

export function confirmar(msg) {
  return new Promise((resolve) => {
    const m = modal('Confirmação', `<p>${esc(msg)}</p>`, {
      rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okConfirmar">Confirmar</button>',
    });
    m.el.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => resolve(false)));
    m.$('#okConfirmar').addEventListener('click', () => { m.fechar(); resolve(true); });
  });
}

/** Lê os campos de um formulário como objeto (checkbox => boolean). */
export function lerForm(form) {
  const o = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') {
      if (el.dataset.lista !== undefined) {
        o[el.name] = o[el.name] || [];
        if (el.checked) o[el.name].push(Number(el.value));
      } else o[el.name] = el.checked;
    } else o[el.name] = el.value;
  }
  return o;
}

export const opcoesCarteiras = (sel = '', lista = state.carteiras) => lista
  .map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');

export const ehSupervisao = () => ['admin', 'supervisor'].includes(state.usuario?.perfil);
export const ehAdmin = () => state.usuario?.perfil === 'admin';

export async function carregarSessao() {
  const me = await api('GET', '/api/me');
  state.usuario = me.usuario;
  state.config = me.config;
  state.carteiras = me.carteiras;
  state.tabulacoes = me.tabulacoes;
  return me;
}

/** Lê um CSV; se não for UTF-8 válido, relê como Windows-1252 (padrão do Excel em PT-BR). */
export function lerArquivoTexto(arquivo) {
  const ler = (enc) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    fr.readAsText(arquivo, enc);
  });
  return ler('utf-8').then((txt) => (txt.includes('\uFFFD') ? ler('windows-1252') : txt));
}

export function intervalo(fn, ms) {
  state.timers.push(setInterval(fn, ms));
}
