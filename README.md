# VirtuaNosso - CRM de Cobrança (versão de teste)

Sistema para call center de cobrança, inspirado no **Virtúa Cobrança**: gestão de carteiras de inadimplentes,
fila de trabalho dos operadores, acionamentos (tabulações), simulação e formalização de acordos, baixa de parcelas,
agenda de retornos, integração com discador e painel da supervisão.

Não tem dependências externas: basta o **Node.js 22.13 ou mais novo** (testado no Node 24). O banco é SQLite, e fica em `data/virtua.db`.

## Como rodar

```powershell
cd C:\Users\alesi\virtuanosso
npm start
```

Abra `http://localhost:3000`. O terminal também mostra o endereço **na rede** (ex.: `http://192.168.0.47:3000`),
que é o que os operadores usam nos PCs deles. Na primeira execução, o Windows pode pedir para liberar o Node no firewall.
Aceite para a rede privada.

Logins de demonstração (criados automaticamente com 2 carteiras e 120 devedores fictícios):

| Usuário      | Senha     | Perfil      |
|--------------|-----------|-------------|
| `admin`      | `admin123`| Administrador |
| `supervisor` | `super123`| Supervisor  |
| `operador1`..`operador3` | `123456` | Operador (ramais 1001 a 1003) |

Para apagar tudo e começar do zero: pare o servidor e rode `npm run reset`.

## Módulos

**Operador**
- **Atendimento**: botão *Próximo cliente* (ou tecla F2) puxa o próximo devedor da fila. Dois operadores nunca recebem o mesmo devedor.
  A ficha mostra os dados cadastrais, os telefones (com botão *Ligar*), as dívidas atualizadas (multa, juros e honorários),
  o simulador de acordo, o registro do acionamento e o histórico.
- **Buscar devedor** por CPF/CNPJ, nome, telefone ou contrato.
- **Agenda** de retornos e promessas. Os retornos vencidos voltam primeiro na fila do próprio operador.
- **Acordos**: os acordos do operador, com as parcelas.

**Supervisão**
- **Painel**: operadores online e o cliente que cada um está atendendo, acionamentos, CPC, acordos, valor acordado,
  recebido, TMA (tempo médio de atendimento), tabulações e volume por hora. Atualiza a cada 30 segundos.
- **Carteiras**: distribuir devedores entre operadores e exportar o *mailing* (CSV) para o discador.
- **Baixa de parcelas**, estorno, quebra e cancelamento de acordo (na ficha do devedor).
- **Relatórios** em CSV (abrem no Excel): acionamentos, produtividade, acordos e parcelas.
- **Alçada**: o supervisor pode formalizar acordos acima do desconto e das parcelas máximas da carteira; o operador não pode.

**Administração**
- **Carteiras**: credor, juros ao mês, multa, honorários, desconto máximo, parcelas máximas e entrada mínima.
  Importação de devedores por CSV (use o botão *Modelo de importação*).
- **Usuários**: perfis, ramal e quais carteiras cada operador pode trabalhar.
- **Tabulações**: códigos de ocorrência. Cada uma pode exigir agendamento, invalidar o telefone ou encerrar o devedor.
- **Configurações**: modo de discagem, tempo de reciclagem da fila e chave da API do discador.

## Regras da fila

1. Primeiro vêm os retornos agendados do próprio operador que já venceram.
2. Depois, os devedores com menos tentativas e há mais tempo sem acionamento.
3. Uma tabulação *sem contato* devolve o devedor à fila depois de 2 horas; *com contato* ou CPC, depois de 24 horas (dá para mudar em Configurações).
4. Devedores sem telefone válido, em acordo, quitados ou encerrados não entram na fila.
5. Um devedor distribuído para um operador só aparece na fila daquele operador.

## Integração com discador / telefonia

- **Clique para ligar** (`tel:` ou `sip:`): o botão *Ligar* abre o softphone instalado no PC (MicroSIP, Zoiper, etc.).
- **Webhook**: o servidor chama a URL da API do seu discador ou PABX, por exemplo
  `http://discador/api/call?ramal={ramal}&numero={numero}`.
- **Screen pop** (discador preditivo): quando a ligação conecta, o discador chama
  `GET /api/discador/screenpop?key=CHAVE&ramal=1001&numero=11999998888` e a ficha abre sozinha na tela do operador daquele ramal.
  A URL exata aparece em *Configurações*.
- **Mailing**: exporte o CSV da carteira e suba no discador.

## Importação (CSV)

Uma linha por dívida, com separador `;` ou `,` e cabeçalho na primeira linha. Arquivos salvos pelo Excel (ANSI) e em UTF-8 são aceitos.

- Colunas obrigatórias: `cpf`, `nome`, `valor`, `vencimento` (no formato `dd/mm/aaaa`).
- Colunas opcionais: `contrato`, `descricao`, `telefone1`, `telefone2`, ..., `email`, `endereco`, `cidade`, `uf`, `cep`, `data_nasc`.

Se o mesmo CPF aparecer em várias linhas, vira um único devedor com várias dívidas. Reimportar o mesmo arquivo não duplica as dívidas:
o sistema compara contrato + vencimento.

## Antes de colocar em produção (100 operadores)

Esta é uma versão de **teste/piloto**. Para a operação completa, planeje:

- **Servidor dedicado**, ligado o tempo todo, com **backup diário** da pasta `data/`. O SQLite com WAL aguenta bem 100 usuários
  numa rede local. Se o volume crescer muito, dá para migrar para PostgreSQL.
- **HTTPS** (atrás de um proxy como Nginx ou Caddy) se o acesso for fora da rede interna.
- **LGPD**: controle de acesso por carteira (já existe), senhas fortes, e troca das senhas de demonstração.
- **Integração real com o seu discador**: confirme com o fornecedor qual API ele oferece (webhook, screen pop, mailing).
- **Boletos / Pix**: integração com o banco para gerar as parcelas dos acordos (ainda não implementado).
- **SMS / WhatsApp / e-mail**: régua de cobrança automática (ainda não implementado).
- **Piloto**: comece com 5 a 10 operadores em uma carteira, rodando em paralelo com o Virtúa, e compare os números no Painel.
