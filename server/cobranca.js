export const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

export function hojeISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function agoraISO(d = new Date()) {
  return `${hojeISO(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function addMeses(dataISO, meses) {
  const [a, m, d] = dataISO.split('-').map(Number);
  const alvo = new Date(a, m - 1 + meses, 1);
  const ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(d, ultimoDia));
  return hojeISO(alvo);
}

/** Atualiza o valor da dívida: multa (se vencida) + juros simples pro rata + honorários sobre o subtotal. */
export function atualizarDivida(divida, carteira, hoje = new Date()) {
  const valor = Number(divida.valor_original);
  const venc = new Date(`${divida.vencimento}T00:00:00`);
  const base = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const dias = Math.max(0, Math.round((base - venc) / 86400000));
  const multa = dias > 0 ? valor * (carteira.multa / 100) : 0;
  const juros = valor * (carteira.juros_mes / 100) * (dias / 30);
  const subtotal = valor + multa + juros;
  const honorarios = subtotal * (carteira.honorarios / 100);
  return {
    dias_atraso: dias,
    valor_original: r2(valor),
    multa: r2(multa),
    juros: r2(juros),
    honorarios: r2(honorarios),
    total: r2(subtotal + honorarios),
  };
}

/**
 * Simula um acordo. Retorna valores, parcelas e a lista de violações das regras da carteira
 * (desconto máximo, parcelas máximas, entrada mínima).
 */
export function simularAcordo({ dividas, carteira, desconto_pct = 0, qtd_parcelas = 1, entrada = null, primeiro_vencimento }) {
  desconto_pct = Number(desconto_pct) || 0;
  qtd_parcelas = Math.max(1, parseInt(qtd_parcelas, 10) || 1);
  const venc1 = primeiro_vencimento || hojeISO();

  const total = r2(dividas.reduce((s, d) => s + atualizarDivida(d, carteira).total, 0));
  const valor_desconto = r2(total * desconto_pct / 100);
  const valor_acordo = r2(total - valor_desconto);

  const parcelas = [];
  if (qtd_parcelas === 1) {
    parcelas.push({ numero: 1, vencimento: venc1, valor: valor_acordo });
  } else {
    const ent = entrada != null && entrada !== '' && Number(entrada) > 0
      ? r2(entrada)
      : r2(valor_acordo / qtd_parcelas);
    const resto = r2(valor_acordo - ent);
    const cada = Math.floor((resto / (qtd_parcelas - 1)) * 100) / 100;
    parcelas.push({ numero: 1, vencimento: venc1, valor: ent });
    let acumulado = ent;
    for (let i = 2; i <= qtd_parcelas; i++) {
      const valor = i === qtd_parcelas ? r2(valor_acordo - acumulado) : cada;
      acumulado = r2(acumulado + valor);
      parcelas.push({ numero: i, vencimento: addMeses(venc1, i - 1), valor });
    }
  }

  // alcada = regra da carteira que supervisor/admin pode ultrapassar; as demais bloqueiam sempre.
  const violacoes = [];
  const v = (msg, alcada = false) => violacoes.push({ msg, alcada });
  if (!dividas.length) v('Selecione ao menos uma dívida.');
  if (desconto_pct < 0 || desconto_pct > 100) v('Desconto inválido.');
  if (desconto_pct > carteira.desconto_max) {
    v(`Desconto de ${desconto_pct}% acima do máximo da carteira (${carteira.desconto_max}%).`, true);
  }
  if (qtd_parcelas > carteira.parcelas_max) {
    v(`Quantidade de parcelas acima do máximo da carteira (${carteira.parcelas_max}x).`, true);
  }
  if (qtd_parcelas > 1) {
    const minEntrada = r2(valor_acordo * carteira.entrada_min_pct / 100);
    if (parcelas[0].valor < minEntrada) {
      v(`Entrada mínima para esta carteira: R$ ${minEntrada.toFixed(2)} (${carteira.entrada_min_pct}%).`, true);
    }
    if (parcelas[0].valor >= valor_acordo) v('A entrada não pode ser maior ou igual ao valor do acordo.');
  }
  if (venc1 < hojeISO()) v('O primeiro vencimento não pode ser no passado.');

  return { valor_divida: total, desconto_pct, valor_desconto, valor_acordo, qtd_parcelas, parcelas, violacoes };
}

export function soDigitos(v) {
  return String(v ?? '').replace(/\D/g, '');
}

/** Converte "1.234,56" / "1234.56" / "1234,56" em número. */
export function parseValor(v) {
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}

/** Converte "dd/mm/aaaa" ou "aaaa-mm-dd" em "aaaa-mm-dd". */
export function parseData(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Parser de CSV simples com suporte a aspas; detecta separador ";" ou ",". */
export function parseCsv(texto) {
  texto = String(texto).replace(/^\uFEFF/, '');
  const primeiraLinha = texto.split(/\r?\n/, 1)[0] || '';
  const sep = (primeiraLinha.match(/;/g) || []).length >= (primeiraLinha.match(/,/g) || []).length ? ';' : ',';
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
  if (!linhas.length) return [];
  const cab = linhas[0].map((h) => h.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_'));
  return linhas.slice(1).map((l) => Object.fromEntries(cab.map((h, i) => [h, (l[i] ?? '').trim()])));
}

export function toCsv(linhas, colunas) {
  const escapar = (v) => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [colunas.map((c) => c.titulo).join(';')];
  for (const l of linhas) {
    out.push(colunas.map((c) => {
      let v = typeof c.valor === 'function' ? c.valor(l) : l[c.campo];
      if (typeof v === 'number' && c.decimal) v = v.toFixed(2).replace('.', ',');
      return escapar(v);
    }).join(';'));
  }
  return '\uFEFF' + out.join('\r\n');
}
