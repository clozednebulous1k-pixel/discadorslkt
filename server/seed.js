import crypto from 'node:crypto';
import { fs, C, hashSenha, gravarEmLotes } from './firebase.js';
import { agoraISO } from './cobranca.js';
import { novoDevedor, novoId, idDevedor } from './devedor.js';

export const CONFIG_PADRAO = {
  empresa_nome: 'Minha Assessoria de Cobrança',
  discador_modo: 'tel',
  discador_url: 'http://127.0.0.1:8080/api/discar?ramal={ramal}&numero={numero}',
  discador_api_key: crypto.randomBytes(12).toString('hex'),
  reciclagem_sem_contato_horas: '2',
  reciclagem_contato_horas: '24',
  lock_minutos: '15',
};

const TABULACOES = [
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

const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João',
  'Karina', 'Lucas', 'Mariana', 'Nicolas', 'Olívia', 'Paulo', 'Rafaela', 'Samuel', 'Tatiane', 'Vinícius',
  'Aline', 'Marcos', 'Patrícia', 'Ricardo', 'Sandra', 'Thiago', 'Juliana', 'Fernando', 'Camila', 'Rodrigo'];
const SOBRENOMES = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima',
  'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Lopes', 'Soares', 'Fernandes', 'Vieira', 'Barbosa'];
const CIDADES = [['São Paulo', 'SP', '11'], ['Campinas', 'SP', '19'], ['Rio de Janeiro', 'RJ', '21'],
  ['Belo Horizonte', 'MG', '31'], ['Curitiba', 'PR', '41'], ['Porto Alegre', 'RS', '51'], ['Salvador', 'BA', '71'],
  ['Recife', 'PE', '81'], ['Goiânia', 'GO', '62'], ['Fortaleza', 'CE', '85']];

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
  return agoraISO(dt).slice(0, 10);
}

async function popular() {
  const ops = [];
  for (const [codigo, descricao, tipo, ag, inv, fin] of TABULACOES) {
    ops.push((b) => b.set(C('tabulacoes').doc(novoId()), {
      codigo, descricao, tipo, exige_agendamento: !!ag, invalida_telefone: !!inv, finaliza: !!fin, ativa: true,
    }));
  }
  const usuario = (nome, login, senha, perfil, ramal = null) => ops.push((b) => b.set(C('usuarios').doc(novoId()), {
    nome, login, senha_hash: hashSenha(senha), perfil, ramal, ativo: true, carteiras: [],
    ultimo_acesso: null, atendendo: null, criado_em: agoraISO(),
  }));
  usuario('Administrador', 'admin', 'admin123', 'admin');
  usuario('Supervisora Demo', 'supervisor', 'super123', 'supervisor');
  for (let i = 1; i <= 3; i++) usuario(`Operador ${i}`, `operador${i}`, '123456', 'operador', String(1000 + i));

  const carteiras = [
    { id: novoId(), nome: 'Cartão de Crédito - Banco Demo', credor: 'Banco Demo S.A.', cnpj: '00.000.000/0001-00',
      juros_mes: 2, multa: 2, honorarios: 10, desconto_max: 50, parcelas_max: 18, entrada_min_pct: 10, prefixo: 'CC', desc: 'Fatura cartão de crédito' },
    { id: novoId(), nome: 'Mensalidades - Escola Demo', credor: 'Colégio Demo Ltda', cnpj: '11.111.111/0001-11',
      juros_mes: 1, multa: 2, honorarios: 10, desconto_max: 20, parcelas_max: 6, entrada_min_pct: 20, prefixo: 'MEN', desc: 'Mensalidade escolar' },
  ];
  for (const { id, prefixo, desc, ...c } of carteiras) {
    ops.push((b) => b.set(C('carteiras').doc(id), { ...c, ativa: true, criado_em: agoraISO() }));
  }

  for (let i = 0; i < 120; i++) {
    const cart = carteiras[i % 2];
    const [cidade, uf, ddd] = pick(CIDADES);
    const nome = `${pick(NOMES)} ${pick(SOBRENOMES)} ${pick(SOBRENOMES)}`;
    const cpf = gerarCpf();
    const telefones = Array.from({ length: rnd(1, 3) }, (_, f) => ({
      id: novoId(),
      numero: f === 2 ? `${ddd}3${rnd(1000000, 9999999)}` : `${ddd}9${rnd(10000000, 99999999)}`,
      tipo: f === 2 ? 'FIXO' : 'CELULAR',
      status: 'ATIVO',
    }));
    const dividas = Array.from({ length: rnd(1, 3) }, () => ({
      id: novoId(),
      contrato: `${cart.prefixo}${rnd(100000, 999999)}`,
      descricao: cart.desc,
      valor_original: cart.prefixo === 'CC' ? rnd(300, 9000) + rnd(0, 99) / 100 : rnd(400, 1800),
      vencimento: diasAtras(rnd(20, 900)),
      status: 'ABERTA',
      acordo_id: null,
    }));
    const dev = novoDevedor({
      carteira_id: cart.id, cpf_cnpj: cpf, nome, data_nasc: diasAtras(rnd(365 * 20, 365 * 65)),
      email: `${nome.split(' ')[0].toLowerCase()}${rnd(10, 999)}@email.com`,
      endereco: `Rua ${pick(SOBRENOMES)}, ${rnd(10, 2000)}`, cidade, uf, cep: `${rnd(10000, 99999)}-${rnd(100, 999)}`,
      telefones, dividas,
    });
    ops.push((b) => b.set(C('devedores').doc(idDevedor(cart.id, cpf)), dev));
  }
  await gravarEmLotes(ops);
}

let inicializacao = null;

/** Cria configuração e dados de demonstração na primeira execução (uma única instância faz isso). */
export function garantirInicializado() {
  if (!inicializacao) {
    inicializacao = (async () => {
      const cfgRef = C('config').doc('geral');
      if ((await cfgRef.get()).exists) return;
      try {
        await C('config').doc('_inicializando').create({ em: agoraISO() });
      } catch {
        return; // outra instância já está criando os dados
      }
      await popular();
      await cfgRef.set(CONFIG_PADRAO);
      console.log('Firestore inicializado com dados de demonstração.');
    })().catch((e) => { inicializacao = null; throw e; });
  }
  return inicializacao;
}

export { fs };
