import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { db, all, get, run, tx, hashSenha, verificarSenha, getConfig } from './db.js';
import {
  r2, hojeISO, agoraISO, atualizarDivida, simularAcordo, soDigitos, parseValor, parseData, parseCsv, toCsv,
} from './cobranca.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const SESSAO_HORAS = 12;
const TIPOS_CPC = ['CPC', 'PROMESSA', 'ACORDO', 'RECUSA'];
const STATUS_FILA = ['ABERTO', 'SEM_CONTATO'];

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const falha = (status, msg) => { throw new HttpError(status, msg); };

// ---------------------------------------------------------------- estado em memória
const ultimoVisto = new Map();      // usuario_id -> timestamp (ms) da última requisição
const popsPendentes = new Map();    // ramal -> { devedor_id, numero, ts }

// ---------------------------------------------------------------- roteador
const rotas = [];
/** perfis: null = público; [] = qualquer usuário logado; ['admin', ...] = perfis permitidos */
function rota(metodo, padrao, perfis, handler) {
  const chaves = [];
  const re = new RegExp(`^${padrao.replace(/:(\w+)/g, (_, k) => { chaves.push(k); return '([^/]+)'; })}$`);
  rotas.push({ metodo, re, chaves, perfis, handler });
}
const SUP = ['admin', 'supervisor'];
const ADM = ['admin'];

// ---------------------------------------------------------------- utilidades
const intervaloDatas = (q) => {
  const ini = parseData(q.data_ini) || hojeISO();
  const fim = parseData(q.data_fim) || ini;
  return [`${ini} 00:00:00`, `${fim} 23:59:59`, ini, fim];
};
const normDataHora = (v) => {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/);
  if (!m) falha(400, 'Data/hora inválida.');
  return `${m[1]} ${m[2]}${m[3] || ':00'}`;
};
const emHoras = (h) => agoraISO(new Date(Date.now() + Number(h) * 3600000));
const placeholders = (arr) => arr.map(() => '?').join(',');
const inteiro = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

function carteirasPermitidas(user) {
  if (user.perfil !== 'operador') return null;
  const ids = all('SELECT carteira_id FROM usuario_carteiras WHERE usuario_id = ?', user.id).map((r) => r.carteira_id);
  return ids.length ? ids : null;
}

function exigirAcessoDevedor(user, devedorId) {
  const dev = get('SELECT * FROM devedores WHERE id = ?', devedorId);
  if (!dev) falha(404, 'Devedor não encontrado.');
  const perm = carteirasPermitidas(user);
  if (perm && !perm.includes(dev.carteira_id)) falha(403, 'Sem acesso a esta carteira.');
  return dev;
}

function usuarioPublico(u) {
  return { id: u.id, nome: u.nome, login: u.login, perfil: u.perfil, ramal: u.ramal };
}

// ---------------------------------------------------------------- autenticação
rota('POST', '/api/login', null, ({ body, res }) => {
  const u = get('SELECT * FROM usuarios WHERE login = ? AND ativo = 1', String(body.login || '').trim());
  if (!u || !verificarSenha(body.senha || '', u.senha_hash)) falha(401, 'Usuário ou senha inválidos.');
  const token = crypto.randomBytes(32).toString('hex');
  run('DELETE FROM sessoes WHERE expira_em < ?', agoraISO());
  run('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)', token, u.id, emHoras(SESSAO_HORAS));
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSAO_HORAS * 3600}`);
  return usuarioPublico(u);
});

rota('POST', '/api/logout', [], ({ res, token, user }) => {
  run('DELETE FROM sessoes WHERE token = ?', token);
  run('UPDATE devedores SET lock_usuario_id = NULL, lock_ate = NULL WHERE lock_usuario_id = ?', user.id);
  ultimoVisto.delete(user.id);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

rota('GET', '/api/me', [], ({ user }) => {
  const cfg = getConfig();
  const perm = carteirasPermitidas(user);
  const carteiras = all('SELECT * FROM carteiras WHERE ativa = 1 ORDER BY nome')
    .filter((c) => !perm || perm.includes(c.id));
  return {
    usuario: usuarioPublico(user),
    config: { empresa_nome: cfg.empresa_nome, discador_modo: cfg.discador_modo },
    carteiras,
    tabulacoes: all('SELECT * FROM tabulacoes WHERE ativa = 1 ORDER BY tipo, descricao'),
  };
});

// ---------------------------------------------------------------- fila de trabalho
rota('POST', '/api/fila/proximo', [], ({ user, body }) => {
  const cfg = getConfig();
  const agora = agoraISO();
  const perm = carteirasPermitidas(user);
  const filtroCarteira = inteiro(body.carteira_id);
  if (filtroCarteira && perm && !perm.includes(filtroCarteira)) falha(403, 'Sem acesso a esta carteira.');

  const where = [
    'c.ativa = 1',
    `d.status IN (${placeholders(STATUS_FILA)})`,
    '(d.operador_id IS NULL OR d.operador_id = ?)',
    '(d.proximo_contato IS NULL OR d.proximo_contato <= ?)',
    '(d.lock_usuario_id IS NULL OR d.lock_usuario_id = ? OR d.lock_ate < ?)',
    "EXISTS (SELECT 1 FROM telefones t WHERE t.devedor_id = d.id AND t.status <> 'INVALIDO')",
  ];
  const params = [...STATUS_FILA, user.id, agora, user.id, agora];
  if (perm) { where.push(`d.carteira_id IN (${placeholders(perm)})`); params.push(...perm); }
  if (filtroCarteira) { where.push('d.carteira_id = ?'); params.push(filtroCarteira); }

  // Tudo síncrono no mesmo tick: dois operadores nunca recebem o mesmo devedor.
  run('UPDATE devedores SET lock_usuario_id = NULL, lock_ate = NULL WHERE lock_usuario_id = ?', user.id);
  const prox = get(`
    SELECT d.id FROM devedores d JOIN carteiras c ON c.id = d.carteira_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN d.operador_id = ? AND d.proximo_contato IS NOT NULL THEN 0 ELSE 1 END,
      d.tentativas, d.ultimo_acionamento IS NOT NULL, d.ultimo_acionamento, d.id
    LIMIT 1`, ...params, user.id);
  if (!prox) return { devedor_id: null };
  const lockMin = Number(cfg.lock_minutos) || 15;
  run('UPDATE devedores SET lock_usuario_id = ?, lock_ate = ? WHERE id = ?',
    user.id, agoraISO(new Date(Date.now() + lockMin * 60000)), prox.id);
  return { devedor_id: prox.id };
});

rota('GET', '/api/fila/resumo', [], ({ user }) => {
  const agora = agoraISO();
  const perm = carteirasPermitidas(user);
  const params = [...STATUS_FILA, user.id, agora];
  let filtro = '';
  if (perm) { filtro = `AND d.carteira_id IN (${placeholders(perm)})`; params.push(...perm); }
  return all(`
    SELECT c.id, c.nome, COUNT(d.id) AS disponiveis
    FROM carteiras c JOIN devedores d ON d.carteira_id = c.id
    WHERE c.ativa = 1 AND d.status IN (${placeholders(STATUS_FILA)})
      AND (d.operador_id IS NULL OR d.operador_id = ?)
      AND (d.proximo_contato IS NULL OR d.proximo_contato <= ?)
      AND EXISTS (SELECT 1 FROM telefones t WHERE t.devedor_id = d.id AND t.status <> 'INVALIDO')
      ${filtro}
    GROUP BY c.id ORDER BY c.nome`, ...params);
});

rota('GET', '/api/meus-numeros', [], ({ user }) => {
  const [ini, fim] = intervaloDatas({});
  const a = get(`
    SELECT COUNT(*) AS acionamentos,
      COALESCE(SUM(CASE WHEN t.tipo IN (${placeholders(TIPOS_CPC)}) THEN 1 ELSE 0 END), 0) AS cpc
    FROM acionamentos a JOIN tabulacoes t ON t.id = a.tabulacao_id
    WHERE a.usuario_id = ? AND a.criado_em BETWEEN ? AND ?`, ...TIPOS_CPC, user.id, ini, fim);
  const ac = get(`SELECT COUNT(*) AS acordos, COALESCE(SUM(valor_acordo), 0) AS valor
    FROM acordos WHERE usuario_id = ? AND criado_em BETWEEN ? AND ? AND status <> 'CANCELADO'`, user.id, ini, fim);
  const ag = get(`SELECT COUNT(*) AS n FROM devedores WHERE operador_id = ? AND proximo_contato IS NOT NULL
    AND proximo_contato <= ? AND status IN (${placeholders(STATUS_FILA)})`, user.id, agoraISO(), ...STATUS_FILA);
  return { ...a, ...ac, agendados_vencidos: ag.n };
});

// ---------------------------------------------------------------- devedores
rota('GET', '/api/devedores', [], ({ user, query }) => {
  const where = ['1 = 1'];
  const params = [];
  const perm = carteirasPermitidas(user);
  if (perm) { where.push(`d.carteira_id IN (${placeholders(perm)})`); params.push(...perm); }
  if (query.carteira_id) { where.push('d.carteira_id = ?'); params.push(inteiro(query.carteira_id)); }
  if (query.status) { where.push('d.status = ?'); params.push(query.status); }
  const q = String(query.q || '').trim();
  if (q) {
    const dig = soDigitos(q).replace(/^55(?=\d{10,11}$)/, '');
    const conds = ['d.nome LIKE ?', 'EXISTS (SELECT 1 FROM dividas v WHERE v.devedor_id = d.id AND v.contrato = ?)'];
    params.push(`%${q}%`, q);
    if (dig.length >= 3) {
      conds.push('d.cpf_cnpj LIKE ?', 'EXISTS (SELECT 1 FROM telefones t WHERE t.devedor_id = d.id AND t.numero LIKE ?)');
      params.push(`${dig}%`, `%${dig}%`);
    }
    where.push(`(${conds.join(' OR ')})`);
  }
  return all(`
    SELECT d.id, d.nome, d.cpf_cnpj, d.status, d.cidade, d.uf, d.ultimo_acionamento, d.proximo_contato, d.tentativas,
      c.nome AS carteira, u.nome AS operador,
      (SELECT COALESCE(SUM(valor_original), 0) FROM dividas v WHERE v.devedor_id = d.id AND v.status = 'ABERTA') AS valor_aberto
    FROM devedores d JOIN carteiras c ON c.id = d.carteira_id LEFT JOIN usuarios u ON u.id = d.operador_id
    WHERE ${where.join(' AND ')}
    ORDER BY d.nome LIMIT 200`, ...params);
});

function fichaDevedor(id) {
  const devedor = get(`SELECT d.*, u.nome AS operador_nome, lu.nome AS lock_nome
    FROM devedores d LEFT JOIN usuarios u ON u.id = d.operador_id LEFT JOIN usuarios lu ON lu.id = d.lock_usuario_id
    WHERE d.id = ?`, id);
  const carteira = get('SELECT * FROM carteiras WHERE id = ?', devedor.carteira_id);
  const dividas = all('SELECT * FROM dividas WHERE devedor_id = ? ORDER BY vencimento', id)
    .map((d) => ({ ...d, atualizado: atualizarDivida(d, carteira) }));
  const acordos = all(`SELECT a.*, u.nome AS operador FROM acordos a JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.devedor_id = ? ORDER BY a.id DESC`, id);
  const hoje = hojeISO();
  for (const a of acordos) {
    a.parcelas = all('SELECT * FROM parcelas WHERE acordo_id = ? ORDER BY numero', a.id)
      .map((p) => ({ ...p, atrasada: p.status === 'ABERTA' && p.vencimento < hoje }));
  }
  const abertas = dividas.filter((d) => d.status === 'ABERTA');
  return {
    devedor,
    carteira,
    telefones: all(`SELECT * FROM telefones WHERE devedor_id = ?
      ORDER BY CASE status WHEN 'CPC' THEN 0 WHEN 'ATIVO' THEN 1 ELSE 2 END, id`, id),
    dividas,
    acordos,
    acionamentos: all(`SELECT a.*, u.nome AS operador, t.descricao AS tabulacao, t.tipo, f.numero AS telefone
      FROM acionamentos a JOIN usuarios u ON u.id = a.usuario_id JOIN tabulacoes t ON t.id = a.tabulacao_id
      LEFT JOIN telefones f ON f.id = a.telefone_id
      WHERE a.devedor_id = ? ORDER BY a.id DESC LIMIT 200`, id),
    resumo: {
      qtd_abertas: abertas.length,
      original_aberto: r2(abertas.reduce((s, d) => s + d.valor_original, 0)),
      atualizado_aberto: r2(abertas.reduce((s, d) => s + d.atualizado.total, 0)),
    },
  };
}

rota('GET', '/api/devedores/:id', [], ({ user, params }) => {
  exigirAcessoDevedor(user, params.id);
  return fichaDevedor(params.id);
});

rota('PUT', '/api/devedores/:id', [], ({ user, params, body }) => {
  exigirAcessoDevedor(user, params.id);
  run(`UPDATE devedores SET nome = COALESCE(?, nome), email = ?, endereco = ?, cidade = ?, uf = ?, cep = ?,
       data_nasc = ?, observacao = ? WHERE id = ?`,
    body.nome, body.email, body.endereco, body.cidade, body.uf, body.cep, parseData(body.data_nasc), body.observacao, params.id);
  return { ok: true };
});

rota('POST', '/api/devedores/:id/telefones', [], ({ user, params, body }) => {
  exigirAcessoDevedor(user, params.id);
  const numero = soDigitos(body.numero);
  if (numero.length < 10 || numero.length > 13) falha(400, 'Telefone inválido. Informe DDD + número.');
  run('INSERT OR IGNORE INTO telefones (devedor_id, numero, tipo) VALUES (?, ?, ?)', params.id, numero, body.tipo || 'CELULAR');
  return { ok: true };
});

rota('PUT', '/api/telefones/:id', [], ({ user, params, body }) => {
  const tel = get('SELECT * FROM telefones WHERE id = ?', params.id);
  if (!tel) falha(404, 'Telefone não encontrado.');
  exigirAcessoDevedor(user, tel.devedor_id);
  if (!['ATIVO', 'CPC', 'INVALIDO'].includes(body.status)) falha(400, 'Status inválido.');
  run('UPDATE telefones SET status = ? WHERE id = ?', body.status, params.id);
  return { ok: true };
});

// ---------------------------------------------------------------- acionamentos
rota('POST', '/api/devedores/:id/acionamentos', [], ({ user, params, body }) => {
  const dev = exigirAcessoDevedor(user, params.id);
  const t = get('SELECT * FROM tabulacoes WHERE id = ? AND ativa = 1', inteiro(body.tabulacao_id));
  if (!t) falha(400, 'Selecione a tabulação.');
  const agendamento = normDataHora(body.data_agendamento);
  if (t.exige_agendamento && !agendamento) falha(400, 'Esta tabulação exige data/hora de retorno.');
  if (agendamento && agendamento < agoraISO().slice(0, 16)) falha(400, 'O agendamento não pode ser no passado.');
  const telefoneId = inteiro(body.telefone_id);
  if (telefoneId && !get('SELECT 1 FROM telefones WHERE id = ? AND devedor_id = ?', telefoneId, dev.id)) {
    falha(400, 'Telefone não pertence ao devedor.');
  }
  const cfg = getConfig();

  tx(() => {
    run(`INSERT INTO acionamentos (devedor_id, usuario_id, telefone_id, tabulacao_id, observacao, data_agendamento, duracao_seg)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      dev.id, user.id, telefoneId, t.id, String(body.observacao || '').slice(0, 2000), agendamento, inteiro(body.duracao_seg));

    if (telefoneId) {
      if (t.invalida_telefone) run("UPDATE telefones SET status = 'INVALIDO' WHERE id = ?", telefoneId);
      else if (TIPOS_CPC.includes(t.tipo)) run("UPDATE telefones SET status = 'CPC' WHERE id = ?", telefoneId);
    }

    let { status, operador_id: operador } = dev;
    let proximo = dev.proximo_contato;
    const naFila = STATUS_FILA.includes(status);
    if (t.finaliza) {
      status = 'ENCERRADO';
      proximo = null;
    } else if (agendamento) {
      proximo = agendamento;
      if (user.perfil === 'operador') operador = user.id;
    } else if (naFila) {
      if (t.tipo === 'SEM_CONTATO') {
        proximo = emHoras(cfg.reciclagem_sem_contato_horas || 2);
        status = 'SEM_CONTATO';
      } else {
        proximo = emHoras(cfg.reciclagem_contato_horas || 24);
        status = 'ABERTO';
      }
    }
    run(`UPDATE devedores SET status = ?, operador_id = ?, proximo_contato = ?, ultimo_acionamento = ?,
         tentativas = tentativas + 1, lock_usuario_id = NULL, lock_ate = NULL WHERE id = ?`,
      status, operador, proximo, agoraISO(), dev.id);
  });
  return { ok: true };
});

// ---------------------------------------------------------------- acordos
function dividasSelecionadas(devedorId, ids) {
  const lista = (Array.isArray(ids) ? ids : []).map(inteiro).filter(Boolean);
  if (!lista.length) return [];
  return all(`SELECT * FROM dividas WHERE devedor_id = ? AND status = 'ABERTA' AND id IN (${placeholders(lista)})`,
    devedorId, ...lista);
}

rota('POST', '/api/devedores/:id/simular', [], ({ user, params, body }) => {
  const dev = exigirAcessoDevedor(user, params.id);
  const carteira = get('SELECT * FROM carteiras WHERE id = ?', dev.carteira_id);
  const dividas = dividasSelecionadas(dev.id, body.divida_ids);
  const sim = simularAcordo({ ...body, dividas, carteira });
  sim.pode_formalizar = !sim.violacoes.some((v) => !v.alcada || user.perfil === 'operador');
  return sim;
});

rota('POST', '/api/devedores/:id/acordos', [], ({ user, params, body }) => {
  const dev = exigirAcessoDevedor(user, params.id);
  const carteira = get('SELECT * FROM carteiras WHERE id = ?', dev.carteira_id);
  const dividas = dividasSelecionadas(dev.id, body.divida_ids);
  const sim = simularAcordo({ ...body, dividas, carteira });
  const bloqueios = sim.violacoes.filter((v) => !v.alcada || user.perfil === 'operador');
  if (bloqueios.length) falha(400, bloqueios.map((v) => v.msg).join(' '));

  const tabAcordo = get("SELECT id FROM tabulacoes WHERE codigo = 'ACORDO'") || get("SELECT id FROM tabulacoes WHERE tipo = 'ACORDO' LIMIT 1");
  const acordoId = tx(() => {
    const id = run(`INSERT INTO acordos (devedor_id, usuario_id, valor_divida, desconto_pct, valor_desconto, valor_acordo, qtd_parcelas, observacao)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      dev.id, user.id, sim.valor_divida, sim.desconto_pct, sim.valor_desconto, sim.valor_acordo, sim.qtd_parcelas,
      String(body.observacao || '').slice(0, 1000)).id;
    for (const p of sim.parcelas) {
      run('INSERT INTO parcelas (acordo_id, numero, vencimento, valor) VALUES (?, ?, ?, ?)', id, p.numero, p.vencimento, p.valor);
    }
    run(`UPDATE dividas SET status = 'EM_ACORDO', acordo_id = ? WHERE id IN (${placeholders(dividas)})`, id, ...dividas.map((d) => d.id));
    run(`UPDATE devedores SET status = 'EM_ACORDO', proximo_contato = NULL, ultimo_acionamento = ?,
         lock_usuario_id = NULL, lock_ate = NULL, operador_id = COALESCE(operador_id, ?) WHERE id = ?`,
      agoraISO(), user.perfil === 'operador' ? user.id : null, dev.id);
    if (tabAcordo) {
      run(`INSERT INTO acionamentos (devedor_id, usuario_id, telefone_id, tabulacao_id, observacao) VALUES (?, ?, ?, ?, ?)`,
        dev.id, user.id, inteiro(body.telefone_id), tabAcordo.id,
        `Acordo #${id}: R$ ${sim.valor_acordo.toFixed(2)} em ${sim.qtd_parcelas}x (desconto ${sim.desconto_pct}%)`);
    }
    return id;
  });
  return { ok: true, acordo_id: acordoId };
});

rota('GET', '/api/acordos', [], ({ user, query }) => {
  const [ini, fim] = intervaloDatas(query);
  const where = ['a.criado_em BETWEEN ? AND ?'];
  const params = [ini, fim];
  if (user.perfil === 'operador') { where.push('a.usuario_id = ?'); params.push(user.id); }
  if (query.status) { where.push('a.status = ?'); params.push(query.status); }
  if (query.carteira_id) { where.push('d.carteira_id = ?'); params.push(inteiro(query.carteira_id)); }
  const hoje = hojeISO();
  return all(`
    SELECT a.*, d.nome AS devedor, d.cpf_cnpj, c.nome AS carteira, u.nome AS operador,
      (SELECT COALESCE(SUM(valor_pago), 0) FROM parcelas p WHERE p.acordo_id = a.id AND p.status = 'PAGA') AS valor_pago,
      (SELECT COUNT(*) FROM parcelas p WHERE p.acordo_id = a.id AND p.status = 'ABERTA' AND p.vencimento < ?) AS parcelas_atrasadas
    FROM acordos a JOIN devedores d ON d.id = a.devedor_id JOIN carteiras c ON c.id = d.carteira_id
    JOIN usuarios u ON u.id = a.usuario_id
    WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 500`, hoje, ...params);
});

rota('POST', '/api/parcelas/:id/pagar', SUP, ({ params, body }) => {
  const p = get('SELECT * FROM parcelas WHERE id = ?', params.id);
  if (!p) falha(404, 'Parcela não encontrada.');
  if (p.status !== 'ABERTA') falha(400, 'Parcela não está em aberto.');
  const acordo = get('SELECT * FROM acordos WHERE id = ?', p.acordo_id);
  if (acordo.status !== 'ATIVO') falha(400, 'Acordo não está ativo.');
  const valor = body.valor_pago != null && body.valor_pago !== '' ? parseValor(body.valor_pago) : p.valor;
  if (!Number.isFinite(valor) || valor <= 0) falha(400, 'Valor pago inválido.');
  tx(() => {
    run("UPDATE parcelas SET status = 'PAGA', pago_em = ?, valor_pago = ? WHERE id = ?", parseData(body.pago_em) || hojeISO(), r2(valor), p.id);
    const restantes = get("SELECT COUNT(*) AS n FROM parcelas WHERE acordo_id = ? AND status = 'ABERTA'", acordo.id).n;
    if (restantes === 0) {
      run("UPDATE acordos SET status = 'QUITADO' WHERE id = ?", acordo.id);
      run("UPDATE dividas SET status = 'PAGA' WHERE acordo_id = ?", acordo.id);
      const pendentes = get("SELECT COUNT(*) AS n FROM dividas WHERE devedor_id = ? AND status <> 'PAGA'", acordo.devedor_id).n;
      run('UPDATE devedores SET status = ? WHERE id = ?', pendentes ? 'ABERTO' : 'QUITADO', acordo.devedor_id);
    }
  });
  return { ok: true };
});

rota('POST', '/api/parcelas/:id/estornar', SUP, ({ params }) => {
  const p = get('SELECT * FROM parcelas WHERE id = ?', params.id);
  if (!p || p.status !== 'PAGA') falha(400, 'Parcela não está paga.');
  const acordo = get('SELECT * FROM acordos WHERE id = ?', p.acordo_id);
  tx(() => {
    run("UPDATE parcelas SET status = 'ABERTA', pago_em = NULL, valor_pago = NULL WHERE id = ?", p.id);
    if (acordo.status === 'QUITADO') {
      run("UPDATE acordos SET status = 'ATIVO' WHERE id = ?", acordo.id);
      run("UPDATE dividas SET status = 'EM_ACORDO' WHERE acordo_id = ?", acordo.id);
      run("UPDATE devedores SET status = 'EM_ACORDO' WHERE id = ?", acordo.devedor_id);
    }
  });
  return { ok: true };
});

rota('POST', '/api/acordos/:id/quebrar', SUP, ({ params, body }) => {
  const acordo = get('SELECT * FROM acordos WHERE id = ?', params.id);
  if (!acordo) falha(404, 'Acordo não encontrado.');
  if (acordo.status !== 'ATIVO') falha(400, 'Somente acordos ativos podem ser quebrados/cancelados.');
  const novo = body.cancelar ? 'CANCELADO' : 'QUEBRADO';
  tx(() => {
    run('UPDATE acordos SET status = ? WHERE id = ?', novo, acordo.id);
    run("UPDATE parcelas SET status = 'CANCELADA' WHERE acordo_id = ? AND status = 'ABERTA'", acordo.id);
    run("UPDATE dividas SET status = 'ABERTA', acordo_id = NULL WHERE acordo_id = ?", acordo.id);
    run("UPDATE devedores SET status = 'ABERTO', proximo_contato = NULL WHERE id = ?", acordo.devedor_id);
  });
  return { ok: true };
});

// ---------------------------------------------------------------- agenda
rota('GET', '/api/agenda', [], ({ user, query }) => {
  const where = ['d.proximo_contato IS NOT NULL', 'd.operador_id IS NOT NULL', `d.status IN (${placeholders(STATUS_FILA)})`];
  const params = [...STATUS_FILA];
  if (user.perfil === 'operador' || query.meus) { where.push('d.operador_id = ?'); params.push(user.id); }
  return all(`
    SELECT d.id, d.nome, d.cpf_cnpj, d.proximo_contato, d.status, c.nome AS carteira, u.nome AS operador,
      (SELECT observacao FROM acionamentos a WHERE a.devedor_id = d.id ORDER BY a.id DESC LIMIT 1) AS ultima_obs
    FROM devedores d JOIN carteiras c ON c.id = d.carteira_id JOIN usuarios u ON u.id = d.operador_id
    WHERE ${where.join(' AND ')} ORDER BY d.proximo_contato LIMIT 500`, ...params);
});

// ---------------------------------------------------------------- discador
rota('POST', '/api/discar', [], async ({ user, body }) => {
  const tel = get('SELECT * FROM telefones WHERE id = ?', inteiro(body.telefone_id));
  if (!tel) falha(404, 'Telefone não encontrado.');
  const dev = exigirAcessoDevedor(user, tel.devedor_id);
  const cfg = getConfig();
  const modo = cfg.discador_modo || 'tel';
  if (modo === 'tel') return { modo, uri: `tel:+55${tel.numero}` };
  if (modo === 'sip') return { modo, uri: `sip:${tel.numero}` };
  if (modo === 'callto') return { modo, uri: `callto:${tel.numero}` };
  if (modo === 'webhook') {
    if (!user.ramal) falha(400, 'Seu usuário não tem ramal cadastrado.');
    const url = String(cfg.discador_url || '')
      .replaceAll('{numero}', encodeURIComponent(tel.numero))
      .replaceAll('{ramal}', encodeURIComponent(user.ramal))
      .replaceAll('{login}', encodeURIComponent(user.login))
      .replaceAll('{devedor_id}', String(dev.id))
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

// Endpoint para o discador (preditivo/power) abrir a ficha do devedor na tela do operador (screen pop).
rota('GET', '/api/discador/screenpop', null, ({ query }) => {
  const cfg = getConfig();
  if (!query.key || query.key !== cfg.discador_api_key) falha(401, 'Chave inválida.');
  if (!query.ramal) falha(400, 'Informe o ramal.');
  let dev = null;
  if (query.devedor_id) dev = get('SELECT id FROM devedores WHERE id = ?', inteiro(query.devedor_id));
  if (!dev && query.cpf) dev = get('SELECT id FROM devedores WHERE cpf_cnpj = ? ORDER BY id DESC', soDigitos(query.cpf));
  if (!dev && query.numero) {
    const n = soDigitos(query.numero);
    dev = get(`SELECT d.id FROM telefones t JOIN devedores d ON d.id = t.devedor_id
      WHERE t.numero = ? OR t.numero = ? ORDER BY d.status IN ('ABERTO','SEM_CONTATO') DESC, d.id DESC`, n, n.replace(/^55/, ''));
  }
  if (!dev) falha(404, 'Devedor não encontrado.');
  popsPendentes.set(String(query.ramal), { devedor_id: dev.id, numero: soDigitos(query.numero), ts: Date.now() });
  return { ok: true, devedor_id: dev.id };
});

rota('GET', '/api/operador/pop', [], ({ user }) => {
  if (!user.ramal) return { devedor_id: null };
  const pop = popsPendentes.get(String(user.ramal));
  if (!pop || Date.now() - pop.ts > 60000) return { devedor_id: null };
  popsPendentes.delete(String(user.ramal));
  run('UPDATE devedores SET lock_usuario_id = NULL, lock_ate = NULL WHERE lock_usuario_id = ?', user.id);
  run('UPDATE devedores SET lock_usuario_id = ?, lock_ate = ? WHERE id = ?',
    user.id, agoraISO(new Date(Date.now() + 15 * 60000)), pop.devedor_id);
  return pop;
});

// ---------------------------------------------------------------- dashboard (supervisão)
rota('GET', '/api/dashboard', SUP, ({ query }) => {
  const [ini, fim] = intervaloDatas(query);
  const dIni = ini.slice(0, 10);
  const dFim = fim.slice(0, 10);
  const cpcIn = placeholders(TIPOS_CPC);

  const totais = {
    ...get(`SELECT COUNT(*) AS acionamentos,
        COALESCE(SUM(CASE WHEN t.tipo IN (${cpcIn}) THEN 1 ELSE 0 END), 0) AS cpc,
        COALESCE(SUM(CASE WHEN t.tipo = 'SEM_CONTATO' THEN 1 ELSE 0 END), 0) AS sem_contato,
        COUNT(DISTINCT a.devedor_id) AS devedores_trabalhados
      FROM acionamentos a JOIN tabulacoes t ON t.id = a.tabulacao_id WHERE a.criado_em BETWEEN ? AND ?`, ...TIPOS_CPC, ini, fim),
    ...get(`SELECT COUNT(*) AS acordos, COALESCE(SUM(valor_acordo), 0) AS valor_acordos
      FROM acordos WHERE criado_em BETWEEN ? AND ? AND status <> 'CANCELADO'`, ini, fim),
    ...get(`SELECT COALESCE(SUM(valor_pago), 0) AS recebido, COUNT(*) AS parcelas_pagas
      FROM parcelas WHERE status = 'PAGA' AND pago_em BETWEEN ? AND ?`, dIni, dFim),
    ...get(`SELECT COALESCE(SUM(valor), 0) AS a_receber FROM parcelas p JOIN acordos a ON a.id = p.acordo_id
      WHERE p.status = 'ABERTA' AND a.status = 'ATIVO' AND p.vencimento BETWEEN ? AND ?`, dIni, dFim),
  };

  const agora = Date.now();
  const acordosPorOp = new Map(all(`SELECT usuario_id, COUNT(*) AS n, SUM(valor_acordo) AS valor FROM acordos
    WHERE criado_em BETWEEN ? AND ? AND status <> 'CANCELADO' GROUP BY usuario_id`, ini, fim).map((r) => [r.usuario_id, r]));
  const emAtendimento = new Map(all(`SELECT lock_usuario_id, nome FROM devedores
    WHERE lock_usuario_id IS NOT NULL AND lock_ate > ?`, agoraISO()).map((r) => [r.lock_usuario_id, r.nome]));
  const operadores = all(`
    SELECT u.id, u.nome, u.login, u.ramal, u.perfil,
      COUNT(a.id) AS acionamentos,
      COALESCE(SUM(CASE WHEN t.tipo IN (${cpcIn}) THEN 1 ELSE 0 END), 0) AS cpc,
      COALESCE(SUM(CASE WHEN t.tipo = 'SEM_CONTATO' THEN 1 ELSE 0 END), 0) AS sem_contato,
      COALESCE(SUM(a.duracao_seg), 0) AS tempo_total,
      MIN(a.criado_em) AS primeiro, MAX(a.criado_em) AS ultimo
    FROM usuarios u
    LEFT JOIN acionamentos a ON a.usuario_id = u.id AND a.criado_em BETWEEN ? AND ?
    LEFT JOIN tabulacoes t ON t.id = a.tabulacao_id
    WHERE u.ativo = 1 AND u.perfil IN ('operador', 'supervisor')
    GROUP BY u.id ORDER BY acionamentos DESC, u.nome`, ...TIPOS_CPC, ini, fim).map((o) => ({
    ...o,
    online: agora - (ultimoVisto.get(o.id) || 0) < 90000,
    em_atendimento: emAtendimento.get(o.id) || null,
    acordos: acordosPorOp.get(o.id)?.n || 0,
    valor_acordos: r2(acordosPorOp.get(o.id)?.valor || 0),
  }));

  const carteiras = all(`
    SELECT c.id, c.nome, c.credor,
      COUNT(d.id) AS devedores,
      COALESCE(SUM(CASE WHEN d.status IN ('ABERTO','SEM_CONTATO') THEN 1 ELSE 0 END), 0) AS em_aberto,
      COALESCE(SUM(CASE WHEN d.status = 'EM_ACORDO' THEN 1 ELSE 0 END), 0) AS em_acordo,
      COALESCE(SUM(CASE WHEN d.status = 'QUITADO' THEN 1 ELSE 0 END), 0) AS quitados,
      COALESCE(SUM(CASE WHEN d.tentativas = 0 AND d.status IN ('ABERTO','SEM_CONTATO') THEN 1 ELSE 0 END), 0) AS virgens,
      (SELECT COALESCE(SUM(v.valor_original), 0) FROM dividas v JOIN devedores dd ON dd.id = v.devedor_id
        WHERE dd.carteira_id = c.id AND v.status = 'ABERTA') AS valor_aberto
    FROM carteiras c LEFT JOIN devedores d ON d.carteira_id = c.id
    WHERE c.ativa = 1 GROUP BY c.id ORDER BY c.nome`);

  const tabulacoes = all(`SELECT t.descricao, t.tipo, COUNT(*) AS qtd FROM acionamentos a JOIN tabulacoes t ON t.id = a.tabulacao_id
    WHERE a.criado_em BETWEEN ? AND ? GROUP BY t.id ORDER BY qtd DESC`, ini, fim);

  const porHora = all(`SELECT CAST(strftime('%H', criado_em) AS INTEGER) AS hora, COUNT(*) AS qtd FROM acionamentos
    WHERE criado_em BETWEEN ? AND ? GROUP BY hora ORDER BY hora`, ini, fim);

  return { periodo: { ini: dIni, fim: dFim }, totais, operadores, carteiras, tabulacoes, por_hora: porHora };
});

// ---------------------------------------------------------------- relatórios CSV
const RELATORIOS = {
  acionamentos: (q, [ini, fim]) => ({
    linhas: all(`SELECT a.criado_em, u.nome AS operador, c.nome AS carteira, d.cpf_cnpj, d.nome, f.numero AS telefone,
        t.codigo, t.descricao AS tabulacao, t.tipo, a.observacao, a.data_agendamento, a.duracao_seg
      FROM acionamentos a JOIN usuarios u ON u.id = a.usuario_id JOIN devedores d ON d.id = a.devedor_id
      JOIN carteiras c ON c.id = d.carteira_id JOIN tabulacoes t ON t.id = a.tabulacao_id
      LEFT JOIN telefones f ON f.id = a.telefone_id
      WHERE a.criado_em BETWEEN ? AND ? AND (? IS NULL OR d.carteira_id = ?) ORDER BY a.id`,
    ini, fim, inteiro(q.carteira_id), inteiro(q.carteira_id)),
    colunas: [
      { titulo: 'Data/Hora', campo: 'criado_em' }, { titulo: 'Operador', campo: 'operador' },
      { titulo: 'Carteira', campo: 'carteira' }, { titulo: 'CPF/CNPJ', campo: 'cpf_cnpj' }, { titulo: 'Nome', campo: 'nome' },
      { titulo: 'Telefone', campo: 'telefone' }, { titulo: 'Código', campo: 'codigo' }, { titulo: 'Tabulação', campo: 'tabulacao' },
      { titulo: 'Tipo', campo: 'tipo' }, { titulo: 'Observação', campo: 'observacao' },
      { titulo: 'Agendamento', campo: 'data_agendamento' }, { titulo: 'Duração (s)', campo: 'duracao_seg' },
    ],
  }),
  acordos: (q, [ini, fim]) => ({
    linhas: all(`SELECT a.*, u.nome AS operador, c.nome AS carteira, d.cpf_cnpj, d.nome,
        (SELECT COALESCE(SUM(valor_pago), 0) FROM parcelas p WHERE p.acordo_id = a.id AND p.status = 'PAGA') AS valor_pago
      FROM acordos a JOIN usuarios u ON u.id = a.usuario_id JOIN devedores d ON d.id = a.devedor_id
      JOIN carteiras c ON c.id = d.carteira_id
      WHERE a.criado_em BETWEEN ? AND ? AND (? IS NULL OR d.carteira_id = ?) ORDER BY a.id`,
    ini, fim, inteiro(q.carteira_id), inteiro(q.carteira_id)),
    colunas: [
      { titulo: 'Acordo', campo: 'id' }, { titulo: 'Data', campo: 'criado_em' }, { titulo: 'Operador', campo: 'operador' },
      { titulo: 'Carteira', campo: 'carteira' }, { titulo: 'CPF/CNPJ', campo: 'cpf_cnpj' }, { titulo: 'Nome', campo: 'nome' },
      { titulo: 'Valor dívida', campo: 'valor_divida', decimal: true }, { titulo: 'Desconto %', campo: 'desconto_pct' },
      { titulo: 'Valor acordo', campo: 'valor_acordo', decimal: true }, { titulo: 'Parcelas', campo: 'qtd_parcelas' },
      { titulo: 'Status', campo: 'status' }, { titulo: 'Valor pago', campo: 'valor_pago', decimal: true },
    ],
  }),
  parcelas: (q, [, , ini, fim]) => ({
    linhas: all(`SELECT p.*, a.status AS status_acordo, d.cpf_cnpj, d.nome, c.nome AS carteira, u.nome AS operador
      FROM parcelas p JOIN acordos a ON a.id = p.acordo_id JOIN devedores d ON d.id = a.devedor_id
      JOIN carteiras c ON c.id = d.carteira_id JOIN usuarios u ON u.id = a.usuario_id
      WHERE p.vencimento BETWEEN ? AND ? AND (? IS NULL OR d.carteira_id = ?) ORDER BY p.vencimento`,
    ini, fim, inteiro(q.carteira_id), inteiro(q.carteira_id)),
    colunas: [
      { titulo: 'Acordo', campo: 'acordo_id' }, { titulo: 'Parcela', campo: 'numero' }, { titulo: 'Vencimento', campo: 'vencimento' },
      { titulo: 'Valor', campo: 'valor', decimal: true }, { titulo: 'Status', campo: 'status' },
      { titulo: 'Pago em', campo: 'pago_em' }, { titulo: 'Valor pago', campo: 'valor_pago', decimal: true },
      { titulo: 'Status acordo', campo: 'status_acordo' }, { titulo: 'Carteira', campo: 'carteira' },
      { titulo: 'CPF/CNPJ', campo: 'cpf_cnpj' }, { titulo: 'Nome', campo: 'nome' }, { titulo: 'Operador', campo: 'operador' },
    ],
  }),
  produtividade: (q, [ini, fim, dIni, dFim]) => ({
    linhas: all(`SELECT u.nome, u.login,
        (SELECT COUNT(*) FROM acionamentos a WHERE a.usuario_id = u.id AND a.criado_em BETWEEN ? AND ?) AS acionamentos,
        (SELECT COUNT(*) FROM acionamentos a JOIN tabulacoes t ON t.id = a.tabulacao_id WHERE a.usuario_id = u.id
          AND a.criado_em BETWEEN ? AND ? AND t.tipo IN ('CPC','PROMESSA','ACORDO','RECUSA')) AS cpc,
        (SELECT COUNT(*) FROM acordos a WHERE a.usuario_id = u.id AND a.criado_em BETWEEN ? AND ? AND a.status <> 'CANCELADO') AS acordos,
        (SELECT COALESCE(SUM(valor_acordo), 0) FROM acordos a WHERE a.usuario_id = u.id AND a.criado_em BETWEEN ? AND ? AND a.status <> 'CANCELADO') AS valor_acordos,
        (SELECT COALESCE(SUM(p.valor_pago), 0) FROM parcelas p JOIN acordos a ON a.id = p.acordo_id
          WHERE a.usuario_id = u.id AND p.status = 'PAGA' AND p.pago_em BETWEEN ? AND ?) AS recebido
      FROM usuarios u WHERE u.perfil IN ('operador','supervisor') ORDER BY acionamentos DESC`,
    ini, fim, ini, fim, ini, fim, ini, fim, dIni, dFim),
    colunas: [
      { titulo: 'Operador', campo: 'nome' }, { titulo: 'Login', campo: 'login' }, { titulo: 'Acionamentos', campo: 'acionamentos' },
      { titulo: 'CPC', campo: 'cpc' }, { titulo: 'Acordos', campo: 'acordos' },
      { titulo: 'Valor acordos', campo: 'valor_acordos', decimal: true }, { titulo: 'Recebido', campo: 'recebido', decimal: true },
    ],
  }),
};

rota('GET', '/api/relatorios/:tipo', SUP, ({ params, query, res }) => {
  const gerar = RELATORIOS[params.tipo];
  if (!gerar) falha(404, 'Relatório inexistente.');
  const { linhas, colunas } = gerar(query, intervaloDatas(query));
  enviarCsv(res, `${params.tipo}_${hojeISO()}.csv`, toCsv(linhas, colunas));
});

// ---------------------------------------------------------------- carteiras
rota('GET', '/api/carteiras', SUP, () => all(`
  SELECT c.*,
    (SELECT COUNT(*) FROM devedores d WHERE d.carteira_id = c.id) AS devedores,
    (SELECT COUNT(*) FROM devedores d WHERE d.carteira_id = c.id AND d.status IN ('ABERTO','SEM_CONTATO')) AS em_aberto,
    (SELECT COUNT(*) FROM devedores d WHERE d.carteira_id = c.id AND d.operador_id IS NOT NULL
       AND d.status IN ('ABERTO','SEM_CONTATO')) AS distribuidos
  FROM carteiras c ORDER BY c.ativa DESC, c.nome`));

function dadosCarteira(b) {
  const nome = String(b.nome || '').trim();
  const credor = String(b.credor || '').trim();
  if (!nome || !credor) falha(400, 'Informe nome e credor.');
  const num = (v, pad) => (v === '' || v == null ? pad : Number(v));
  return [nome, credor, b.cnpj, num(b.juros_mes, 1), num(b.multa, 2), num(b.honorarios, 10), num(b.desconto_max, 30),
    num(b.parcelas_max, 12), num(b.entrada_min_pct, 10), b.ativa === undefined ? 1 : (b.ativa ? 1 : 0)];
}

rota('POST', '/api/carteiras', ADM, ({ body }) => {
  const id = run(`INSERT INTO carteiras (nome, credor, cnpj, juros_mes, multa, honorarios, desconto_max, parcelas_max, entrada_min_pct, ativa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...dadosCarteira(body)).id;
  return { id };
});

rota('PUT', '/api/carteiras/:id', ADM, ({ params, body }) => {
  run(`UPDATE carteiras SET nome = ?, credor = ?, cnpj = ?, juros_mes = ?, multa = ?, honorarios = ?, desconto_max = ?,
    parcelas_max = ?, entrada_min_pct = ?, ativa = ? WHERE id = ?`, ...dadosCarteira(body), params.id);
  return { ok: true };
});

const pegar = (linha, ...nomes) => {
  for (const n of nomes) if (linha[n]) return linha[n];
  return '';
};

rota('POST', '/api/carteiras/:id/importar', ADM, ({ params, body }) => {
  const carteira = get('SELECT * FROM carteiras WHERE id = ?', params.id);
  if (!carteira) falha(404, 'Carteira não encontrada.');
  const linhas = parseCsv(body.csv || '');
  if (!linhas.length) falha(400, 'Arquivo vazio ou sem cabeçalho.');

  const r = { linhas: linhas.length, devedores_novos: 0, dividas_novas: 0, dividas_duplicadas: 0, telefones_novos: 0, erros: [] };
  tx(() => {
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

      let dev = get('SELECT id FROM devedores WHERE carteira_id = ? AND cpf_cnpj = ?', carteira.id, doc);
      if (!dev) {
        dev = { id: run(`INSERT INTO devedores (carteira_id, cpf_cnpj, nome, data_nasc, email, endereco, cidade, uf, cep)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, carteira.id, doc, nome,
        parseData(pegar(l, 'data_nasc', 'nascimento', 'data_nascimento')), pegar(l, 'email', 'e-mail'),
        pegar(l, 'endereco', 'logradouro'), pegar(l, 'cidade', 'municipio'), pegar(l, 'uf', 'estado').toUpperCase().slice(0, 2),
        pegar(l, 'cep')).id };
        r.devedores_novos++;
      }
      for (const [k, v] of Object.entries(l)) {
        if (!/^(telefone|fone|celular|tel)_?\d*$/.test(k)) continue;
        const numero = soDigitos(v).replace(/^55(?=\d{10,11}$)/, '');
        if (numero.length < 10 || numero.length > 11) continue;
        const tipo = k.startsWith('celular') || numero[2] === '9' ? 'CELULAR' : 'FIXO';
        r.telefones_novos += run('INSERT OR IGNORE INTO telefones (devedor_id, numero, tipo) VALUES (?, ?, ?)', dev.id, numero, tipo).changes;
      }
      const contrato = pegar(l, 'contrato', 'numero_contrato', 'titulo', 'documento_divida');
      if (contrato && get('SELECT 1 FROM dividas WHERE devedor_id = ? AND contrato = ? AND vencimento = ?', dev.id, contrato, venc)) {
        r.dividas_duplicadas++;
        return;
      }
      run('INSERT INTO dividas (devedor_id, contrato, descricao, valor_original, vencimento) VALUES (?, ?, ?, ?, ?)',
        dev.id, contrato, pegar(l, 'descricao', 'produto'), r2(valor), venc);
      r.dividas_novas++;
      if (get('SELECT status FROM devedores WHERE id = ?', dev.id).status === 'QUITADO') {
        run("UPDATE devedores SET status = 'ABERTO' WHERE id = ?", dev.id);
      }
    });
  });
  if (r.erros.length > 200) r.erros = [...r.erros.slice(0, 200), `... e mais ${r.erros.length - 200} erros.`];
  return r;
});

rota('POST', '/api/carteiras/:id/distribuir', SUP, ({ params, body }) => {
  const carteiraId = inteiro(params.id);
  if (body.liberar) {
    const n = run(`UPDATE devedores SET operador_id = NULL WHERE carteira_id = ? AND status IN ('ABERTO','SEM_CONTATO')`, carteiraId).changes;
    return { ok: true, afetados: n };
  }
  const ops = (body.usuario_ids || []).map(inteiro).filter(Boolean);
  if (!ops.length) falha(400, 'Selecione ao menos um operador.');
  const devs = all(`SELECT id FROM devedores WHERE carteira_id = ? AND status IN ('ABERTO','SEM_CONTATO')
    ${body.somente_livres ? 'AND operador_id IS NULL' : ''} ORDER BY id`, carteiraId);
  tx(() => devs.forEach((d, i) => run('UPDATE devedores SET operador_id = ? WHERE id = ?', ops[i % ops.length], d.id)));
  return { ok: true, afetados: devs.length };
});

rota('GET', '/api/carteiras/:id/mailing', SUP, ({ params, res }) => {
  const linhas = all(`SELECT d.id, d.cpf_cnpj, d.nome, t.numero, t.tipo, t.status
    FROM devedores d JOIN telefones t ON t.devedor_id = d.id
    WHERE d.carteira_id = ? AND d.status IN ('ABERTO','SEM_CONTATO') AND t.status <> 'INVALIDO'
      AND (d.proximo_contato IS NULL OR d.proximo_contato <= ?)
    ORDER BY d.tentativas, d.id, CASE t.status WHEN 'CPC' THEN 0 ELSE 1 END`, inteiro(params.id), agoraISO());
  enviarCsv(res, `mailing_carteira_${params.id}_${hojeISO()}.csv`, toCsv(linhas, [
    { titulo: 'devedor_id', campo: 'id' }, { titulo: 'cpf', campo: 'cpf_cnpj' }, { titulo: 'nome', campo: 'nome' },
    { titulo: 'telefone', campo: 'numero' }, { titulo: 'tipo', campo: 'tipo' }, { titulo: 'status_telefone', campo: 'status' },
  ]));
});

// ---------------------------------------------------------------- usuários
rota('GET', '/api/usuarios', SUP, () => {
  const us = all('SELECT id, nome, login, perfil, ramal, ativo, ultimo_acesso, criado_em FROM usuarios ORDER BY ativo DESC, perfil, nome');
  const vinc = all('SELECT * FROM usuario_carteiras');
  return us.map((u) => ({ ...u, carteiras: vinc.filter((v) => v.usuario_id === u.id).map((v) => v.carteira_id) }));
});

function salvarVinculos(usuarioId, carteiras) {
  run('DELETE FROM usuario_carteiras WHERE usuario_id = ?', usuarioId);
  for (const c of (carteiras || []).map(inteiro).filter(Boolean)) {
    run('INSERT OR IGNORE INTO usuario_carteiras (usuario_id, carteira_id) VALUES (?, ?)', usuarioId, c);
  }
}

rota('POST', '/api/usuarios', ADM, ({ body }) => {
  const login = String(body.login || '').trim().toLowerCase();
  if (!body.nome || !login || !body.senha) falha(400, 'Informe nome, login e senha.');
  if (String(body.senha).length < 6) falha(400, 'A senha deve ter ao menos 6 caracteres.');
  if (!['admin', 'supervisor', 'operador'].includes(body.perfil)) falha(400, 'Perfil inválido.');
  if (get('SELECT 1 FROM usuarios WHERE login = ?', login)) falha(400, 'Login já existe.');
  const id = tx(() => {
    const novo = run('INSERT INTO usuarios (nome, login, senha_hash, perfil, ramal, ativo) VALUES (?, ?, ?, ?, ?, ?)',
      body.nome, login, hashSenha(body.senha), body.perfil, body.ramal, body.ativo === false ? 0 : 1).id;
    salvarVinculos(novo, body.carteiras);
    return novo;
  });
  return { id };
});

rota('PUT', '/api/usuarios/:id', ADM, ({ params, body, user }) => {
  const alvo = get('SELECT * FROM usuarios WHERE id = ?', params.id);
  if (!alvo) falha(404, 'Usuário não encontrado.');
  if (!['admin', 'supervisor', 'operador'].includes(body.perfil)) falha(400, 'Perfil inválido.');
  if (alvo.id === user.id && (body.perfil !== 'admin' || body.ativo === false)) {
    falha(400, 'Você não pode remover seu próprio acesso de administrador.');
  }
  if (body.senha && String(body.senha).length < 6) falha(400, 'A senha deve ter ao menos 6 caracteres.');
  tx(() => {
    run('UPDATE usuarios SET nome = ?, perfil = ?, ramal = ?, ativo = ? WHERE id = ?',
      body.nome || alvo.nome, body.perfil, body.ramal, body.ativo === false ? 0 : 1, alvo.id);
    if (body.senha) run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', hashSenha(body.senha), alvo.id);
    if (body.ativo === false) run('DELETE FROM sessoes WHERE usuario_id = ?', alvo.id);
    salvarVinculos(alvo.id, body.carteiras);
  });
  return { ok: true };
});

rota('POST', '/api/minha-senha', [], ({ user, body }) => {
  if (!verificarSenha(body.atual || '', user.senha_hash)) falha(400, 'Senha atual incorreta.');
  if (String(body.nova || '').length < 6) falha(400, 'A nova senha deve ter ao menos 6 caracteres.');
  run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', hashSenha(body.nova), user.id);
  return { ok: true };
});

// ---------------------------------------------------------------- tabulações
rota('GET', '/api/tabulacoes', ADM, () => all('SELECT * FROM tabulacoes ORDER BY ativa DESC, tipo, descricao'));

function dadosTabulacao(b) {
  const codigo = String(b.codigo || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (!codigo || !b.descricao) falha(400, 'Informe código e descrição.');
  if (!['SEM_CONTATO', 'CONTATO', 'CPC', 'PROMESSA', 'ACORDO', 'RECUSA'].includes(b.tipo)) falha(400, 'Tipo inválido.');
  return [codigo, b.descricao, b.tipo, b.exige_agendamento ? 1 : 0, b.invalida_telefone ? 1 : 0, b.finaliza ? 1 : 0,
    b.ativa === false ? 0 : 1];
}

rota('POST', '/api/tabulacoes', ADM, ({ body }) => {
  const d = dadosTabulacao(body);
  if (get('SELECT 1 FROM tabulacoes WHERE codigo = ?', d[0])) falha(400, 'Código já existe.');
  return { id: run(`INSERT INTO tabulacoes (codigo, descricao, tipo, exige_agendamento, invalida_telefone, finaliza, ativa)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, ...d).id };
});

rota('PUT', '/api/tabulacoes/:id', ADM, ({ params, body }) => {
  run(`UPDATE tabulacoes SET codigo = ?, descricao = ?, tipo = ?, exige_agendamento = ?, invalida_telefone = ?, finaliza = ?, ativa = ?
    WHERE id = ?`, ...dadosTabulacao(body), params.id);
  return { ok: true };
});

// ---------------------------------------------------------------- configurações
const CHAVES_CONFIG = ['empresa_nome', 'discador_modo', 'discador_url', 'discador_api_key',
  'reciclagem_sem_contato_horas', 'reciclagem_contato_horas', 'lock_minutos'];

rota('GET', '/api/config', ADM, () => getConfig());

rota('PUT', '/api/config', ADM, ({ body }) => {
  tx(() => {
    for (const k of CHAVES_CONFIG) {
      if (body[k] !== undefined) run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)', k, String(body[k]));
    }
  });
  return { ok: true };
});

// ---------------------------------------------------------------- HTTP
function enviarJson(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function enviarCsv(res, nome, conteudo) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${nome}"`,
    'Cache-Control': 'no-store',
  });
  res.end(conteudo);
}

function lerCorpo(req, limite = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) { reject(new HttpError(413, 'Arquivo muito grande.')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      const txt = Buffer.concat(partes).toString('utf8');
      if (!txt) return resolve({});
      try { resolve(JSON.parse(txt)); } catch { reject(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function lerCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
  }));
}

function autenticar(req) {
  const token = lerCookies(req).sid;
  if (!token) return {};
  const s = get(`SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1`, token, agoraISO());
  if (!s) return {};
  const agora = Date.now();
  const anterior = ultimoVisto.get(s.id) || 0;
  ultimoVisto.set(s.id, agora);
  if (agora - anterior > 60000) run('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?', agoraISO(), s.id);
  return { user: s, token };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
};

function servirEstatico(req, res, pathname) {
  let arquivo = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!arquivo.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) arquivo = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(arquivo).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return servirEstatico(req, res, url.pathname);

  try {
    const r = rotas.find((x) => x.metodo === req.method && x.re.test(url.pathname));
    if (!r) falha(404, 'Rota não encontrada.');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.chaves.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const { user, token } = autenticar(req);
    if (r.perfis !== null) {
      if (!user) falha(401, 'Não autenticado.');
      if (r.perfis.length && !r.perfis.includes(user.perfil)) falha(403, 'Sem permissão.');
    }
    const body = ['POST', 'PUT'].includes(req.method) ? await lerCorpo(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const out = await r.handler({ req, res, user, token, params, query, body });
    if (!res.headersSent) enviarJson(res, 200, out ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return enviarJson(res, e.status, { erro: e.message });
    console.error(e);
    enviarJson(res, 500, { erro: 'Erro interno no servidor.' });
  }
});

servidor.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  VirtuaNosso - CRM de Cobrança');
  console.log(`  Local:      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Na rede:    http://${ip}:${PORT}   (use este nos PCs dos operadores)`);
  console.log('\n  Logins de teste: admin/admin123 | supervisor/super123 | operador1/123456\n');
});

const encerrar = () => { servidor.close(); db.close(); process.exit(0); };
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
