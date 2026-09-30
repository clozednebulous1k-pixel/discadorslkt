import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'virtua.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','supervisor','operador')),
  ramal TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carteiras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  credor TEXT NOT NULL,
  cnpj TEXT,
  juros_mes REAL NOT NULL DEFAULT 1,
  multa REAL NOT NULL DEFAULT 2,
  honorarios REAL NOT NULL DEFAULT 10,
  desconto_max REAL NOT NULL DEFAULT 30,
  parcelas_max INTEGER NOT NULL DEFAULT 12,
  entrada_min_pct REAL NOT NULL DEFAULT 10,
  ativa INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS usuario_carteiras (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  carteira_id INTEGER NOT NULL REFERENCES carteiras(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, carteira_id)
);

CREATE TABLE IF NOT EXISTS devedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carteira_id INTEGER NOT NULL REFERENCES carteiras(id),
  cpf_cnpj TEXT NOT NULL,
  nome TEXT NOT NULL,
  data_nasc TEXT,
  email TEXT,
  endereco TEXT,
  cidade TEXT,
  uf TEXT,
  cep TEXT,
  observacao TEXT,
  status TEXT NOT NULL DEFAULT 'ABERTO'
    CHECK (status IN ('ABERTO','SEM_CONTATO','EM_ACORDO','QUITADO','ENCERRADO')),
  operador_id INTEGER REFERENCES usuarios(id),
  proximo_contato TEXT,
  ultimo_acionamento TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  lock_usuario_id INTEGER,
  lock_ate TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (carteira_id, cpf_cnpj)
);
CREATE INDEX IF NOT EXISTS ix_devedores_fila ON devedores (status, proximo_contato);
CREATE INDEX IF NOT EXISTS ix_devedores_cpf ON devedores (cpf_cnpj);
CREATE INDEX IF NOT EXISTS ix_devedores_nome ON devedores (nome);

CREATE TABLE IF NOT EXISTS telefones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  devedor_id INTEGER NOT NULL REFERENCES devedores(id) ON DELETE CASCADE,
  numero TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'CELULAR',
  status TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','CPC','INVALIDO')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (devedor_id, numero)
);
CREATE INDEX IF NOT EXISTS ix_telefones_numero ON telefones (numero);

CREATE TABLE IF NOT EXISTS dividas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  devedor_id INTEGER NOT NULL REFERENCES devedores(id) ON DELETE CASCADE,
  contrato TEXT,
  descricao TEXT,
  valor_original REAL NOT NULL,
  vencimento TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','EM_ACORDO','PAGA')),
  acordo_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_dividas_devedor ON dividas (devedor_id);
CREATE INDEX IF NOT EXISTS ix_dividas_contrato ON dividas (contrato);

CREATE TABLE IF NOT EXISTS tabulacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  descricao TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('SEM_CONTATO','CONTATO','CPC','PROMESSA','ACORDO','RECUSA')),
  exige_agendamento INTEGER NOT NULL DEFAULT 0,
  invalida_telefone INTEGER NOT NULL DEFAULT 0,
  finaliza INTEGER NOT NULL DEFAULT 0,
  ativa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS acionamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  devedor_id INTEGER NOT NULL REFERENCES devedores(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  telefone_id INTEGER REFERENCES telefones(id) ON DELETE SET NULL,
  tabulacao_id INTEGER NOT NULL REFERENCES tabulacoes(id),
  observacao TEXT,
  data_agendamento TEXT,
  duracao_seg INTEGER,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_acionamentos_data ON acionamentos (criado_em);
CREATE INDEX IF NOT EXISTS ix_acionamentos_devedor ON acionamentos (devedor_id);

CREATE TABLE IF NOT EXISTS acordos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  devedor_id INTEGER NOT NULL REFERENCES devedores(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  valor_divida REAL NOT NULL,
  desconto_pct REAL NOT NULL DEFAULT 0,
  valor_desconto REAL NOT NULL DEFAULT 0,
  valor_acordo REAL NOT NULL,
  qtd_parcelas INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','QUITADO','QUEBRADO','CANCELADO')),
  observacao TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_acordos_data ON acordos (criado_em);

CREATE TABLE IF NOT EXISTS parcelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  acordo_id INTEGER NOT NULL REFERENCES acordos(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  vencimento TEXT NOT NULL,
  valor REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','PAGA','CANCELADA')),
  pago_em TEXT,
  valor_pago REAL
);
CREATE INDEX IF NOT EXISTS ix_parcelas_acordo ON parcelas (acordo_id);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);
`);

const cacheStmts = new Map();
function stmt(sql) {
  let s = cacheStmts.get(sql);
  if (!s) {
    if (cacheStmts.size > 500) cacheStmts.clear();
    s = db.prepare(sql);
    cacheStmts.set(sql, s);
  }
  return s;
}

export function all(sql, ...params) {
  return stmt(sql).all(...params.map(nulo));
}
export function get(sql, ...params) {
  return stmt(sql).get(...params.map(nulo));
}
export function run(sql, ...params) {
  const r = stmt(sql).run(...params.map(nulo));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

function nulo(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verificarSenha(senha, armazenado) {
  const [salt, hash] = String(armazenado).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(senha), salt, 64);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}

export function getConfig() {
  const cfg = {};
  for (const r of all('SELECT chave, valor FROM config')) cfg[r.chave] = r.valor;
  return cfg;
}

const CONFIG_PADRAO = {
  empresa_nome: 'Minha Assessoria de Cobrança',
  discador_modo: 'tel',
  discador_url: 'http://127.0.0.1:8080/api/discar?ramal={ramal}&numero={numero}',
  discador_api_key: crypto.randomBytes(12).toString('hex'),
  reciclagem_sem_contato_horas: '2',
  reciclagem_contato_horas: '24',
  lock_minutos: '15',
};

const TABULACOES_PADRAO = [
  ['NAO_ATENDE', 'Não atende', 'SEM_CONTATO', 0, 0, 0],
  ['CAIXA_POSTAL', 'Caixa postal', 'SEM_CONTATO', 0, 0, 0],
  ['OCUPADO', 'Ocupado', 'SEM_CONTATO', 0, 0, 0],
  ['FONE_INEXISTENTE', 'Telefone inexistente / errado', 'SEM_CONTATO', 0, 1, 0],
  ['NAO_CONHECE', 'Terceiro não conhece o devedor', 'CONTATO', 0, 1, 0],
  ['RECADO', 'Recado com terceiro', 'CONTATO', 0, 0, 0],
  ['RETORNAR', 'Retornar ligação (agendado)', 'CONTATO', 1, 0, 0],
  ['CPC_SEM_PROPOSTA', 'Falou com o devedor - sem proposta', 'CPC', 0, 0, 0],
  ['RECUSA', 'Devedor recusa pagamento', 'RECUSA', 0, 0, 0],
  ['PROMESSA', 'Promessa de pagamento', 'PROMESSA', 1, 0, 0],
  ['ACORDO', 'Acordo formalizado', 'ACORDO', 0, 0, 0],
  ['JA_PAGOU', 'Alega já ter pago', 'CPC', 1, 0, 0],
  ['FALECIDO', 'Devedor falecido', 'CONTATO', 0, 0, 1],
];

function inicializar() {
  for (const [k, v] of Object.entries(CONFIG_PADRAO)) {
    run('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)', k, v);
  }
  if (get('SELECT COUNT(*) AS n FROM tabulacoes').n === 0) {
    for (const t of TABULACOES_PADRAO) {
      run(`INSERT INTO tabulacoes (codigo, descricao, tipo, exige_agendamento, invalida_telefone, finaliza)
           VALUES (?, ?, ?, ?, ?, ?)`, ...t);
    }
  }
  if (get('SELECT COUNT(*) AS n FROM usuarios').n === 0) {
    tx(seedDemonstracao);
    console.log('Banco criado com dados de demonstração.');
  }
}

// ---------- dados de demonstração ----------
const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João',
  'Karina', 'Lucas', 'Mariana', 'Nicolas', 'Olívia', 'Paulo', 'Rafaela', 'Samuel', 'Tatiane', 'Vinícius',
  'Aline', 'Marcos', 'Patrícia', 'Ricardo', 'Sandra', 'Thiago', 'Juliana', 'Fernando', 'Camila', 'Rodrigo'];
const SOBRENOMES = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima',
  'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Lopes', 'Soares', 'Fernandes', 'Vieira', 'Barbosa'];
const CIDADES = [['São Paulo', 'SP'], ['Campinas', 'SP'], ['Rio de Janeiro', 'RJ'], ['Belo Horizonte', 'MG'],
  ['Curitiba', 'PR'], ['Porto Alegre', 'RS'], ['Salvador', 'BA'], ['Recife', 'PE'], ['Goiânia', 'GO'], ['Fortaleza', 'CE']];
const DDDS = ['11', '19', '21', '31', '41', '51', '71', '81', '62', '85'];

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[rnd(0, arr.length - 1)];

function gerarCpf() {
  const n = Array.from({ length: 9 }, () => rnd(0, 9));
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += n[i] * (t + 1 - i);
    const d = (s * 10) % 11;
    n.push(d === 10 ? 0 : d);
  }
  return n.join('');
}

function diasAtras(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() - d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function seedDemonstracao() {
  run('INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES (?, ?, ?, ?)',
    'Administrador', 'admin', hashSenha('admin123'), 'admin');
  run('INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES (?, ?, ?, ?)',
    'Supervisora Demo', 'supervisor', hashSenha('super123'), 'supervisor');
  for (let i = 1; i <= 3; i++) {
    run('INSERT INTO usuarios (nome, login, senha_hash, perfil, ramal) VALUES (?, ?, ?, ?, ?)',
      `Operador ${i}`, `operador${i}`, hashSenha('123456'), 'operador', String(1000 + i));
  }

  const carteiras = [
    run(`INSERT INTO carteiras (nome, credor, cnpj, juros_mes, multa, honorarios, desconto_max, parcelas_max, entrada_min_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'Cartão de Crédito - Banco Demo', 'Banco Demo S.A.', '00.000.000/0001-00', 2, 2, 10, 50, 18, 10).id,
    run(`INSERT INTO carteiras (nome, credor, cnpj, juros_mes, multa, honorarios, desconto_max, parcelas_max, entrada_min_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'Mensalidades - Escola Demo', 'Colégio Demo Ltda', '11.111.111/0001-11', 1, 2, 10, 20, 6, 20).id,
  ];

  for (let i = 0; i < 120; i++) {
    const carteira = carteiras[i % 2];
    const [cidade, uf] = pick(CIDADES);
    const ddd = DDDS[CIDADES.findIndex((c) => c[0] === cidade)];
    const nome = `${pick(NOMES)} ${pick(SOBRENOMES)} ${pick(SOBRENOMES)}`;
    const dev = run(`INSERT OR IGNORE INTO devedores (carteira_id, cpf_cnpj, nome, data_nasc, email, endereco, cidade, uf, cep)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      carteira, gerarCpf(), nome, diasAtras(rnd(365 * 20, 365 * 65)),
      `${nome.split(' ')[0].toLowerCase()}${rnd(10, 999)}@email.com`,
      `Rua ${pick(SOBRENOMES)}, ${rnd(10, 2000)}`, cidade, uf, `${rnd(10000, 99999)}-${rnd(100, 999)}`);
    if (!dev.changes) continue;
    const qtdFones = rnd(1, 3);
    for (let f = 0; f < qtdFones; f++) {
      const numero = f === 2 ? `${ddd}3${rnd(1000000, 9999999)}` : `${ddd}9${rnd(10000000, 99999999)}`;
      run('INSERT OR IGNORE INTO telefones (devedor_id, numero, tipo) VALUES (?, ?, ?)',
        dev.id, numero, f === 2 ? 'FIXO' : 'CELULAR');
    }
    const qtdDiv = rnd(1, 3);
    for (let k = 0; k < qtdDiv; k++) {
      const valor = carteira === carteiras[0] ? rnd(300, 9000) + rnd(0, 99) / 100 : rnd(400, 1800);
      run('INSERT INTO dividas (devedor_id, contrato, descricao, valor_original, vencimento) VALUES (?, ?, ?, ?, ?)',
        dev.id, `${carteira === carteiras[0] ? 'CC' : 'MEN'}${rnd(100000, 999999)}`,
        carteira === carteiras[0] ? 'Fatura cartão de crédito' : 'Mensalidade escolar',
        valor, diasAtras(rnd(20, 900)));
    }
  }
}

inicializar();
