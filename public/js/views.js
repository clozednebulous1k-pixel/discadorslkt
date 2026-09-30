import {
  state, api, esc, moeda, num, pct, data, dataHora, hoje, doc, duracao, badge, toast, acao, modal, lerForm,
  opcoesCarteiras, ehSupervisao, ehAdmin, intervalo, carregarSessao, lerArquivoTexto,
} from './core.js';
import { renderFicha } from './ficha.js';

const STATUS_DEVEDOR = ['ABERTO', 'SEM_CONTATO', 'EM_ACORDO', 'QUITADO', 'ENCERRADO'];
const ROT_STATUS = { ABERTO: 'Em aberto', SEM_CONTATO: 'Sem contato', EM_ACORDO: 'Em acordo', QUITADO: 'Quitado', ENCERRADO: 'Encerrado' };
const primeiroDiaMes = () => `${hoje().slice(0, 8)}01`;
const irPara = (id) => { location.hash = `#/devedor/${id}`; };

// ============================================================== ATENDIMENTO (fila)
export async function viewAtendimento(view) {
  view.innerHTML = `
    <div class="toolbar">
      <h1>Atendimento</h1>
      <select id="filaCarteira">
        <option value="">Todas as minhas carteiras</option>
        ${opcoesCarteiras(localStorage.getItem('filaCarteira') || '')}
      </select>
      <button class="btn primary lg" id="btnProximo">▶ Próximo cliente (F2)</button>
      <span class="espaco"></span>
      <div class="fila-info" id="meusNumeros"></div>
    </div>
    <div id="fichaAtual"></div>`;
  const alvo = view.querySelector('#fichaAtual');
  const sel = view.querySelector('#filaCarteira');
  const btn = view.querySelector('#btnProximo');
  sel.addEventListener('change', () => localStorage.setItem('filaCarteira', sel.value));

  const atualizarNumeros = async () => {
    const n = await api('GET', '/api/meus-numeros').catch(() => null);
    const el = document.getElementById('meusNumeros');
    if (!n || !el) return;
    el.innerHTML = `
      <span class="badge">Hoje: <b>${n.acionamentos}</b> acionamentos</span>
      <span class="badge azul">CPC: <b>${n.cpc}</b></span>
      <span class="badge verde">Acordos: <b>${n.acordos}</b> · ${moeda(n.valor)}</span>
      ${n.agendados_vencidos ? `<span class="badge amarelo">Retornos pendentes: <b>${n.agendados_vencidos}</b></span>` : ''}`;
  };

  const telaVazia = async (msg) => {
    state.atualId = null;
    const resumo = await api('GET', '/api/fila/resumo').catch(() => []);
    alvo.innerHTML = `
      <div class="card vazio">
        <div class="grande">🎧</div>
        <h2>${esc(msg)}</h2>
        <p>Clique em <b>Próximo cliente</b> (ou F2) para puxar o próximo devedor da fila.</p>
        ${resumo.length ? `<div class="fila-info" style="justify-content:center; margin-top:16px">
          ${resumo.map((r) => `<span class="badge azul">${esc(r.nome)}: <b>${num(r.disponiveis)}</b> disponíveis</span>`).join('')}
        </div>` : '<p class="muted">Nenhum cliente disponível na fila neste momento.</p>'}
      </div>`;
  };

  const proximo = async () => {
    const r = await api('POST', '/api/fila/proximo', { carteira_id: sel.value || null });
    state.inicioAtendimento = null;
    if (!r.devedor_id) {
      await telaVazia('Fila vazia para o filtro selecionado');
      toast('Não há clientes disponíveis na fila agora.');
    } else {
      state.atualId = r.devedor_id;
      state.inicioAtendimento = Date.now();
      await renderFicha(alvo, r.devedor_id, { modoFila: true, aoFinalizar: proximo });
    }
    atualizarNumeros();
  };

  btn.addEventListener('click', () => acao(proximo, btn));
  state.atalhoF2 = () => acao(proximo, btn);

  if (state.atualId) {
    await renderFicha(alvo, state.atualId, { modoFila: true, aoFinalizar: proximo })
      .catch(() => telaVazia('Pronto para atender'));
  } else {
    await telaVazia('Pronto para atender');
  }
  atualizarNumeros();
  intervalo(atualizarNumeros, 60000);
}

// ============================================================== BUSCA
export async function viewBusca(view) {
  view.innerHTML = `
    <div class="toolbar"><h1>Buscar devedor</h1></div>
    <form class="card linha" id="fBusca" style="margin-bottom:16px">
      <div class="campo" style="flex:3; margin:0"><label>CPF/CNPJ, nome, telefone ou contrato</label>
        <input name="q" placeholder="Digite para buscar..." value="${esc(sessionStorage.getItem('buscaQ') || '')}"></div>
      <div class="campo" style="margin:0"><label>Carteira</label>
        <select name="carteira_id"><option value="">Todas</option>${opcoesCarteiras()}</select></div>
      <div class="campo" style="margin:0"><label>Status</label>
        <select name="status"><option value="">Todos</option>${STATUS_DEVEDOR.map((s) => `<option value="${s}">${ROT_STATUS[s]}</option>`).join('')}</select></div>
      <button class="btn primary">Buscar</button>
    </form>
    <div id="resBusca"></div>`;
  const form = view.querySelector('#fBusca');
  const buscar = async () => {
    const p = lerForm(form);
    sessionStorage.setItem('buscaQ', p.q);
    const lista = await api('GET', `/api/devedores?${new URLSearchParams(p)}`);
    view.querySelector('#resBusca').innerHTML = lista.length ? `
      <div class="tabela"><table>
        <thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Carteira</th><th>Status</th><th>Cidade/UF</th>
          <th class="num">Valor original aberto</th><th>Operador</th><th>Últ. acionamento</th><th class="num">Tent.</th></tr></thead>
        <tbody>${lista.map((d) => `
          <tr class="clicavel" data-id="${d.id}">
            <td><b>${esc(d.nome)}</b></td><td class="mono">${doc(d.cpf_cnpj)}</td><td>${esc(d.carteira)}</td>
            <td>${badge(d.status)}</td><td>${esc([d.cidade, d.uf].filter(Boolean).join('/'))}</td>
            <td class="num">${moeda(d.valor_aberto)}</td><td>${esc(d.operador) || '<span class="muted">-</span>'}</td>
            <td>${dataHora(d.ultimo_acionamento)}</td><td class="num">${d.tentativas}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">${lista.length === 200 ? 'Mostrando os 200 primeiros resultados. Refine a busca.' : `${lista.length} resultado(s).`}</p>`
      : '<div class="card vazio">Nenhum devedor encontrado.</div>';
    view.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => irPara(tr.dataset.id)));
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); acao(buscar, e.submitter); });
  if (sessionStorage.getItem('buscaQ')) acao(buscar);
}

// ============================================================== FICHA AVULSA
export async function viewDevedor(view, id) {
  view.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="voltar">← Voltar</button>
      <h1>Ficha do devedor</h1>
    </div>
    <div id="fichaAvulsa"></div>`;
  view.querySelector('#voltar').addEventListener('click', () => history.back());
  await renderFicha(view.querySelector('#fichaAvulsa'), id, { modoFila: false });
}

// ============================================================== AGENDA
export async function viewAgenda(view) {
  const sup = ehSupervisao();
  view.innerHTML = `
    <div class="toolbar">
      <h1>Agenda de retornos</h1>
      ${sup ? '<label class="check" style="margin:0"><input type="checkbox" id="soMeus"> Somente os meus</label>' : ''}
    </div>
    <div id="resAgenda"></div>`;
  const carregar = async () => {
    const meus = view.querySelector('#soMeus')?.checked;
    const lista = await api('GET', `/api/agenda${meus ? '?meus=1' : ''}`);
    const agora = `${hoje()} ${new Date().toTimeString().slice(0, 5)}`;
    view.querySelector('#resAgenda').innerHTML = lista.length ? `
      <div class="tabela"><table>
        <thead><tr><th>Retorno</th><th>Nome</th><th>CPF/CNPJ</th><th>Carteira</th>${sup ? '<th>Operador</th>' : ''}<th>Última observação</th></tr></thead>
        <tbody>${lista.map((d) => `
          <tr class="clicavel" data-id="${d.id}">
            <td>${d.proximo_contato.slice(0, 16) <= agora ? badge('ATRASADA', dataHora(d.proximo_contato)) : dataHora(d.proximo_contato)}</td>
            <td><b>${esc(d.nome)}</b></td><td class="mono">${doc(d.cpf_cnpj)}</td><td>${esc(d.carteira)}</td>
            ${sup ? `<td>${esc(d.operador)}</td>` : ''}<td class="muted">${esc((d.ultima_obs || '').slice(0, 90))}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">Os retornos vencidos também aparecem primeiro na sua fila de atendimento.</p>`
      : '<div class="card vazio"><div class="grande">📅</div>Nenhum retorno agendado.</div>';
    view.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => irPara(tr.dataset.id)));
  };
  view.querySelector('#soMeus')?.addEventListener('change', () => acao(carregar));
  await carregar();
}

// ============================================================== ACORDOS
export async function viewAcordos(view) {
  view.innerHTML = `
    <div class="toolbar"><h1>Acordos</h1></div>
    <form class="card linha" id="fAc" style="margin-bottom:16px">
      <div class="campo" style="margin:0"><label>De</label><input type="date" name="data_ini" value="${primeiroDiaMes()}"></div>
      <div class="campo" style="margin:0"><label>Até</label><input type="date" name="data_fim" value="${hoje()}"></div>
      <div class="campo" style="margin:0"><label>Carteira</label><select name="carteira_id"><option value="">Todas</option>${opcoesCarteiras()}</select></div>
      <div class="campo" style="margin:0"><label>Status</label><select name="status"><option value="">Todos</option>
        <option value="ATIVO">Ativo</option><option value="QUITADO">Quitado</option><option value="QUEBRADO">Quebrado</option><option value="CANCELADO">Cancelado</option></select></div>
      <button class="btn primary">Filtrar</button>
    </form>
    <div id="kpiAc"></div><div id="resAc"></div>`;
  const form = view.querySelector('#fAc');
  const carregar = async () => {
    const lista = await api('GET', `/api/acordos?${new URLSearchParams(lerForm(form))}`);
    const validos = lista.filter((a) => a.status !== 'CANCELADO');
    const total = validos.reduce((s, a) => s + a.valor_acordo, 0);
    const pago = validos.reduce((s, a) => s + a.valor_pago, 0);
    view.querySelector('#kpiAc').innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Acordos</span><b>${num(validos.length)}</b></div>
        <div class="kpi"><span>Valor acordado</span><b>${moeda(total)}</b></div>
        <div class="kpi"><span>Recebido destes acordos</span><b>${moeda(pago)}</b><small>${pct(pago, total)}</small></div>
        <div class="kpi"><span>Com parcela atrasada</span><b>${num(lista.filter((a) => a.status === 'ATIVO' && a.parcelas_atrasadas).length)}</b></div>
      </div>`;
    view.querySelector('#resAc').innerHTML = lista.length ? `
      <div class="tabela"><table>
        <thead><tr><th>#</th><th>Data</th><th>Devedor</th><th>CPF/CNPJ</th><th>Carteira</th><th>Operador</th>
          <th class="num">Valor</th><th class="num">Parc.</th><th class="num">Pago</th><th>Status</th></tr></thead>
        <tbody>${lista.map((a) => `
          <tr class="clicavel" data-id="${a.devedor_id}">
            <td>${a.id}</td><td>${dataHora(a.criado_em)}</td><td><b>${esc(a.devedor)}</b></td><td class="mono">${doc(a.cpf_cnpj)}</td>
            <td>${esc(a.carteira)}</td><td>${esc(a.operador)}</td><td class="num">${moeda(a.valor_acordo)}</td>
            <td class="num">${a.qtd_parcelas}x</td><td class="num">${moeda(a.valor_pago)}</td>
            <td>${badge(a.status)} ${a.status === 'ATIVO' && a.parcelas_atrasadas ? badge('ATRASADA', `${a.parcelas_atrasadas} atrasada(s)`) : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<div class="card vazio">Nenhum acordo no período.</div>';
    view.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => irPara(tr.dataset.id)));
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); acao(carregar, e.submitter); });
  await carregar();
}

// ============================================================== DASHBOARD (supervisão)
export async function viewDashboard(view) {
  view.innerHTML = `
    <div class="toolbar">
      <h1>Painel da supervisão</h1>
      <span class="espaco"></span>
      <input type="date" id="dIni" value="${hoje()}"> até <input type="date" id="dFim" value="${hoje()}">
      <button class="btn" id="btnAtualizar">Atualizar</button>
      <span class="muted" id="atualizadoEm"></span>
    </div>
    <div id="dash"></div>`;
  const carregar = async () => {
    const q = new URLSearchParams({ data_ini: view.querySelector('#dIni').value, data_fim: view.querySelector('#dFim').value });
    const r = await api('GET', `/api/dashboard?${q}`);
    const el = view.querySelector('#dash');
    if (!el) return;
    const t = r.totais;
    const maxTab = Math.max(1, ...r.tabulacoes.map((x) => x.qtd));
    const horas = Array.from({ length: 15 }, (_, i) => i + 7);
    const porHora = new Map(r.por_hora.map((h) => [h.hora, h.qtd]));
    const maxHora = Math.max(1, ...r.por_hora.map((h) => h.qtd));
    const online = r.operadores.filter((o) => o.online).length;
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Operadores online</span><b>${online}</b><small>de ${r.operadores.length} ativos</small></div>
        <div class="kpi"><span>Acionamentos</span><b>${num(t.acionamentos)}</b><small>${num(t.devedores_trabalhados)} devedores trabalhados</small></div>
        <div class="kpi"><span>CPC (falou com devedor)</span><b>${num(t.cpc)}</b><small>${pct(t.cpc, t.acionamentos)} dos acionamentos</small></div>
        <div class="kpi"><span>Sem contato</span><b>${num(t.sem_contato)}</b><small>${pct(t.sem_contato, t.acionamentos)}</small></div>
        <div class="kpi"><span>Acordos</span><b>${num(t.acordos)}</b><small>${pct(t.acordos, t.cpc)} dos CPCs</small></div>
        <div class="kpi"><span>Valor acordado</span><b>${moeda(t.valor_acordos)}</b></div>
        <div class="kpi"><span>Recebido no período</span><b>${moeda(t.recebido)}</b><small>${num(t.parcelas_pagas)} parcelas</small></div>
        <div class="kpi"><span>A receber no período</span><b>${moeda(t.a_receber)}</b></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h2>Operadores</h2>
        <div class="tabela"><table>
          <thead><tr><th>Operador</th><th>Ramal</th><th>Em atendimento</th><th class="num">Acion.</th><th class="num">CPC</th>
            <th class="num">% CPC</th><th class="num">Acordos</th><th class="num">Valor acordos</th><th class="num">TMA</th>
            <th>1º / último acion.</th></tr></thead>
          <tbody>${r.operadores.map((o) => `
            <tr>
              <td><span class="dot ${o.online ? 'on' : ''}"></span><b>${esc(o.nome)}</b> <span class="muted">${esc(o.login)}</span></td>
              <td>${esc(o.ramal) || '-'}</td>
              <td>${o.em_atendimento ? esc(o.em_atendimento) : '<span class="muted">-</span>'}</td>
              <td class="num">${num(o.acionamentos)}</td><td class="num">${num(o.cpc)}</td>
              <td class="num">${pct(o.cpc, o.acionamentos)}</td><td class="num">${num(o.acordos)}</td>
              <td class="num">${moeda(o.valor_acordos)}</td>
              <td class="num">${o.acionamentos ? duracao(o.tempo_total / o.acionamentos) : '-'}</td>
              <td class="muted">${o.primeiro ? `${o.primeiro.slice(11, 16)} / ${o.ultimo.slice(11, 16)}` : '-'}</td>
            </tr>`).join('') || '<tr><td colspan="10" class="vazio">Nenhum operador.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="grid g2" style="margin-bottom:16px">
        <div class="card">
          <h2>Tabulações no período</h2>
          <div class="barras">${r.tabulacoes.map((x) => `
            <div class="barra"><span title="${esc(x.descricao)}">${esc(x.descricao)}</span>
              <div class="trilho"><div class="preench ${x.tipo}" style="width:${(x.qtd / maxTab) * 100}%"></div></div>
              <b class="dir">${num(x.qtd)}</b></div>`).join('') || '<p class="muted">Sem acionamentos no período.</p>'}
          </div>
        </div>
        <div class="card">
          <h2>Acionamentos por hora</h2>
          <div class="horas">${horas.map((h) => `
            <div class="h" title="${h}h: ${porHora.get(h) || 0}">
              <span>${porHora.get(h) || ''}</span>
              <div class="c" style="height:${((porHora.get(h) || 0) / maxHora) * 100}%"></div>
              <span>${h}h</span>
            </div>`).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Carteiras</h2>
        <div class="tabela"><table>
          <thead><tr><th>Carteira</th><th>Credor</th><th class="num">Devedores</th><th class="num">Em aberto</th>
            <th class="num">Nunca acionados</th><th class="num">Em acordo</th><th class="num">Quitados</th><th class="num">Valor original aberto</th></tr></thead>
          <tbody>${r.carteiras.map((c) => `
            <tr><td><b>${esc(c.nome)}</b></td><td>${esc(c.credor)}</td><td class="num">${num(c.devedores)}</td>
              <td class="num">${num(c.em_aberto)}</td><td class="num">${num(c.virgens)}</td><td class="num">${num(c.em_acordo)}</td>
              <td class="num">${num(c.quitados)}</td><td class="num">${moeda(c.valor_aberto)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    view.querySelector('#atualizadoEm').textContent = `Atualizado às ${new Date().toTimeString().slice(0, 8)}`;
  };
  view.querySelector('#btnAtualizar').addEventListener('click', (e) => acao(carregar, e.target));
  await carregar();
  intervalo(() => carregar().catch(() => {}), 30000);
}

// ============================================================== CARTEIRAS
export async function viewCarteiras(view) {
  const admin = ehAdmin();
  view.innerHTML = `
    <div class="toolbar">
      <h1>Carteiras</h1><span class="espaco"></span>
      <a class="btn" href="/modelo_importacao.csv" download>⬇ Modelo de importação (CSV)</a>
      ${admin ? '<button class="btn primary" id="novaCart">+ Nova carteira</button>' : ''}
    </div>
    <div id="listaCart"></div>`;
  const carregar = async () => {
    const lista = await api('GET', '/api/carteiras');
    view.querySelector('#listaCart').innerHTML = `
      <div class="tabela"><table>
        <thead><tr><th>Carteira</th><th>Credor</th><th class="num">Devedores</th><th class="num">Em aberto</th>
          <th class="num">Distribuídos</th><th>Regras</th><th>Status</th><th></th></tr></thead>
        <tbody>${lista.map((c) => `
          <tr>
            <td><b>${esc(c.nome)}</b></td><td>${esc(c.credor)}<div class="muted" style="font-size:12px">${esc(c.cnpj)}</div></td>
            <td class="num">${num(c.devedores)}</td><td class="num">${num(c.em_aberto)}</td><td class="num">${num(c.distribuidos)}</td>
            <td class="muted" style="font-size:12px">Juros ${c.juros_mes}% · Multa ${c.multa}% · Hon. ${c.honorarios}%<br>
              Desc. máx ${c.desconto_max}% · ${c.parcelas_max}x · Entrada ${c.entrada_min_pct}%</td>
            <td>${c.ativa ? badge('ATIVO', 'Ativa') : badge('CANCELADO', 'Inativa')}</td>
            <td class="dir" style="white-space:nowrap">
              ${admin ? `<button class="btn sm" data-editar="${c.id}">Editar</button>
                <button class="btn sm" data-importar="${c.id}">Importar</button>` : ''}
              <button class="btn sm" data-distribuir="${c.id}">Distribuir</button>
              <a class="btn sm" href="/api/carteiras/${c.id}/mailing" title="Exportar mailing para o discador">Mailing</a>
            </td>
          </tr>`).join('') || '<tr><td colspan="8" class="vazio">Nenhuma carteira cadastrada.</td></tr>'}</tbody>
      </table></div>`;
    const porId = (id) => lista.find((c) => String(c.id) === String(id));
    view.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => formCarteira(porId(b.dataset.editar), carregar)));
    view.querySelectorAll('[data-importar]').forEach((b) => b.addEventListener('click', () => importar(porId(b.dataset.importar), carregar)));
    view.querySelectorAll('[data-distribuir]').forEach((b) => b.addEventListener('click', () => distribuir(porId(b.dataset.distribuir), carregar)));
  };
  view.querySelector('#novaCart')?.addEventListener('click', () => formCarteira(null, carregar));
  await carregar();
}

function formCarteira(c, aoSalvar) {
  const v = c || { juros_mes: 1, multa: 2, honorarios: 10, desconto_max: 30, parcelas_max: 12, entrada_min_pct: 10, ativa: 1 };
  const campo = (nome, rot, tipo = 'text', extra = '') => `
    <div class="campo"><label>${rot}</label><input type="${tipo}" name="${nome}" value="${esc(v[nome])}" ${extra}></div>`;
  const m = modal(c ? 'Editar carteira' : 'Nova carteira', `
    <form id="fCart">
      <div class="linha">${campo('nome', 'Nome da carteira *')}${campo('credor', 'Credor *')}</div>
      ${campo('cnpj', 'CNPJ do credor')}
      <h3>Atualização da dívida</h3>
      <div class="linha">
        ${campo('juros_mes', 'Juros ao mês (%)', 'number', 'step="0.01" min="0"')}
        ${campo('multa', 'Multa (%)', 'number', 'step="0.01" min="0"')}
        ${campo('honorarios', 'Honorários (%)', 'number', 'step="0.01" min="0"')}
      </div>
      <h3>Política de negociação (alçada do operador)</h3>
      <div class="linha">
        ${campo('desconto_max', 'Desconto máximo (%)', 'number', 'step="0.01" min="0" max="100"')}
        ${campo('parcelas_max', 'Parcelas máximas', 'number', 'min="1"')}
        ${campo('entrada_min_pct', 'Entrada mínima (%)', 'number', 'step="0.01" min="0" max="100"')}
      </div>
      <label class="check"><input type="checkbox" name="ativa" ${v.ativa ? 'checked' : ''}> Carteira ativa (aparece na fila)</label>
    </form>`, { rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okCart">Salvar</button>' });
  m.$('#okCart').addEventListener('click', (e) => acao(async () => {
    const dados = lerForm(m.$('#fCart'));
    if (c) await api('PUT', `/api/carteiras/${c.id}`, dados);
    else await api('POST', '/api/carteiras', dados);
    m.fechar();
    toast('Carteira salva.', 'ok');
    await carregarSessao();
    await aoSalvar();
  }, e.target));
}

function importar(c, aoFinal) {
  const m = modal(`Importar devedores - ${c.nome}`, `
    <div class="alerta info">
      Arquivo CSV (separado por <b>;</b> ou <b>,</b>) com cabeçalho. Colunas obrigatórias: <b>cpf, nome, valor, vencimento</b>.<br>
      Opcionais: contrato, descricao, telefone1, telefone2, telefone3..., email, endereco, cidade, uf, cep, data_nasc.<br>
      Uma linha por dívida: o mesmo CPF em várias linhas vira um devedor com várias dívidas.
      <a href="/modelo_importacao.csv" download>Baixar modelo</a>.
    </div>
    <div class="campo"><label>Arquivo CSV</label><input type="file" id="arq" accept=".csv,.txt"></div>
    <div id="resImp"></div>`, { rodape: '<button class="btn" data-fechar>Fechar</button><button class="btn primary" id="okImp">Importar</button>', largura: 700 });
  m.$('#okImp').addEventListener('click', (e) => acao(async () => {
    const arq = m.$('#arq').files[0];
    if (!arq) throw new Error('Selecione um arquivo.');
    m.$('#resImp').innerHTML = '<div class="alerta info">Importando, aguarde...</div>';
    const csv = await lerArquivoTexto(arq);
    const r = await api('POST', `/api/carteiras/${c.id}/importar`, { csv });
    m.$('#resImp').innerHTML = `
      <div class="alerta ok">
        ${num(r.linhas)} linhas lidas · <b>${num(r.devedores_novos)}</b> devedores novos · <b>${num(r.dividas_novas)}</b> dívidas novas ·
        ${num(r.telefones_novos)} telefones novos · ${num(r.dividas_duplicadas)} dívidas duplicadas ignoradas
      </div>
      ${r.erros.length ? `<div class="alerta erro" style="max-height:200px; overflow:auto">${r.erros.map(esc).join('<br>')}</div>` : ''}`;
    await aoFinal();
  }, e.target));
}

async function distribuir(c, aoFinal) {
  const ops = (await api('GET', '/api/usuarios')).filter((u) => u.ativo && u.perfil === 'operador');
  const m = modal(`Distribuir carteira - ${c.nome}`, `
    <p class="muted">Divide os devedores em aberto desta carteira entre os operadores selecionados (rodízio).
      Devedores distribuídos só aparecem na fila do operador dono. Devedores "livres" aparecem para qualquer operador com acesso à carteira.</p>
    <div class="campo">${ops.map((o) => `
      <label class="check"><input type="checkbox" class="opSel" value="${o.id}"> ${esc(o.nome)} <span class="muted">(${esc(o.login)})</span></label>`).join('')
      || '<p class="muted">Nenhum operador ativo.</p>'}</div>
    <label class="check"><input type="checkbox" id="soLivres" checked> Distribuir somente os que ainda estão livres</label>`,
  { rodape: `<button class="btn danger" id="liberar">Liberar todos (voltar para fila geral)</button>
      <span class="espaco"></span><button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okDist">Distribuir</button>` });
  m.$('#okDist').addEventListener('click', (e) => acao(async () => {
    const r = await api('POST', `/api/carteiras/${c.id}/distribuir`, {
      usuario_ids: m.$$('.opSel:checked').map((x) => Number(x.value)), somente_livres: m.$('#soLivres').checked,
    });
    m.fechar();
    toast(`${num(r.afetados)} devedores distribuídos.`, 'ok');
    await aoFinal();
  }, e.target));
  m.$('#liberar').addEventListener('click', (e) => acao(async () => {
    const r = await api('POST', `/api/carteiras/${c.id}/distribuir`, { liberar: true });
    m.fechar();
    toast(`${num(r.afetados)} devedores liberados para a fila geral.`, 'ok');
    await aoFinal();
  }, e.target));
}

// ============================================================== USUÁRIOS
export async function viewUsuarios(view) {
  view.innerHTML = `
    <div class="toolbar"><h1>Usuários</h1><span class="espaco"></span><button class="btn primary" id="novoUs">+ Novo usuário</button></div>
    <div id="listaUs"></div>`;
  const carregar = async () => {
    const [lista, carteiras] = await Promise.all([api('GET', '/api/usuarios'), api('GET', '/api/carteiras')]);
    const nomeCart = (id) => carteiras.find((c) => c.id === id)?.nome || id;
    view.querySelector('#listaUs').innerHTML = `
      <div class="tabela"><table>
        <thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Ramal</th><th>Carteiras</th><th>Último acesso</th><th>Status</th><th></th></tr></thead>
        <tbody>${lista.map((u) => `
          <tr>
            <td><b>${esc(u.nome)}</b></td><td class="mono">${esc(u.login)}</td><td>${esc(u.perfil)}</td><td>${esc(u.ramal) || '-'}</td>
            <td style="font-size:12px">${u.perfil !== 'operador' ? '<span class="muted">Todas</span>'
    : (u.carteiras.length ? u.carteiras.map((id) => esc(nomeCart(id))).join(', ') : '<span class="muted">Todas</span>')}</td>
            <td>${dataHora(u.ultimo_acesso) || '-'}</td>
            <td>${u.ativo ? badge('ATIVO', 'Ativo') : badge('CANCELADO', 'Inativo')}</td>
            <td class="dir"><button class="btn sm" data-editar="${u.id}">Editar</button></td>
          </tr>`).join('')}</tbody>
      </table></div>`;
    view.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => formUsuario(lista.find((u) => String(u.id) === b.dataset.editar), carteiras, carregar)));
    view.querySelector('#novoUs').onclick = () => formUsuario(null, carteiras, carregar);
  };
  await carregar();
}

function formUsuario(u, carteiras, aoSalvar) {
  const v = u || { perfil: 'operador', ativo: 1, carteiras: [] };
  const m = modal(u ? 'Editar usuário' : 'Novo usuário', `
    <form id="fUs">
      <div class="linha">
        <div class="campo"><label>Nome *</label><input name="nome" value="${esc(v.nome)}"></div>
        <div class="campo"><label>Login *</label><input name="login" value="${esc(v.login)}" ${u ? 'disabled' : ''}></div>
      </div>
      <div class="linha">
        <div class="campo"><label>${u ? 'Nova senha (deixe em branco para manter)' : 'Senha * (mín. 6)'}</label><input type="password" name="senha" autocomplete="new-password"></div>
        <div class="campo"><label>Perfil</label><select name="perfil">
          ${['operador', 'supervisor', 'admin'].map((p) => `<option ${v.perfil === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="campo"><label>Ramal (discador)</label><input name="ramal" value="${esc(v.ramal)}"></div>
      </div>
      <h3>Carteiras que o operador pode trabalhar</h3>
      <p class="muted" style="font-size:12px; margin-top:0">Nenhuma marcada = todas as carteiras ativas.</p>
      ${carteiras.map((c) => `<label class="check"><input type="checkbox" name="carteiras" data-lista value="${c.id}" ${v.carteiras.includes(c.id) ? 'checked' : ''}> ${esc(c.nome)}</label>`).join('')}
      <label class="check" style="margin-top:12px"><input type="checkbox" name="ativo" ${v.ativo ? 'checked' : ''}> Usuário ativo</label>
    </form>`, { rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okUs">Salvar</button>' });
  m.$('#okUs').addEventListener('click', (e) => acao(async () => {
    const dados = lerForm(m.$('#fUs'));
    if (u) await api('PUT', `/api/usuarios/${u.id}`, dados);
    else await api('POST', '/api/usuarios', dados);
    m.fechar();
    toast('Usuário salvo.', 'ok');
    await aoSalvar();
  }, e.target));
}

// ============================================================== TABULAÇÕES
const TIPOS = {
  SEM_CONTATO: 'Sem contato', CONTATO: 'Contato com terceiro', CPC: 'CPC (falou com devedor)',
  PROMESSA: 'Promessa de pagamento', ACORDO: 'Acordo', RECUSA: 'Recusa',
};

export async function viewTabulacoes(view) {
  view.innerHTML = `
    <div class="toolbar"><h1>Tabulações (ocorrências)</h1><span class="espaco"></span><button class="btn primary" id="novaTab">+ Nova tabulação</button></div>
    <div class="alerta info">
      <b>Sem contato</b> volta para a fila após o tempo de reciclagem curto; <b>contato/CPC</b> após o tempo longo
      (ver Configurações). Tabulações com agendamento prendem o devedor ao operador até a data do retorno.
    </div>
    <div id="listaTab"></div>`;
  const carregar = async () => {
    const lista = await api('GET', '/api/tabulacoes');
    view.querySelector('#listaTab').innerHTML = `
      <div class="tabela"><table>
        <thead><tr><th>Código</th><th>Descrição</th><th>Tipo</th><th>Exige agendamento</th><th>Invalida telefone</th><th>Encerra devedor</th><th>Status</th><th></th></tr></thead>
        <tbody>${lista.map((t) => `
          <tr>
            <td class="mono">${esc(t.codigo)}</td><td><b>${esc(t.descricao)}</b></td><td>${badge(t.tipo, TIPOS[t.tipo])}</td>
            <td>${t.exige_agendamento ? 'Sim' : '-'}</td><td>${t.invalida_telefone ? 'Sim' : '-'}</td><td>${t.finaliza ? 'Sim' : '-'}</td>
            <td>${t.ativa ? badge('ATIVO', 'Ativa') : badge('CANCELADO', 'Inativa')}</td>
            <td class="dir"><button class="btn sm" data-editar="${t.id}">Editar</button></td>
          </tr>`).join('')}</tbody>
      </table></div>`;
    view.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => formTabulacao(lista.find((t) => String(t.id) === b.dataset.editar), carregar)));
  };
  view.querySelector('#novaTab').addEventListener('click', () => formTabulacao(null, carregar));
  await carregar();
}

function formTabulacao(t, aoSalvar) {
  const v = t || { tipo: 'SEM_CONTATO', ativa: 1 };
  const m = modal(t ? 'Editar tabulação' : 'Nova tabulação', `
    <form id="fTab">
      <div class="linha">
        <div class="campo"><label>Código *</label><input name="codigo" value="${esc(v.codigo)}"></div>
        <div class="campo" style="flex:2"><label>Descrição *</label><input name="descricao" value="${esc(v.descricao)}"></div>
      </div>
      <div class="campo"><label>Tipo</label><select name="tipo">
        ${Object.entries(TIPOS).map(([k, n]) => `<option value="${k}" ${v.tipo === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" name="exige_agendamento" ${v.exige_agendamento ? 'checked' : ''}> Exige data de agendamento/retorno</label>
      <label class="check"><input type="checkbox" name="invalida_telefone" ${v.invalida_telefone ? 'checked' : ''}> Marca o telefone discado como inválido</label>
      <label class="check"><input type="checkbox" name="finaliza" ${v.finaliza ? 'checked' : ''}> Encerra o devedor (sai da fila definitivamente)</label>
      <label class="check"><input type="checkbox" name="ativa" ${v.ativa ? 'checked' : ''}> Ativa</label>
    </form>`, { rodape: '<button class="btn" data-fechar>Cancelar</button><button class="btn primary" id="okTab">Salvar</button>' });
  m.$('#okTab').addEventListener('click', (e) => acao(async () => {
    const dados = lerForm(m.$('#fTab'));
    if (t) await api('PUT', `/api/tabulacoes/${t.id}`, dados);
    else await api('POST', '/api/tabulacoes', dados);
    m.fechar();
    toast('Tabulação salva.', 'ok');
    await carregarSessao();
    await aoSalvar();
  }, e.target));
}

// ============================================================== RELATÓRIOS
export async function viewRelatorios(view) {
  const rels = [
    ['acionamentos', 'Acionamentos', 'Todos os acionamentos do período com operador, telefone, tabulação e observação.'],
    ['produtividade', 'Produtividade por operador', 'Acionamentos, CPC, acordos, valor acordado e valor recebido por operador.'],
    ['acordos', 'Acordos', 'Acordos formalizados no período com valores, desconto, parcelas e status.'],
    ['parcelas', 'Parcelas (previsão / recebimento)', 'Parcelas com vencimento no período: abertas, pagas e canceladas.'],
  ];
  view.innerHTML = `
    <div class="toolbar"><h1>Relatórios</h1></div>
    <form class="card linha" id="fRel" style="margin-bottom:16px">
      <div class="campo" style="margin:0"><label>De</label><input type="date" name="data_ini" value="${primeiroDiaMes()}"></div>
      <div class="campo" style="margin:0"><label>Até</label><input type="date" name="data_fim" value="${hoje()}"></div>
      <div class="campo" style="margin:0"><label>Carteira</label><select name="carteira_id"><option value="">Todas</option>${opcoesCarteiras()}</select></div>
    </form>
    <div class="grid g2">${rels.map(([id, titulo, desc]) => `
      <div class="card">
        <h2>${titulo}</h2><p class="muted">${desc}</p>
        <button class="btn primary" data-rel="${id}">⬇ Baixar CSV (Excel)</button>
      </div>`).join('')}
    </div>`;
  view.querySelectorAll('[data-rel]').forEach((b) => b.addEventListener('click', () => {
    const p = new URLSearchParams(lerForm(view.querySelector('#fRel')));
    window.location.href = `/api/relatorios/${b.dataset.rel}?${p}`;
  }));
}

// ============================================================== CONFIGURAÇÕES
export async function viewConfig(view) {
  const cfg = await api('GET', '/api/config');
  const exemploPop = `${location.origin}/api/discador/screenpop?key=${cfg.discador_api_key}&ramal={RAMAL}&numero={NUMERO}`;
  view.innerHTML = `
    <div class="toolbar"><h1>Configurações</h1></div>
    <form id="fCfg" class="grid g2">
      <div class="card">
        <h2>Geral</h2>
        <div class="campo"><label>Nome da empresa</label><input name="empresa_nome" value="${esc(cfg.empresa_nome)}"></div>
        <h2 style="margin-top:20px">Fila de trabalho</h2>
        <div class="linha">
          <div class="campo"><label>Reciclagem "sem contato" (horas)</label><input type="number" step="0.25" min="0" name="reciclagem_sem_contato_horas" value="${esc(cfg.reciclagem_sem_contato_horas)}"></div>
          <div class="campo"><label>Reciclagem "com contato" (horas)</label><input type="number" step="0.25" min="0" name="reciclagem_contato_horas" value="${esc(cfg.reciclagem_contato_horas)}"></div>
        </div>
        <div class="campo"><label>Tempo de reserva do devedor para o operador (minutos)</label><input type="number" min="1" name="lock_minutos" value="${esc(cfg.lock_minutos)}"></div>
      </div>
      <div class="card">
        <h2>Integração com discador / telefonia</h2>
        <div class="campo"><label>Modo de discagem ao clicar em "Ligar"</label>
          <select name="discador_modo">
            ${[['tel', 'tel: (softphone padrão do Windows, ex.: MicroSIP, Zoiper)'], ['sip', 'sip: (softphone SIP)'],
    ['callto', 'callto:'], ['webhook', 'Webhook HTTP (API do discador / PABX)'], ['nenhum', 'Nenhum (discagem manual)']]
    .map(([k, n]) => `<option value="${k}" ${cfg.discador_modo === k ? 'selected' : ''}>${n}</option>`).join('')}
          </select></div>
        <div class="campo"><label>URL do webhook (variáveis: {numero} {ramal} {login} {cpf} {devedor_id})</label>
          <input name="discador_url" value="${esc(cfg.discador_url)}"></div>
        <div class="campo"><label>Chave de API para o discador (screen pop)</label>
          <div class="linha"><input name="discador_api_key" value="${esc(cfg.discador_api_key)}" style="flex:1"><button type="button" class="btn" id="novaChave">Gerar nova</button></div></div>
        <div class="alerta info" style="font-size:12px">
          <b>Screen pop:</b> configure o discador (preditivo/power) para chamar esta URL quando atender uma ligação;
          a ficha do devedor abre sozinha na tela do operador daquele ramal:<br>
          <code style="word-break:break-all">${esc(exemploPop)}</code><br>
          Também aceita <code>&cpf=</code> ou <code>&devedor_id=</code> no lugar de <code>numero</code>.
          Para alimentar o discador, use o botão <b>Mailing</b> em Carteiras.
        </div>
      </div>
      <div style="grid-column:1/-1"><button class="btn primary lg">Salvar configurações</button></div>
    </form>`;
  view.querySelector('#novaChave').addEventListener('click', () => {
    const arr = crypto.getRandomValues(new Uint8Array(12));
    view.querySelector('[name=discador_api_key]').value = [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
  view.querySelector('#fCfg').addEventListener('submit', (e) => {
    e.preventDefault();
    acao(async () => {
      await api('PUT', '/api/config', lerForm(e.target));
      await carregarSessao();
      toast('Configurações salvas.', 'ok');
      await viewConfig(view);
    }, e.submitter);
  });
}
