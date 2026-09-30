import { r2, agoraISO } from './cobranca.js';

export const STATUS_FILA = ['ABERTO', 'SEM_CONTATO'];
export const NUNCA = '2000-01-01 00:00:00';

export const novoId = () => String(Math.floor(Math.random() * 9e11) + 1e11);

export const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/\s+/g, ' ').trim();

export const idDevedor = (carteiraId, cpf) => `${carteiraId}_${cpf}`;

/**
 * Recalcula os campos que o Firestore usa para fila, agenda, busca e totais.
 * Deve ser chamada sempre antes de gravar um devedor.
 */
export function derivar(d) {
  d.telefones = d.telefones || [];
  d.dividas = d.dividas || [];
  const agora = agoraISO();
  const temTelefone = d.telefones.some((t) => t.status !== 'INVALIDO');
  const naFila = STATUS_FILA.includes(d.status) && temTelefone;

  d.valor_aberto = r2(d.dividas.filter((v) => v.status === 'ABERTA').reduce((s, v) => s + Number(v.valor_original), 0));
  d.telefone_ids = d.telefones.map((t) => String(t.id));
  d.nome_busca = normalizar(d.nome);
  const termos = new Set(d.telefones.map((t) => t.numero));
  for (const v of d.dividas) if (v.contrato) termos.add(normalizar(v.contrato));
  for (const w of d.nome_busca.split(' ')) if (w.length >= 2) termos.add(w);
  d.busca_termos = [...termos];

  const lockAtivo = !!(d.lock_usuario_id && d.lock_ate && d.lock_ate > agora);
  if (!lockAtivo) { d.lock_usuario_id = null; d.lock_ate = null; }

  d.fila_chave = naFila ? `${d.carteira_id}|${d.operador_id || 'LIVRE'}` : null;
  const base = d.proximo_contato || NUNCA;
  d.disponivel_em = lockAtivo && d.lock_ate > base ? d.lock_ate : base;
  d.distribuido = naFila && !!d.operador_id;
  d.agendado = naFila && !!d.operador_id && !!d.proximo_contato && !!d.agendamento_pessoal;
  d.agendado_por = d.agendado ? d.operador_id : null;
  return d;
}

const ZEROS = { devedores: 0, em_aberto: 0, em_acordo: 0, quitados: 0, virgens: 0, valor_aberto: 0, distribuidos: 0 };

export function contagem(d) {
  if (!d) return { ...ZEROS };
  const aberto = STATUS_FILA.includes(d.status);
  return {
    devedores: 1,
    em_aberto: aberto ? 1 : 0,
    em_acordo: d.status === 'EM_ACORDO' ? 1 : 0,
    quitados: d.status === 'QUITADO' ? 1 : 0,
    virgens: aberto && !d.tentativas ? 1 : 0,
    valor_aberto: d.valor_aberto || 0,
    distribuidos: aberto && d.operador_id ? 1 : 0,
  };
}

export function deltaContagem(antes, depois) {
  const a = contagem(antes);
  const b = contagem(depois);
  const o = {};
  for (const k of Object.keys(ZEROS)) {
    const n = r2(b[k] - a[k]);
    if (n) o[k] = n;
  }
  return o;
}

export function novoDevedor(campos) {
  return derivar({
    email: null, endereco: null, cidade: null, uf: null, cep: null, data_nasc: null, observacao: null,
    status: 'ABERTO', operador_id: null, proximo_contato: null, ultimo_acionamento: null, ultima_obs: null,
    tentativas: 0, lock_usuario_id: null, lock_ate: null, agendamento_pessoal: false,
    telefones: [], dividas: [], criado_em: agoraISO(),
    ...campos,
  });
}
