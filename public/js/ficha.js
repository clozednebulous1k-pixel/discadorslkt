import {
  state, api, esc, moeda, data, dataHora, hoje, doc, fone, duracao, badge, toast, acao, modal, confirmar,
  lerForm, ehSupervisao,
} from './core.js';

let timerFicha = null;
let abaAtual = 'titulos';
let ultimoDevedor = null;

const TIPOS_TAB = {
  SEM_CONTATO: 'Sem contato', CONTATO: 'Contato com terceiro', CPC: 'Contato com o devedor (CPC)',
  PROMESSA: 'Promessa', ACORDO: 'Acordo', RECUSA: 'Recusa',
};

/**
 * Renderiza a ficha completa do devedor.
 * modoFila: tela de atendimento (mostra cronômetro e opção de ir ao próximo).
 * aoFinalizar: callback chamado após registrar acionamento quando o operador quer o próximo cliente.
 */
export async function renderFicha(alvo, id, { modoFila = false, aoFinalizar } = {}) {
  const f = await api('GET', `/api/devedores/${id}`);
  const { devedor: d, carteira: c, telefones, dividas, acordos, acionamentos, resumo } = f;
  const recarregar = () => renderFicha(alvo, id, { modoFila, aoFinalizar });

  if (modoFila && state.atualId !== d.id) state.atualId = d.id;
  if (modoFila && !state.inicioAtendimento) state.inicioAtendimento = Date.now();
  if (ultimoDevedor !== d.id) { abaAtual = 'titulos'; ultimoDevedor = d.id; }

  const telsAtivos = telefones.filter((t) => t.status !== 'INVALIDO');
  const abertas = dividas.filter((v) => v.status === 'ABERTA');
  const abas = [
    ['titulos', `Títulos (${dividas.length})`],
    ['negociacao', 'Negociação'],
    ['acordos', `Acordos (${acordos.length})`],
    ['historico', `Histórico (${acionamentos.length})`],
    ['cadastro', 'Cadastro'],
  ];

  alvo.innerHTML = `
  <div class="ficha-cab">
    <div>
      <span class="nome">${esc(d.nome)}</span>
      <span class="mono">${doc(d.cpf_cnpj)}</span>
      ${badge(d.status)}
      <span class="muted">${esc(c.nome)}</span>
      ${d.lock_nome && d.lock_usuario_id !== state.usuario.id ? `<span class="badge amarelo">Em atendimento por ${esc(d.lock_nome)}</span>` : ''}
    </div>
    <div class="dir">
      Total atualizado: <b class="valor-destaque">${moeda(resumo.atualizado_aberto)}</b>
      ${modoFila ? ' · Tempo: <span class="timer" id="timer">00:00</span>' : ''}
    </div>
  </div>

  <div class="ficha">
    <div class="col">
      <fieldset class="painel">
        <legend>Telefones</legend>
        ${telefones.map((t) => `
          <div class="fone ${t.status === 'INVALIDO' ? 'invalido' : ''}">
            <span class="numero">${fone(t.numero)}</span>
            <span class="muted">${esc(t.tipo)}</span>
            ${t.status !== 'ATIVO' ? badge(t.status) : ''}
            ${t.status !== 'INVALIDO' ? `<button class="btn sm success" data-ligar="${t.id}">Ligar</button>` : ''}
            <button class="btn sm" data-tel-status="${t.id}" data-status="${t.status === 'INVALIDO' ? 'ATIVO' : 'INVALIDO'}"
              title="${t.status === 'INVALIDO' ? 'Reativar' : 'Marcar como inválido'}">${t.status === 'INVALIDO' ? '↺' : '✕'}</button>
          </div>`).join('') || '<p class="muted">Nenhum telefone.</p>'}
        <form id="formFone" class="linha" style="margin-top:6px">
          <input name="numero" placeholder="DDD + número" required style="flex:1">
          <select name="tipo" style="width:95px"><option>CELULAR</option><option>FIXO</option><option>COMERCIAL</option><option>REFERENCIA</option></select>
          <button class="btn sm">Incluir</button>
        </form>
      </fieldset>

      <fieldset class="painel">
        <legend>Acionamento</legend>
        <form id="formAcion">
          <div class="campo"><label>Tabulação *</label>
            <select name="tabulacao_id" required>
              <option value="">Selecione...</option>
              ${Object.entries(TIPOS_TAB).map(([tipo, nome]) => {
    const itens = state.tabulacoes.filter((t) => t.tipo === tipo && t.tipo !== 'ACORDO');
    return itens.length ? `<optgroup label="${esc(nome)}">${itens.map((t) => `
                  <option value="${t.id}" data-agenda="${t.exige_agendamento}">${esc(t.descricao)}</option>`).join('')}</optgroup>` : '';
  }).join('')}
            </select>
          </div>
          <div class="campo"><label>Telefone</label>
            <select name="telefone_id">
              <option value="">(nenhum)</option>
              ${telsAtivos.map((t, i) => `<option value="${t.id}" ${i === 0 ? 'selected' : ''}>${fone(t.numero)}</option>`).join('')}
            </select>
          </div>
          <div class="campo"><label id="lblAgenda">Retorno / data da promessa</label>
            <input type="datetime-local" name="data_agendamento"></div>
          <div class="campo"><label>Observação</label>
            <textarea name="observacao" rows="3"></textarea></div>
          ${modoFila ? '<label class="check"><input type="checkbox" id="autoProx" checked> Ir para o próximo ao gravar</label>' : ''}
          <button class="btn primary" style="width:100%">Gravar acionamento</button>
        </form>
      </fieldset>
    </div>

    <div class="painel">
      <div class="tabs">
        ${abas.map(([k, n]) => `<button type="button" data-aba="${k}" class="${abaAtual === k ? 'ativo' : ''}">${n}</button>`).join('')}
      </div>

      <div class="aba" data-conteudo="titulos">
        <div class="tabela"><table>
          <thead><tr>
            <th></th><th>Contrato</th><th>Descrição</th><th>Vencto</th><th class="num">Atraso</th>
            <th class="num">Original</th><th class="num">Multa</th><th class="num">Juros</th><th class="num">Honor.</th>
            <th class="num">Atualizado</th><th>Situação</th>
          </tr></thead>
          <tbody>
            ${dividas.map((v) => `
              <tr>
                <td>${v.status === 'ABERTA' ? `<input type="checkbox" class="selDiv" value="${v.id}" checked>` : ''}</td>
                <td class="mono">${esc(v.contrato) || '-'}</td>
                <td>${esc(v.descricao) || '-'}</td>
                <td>${data(v.vencimento)}</td>
                <td class="num">${v.atualizado.dias_atraso}</td>
                <td class="num">${moeda(v.valor_original)}</td>
                <td class="num">${moeda(v.atualizado.multa)}</td>
                <td class="num">${moeda(v.atualizado.juros)}</td>
                <td class="num">${moeda(v.atualizado.honorarios)}</td>
                <td class="num"><b>${moeda(v.atualizado.total)}</b></td>
                <td>${badge(v.status)}</td>
              </tr>`).join('') || '<tr><td colspan="11" class="vazio">Nenhum título.</td></tr>'}
          </tbody>
          <tfoot><tr><td colspan="5">Em aberto: ${resumo.qtd_abertas}</td>
            <td class="num">${moeda(resumo.original_aberto)}</td><td colspan="3"></td>
            <td class="num">${moeda(resumo.atualizado_aberto)}</td><td></td></tr></tfoot>
        </table></div>
        <p class="muted" style="margin:6px 0 0">Marque os títulos que entram na negociação.
          Carteira: juros ${c.juros_mes}% a.m. · multa ${c.multa}% · honorários ${c.honorarios}%</p>
      </div>

      <div class="aba" data-conteudo="negociacao">
        ${abertas.length ? `
        <p class="muted" style="margin-top:0">Limites da carteira: desconto até ${c.desconto_max}% · até ${c.parcelas_max}x · entrada mínima ${c.entrada_min_pct}%</p>
        <form id="formSim" class="linha">
          <div class="campo"><label>Desconto %</label><input type="number" name="desconto_pct" min="0" max="100" step="0.01" value="0"></div>
          <div class="campo"><label>Parcelas</label><input type="number" name="qtd_parcelas" min="1" max="120" value="1"></div>
          <div class="campo"><label>Entrada R$</label><input type="number" name="entrada" min="0" step="0.01" placeholder="Automática"></div>
          <div class="campo"><label>1º vencimento</label><input type="date" name="primeiro_vencimento" value="${hoje(1)}" min="${hoje()}"></div>
          <div class="campo" style="flex:0"><button class="btn primary">Calcular</button></div>
        </form>
        <div id="resSim"></div>` : '<p class="muted">Não há títulos em aberto para negociar.</p>'}
      </div>

      <div class="aba" data-conteudo="acordos">
        ${acordos.map((a) => htmlAcordo(a)).join('') || '<p class="muted">Nenhum acordo.</p>'}
      </div>

      <div class="aba" data-conteudo="historico">
        <div class="tabela"><table>
          <thead><tr><th>Data/hora</th><th>Operador</th><th>Tabulação</th><th>Telefone</th><th>Retorno</th><th>Observação</th></tr></thead>
          <tbody>${acionamentos.map((a) => `
            <tr>
              <td>${dataHora(a.criado_em)}</td><td>${esc(a.operador)}</td><td>${esc(a.tabulacao)}</td>
              <td>${a.telefone ? fone(a.telefone) : ''}</td><td>${dataHora(a.data_agendamento)}</td>
              <td class="obs">${esc(a.observacao)}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum acionamento.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="aba" data-conteudo="cadastro">
        <dl class="info">
          <dt>Nome</dt><dd>${esc(d.nome)}</dd>
          <dt>CPF/CNPJ</dt><dd>${doc(d.cpf_cnpj)}</dd>
          <dt>Credor</dt><dd>${esc(c.credor)}</dd>
          <dt>Nascimento</dt><dd>${data(d.data_nasc) || '-'}</dd>
          <dt>E-mail</dt><dd>${esc(d.email) || '-'}</dd>
          <dt>Endereço</dt><dd>${esc(d.endereco) || '-'}</dd>
          <dt>Cidade/UF</dt><dd>${esc([d.cidade, d.uf].filter(Boolean).join(' / ')) || '-'}</dd>
          <dt>CEP</dt><dd>${esc(d.cep) || '-'}</dd>
          <dt>Operador</dt><dd>${esc(d.operador_nome) || 'Livre'}</dd>
          <dt>Tentativas</dt><dd>${d.tentativas}</dd>
          <dt>Últ. acion.</dt><dd>${dataHora(d.ultimo_acionamento) || '-'}</dd>
          <dt>Próx. contato</dt><dd>${dataHora(d.proximo_contato) || '-'}</dd>
          <dt>Observação</dt><dd>${esc(d.observacao) || '-'}</dd>
        </dl>
        <button class="btn" id="btnEditar" style="margin-top:10px">Alterar cadastro</button>
      </div>
    </div>
  </div>`;

  const $ = (s) => alvo.querySelector(s);
  const $$ = (s) => [...alvo.querySelectorAll(s)];

  const mostrarAba = (k) => {
    abaAtual = k;
    $$('.tabs [data-aba]').forEach((b) => b.classList.toggle('ativo', b.dataset.aba === k));
    $$('.aba').forEach((el) => { el.hidden = el.dataset.conteudo !== k; });
  };
  $$('.tabs [data-aba]').forEach((b) => b.addEventListener('click', () => mostrarAba(b.dataset.aba)));
  mostrarAba(abaAtual);

  clearInterval(timerFicha);
  if (modoFila) {
    const tick = () => {
      const el = document.getElementById('timer');
      if (!el) { clearInterval(timerFicha); return; }
      el.textContent = duracao((Date.now() - state.inicioAtendimento) / 1000);
    };
    tick();
    timerFicha = setInterval(tick, 1000);
  }

  $('#btnEditar').addEventListener('click', () => editarDevedor(d, recarregar));

  $$('[data-ligar]').forEach((b) => b.addEventListener('click', () => acao(async () => {
    const telId = b.dataset.ligar;
    const sel = $('#formAcion [name=telefone_id]');
    if (sel) sel.value = telId;
    const r = await api('POST', '/api/discar', { telefone_id: telId });
    if (r.uri) window.location.href = r.uri;
    toast(r.modo === 'webhook' ? 'Discador acionado. Aguarde a chamada no seu ramal.' : 'Chamando...', 'ok');
  }, b)));

  $$('[data-tel-status]').forEach((b) => b.addEventListener('click', () => acao(async () => {
    await api('PUT', `/api/telefones/${b.dataset.telStatus}`, { status: b.dataset.status });
    await recarregar();
  }, b)));

  $('#formFone').addEventListener('submit', (e) => {
    e.preventDefault();
    acao(async () => {
      await api('POST', `/api/devedores/${d.id}/telefones`, lerForm(e.target));
      toast('Telefone incluído.', 'ok');
      await recarregar();
    }, e.submitter);
  });

  const selTab = $('#formAcion [name=tabulacao_id]');
  selTab.addEventListener('change', () => {
    const exige = selTab.selectedOptions[0]?.dataset.agenda === '1';
    $('#lblAgenda').textContent = exige ? 'Retorno / data da promessa *' : 'Retorno / data da promessa';
    $('#formAcion [name=data_agendamento]').required = exige;
  });

  $('#formAcion').addEventListener('submit', (e) => {
    e.preventDefault();
    acao(async () => {
      const dados = lerForm(e.target);
      if (modoFila && state.inicioAtendimento) dados.duracao_seg = Math.round((Date.now() - state.inicioAtendimento) / 1000);
      await api('POST', `/api/devedores/${d.id}/acionamentos`, dados);
      toast('Acionamento gravado.', 'ok');
      if (modoFila && $('#autoProx')?.checked && aoFinalizar) {
        state.inicioAtendimento = null;
        await aoFinalizar();
      } else {
        await recarregar();
      }
    }, e.submitter);
  });

  const formSim = $('#formSim');
  if (formSim) {
    const idsSelecionados = () => $$('.selDiv:checked').map((x) => Number(x.value));
    formSim.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(async () => {
        const params = { ...lerForm(formSim), divida_ids: idsSelecionados() };
        const sim = await api('POST', `/api/devedores/${d.id}/simular`, params);
        mostrarSimulacao($('#resSim'), sim, params, d, async () => { abaAtual = 'acordos'; await recarregar(); },
          () => $('#formAcion [name=telefone_id]')?.value);
      }, e.submitter);
    });
    $$('.selDiv').forEach((x) => x.addEventListener('change', () => { $('#resSim').innerHTML = ''; }));
  }

  bindAcordos(alvo, recarregar);
}

function mostrarSimulacao(alvo, sim, params, d, recarregar, telefoneAtual) {
  const supervisao = ehSupervisao();
  alvo.innerHTML = `
    <div class="simulacao">
      <table class="resumo-sim">
        <tr><td>Dívida atualizada</td><td class="num">${moeda(sim.valor_divida)}</td></tr>
        <tr><td>Desconto (${sim.desconto_pct}%)</td><td class="num">- ${moeda(sim.valor_desconto)}</td></tr>
        <tr><td><b>Valor do acordo</b></td><td class="num"><b>${moeda(sim.valor_acordo)}</b></td></tr>
      </table>
      <div class="tabela" style="margin-top:8px"><table>
        <thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th></tr></thead>
        <tbody>${sim.parcelas.map((p) => `<tr><td>${p.numero === 1 && sim.qtd_parcelas > 1 ? 'Entrada' : `${p.numero}/${sim.qtd_parcelas}`}</td>
          <td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${sim.violacoes.map((v) => `<div class="alerta ${v.alcada && supervisao ? '' : 'erro'}">${esc(v.msg)}${v.alcada && supervisao ? ' (liberado pela sua alçada)' : ''}</div>`).join('')}
      <div class="linha" style="margin-top:8px">
        <input id="obsAcordo" placeholder="Observação do acordo (opcional)" style="flex:1">
        <button class="btn success" id="btnFormalizar" ${sim.pode_formalizar ? '' : 'disabled'}>Gravar acordo</button>
      </div>
    </div>`;
  alvo.querySelector('#btnFormalizar').addEventListener('click', async (e) => {
    if (!await confirmar(`Gravar acordo de ${moeda(sim.valor_acordo)} em ${sim.qtd_parcelas}x?`)) return;
    acao(async () => {
      await api('POST', `/api/devedores/${d.id}/acordos`, {
        ...params, observacao: alvo.querySelector('#obsAcordo').value, telefone_id: telefoneAtual(),
      });
      toast('Acordo gravado.', 'ok');
      await recarregar();
    }, e.target);
  });
}

function htmlAcordo(a) {
  const sup = ehSupervisao();
  const pago = a.parcelas.filter((p) => p.status === 'PAGA').reduce((s, p) => s + (p.valor_pago || 0), 0);
  return `
    <div class="acordo-box">
      <div class="topo">
        <div><b>Acordo nº ${a.id}</b> ${badge(a.status)} <span class="muted">${dataHora(a.criado_em)} · ${esc(a.operador)}</span></div>
        <div>${moeda(a.valor_acordo)} em ${a.qtd_parcelas}x ${a.desconto_pct ? `<span class="muted">(desc. ${a.desconto_pct}%)</span>` : ''}
          · Pago: ${moeda(pago)}</div>
      </div>
      ${a.observacao ? `<div class="muted" style="margin-bottom:4px">${esc(a.observacao)}</div>` : ''}
      <div class="tabela"><table>
        <thead><tr><th>Nº</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th>Pago em</th><th class="num">Valor pago</th>${sup ? '<th></th>' : ''}</tr></thead>
        <tbody>${a.parcelas.map((p) => `
          <tr>
            <td>${p.numero}</td><td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor)}</td>
            <td>${p.atrasada ? badge('ATRASADA') : badge(p.status)}</td>
            <td>${data(p.pago_em)}</td><td class="num">${p.valor_pago != null ? moeda(p.valor_pago) : ''}</td>
            ${sup ? `<td class="dir">
              ${p.status === 'ABERTA' && a.status === 'ATIVO' ? `<button class="btn sm" data-pagar="${p.id}" data-valor="${p.valor}">Baixar</button>` : ''}
              ${p.status === 'PAGA' ? `<button class="btn sm" data-estornar="${p.id}">Estornar</button>` : ''}
            </td>` : ''}
          </tr>`).join('')}</tbody>
      </table></div>
      ${sup && a.status === 'ATIVO' ? `<div style="margin-top:6px; text-align:right">
        <button class="btn sm danger" data-quebrar="${a.id}">Quebrar acordo</button>
        <button class="btn sm" data-cancelar="${a.id}">Cancelar</button></div>` : ''}
    </div>`;
}

export function bindAcordos(alvo, recarregar) {
  alvo.querySelectorAll('[data-pagar]').forEach((b) => b.addEventListener('click', () => {
    const m = modal('Baixar parcela', `
      <div class="linha">
        <div class="campo"><label>Valor pago (R$)</label><input type="number" step="0.01" id="vp" value="${b.dataset.valor}"></div>
        <div class="campo"><label>Data do pagamento</label><input type="date" id="dp" value="${hoje()}"></div>
      </div>`, { rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn success" id="okPg">Confirmar baixa</button>' });
    m.$('#okPg').addEventListener('click', (e) => acao(async () => {
      await api('POST', `/api/parcelas/${b.dataset.pagar}/pagar`, { valor_pago: m.$('#vp').value, pago_em: m.$('#dp').value });
      m.fechar();
      toast('Pagamento registrado.', 'ok');
      await recarregar();
    }, e.target));
  }));
  alvo.querySelectorAll('[data-estornar]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmar('Estornar o pagamento desta parcela?')) return;
    acao(async () => { await api('POST', `/api/parcelas/${b.dataset.estornar}/estornar`); await recarregar(); }, b);
  }));
  alvo.querySelectorAll('[data-quebrar],[data-cancelar]').forEach((b) => b.addEventListener('click', async () => {
    const cancelar = !!b.dataset.cancelar;
    const id = b.dataset.quebrar || b.dataset.cancelar;
    if (!await confirmar(cancelar
      ? 'Cancelar o acordo? Os títulos voltam para "em aberto".'
      : 'Registrar quebra do acordo? As parcelas em aberto serão canceladas e os títulos voltam para a fila.')) return;
    acao(async () => {
      await api('POST', `/api/acordos/${id}/quebrar`, { cancelar });
      toast(cancelar ? 'Acordo cancelado.' : 'Quebra registrada.', 'ok');
      await recarregar();
    }, b);
  }));
}

function editarDevedor(d, recarregar) {
  const campo = (nome, rot, valor, tipo = 'text') => `
    <div class="campo"><label>${rot}</label><input type="${tipo}" name="${nome}" value="${esc(valor)}"></div>`;
  const m = modal('Alterar cadastro', `
    <form id="fEd">
      ${campo('nome', 'Nome', d.nome)}
      <div class="linha">${campo('data_nasc', 'Nascimento', d.data_nasc, 'date')}${campo('email', 'E-mail', d.email, 'email')}</div>
      ${campo('endereco', 'Endereço', d.endereco)}
      <div class="linha">${campo('cidade', 'Cidade', d.cidade)}${campo('uf', 'UF', d.uf)}${campo('cep', 'CEP', d.cep)}</div>
      <div class="campo"><label>Observação</label><textarea name="observacao">${esc(d.observacao)}</textarea></div>
    </form>`, { rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okEd">Salvar</button>' });
  m.$('#okEd').addEventListener('click', (e) => acao(async () => {
    await api('PUT', `/api/devedores/${d.id}`, lerForm(m.$('#fEd')));
    m.fechar();
    toast('Cadastro atualizado.', 'ok');
    await recarregar();
  }, e.target));
}
