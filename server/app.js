import './tz.js';
import crypto from 'node:crypto';
import { fs, C, FieldValue, hashSenha, verificarSenha, segredo, gravarEmLotes } from './firebase.js';
import { garantirInicializado } from './seed.js';
import {
  r2, hojeISO, agoraISO, atualizarDivida, simularAcordo, soDigitos, parseValor, parseData, parseCsv, toCsv,
} from './cobranca.js';
import {
  STATUS_FILA, derivar, novoDevedor, novoId, idDevedor, normalizar, deltaContagem,
} from './devedor.js';

const TIPOS_CPC = ['CPC', 'PROMESSA', 'ACORDO', 'RECUSA'];
const CHAVES_CONFIG = ['empresa_nome', 'discador_modo', 'discador_url', 'discador_api_key',
  'reciclagem_sem_contato_horas', 'reciclagem_contato_horas', 'lock_minutos'];

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const falha = (status, msg) => { throw new HttpError(status, msg); };

const rotas = [];
function rota(metodo, padrao, perfis, handler) {
  const chaves = [];
  const re = new RegExp(`^${padrao.replace(/:(\w+)/g, (_, k) => { chaves.push(k); return '([^/]+)'; })}$`);
  rotas.push({ metodo, re, chaves, perfis, handler });
}
const SUP = ['admin', 'supervisor'];
const ADM = ['admin'];

const docDe = (s) => (s.exists ? { id: s.id, ...s.data() } : null);
const emHoras = (h) => agoraISO(new Date(Date.now() + Number(h) * 3600000));
const emMinutos = (m) => agoraISO(new Date(Date.now() + Number(m) * 60000));
const sid = (v) => (v == null || v === '' ? '' : String(v));
const ids = (arr) => (Array.isArray(arr) ? arr : []).map(sid).filter((x) => x && x !== 'NaN');

function intervaloDatas(q) {
  const ini = parseData(q.data_ini) || hojeISO();
  const fim = parseData(q.data_fim) || ini;
  return [`${ini} 00:00:00`, `${fim} 23:59:59`, ini, fim];
}
function normDataHora(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/);
  if (!m) falha(400, 'Data/hora inválida.');
  return `${m[1]} ${m[2]}${m[3] || ':00'}`;
}

async function todos(nome) {
  const s = await C(nome).get();
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function um(nome, id) {
  if (!id) return null;
  return docDe(await C(nome).doc(sid(id)).get());
}
async function cfg() {
  return (await C('config').doc('geral').get()).data() || {};
}

function assinar(id, sessao) {
  const exp = Date.now() + 12 * 3600 * 1000;
  const payload = `${id}.${exp}.${sessao || 0}`;
  const sig = crypto.createHmac('sha256', segredo()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function lerToken(token) {
  const p = String(token || '').split('.');
  if (p.length !== 4) return null;
  const [id, exp, sessao, sig] = p;
  const esperado = crypto.createHmac('sha256', segredo()).update(`${id}.${exp}.${sessao}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return { id, sessao: Number(sessao) };
}

function publico(u) {
  return { id: u.id, nome: u.nome, login: u.login, perfil: u.perfil, ramal: u.ramal || null };
}
function carteirasDo(user, lista) {
  const ativas = lista.filter((c) => c.ativa);
  if (user.perfil !== 'operador' || !user.carteiras?.length) return ativas;
  const permitidas = new Set(user.carteiras.map(sid));
  return ativas.filter((c) => permitidas.has(sid(c.id)));
}
function podeDevedor(user, dev) {
  if (user.perfil !== 'operador' || !user.carteiras?.length) return true;
  return user.carteiras.map(sid).includes(sid(dev.carteira_id));
}

async function salvarDevedor(id, antes, depois) {
  derivar(depois);
  const delta = deltaContagem(antes, depois);
  const lote = fs.batch();
  lote.set(C('devedores').doc(id), depois);
  if (depois.carteira_id && Object.keys(delta).length) {
    const inc = {};
    for (const [k, v] of Object.entries(delta)) inc[k] = FieldValue.increment(v);
    lote.set(C('carteiras').doc(sid(depois.carteira_id)), inc, { merge: true });
  }
  await lote.commit();
}

function somarStats(tx, dia, campos) {
  const upd = { dia };
  for (const [k, v] of Object.entries(campos)) {
    if (v) upd[k.replaceAll('.', '_')] = FieldValue.increment(v);
  }
  tx.set(C('stats').doc(dia), upd, { merge: true });
}

async function devedorPorTelefone(telId) {
  const s = await C('devedores').where('telefone_ids', 'array-contains', sid(telId)).limit(1).get();
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}
async function acordoPorParcela(parcelaId) {
  const s = await C('acordos').where('parcela_ids', 'array-contains', sid(parcelaId)).limit(1).get();
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}

function ficha(dev, carteira, acordos, acionamentos) {
  const dividas = (dev.dividas || []).map((d) => ({ ...d, atualizado: atualizarDivida(d, carteira) }));
  const hoje = hojeISO();
  for (const a of acordos) {
    a.parcelas = (a.parcelas || []).map((p) => ({ ...p, atrasada: p.status === 'ABERTA' && p.vencimento < hoje }));
  }
  const abertas = dividas.filter((d) => d.status === 'ABERTA');
  return {
    devedor: dev,
    carteira,
    telefones: [...(dev.telefones || [])].sort((a, b) => (a.status === 'CPC' ? -1 : 1) - (b.status === 'CPC' ? -1 : 1)),
    dividas,
    acordos,
    acionamentos,
    resumo: {
      qtd_abertas: abertas.length,
      original_aberto: r2(abertas.reduce((s, d) => s + Number(d.valor_original), 0)),
      atualizado_aberto: r2(abertas.reduce((s, d) => s + d.atualizado.total, 0)),
    },
  };
}

// ---------------------------------------------------------------- login
rota('POST', '/api/login', null, async ({ body, res }) => {
  const login = String(body.login || '').trim().toLowerCase();
  const s = await C('usuarios').where('login', '==', login).limit(1).get();
  const u = s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
  if (!u || u.ativo === false || u.ativo === 0 || !verificarSenha(body.senha || '', u.senha_hash)) {
    falha(401, 'Usuário ou senha inválidos.');
  }
  const sessao = u.sessao || 0;
  cookie(res, assinar(u.id, sessao), 12 * 3600);
  return publico(u);
});

rota('POST', '/api/logout', [], async ({ res, user }) => {
  await C('usuarios').doc(user.id).set({ sessao: FieldValue.increment(1), atendendo: null }, { merge: true });
  const locks = await C('devedores').where('lock_usuario_id', '==', user.id).get();
  for (const d of locks.docs) {
    const dev = d.data();
    dev.lock_usuario_id = null;
    dev.lock_ate = null;
    await salvarDevedor(d.id, dev, dev);
  }
  cookie(res, '', 0);
  return { ok: true };
});

rota('GET', '/api/me', [], async ({ user }) => {
  const [config, carteiras, tabulacoes] = await Promise.all([cfg(), todos('carteiras'), todos('tabulacoes')]);
  return {
    usuario: publico(user),
    config: { empresa_nome: config.empresa_nome, discador_modo: config.discador_modo },
    carteiras: carteirasDo(user, carteiras),
    tabulacoes: tabulacoes.filter((t) => t.ativa).map((t) => ({
      ...t, exige_agendamento: t.exige_agendamento ? 1 : 0,
    })),
  };
});

// ---------------------------------------------------------------- fila
async function porChave(chave) {
  const s = await C('devedores').where('fila_chave', '==', chave).limit(400).get();
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

rota('POST', '/api/fila/proximo', [], async ({ user, body }) => {
  const config = await cfg();
  const agora = agoraISO();
  const carteiras = carteirasDo(user, await todos('carteiras'));
  const filtro = sid(body.carteira_id);
  const alvos = carteiras.filter((c) => !filtro || sid(c.id) === filtro);
  if (filtro && !alvos.length) falha(403, 'Sem acesso a esta carteira.');

  const locks = await C('devedores').where('lock_usuario_id', '==', user.id).get();
  for (const d of locks.docs) {
    const dev = { ...d.data(), lock_usuario_id: null, lock_ate: null };
    await salvarDevedor(d.id, d.data(), dev);
  }

  const listas = await Promise.all(alvos.flatMap((c) => [porChave(`${c.id}|${user.id}`), porChave(`${c.id}|LIVRE`)]));
  const meus = (await C('devedores').where('agendado_por', '==', user.id).limit(100).get()).docs
    .map((d) => ({ id: d.id, ...d.data() }));
  const candidatos = [...meus, ...listas.flat()]
    .filter((d) => d.disponivel_em <= agora && (!d.lock_usuario_id || d.lock_ate <= agora))
    .filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i)
    .sort((a, b) => {
      const ag = (b.agendado_por === user.id) - (a.agendado_por === user.id);
      if (ag) return ag;
      if ((a.tentativas || 0) !== (b.tentativas || 0)) return (a.tentativas || 0) - (b.tentativas || 0);
      return String(a.disponivel_em).localeCompare(String(b.disponivel_em));
    });
  const escolhido = candidatos[0];
  if (!escolhido) return { devedor_id: null };

  const lockAte = emMinutos(config.lock_minutos || 15);
  await fs.runTransaction(async (tx) => {
    const ref = C('devedores').doc(escolhido.id);
    const snap = await tx.get(ref);
    const d = snap.data();
    if (d.lock_usuario_id && d.lock_ate > agoraISO() && d.lock_usuario_id !== user.id) falha(409, 'Cliente reservado por outro operador.');
    d.lock_usuario_id = user.id;
    d.lock_ate = lockAte;
    derivar(d);
    tx.set(ref, d);
  });
  await C('usuarios').doc(user.id).set({ atendendo: escolhido.nome }, { merge: true });
  return { devedor_id: escolhido.id };
});

rota('GET', '/api/fila/resumo', [], async ({ user }) => {
  const agora = agoraISO();
  const carteiras = carteirasDo(user, await todos('carteiras'));
  const saida = [];
  for (const c of carteiras) {
    const lista = [...await porChave(`${c.id}|${user.id}`), ...await porChave(`${c.id}|LIVRE`)];
    const n = lista.filter((d) => d.disponivel_em <= agora).length;
    if (n) saida.push({ id: c.id, nome: c.nome, disponiveis: n });
  }
  return saida;
});

rota('GET', '/api/meus-numeros', [], async ({ user }) => {
  const st = (await C('stats').doc(hojeISO()).get()).data() || {};
  const op = {
    acionamentos: st[`op_${user.id}_acionamentos`] || 0,
    cpc: st[`op_${user.id}_cpc`] || 0,
    acordos: st[`op_${user.id}_acordos`] || 0,
    valor_acordos: st[`op_${user.id}_valor_acordos`] || 0,
  };
  const ag = (await C('devedores').where('agendado_por', '==', user.id).limit(200).get()).docs
    .filter((d) => d.data().disponivel_em <= agoraISO()).length;
  return {
    acionamentos: op.acionamentos || 0, cpc: op.cpc || 0, acordos: op.acordos || 0,
    valor: op.valor_acordos || 0, agendados_vencidos: ag,
  };
});

// ---------------------------------------------------------------- devedores
rota('GET', '/api/devedores', [], async ({ user, query }) => {
  const texto = String(query.q || '').trim();
  const dig = soDigitos(texto).replace(/^55(?=\d{10,11}$)/, '');
  let docs;
  if (dig.length === 11 || dig.length === 14) {
    docs = (await C('devedores').where('cpf_cnpj', '==', dig).limit(20).get()).docs;
  } else if (dig.length >= 8) {
    docs = (await C('devedores').where('busca_termos', 'array-contains', dig).limit(50).get()).docs;
  } else if (texto) {
    const termo = normalizar(texto).split(' ').sort((a, b) => b.length - a.length)[0];
    docs = termo ? (await C('devedores').where('busca_termos', 'array-contains', termo).limit(80).get()).docs : [];
  } else {
    docs = (await C('devedores').orderBy('nome_busca').limit(200).get()).docs;
  }
  const carteiras = new Map((await todos('carteiras')).map((c) => [sid(c.id), c]));
  const usuarios = new Map((await todos('usuarios')).map((u) => [sid(u.id), u]));
  const palavras = normalizar(texto).split(' ').filter(Boolean);
  return docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => podeDevedor(user, d))
    .filter((d) => !query.carteira_id || sid(d.carteira_id) === sid(query.carteira_id))
    .filter((d) => !query.status || d.status === query.status)
    .filter((d) => palavras.every((p) => d.nome_busca?.includes(p) || d.busca_termos?.includes(p) || d.cpf_cnpj?.startsWith(dig)))
    .slice(0, 200)
    .map((d) => ({
      id: d.id, nome: d.nome, cpf_cnpj: d.cpf_cnpj, status: d.status, cidade: d.cidade, uf: d.uf,
      ultimo_acionamento: d.ultimo_acionamento, proximo_contato: d.proximo_contato, tentativas: d.tentativas,
      carteira: carteiras.get(sid(d.carteira_id))?.nome || '', valor_aberto: d.valor_aberto || 0,
      operador: usuarios.get(sid(d.operador_id))?.nome || null,
    }));
});

async function exigirDevedor(user, id) {
  const dev = await um('devedores', id);
  if (!dev) falha(404, 'Devedor não encontrado.');
  if (!podeDevedor(user, dev)) falha(403, 'Sem acesso a esta carteira.');
  return dev;
}

rota('GET', '/api/devedores/:id', [], async ({ user, params }) => {
  const dev = await exigirDevedor(user, params.id);
  const carteira = await um('carteiras', dev.carteira_id);
  const [ac, ag] = await Promise.all([
    C('acionamentos').where('devedor_id', '==', dev.id).limit(200).get(),
    C('acordos').where('devedor_id', '==', dev.id).limit(50).get(),
  ]);
  const usuarios = new Map((await todos('usuarios')).map((u) => [sid(u.id), u.nome]));
  dev.operador_nome = usuarios.get(sid(dev.operador_id)) || null;
  dev.lock_nome = usuarios.get(sid(dev.lock_usuario_id)) || null;
  const acionamentos = ac.docs.map((d) => d.data()).sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
  const acordos = ag.docs.map((d) => ({ id: d.id, ...d.data(), operador: usuarios.get(sid(d.data().usuario_id)) || '' }))
    .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
  return ficha(dev, carteira, acordos, acionamentos);
});

rota('PUT', '/api/devedores/:id', [], async ({ user, params, body }) => {
  const dev = await exigirDevedor(user, params.id);
  const depois = {
    ...dev, nome: body.nome || dev.nome, email: body.email || null, endereco: body.endereco || null,
    cidade: body.cidade || null, uf: body.uf || null, cep: body.cep || null,
    data_nasc: parseData(body.data_nasc), observacao: body.observacao || null,
  };
  await salvarDevedor(dev.id, dev, depois);
  return { ok: true };
});

rota('POST', '/api/devedores/:id/telefones', [], async ({ user, params, body }) => {
  const dev = await exigirDevedor(user, params.id);
  const numero = soDigitos(body.numero);
  if (numero.length < 10 || numero.length > 13) falha(400, 'Telefone inválido. Informe DDD + número.');
  if (!dev.telefones.some((t) => t.numero === numero)) {
    dev.telefones.push({ id: novoId(), numero, tipo: body.tipo || 'CELULAR', status: 'ATIVO' });
    await salvarDevedor(dev.id, dev, dev);
  }
  return { ok: true };
});

rota('PUT', '/api/telefones/:id', [], async ({ user, params, body }) => {
  if (!['ATIVO', 'CPC', 'INVALIDO'].includes(body.status)) falha(400, 'Status inválido.');
  const dev = await devedorPorTelefone(params.id);
  if (!dev) falha(404, 'Telefone não encontrado.');
  if (!podeDevedor(user, dev)) falha(403, 'Sem acesso a esta carteira.');
  const tel = dev.telefones.find((t) => sid(t.id) === sid(params.id));
  tel.status = body.status;
  await salvarDevedor(dev.id, dev, dev);
  return { ok: true };
});

rota('POST', '/api/devedores/:id/acionamentos', [], async ({ user, params, body }) => {
  const dev = await exigirDevedor(user, params.id);
  const tabs = await todos('tabulacoes');
  const t = tabs.find((x) => sid(x.id) === sid(body.tabulacao_id) && x.ativa);
  if (!t) falha(400, 'Selecione a tabulação.');
  const agendamento = normDataHora(body.data_agendamento);
  if (t.exige_agendamento && !agendamento) falha(400, 'Esta tabulação exige data/hora de retorno.');
  if (agendamento && agendamento < agoraISO().slice(0, 16)) falha(400, 'O agendamento não pode ser no passado.');
  const telefoneId = sid(body.telefone_id);
  const tel = telefoneId ? dev.telefones.find((x) => sid(x.id) === telefoneId) : null;
  if (telefoneId && !tel) falha(400, 'Telefone não pertence ao devedor.');
  const config = await cfg();
  const antes = structuredClone(dev);

  if (tel) {
    if (t.invalida_telefone) tel.status = 'INVALIDO';
    else if (TIPOS_CPC.includes(t.tipo)) tel.status = 'CPC';
  }
  if (t.finaliza) {
    dev.status = 'ENCERRADO';
    dev.proximo_contato = null;
    dev.agendamento_pessoal = false;
  } else if (agendamento) {
    dev.proximo_contato = agendamento;
    dev.agendamento_pessoal = true;
    if (user.perfil === 'operador') dev.operador_id = user.id;
  } else if (STATUS_FILA.includes(dev.status)) {
    dev.agendamento_pessoal = false;
    if (t.tipo === 'SEM_CONTATO') {
      dev.proximo_contato = emHoras(config.reciclagem_sem_contato_horas || 2);
      dev.status = 'SEM_CONTATO';
    } else {
      dev.proximo_contato = emHoras(config.reciclagem_contato_horas || 24);
      dev.status = 'ABERTO';
    }
  }
  dev.ultimo_acionamento = agoraISO();
  dev.ultima_obs = String(body.observacao || '').slice(0, 2000);
  dev.tentativas = (dev.tentativas || 0) + 1;
  dev.lock_usuario_id = null;
  dev.lock_ate = null;

  const carteira = await um('carteiras', dev.carteira_id);
  const ac = {
    devedor_id: dev.id, usuario_id: user.id, operador: user.nome, telefone_id: telefoneId || null,
    telefone: tel?.numero || null, tabulacao_id: t.id, codigo: t.codigo, tabulacao: t.descricao, tipo: t.tipo,
    observacao: dev.ultima_obs, data_agendamento: agendamento, duracao_seg: Number(body.duracao_seg) || null,
    criado_em: agoraISO(), carteira_id: dev.carteira_id, carteira: carteira?.nome || '', cpf_cnpj: dev.cpf_cnpj, nome: dev.nome,
  };
  derivar(dev);
  await fs.runTransaction(async (tx) => {
    tx.set(C('devedores').doc(dev.id), dev);
    tx.set(C('acionamentos').doc(novoId()), ac);
    const delta = deltaContagem(antes, dev);
    if (Object.keys(delta).length) {
      const inc = {};
      for (const [k, v] of Object.entries(delta)) inc[k] = FieldValue.increment(v);
      tx.set(C('carteiras').doc(sid(dev.carteira_id)), inc, { merge: true });
    }
    somarStats(tx, hojeISO(), {
      acionamentos: 1,
      cpc: TIPOS_CPC.includes(t.tipo) ? 1 : 0,
      sem_contato: t.tipo === 'SEM_CONTATO' ? 1 : 0,
      [`op.${user.id}.acionamentos`]: 1,
      [`op.${user.id}.cpc`]: TIPOS_CPC.includes(t.tipo) ? 1 : 0,
      [`op.${user.id}.sem_contato`]: t.tipo === 'SEM_CONTATO' ? 1 : 0,
      [`op.${user.id}.tempo_total`]: Number(body.duracao_seg) || 0,
      [`tab.${t.id}`]: 1,
      [`hora.${new Date().getHours()}`]: 1,
    });
    tx.set(C('usuarios').doc(user.id), { atendendo: null }, { merge: true });
  });
  return { ok: true };
});

function dividasSelecionadas(dev, lista) {
  const quer = new Set(ids(lista));
  return (dev.dividas || []).filter((d) => d.status === 'ABERTA' && quer.has(sid(d.id)));
}

rota('POST', '/api/devedores/:id/simular', [], async ({ user, params, body }) => {
  const dev = await exigirDevedor(user, params.id);
  const carteira = await um('carteiras', dev.carteira_id);
  const sim = simularAcordo({ ...body, dividas: dividasSelecionadas(dev, body.divida_ids), carteira });
  sim.pode_formalizar = !sim.violacoes.some((v) => !v.alcada || user.perfil === 'operador');
  return sim;
});

rota('POST', '/api/devedores/:id/acordos', [], async ({ user, params, body }) => {
  const dev = await exigirDevedor(user, params.id);
  const carteira = await um('carteiras', dev.carteira_id);
  const dividas = dividasSelecionadas(dev, body.divida_ids);
  const sim = simularAcordo({ ...body, dividas, carteira });
  const bloqueios = sim.violacoes.filter((v) => !v.alcada || user.perfil === 'operador');
  if (bloqueios.length) falha(400, bloqueios.map((v) => v.msg).join(' '));
  const antes = structuredClone(dev);
  const acordoId = novoId();
  const parcelas = sim.parcelas.map((p) => ({ ...p, id: novoId(), status: 'ABERTA', pago_em: null, valor_pago: null }));
  for (const dv of dev.dividas) {
    if (dividas.some((x) => sid(x.id) === sid(dv.id))) { dv.status = 'EM_ACORDO'; dv.acordo_id = acordoId; }
  }
  dev.status = 'EM_ACORDO';
  dev.proximo_contato = null;
  dev.agendamento_pessoal = false;
  dev.ultimo_acionamento = agoraISO();
  dev.lock_usuario_id = null;
  dev.lock_ate = null;
  if (user.perfil === 'operador' && !dev.operador_id) dev.operador_id = user.id;
  const tabs = await todos('tabulacoes');
  const tab = tabs.find((t) => t.codigo === 'ACORDO') || tabs.find((t) => t.tipo === 'ACORDO');
  derivar(dev);
  await fs.runTransaction(async (tx) => {
    tx.set(C('acordos').doc(acordoId), {
      devedor_id: dev.id, devedor: dev.nome, cpf_cnpj: dev.cpf_cnpj, carteira_id: dev.carteira_id,
      carteira: carteira.nome, usuario_id: user.id, operador: user.nome,
      valor_divida: sim.valor_divida, desconto_pct: sim.desconto_pct, valor_desconto: sim.valor_desconto,
      valor_acordo: sim.valor_acordo, qtd_parcelas: sim.qtd_parcelas, status: 'ATIVO',
      observacao: String(body.observacao || '').slice(0, 1000), criado_em: agoraISO(),
      parcelas, parcela_ids: parcelas.map((p) => sid(p.id)),
    });
    tx.set(C('devedores').doc(dev.id), dev);
    if (tab) {
      tx.set(C('acionamentos').doc(novoId()), {
        devedor_id: dev.id, usuario_id: user.id, operador: user.nome, telefone_id: sid(body.telefone_id) || null,
        telefone: null, tabulacao_id: tab.id, codigo: tab.codigo, tabulacao: tab.descricao, tipo: tab.tipo,
        observacao: `Acordo #${acordoId}: R$ ${sim.valor_acordo.toFixed(2)} em ${sim.qtd_parcelas}x (desconto ${sim.desconto_pct}%)`,
        data_agendamento: null, duracao_seg: null, criado_em: agoraISO(), carteira_id: dev.carteira_id,
        carteira: carteira.nome, cpf_cnpj: dev.cpf_cnpj, nome: dev.nome,
      });
    }
    const delta = deltaContagem(antes, dev);
    const inc = {};
    for (const [k, v] of Object.entries(delta)) inc[k] = FieldValue.increment(v);
    if (Object.keys(inc).length) tx.set(C('carteiras').doc(sid(dev.carteira_id)), inc, { merge: true });
    somarStats(tx, hojeISO(), {
      acordos: 1, valor_acordos: sim.valor_acordo, acionamentos: tab ? 1 : 0, cpc: tab ? 1 : 0,
      [`op.${user.id}.acordos`]: 1, [`op.${user.id}.valor_acordos`]: sim.valor_acordo,
      [`op.${user.id}.acionamentos`]: tab ? 1 : 0, [`op.${user.id}.cpc`]: tab ? 1 : 0,
    });
  });
  return { ok: true, acordo_id: acordoId };
});

rota('GET', '/api/acordos', [], async ({ user, query }) => {
  const [ini, fim] = intervaloDatas(query);
  const s = await C('acordos').where('criado_em', '>=', ini).where('criado_em', '<=', fim).limit(500).get();
  const hoje = hojeISO();
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => user.perfil !== 'operador' || sid(a.usuario_id) === sid(user.id))
    .filter((a) => !query.status || a.status === query.status)
    .filter((a) => !query.carteira_id || sid(a.carteira_id) === sid(query.carteira_id))
    .map((a) => ({
      ...a,
      valor_pago: r2((a.parcelas || []).filter((p) => p.status === 'PAGA').reduce((s, p) => s + Number(p.valor_pago || 0), 0)),
      parcelas_atrasadas: (a.parcelas || []).filter((p) => p.status === 'ABERTA' && p.vencimento < hoje).length,
    }))
    .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
});

async function gravarAcordoEDevedor(acordo, devAntes, dev) {
  derivar(dev);
  await fs.runTransaction(async (tx) => {
    tx.set(C('acordos').doc(acordo.id), acordo);
    tx.set(C('devedores').doc(dev.id), dev);
    const delta = deltaContagem(devAntes, dev);
    const inc = {};
    for (const [k, v] of Object.entries(delta)) inc[k] = FieldValue.increment(v);
    if (Object.keys(inc).length) tx.set(C('carteiras').doc(sid(dev.carteira_id)), inc, { merge: true });
  });
}

rota('POST', '/api/parcelas/:id/pagar', SUP, async ({ params, body }) => {
  const acordo = await acordoPorParcela(params.id);
  if (!acordo) falha(404, 'Parcela não encontrada.');
  const p = acordo.parcelas.find((x) => sid(x.id) === sid(params.id));
  if (p.status !== 'ABERTA') falha(400, 'Parcela não está em aberto.');
  if (acordo.status !== 'ATIVO') falha(400, 'Acordo não está ativo.');
  const valor = body.valor_pago != null && body.valor_pago !== '' ? parseValor(body.valor_pago) : p.valor;
  if (!Number.isFinite(valor) || valor <= 0) falha(400, 'Valor pago inválido.');
  p.status = 'PAGA';
  p.pago_em = parseData(body.pago_em) || hojeISO();
  p.valor_pago = r2(valor);
  const dev = await um('devedores', acordo.devedor_id);
  const antes = structuredClone(dev);
  if (acordo.parcelas.every((x) => x.status !== 'ABERTA')) {
    acordo.status = 'QUITADO';
    for (const dv of dev.dividas) if (sid(dv.acordo_id) === sid(acordo.id)) dv.status = 'PAGA';
    dev.status = dev.dividas.some((dv) => dv.status !== 'PAGA') ? 'ABERTO' : 'QUITADO';
  }
  await gravarAcordoEDevedor(acordo, antes, dev);
  await fs.runTransaction(async (tx) => somarStats(tx, p.pago_em, {
    recebido: p.valor_pago, parcelas_pagas: 1, [`op.${acordo.usuario_id}.recebido`]: p.valor_pago,
  }));
  return { ok: true };
});

rota('POST', '/api/parcelas/:id/estornar', SUP, async ({ params }) => {
  const acordo = await acordoPorParcela(params.id);
  if (!acordo) falha(404, 'Parcela não encontrada.');
  const p = acordo.parcelas.find((x) => sid(x.id) === sid(params.id));
  if (p.status !== 'PAGA') falha(400, 'Parcela não está paga.');
  p.status = 'ABERTA';
  p.pago_em = null;
  p.valor_pago = null;
  const dev = await um('devedores', acordo.devedor_id);
  const antes = structuredClone(dev);
  if (acordo.status === 'QUITADO') {
    acordo.status = 'ATIVO';
    for (const dv of dev.dividas) if (sid(dv.acordo_id) === sid(acordo.id)) dv.status = 'EM_ACORDO';
    dev.status = 'EM_ACORDO';
  }
  await gravarAcordoEDevedor(acordo, antes, dev);
  return { ok: true };
});

rota('POST', '/api/acordos/:id/quebrar', SUP, async ({ params, body }) => {
  const acordo = await um('acordos', params.id);
  if (!acordo) falha(404, 'Acordo não encontrado.');
  if (acordo.status !== 'ATIVO') falha(400, 'Somente acordos ativos podem ser quebrados/cancelados.');
  acordo.status = body.cancelar ? 'CANCELADO' : 'QUEBRADO';
  for (const p of acordo.parcelas) if (p.status === 'ABERTA') p.status = 'CANCELADA';
  const dev = await um('devedores', acordo.devedor_id);
  const antes = structuredClone(dev);
  for (const dv of dev.dividas) if (sid(dv.acordo_id) === sid(acordo.id)) { dv.status = 'ABERTA'; dv.acordo_id = null; }
  dev.status = 'ABERTO';
  dev.proximo_contato = null;
  dev.agendamento_pessoal = false;
  await gravarAcordoEDevedor(acordo, antes, dev);
  return { ok: true };
});

rota('GET', '/api/agenda', [], async ({ user, query }) => {
  const carteiras = new Map((await todos('carteiras')).map((c) => [sid(c.id), c.nome]));
  const usuarios = new Map((await todos('usuarios')).map((u) => [sid(u.id), u.nome]));
  let docs;
  if (user.perfil === 'operador' || query.meus) {
    docs = (await C('devedores').where('agendado_por', '==', user.id).limit(500).get()).docs;
  } else {
    docs = (await C('devedores').where('agendado', '==', true).limit(500).get()).docs;
  }
  return docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => d.proximo_contato && STATUS_FILA.includes(d.status))
    .sort((a, b) => String(a.proximo_contato).localeCompare(String(b.proximo_contato)))
    .map((d) => ({
      id: d.id, nome: d.nome, cpf_cnpj: d.cpf_cnpj, proximo_contato: d.proximo_contato, status: d.status,
      carteira: carteiras.get(sid(d.carteira_id)) || '', operador: usuarios.get(sid(d.operador_id)) || '',
      ultima_obs: d.ultima_obs || '',
    }));
});

rota('POST', '/api/discar', [], async ({ user, body }) => {
  const dev = await devedorPorTelefone(body.telefone_id);
  if (!dev) falha(404, 'Telefone não encontrado.');
  if (!podeDevedor(user, dev)) falha(403, 'Sem acesso a esta carteira.');
  const tel = dev.telefones.find((t) => sid(t.id) === sid(body.telefone_id));
  const config = await cfg();
  const modo = config.discador_modo || 'tel';
  if (modo === 'tel') return { modo, uri: `tel:+55${tel.numero}` };
  if (modo === 'sip') return { modo, uri: `sip:${tel.numero}` };
  if (modo === 'callto') return { modo, uri: `callto:${tel.numero}` };
  if (modo === 'webhook') {
    if (!user.ramal) falha(400, 'Seu usuário não tem ramal cadastrado.');
    const url = String(config.discador_url || '')
      .replaceAll('{numero}', encodeURIComponent(tel.numero))
      .replaceAll('{ramal}', encodeURIComponent(user.ramal))
      .replaceAll('{login}', encodeURIComponent(user.login))
      .replaceAll('{devedor_id}', dev.id)
      .replaceAll('{cpf}', dev.cpf_cnpj);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) falha(502, `Discador respondeu HTTP ${r.status}.`);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      falha(502, `Falha ao acionar o discador: ${e.message}`);
    }
    return { modo, ok: true };
  }
  return { modo: 'nenhum' };
});

rota('GET', '/api/discador/screenpop', null, async ({ query }) => {
  const config = await cfg();
  if (!query.key || query.key !== config.discador_api_key) falha(401, 'Chave inválida.');
  if (!query.ramal) falha(400, 'Informe o ramal.');
  let dev = null;
  if (query.devedor_id) dev = await um('devedores', query.devedor_id);
  if (!dev && query.cpf) {
    const s = await C('devedores').where('cpf_cnpj', '==', soDigitos(query.cpf)).limit(1).get();
    dev = s.empty ? null : { id: s.docs[0].id };
  }
  if (!dev && query.numero) {
    const n = soDigitos(query.numero).replace(/^55(?=\d{10,11}$)/, '');
    const s = await C('devedores').where('busca_termos', 'array-contains', n).limit(1).get();
    dev = s.empty ? null : { id: s.docs[0].id };
  }
  if (!dev) falha(404, 'Devedor não encontrado.');
  await C('pops').doc(sid(query.ramal)).set({ devedor_id: dev.id, numero: soDigitos(query.numero), ts: Date.now() });
  return { ok: true, devedor_id: dev.id };
});

rota('GET', '/api/operador/pop', [], async ({ user }) => {
  if (!user.ramal) return { devedor_id: null };
  const ref = C('pops').doc(sid(user.ramal));
  const pop = await ref.get();
  if (!pop.exists || Date.now() - pop.data().ts > 60000) return { devedor_id: null };
  await ref.delete();
  return pop.data();
});

function diasEntre(ini, fim) {
  const out = [];
  const d = new Date(`${ini}T12:00:00`);
  const end = new Date(`${fim}T12:00:00`);
  while (d <= end && out.length < 62) {
    out.push(hojeISO(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

rota('GET', '/api/dashboard', SUP, async ({ query }) => {
  const [, , dIni, dFim] = intervaloDatas(query);
  const dias = diasEntre(dIni, dFim);
  const snaps = dias.length ? await fs.getAll(...dias.map((d) => C('stats').doc(d))) : [];
  const stats = snaps.filter((s) => s.exists).map((s) => s.data());
  const soma = (sel) => stats.reduce((s, dia) => s + (Number(sel(dia)) || 0), 0);
  const totais = {
    acionamentos: soma((d) => d.acionamentos), cpc: soma((d) => d.cpc), sem_contato: soma((d) => d.sem_contato),
    devedores_trabalhados: soma((d) => d.acionamentos), acordos: soma((d) => d.acordos),
    valor_acordos: r2(soma((d) => d.valor_acordos)), recebido: r2(soma((d) => d.recebido)),
    parcelas_pagas: soma((d) => d.parcelas_pagas), a_receber: 0,
  };
  const usuarios = (await todos('usuarios')).filter((u) => u.ativo !== false && u.ativo !== 0 && u.perfil !== 'admin');
  const agora = Date.now();
  const operadores = usuarios.map((u) => {
    const op = {};
    for (const k of ['acionamentos', 'cpc', 'sem_contato', 'acordos', 'valor_acordos', 'tempo_total']) {
      op[k] = soma((d) => d[`op_${u.id}_${k}`]);
    }
    return {
      id: u.id, nome: u.nome, login: u.login, ramal: u.ramal, perfil: u.perfil,
      acionamentos: op.acionamentos, cpc: op.cpc, sem_contato: op.sem_contato,
      acordos: op.acordos, valor_acordos: r2(op.valor_acordos),
      tempo_total: op.tempo_total, primeiro: null, ultimo: null,
      online: agora - new Date(String(u.ultimo_acesso || '').replace(' ', 'T')).getTime() < 90000,
      em_atendimento: u.atendendo || null,
    };
  }).sort((a, b) => b.acionamentos - a.acionamentos || a.nome.localeCompare(b.nome));

  const tabs = await todos('tabulacoes');
  const tabulacoes = tabs.map((t) => ({ descricao: t.descricao, tipo: t.tipo, qtd: soma((d) => d[`tab_${t.id}`]) }))
    .filter((t) => t.qtd).sort((a, b) => b.qtd - a.qtd);
  const porHora = [];
  for (let h = 0; h < 24; h++) {
    const qtd = soma((d) => d[`hora_${h}`]);
    if (qtd) porHora.push({ hora: h, qtd });
  }
  const carteiras = (await todos('carteiras')).filter((c) => c.ativa).map((c) => ({
    id: c.id, nome: c.nome, credor: c.credor, devedores: c.devedores || 0, em_aberto: c.em_aberto || 0,
    em_acordo: c.em_acordo || 0, quitados: c.quitados || 0, virgens: c.virgens || 0, valor_aberto: c.valor_aberto || 0,
  }));
  return { periodo: { ini: dIni, fim: dFim }, totais, operadores, carteiras, tabulacoes, por_hora: porHora };
});

rota('GET', '/api/relatorios/:tipo', SUP, async ({ params, query, res }) => {
  const [ini, fim, dIni, dFim] = intervaloDatas(query);
  let linhas = [];
  let colunas = [];
  if (params.tipo === 'acionamentos') {
    linhas = (await C('acionamentos').where('criado_em', '>=', ini).where('criado_em', '<=', fim).limit(2000).get()).docs
      .map((d) => d.data()).filter((a) => !query.carteira_id || sid(a.carteira_id) === sid(query.carteira_id));
    colunas = [
      { titulo: 'Data/Hora', campo: 'criado_em' }, { titulo: 'Operador', campo: 'operador' },
      { titulo: 'Carteira', campo: 'carteira' }, { titulo: 'CPF/CNPJ', campo: 'cpf_cnpj' }, { titulo: 'Nome', campo: 'nome' },
      { titulo: 'Telefone', campo: 'telefone' }, { titulo: 'Código', campo: 'codigo' }, { titulo: 'Tabulação', campo: 'tabulacao' },
      { titulo: 'Tipo', campo: 'tipo' }, { titulo: 'Observação', campo: 'observacao' },
      { titulo: 'Agendamento', campo: 'data_agendamento' }, { titulo: 'Duração (s)', campo: 'duracao_seg' },
    ];
  } else if (params.tipo === 'acordos') {
    linhas = (await C('acordos').where('criado_em', '>=', ini).where('criado_em', '<=', fim).limit(2000).get()).docs
      .map((d) => ({ id: d.id, ...d.data() })).filter((a) => !query.carteira_id || sid(a.carteira_id) === sid(query.carteira_id));
    colunas = [
      { titulo: 'Acordo', campo: 'id' }, { titulo: 'Data', campo: 'criado_em' }, { titulo: 'Operador', campo: 'operador' },
      { titulo: 'Carteira', campo: 'carteira' }, { titulo: 'CPF/CNPJ', campo: 'cpf_cnpj' }, { titulo: 'Nome', campo: 'devedor' },
      { titulo: 'Valor dívida', campo: 'valor_divida', decimal: true }, { titulo: 'Desconto %', campo: 'desconto_pct' },
      { titulo: 'Valor acordo', campo: 'valor_acordo', decimal: true }, { titulo: 'Parcelas', campo: 'qtd_parcelas' },
      { titulo: 'Status', campo: 'status' },
    ];
  } else if (params.tipo === 'parcelas') {
    const ac = (await C('acordos').limit(1000).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    for (const a of ac) {
      for (const p of a.parcelas || []) {
        if (p.vencimento >= dIni && p.vencimento <= dFim && (!query.carteira_id || sid(a.carteira_id) === sid(query.carteira_id))) {
          linhas.push({ ...p, acordo_id: a.id, status_acordo: a.status, cpf_cnpj: a.cpf_cnpj, nome: a.devedor, carteira: a.carteira, operador: a.operador });
        }
      }
    }
    colunas = [
      { titulo: 'Acordo', campo: 'acordo_id' }, { titulo: 'Parcela', campo: 'numero' }, { titulo: 'Vencimento', campo: 'vencimento' },
      { titulo: 'Valor', campo: 'valor', decimal: true }, { titulo: 'Status', campo: 'status' },
      { titulo: 'Pago em', campo: 'pago_em' }, { titulo: 'Valor pago', campo: 'valor_pago', decimal: true },
      { titulo: 'Status acordo', campo: 'status_acordo' }, { titulo: 'Carteira', campo: 'carteira' },
      { titulo: 'CPF/CNPJ', campo: 'cpf_cnpj' }, { titulo: 'Nome', campo: 'nome' }, { titulo: 'Operador', campo: 'operador' },
    ];
  } else if (params.tipo === 'produtividade') {
    const [, , iniD, fimD] = [ini, fim, dIni, dFim];
    void iniD;
    const dias = diasEntre(dIni, fimD);
    const snaps = dias.length ? await fs.getAll(...dias.map((d) => C('stats').doc(d))) : [];
    const stats = snaps.filter((s) => s.exists).map((s) => s.data());
    linhas = (await todos('usuarios')).filter((u) => u.perfil !== 'admin').map((u) => {
      const pega = (k) => stats.reduce((s, d) => s + (Number(d[`op_${u.id}_${k}`]) || 0), 0);
      return { nome: u.nome, login: u.login, acionamentos: pega('acionamentos'), cpc: pega('cpc'), acordos: pega('acordos'), valor_acordos: r2(pega('valor_acordos')), recebido: r2(pega('recebido')) };
    });
    colunas = [
      { titulo: 'Operador', campo: 'nome' }, { titulo: 'Login', campo: 'login' }, { titulo: 'Acionamentos', campo: 'acionamentos' },
      { titulo: 'CPC', campo: 'cpc' }, { titulo: 'Acordos', campo: 'acordos' },
      { titulo: 'Valor acordos', campo: 'valor_acordos', decimal: true }, { titulo: 'Recebido', campo: 'recebido', decimal: true },
    ];
  } else falha(404, 'Relatório inexistente.');
  enviarCsv(res, `${params.tipo}_${hojeISO()}.csv`, toCsv(linhas, colunas));
});

function dadosCarteira(b) {
  const nome = String(b.nome || '').trim();
  const credor = String(b.credor || '').trim();
  if (!nome || !credor) falha(400, 'Informe nome e credor.');
  const num = (v, pad) => (v === '' || v == null ? pad : Number(v));
  return {
    nome, credor, cnpj: b.cnpj || null, juros_mes: num(b.juros_mes, 1), multa: num(b.multa, 2),
    honorarios: num(b.honorarios, 10), desconto_max: num(b.desconto_max, 30), parcelas_max: num(b.parcelas_max, 12),
    entrada_min_pct: num(b.entrada_min_pct, 10), ativa: b.ativa === undefined ? 1 : (b.ativa ? 1 : 0),
  };
}

rota('GET', '/api/carteiras', SUP, async () => {
  const lista = await todos('carteiras');
  return lista.sort((a, b) => (b.ativa - a.ativa) || a.nome.localeCompare(b.nome));
});
rota('POST', '/api/carteiras', ADM, async ({ body }) => {
  const id = novoId();
  await C('carteiras').doc(id).set({ ...dadosCarteira(body), devedores: 0, em_aberto: 0, em_acordo: 0, quitados: 0, virgens: 0, valor_aberto: 0, distribuidos: 0, criado_em: agoraISO() });
  return { id };
});
rota('PUT', '/api/carteiras/:id', ADM, async ({ params, body }) => {
  await C('carteiras').doc(params.id).set(dadosCarteira(body), { merge: true });
  return { ok: true };
});

const pegar = (linha, ...nomes) => {
  for (const n of nomes) if (linha[n]) return linha[n];
  return '';
};

rota('POST', '/api/carteiras/:id/importar', ADM, async ({ params, body }) => {
  const carteira = await um('carteiras', params.id);
  if (!carteira) falha(404, 'Carteira não encontrada.');
  const linhas = parseCsv(body.csv || '');
  if (!linhas.length) falha(400, 'Arquivo vazio ou sem cabeçalho.');
  const r = { linhas: linhas.length, devedores_novos: 0, dividas_novas: 0, dividas_duplicadas: 0, telefones_novos: 0, erros: [] };
  const porCpf = new Map();
  linhas.forEach((l, i) => {
    const doc = soDigitos(pegar(l, 'cpf', 'cpf_cnpj', 'cnpj', 'documento'));
    if (doc.length === 11 || doc.length === 14) porCpf.set(doc, true);
  });
  const refs = [...porCpf.keys()].map((cpf) => C('devedores').doc(idDevedor(carteira.id, cpf)));
  const existentes = new Map();
  for (let i = 0; i < refs.length; i += 300) {
    for (const s of await fs.getAll(...refs.slice(i, i + 300))) if (s.exists) existentes.set(s.id, s.data());
  }
  const gravar = new Map();
  linhas.forEach((l, i) => {
    const nLinha = i + 2;
    const doc = soDigitos(pegar(l, 'cpf', 'cpf_cnpj', 'cnpj', 'documento'));
    const nome = pegar(l, 'nome', 'nome_devedor', 'cliente');
    const valor = parseValor(pegar(l, 'valor', 'valor_original', 'saldo', 'valor_divida'));
    const venc = parseData(pegar(l, 'vencimento', 'data_vencimento', 'dt_vencimento'));
    if (doc.length !== 11 && doc.length !== 14) return r.erros.push(`Linha ${nLinha}: CPF/CNPJ inválido.`);
    if (!nome) return r.erros.push(`Linha ${nLinha}: nome em branco.`);
    if (!Number.isFinite(valor) || valor <= 0) return r.erros.push(`Linha ${nLinha}: valor inválido.`);
    if (!venc) return r.erros.push(`Linha ${nLinha}: vencimento inválido (use dd/mm/aaaa).`);
    const did = idDevedor(carteira.id, doc);
    let dev = gravar.get(did);
    if (!dev) {
      const antigo = existentes.get(did);
      if (antigo) dev = structuredClone(antigo);
      else {
        dev = novoDevedor({
          carteira_id: carteira.id, cpf_cnpj: doc, nome,
          data_nasc: parseData(pegar(l, 'data_nasc', 'nascimento', 'data_nascimento')),
          email: pegar(l, 'email', 'e-mail'), endereco: pegar(l, 'endereco', 'logradouro'),
          cidade: pegar(l, 'cidade', 'municipio'), uf: pegar(l, 'uf', 'estado').toUpperCase().slice(0, 2), cep: pegar(l, 'cep'),
        });
        r.devedores_novos++;
      }
      gravar.set(did, dev);
    }
    for (const [k, v] of Object.entries(l)) {
      if (!/^(telefone|fone|celular|tel)_?\d*$/.test(k)) continue;
      const numero = soDigitos(v).replace(/^55(?=\d{10,11}$)/, '');
      if (numero.length < 10 || numero.length > 11) continue;
      if (dev.telefones.some((t) => t.numero === numero)) continue;
      dev.telefones.push({ id: novoId(), numero, tipo: k.startsWith('celular') || numero[2] === '9' ? 'CELULAR' : 'FIXO', status: 'ATIVO' });
      r.telefones_novos++;
    }
    const contrato = pegar(l, 'contrato', 'numero_contrato', 'titulo', 'documento_divida');
    if (contrato && dev.dividas.some((dv) => dv.contrato === contrato && dv.vencimento === venc)) {
      r.dividas_duplicadas++;
      return;
    }
    dev.dividas.push({ id: novoId(), contrato: contrato || null, descricao: pegar(l, 'descricao', 'produto') || null, valor_original: r2(valor), vencimento: venc, status: 'ABERTA', acordo_id: null });
    r.dividas_novas++;
    if (dev.status === 'QUITADO') dev.status = 'ABERTO';
  });
  let delta = {};
  const ops = [];
  for (const [did, dev] of gravar) {
    const antes = existentes.get(did) || null;
    derivar(dev);
    const d = deltaContagem(antes, dev);
    for (const [k, v] of Object.entries(d)) delta[k] = (delta[k] || 0) + v;
    ops.push((b) => b.set(C('devedores').doc(did), dev));
  }
  if (Object.keys(delta).length) {
    const inc = {};
    for (const [k, v] of Object.entries(delta)) inc[k] = FieldValue.increment(r2(v));
    ops.push((b) => b.set(C('carteiras').doc(sid(carteira.id)), inc, { merge: true }));
  }
  await gravarEmLotes(ops);
  if (r.erros.length > 200) r.erros = [...r.erros.slice(0, 200), `... e mais ${r.erros.length - 200} erros.`];
  return r;
});

rota('POST', '/api/carteiras/:id/distribuir', SUP, async ({ params, body }) => {
  const s = await C('devedores').where('carteira_id', '==', sid(params.id)).limit(2000).get();
  let lista = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => STATUS_FILA.includes(d.status));
  if (body.liberar) {
    for (const dev of lista) await salvarDevedor(dev.id, dev, { ...dev, operador_id: null });
    return { ok: true, afetados: lista.length };
  }
  const ops = ids(body.usuario_ids);
  if (!ops.length) falha(400, 'Selecione ao menos um operador.');
  if (body.somente_livres) lista = lista.filter((d) => !d.operador_id);
  for (let i = 0; i < lista.length; i++) {
    await salvarDevedor(lista[i].id, lista[i], { ...lista[i], operador_id: ops[i % ops.length] });
  }
  return { ok: true, afetados: lista.length };
});

rota('GET', '/api/carteiras/:id/mailing', SUP, async ({ params, res }) => {
  const agora = agoraISO();
  const s = await C('devedores').where('carteira_id', '==', sid(params.id)).limit(2000).get();
  const linhas = [];
  for (const d of s.docs.map((x) => ({ id: x.id, ...x.data() }))) {
    if (!STATUS_FILA.includes(d.status)) continue;
    if (d.proximo_contato && d.proximo_contato > agora) continue;
    for (const t of d.telefones || []) {
      if (t.status === 'INVALIDO') continue;
      linhas.push({ id: d.id, cpf_cnpj: d.cpf_cnpj, nome: d.nome, numero: t.numero, tipo: t.tipo, status: t.status, tentativas: d.tentativas || 0 });
    }
  }
  linhas.sort((a, b) => a.tentativas - b.tentativas || (a.status === 'CPC' ? -1 : 1));
  enviarCsv(res, `mailing_carteira_${params.id}_${hojeISO()}.csv`, toCsv(linhas, [
    { titulo: 'devedor_id', campo: 'id' }, { titulo: 'cpf', campo: 'cpf_cnpj' }, { titulo: 'nome', campo: 'nome' },
    { titulo: 'telefone', campo: 'numero' }, { titulo: 'tipo', campo: 'tipo' }, { titulo: 'status_telefone', campo: 'status' },
  ]));
});

rota('GET', '/api/usuarios', SUP, async () => (await todos('usuarios')).map((u) => ({
  id: u.id, nome: u.nome, login: u.login, perfil: u.perfil, ramal: u.ramal, ativo: u.ativo === false || u.ativo === 0 ? 0 : 1,
  ultimo_acesso: u.ultimo_acesso, criado_em: u.criado_em, carteiras: (u.carteiras || []).map(sid),
})));

rota('POST', '/api/usuarios', ADM, async ({ body }) => {
  const login = String(body.login || '').trim().toLowerCase();
  if (!body.nome || !login || !body.senha) falha(400, 'Informe nome, login e senha.');
  if (String(body.senha).length < 6) falha(400, 'A senha deve ter ao menos 6 caracteres.');
  if (!['admin', 'supervisor', 'operador'].includes(body.perfil)) falha(400, 'Perfil inválido.');
  const existe = await C('usuarios').where('login', '==', login).limit(1).get();
  if (!existe.empty) falha(400, 'Login já existe.');
  const id = novoId();
  await C('usuarios').doc(id).set({
    nome: body.nome, login, senha_hash: hashSenha(body.senha), perfil: body.perfil, ramal: body.ramal || null,
    ativo: body.ativo === false ? 0 : 1, carteiras: ids(body.carteiras), ultimo_acesso: null, atendendo: null, sessao: 0, criado_em: agoraISO(),
  });
  return { id };
});

rota('PUT', '/api/usuarios/:id', ADM, async ({ params, body, user }) => {
  const alvo = await um('usuarios', params.id);
  if (!alvo) falha(404, 'Usuário não encontrado.');
  if (!['admin', 'supervisor', 'operador'].includes(body.perfil)) falha(400, 'Perfil inválido.');
  if (alvo.id === user.id && (body.perfil !== 'admin' || body.ativo === false)) falha(400, 'Você não pode remover seu próprio acesso de administrador.');
  if (body.senha && String(body.senha).length < 6) falha(400, 'A senha deve ter ao menos 6 caracteres.');
  const upd = { nome: body.nome || alvo.nome, perfil: body.perfil, ramal: body.ramal || null, ativo: body.ativo === false ? 0 : 1, carteiras: ids(body.carteiras) };
  if (body.senha) upd.senha_hash = hashSenha(body.senha);
  if (body.ativo === false) upd.sessao = FieldValue.increment(1);
  await C('usuarios').doc(alvo.id).set(upd, { merge: true });
  return { ok: true };
});

rota('POST', '/api/minha-senha', [], async ({ user, body }) => {
  if (!verificarSenha(body.atual || '', user.senha_hash)) falha(400, 'Senha atual incorreta.');
  if (String(body.nova || '').length < 6) falha(400, 'A nova senha deve ter ao menos 6 caracteres.');
  await C('usuarios').doc(user.id).set({ senha_hash: hashSenha(body.nova) }, { merge: true });
  return { ok: true };
});

function dadosTabulacao(b) {
  const codigo = String(b.codigo || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (!codigo || !b.descricao) falha(400, 'Informe código e descrição.');
  if (!['SEM_CONTATO', 'CONTATO', 'CPC', 'PROMESSA', 'ACORDO', 'RECUSA'].includes(b.tipo)) falha(400, 'Tipo inválido.');
  return {
    codigo, descricao: b.descricao, tipo: b.tipo, exige_agendamento: b.exige_agendamento ? 1 : 0,
    invalida_telefone: b.invalida_telefone ? 1 : 0, finaliza: b.finaliza ? 1 : 0, ativa: b.ativa === false ? 0 : 1,
  };
}
rota('GET', '/api/tabulacoes', ADM, async () => (await todos('tabulacoes')).sort((a, b) => (b.ativa - a.ativa) || String(a.tipo).localeCompare(String(b.tipo))));
rota('POST', '/api/tabulacoes', ADM, async ({ body }) => {
  const d = dadosTabulacao(body);
  const existe = (await todos('tabulacoes')).some((t) => t.codigo === d.codigo);
  if (existe) falha(400, 'Código já existe.');
  const id = novoId();
  await C('tabulacoes').doc(id).set(d);
  return { id };
});
rota('PUT', '/api/tabulacoes/:id', ADM, async ({ params, body }) => {
  await C('tabulacoes').doc(params.id).set(dadosTabulacao(body), { merge: true });
  return { ok: true };
});

rota('GET', '/api/config', ADM, async () => cfg());
rota('PUT', '/api/config', ADM, async ({ body }) => {
  const upd = {};
  for (const k of CHAVES_CONFIG) if (body[k] !== undefined) upd[k] = String(body[k]);
  await C('config').doc('geral').set(upd, { merge: true });
  return { ok: true };
});

// ---------------------------------------------------------------- HTTP
function cookie(res, valor, maxAge) {
  const secure = '; Secure';
  res.setHeader('Set-Cookie', `sid=${valor}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${maxAge ? secure : ''}`);
}
function enviarJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function enviarCsv(res, nome, conteudo) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${nome}"`,
    'Cache-Control': 'no-store',
  });
  res.end(conteudo);
}
async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { falha(400, 'JSON inválido.'); }
  }
  const partes = [];
  for await (const c of req) partes.push(c);
  const txt = Buffer.concat(partes).toString('utf8');
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { falha(400, 'JSON inválido.'); }
}
function lerCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
  }));
}

let ultimoAcesso = new Map();
async function autenticar(req) {
  const token = lerToken(lerCookies(req).sid);
  if (!token) return {};
  const u = await um('usuarios', token.id);
  if (!u || u.ativo === false || u.ativo === 0 || (u.sessao || 0) !== token.sessao) return {};
  const agora = Date.now();
  if (agora - (ultimoAcesso.get(u.id) || 0) > 60000) {
    ultimoAcesso.set(u.id, agora);
    await C('usuarios').doc(u.id).set({ ultimo_acesso: agoraISO() }, { merge: true });
  }
  return { user: u };
}

export async function handle(req, res) {
  const candidatos = [req.headers['x-forwarded-uri'], req.headers['x-invoke-path'], req.headers['x-vercel-original-url'], req.url];
  let bruto = candidatos.find((c) => c && String(c).startsWith('/api/') && !String(c).includes('index.js')) || req.url || '/';
  if (!String(bruto).startsWith('/api/') && Array.isArray(req.query?.path)) bruto = `/api/${req.query.path.join('/')}`;
  const url = new URL(bruto, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404);
    return res.end();
  }
  try {
    await garantirInicializado();
    const r = rotas.find((x) => x.metodo === req.method && x.re.test(url.pathname));
    if (!r) falha(404, 'Rota não encontrada.');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.chaves.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const { user } = r.perfis === null ? {} : await autenticar(req);
    if (r.perfis !== null) {
      if (!user) falha(401, 'Não autenticado.');
      if (r.perfis.length && !r.perfis.includes(user.perfil)) falha(403, 'Sem permissão.');
    }
    const body = ['POST', 'PUT'].includes(req.method) ? await lerCorpo(req) : {};
    const out = await r.handler({ req, res, user, params, query: Object.fromEntries(url.searchParams), body });
    if (!res.headersSent) enviarJson(res, 200, out ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return enviarJson(res, e.status, { erro: e.message });
    console.error(e);
    const msg = String(e.message || e);
    const mostrar = /Credenciais do Firebase|index|FAILED_PRECONDITION|NOT_FOUND|Firestore|PERMISSION_DENIED|invalid/i.test(msg);
    enviarJson(res, 500, { erro: mostrar ? msg : 'Erro interno no servidor.' });
  }
}
