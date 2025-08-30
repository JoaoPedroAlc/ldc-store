const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ExcelJS = require('exceljs');
const { setupComandosRobux } = require('./Sistemadevendas'); // importa comandos
const { setupComandosgeral } = require('./geral');
//const logMensagemPrivada = require('./log'); //LOG
const { handleCommand, handleMessage } = require('./responder'); //RESPONDER CLIENTES
const comprarBot = require('./comprar');
const { handleSetStock, aplicarEstoqueAgendado } = require("./utilidades");




const tentativasValor = {}; // Novo objeto para rastrear tentativas
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessao-bot' }),
    puppeteer: {
        headless: false,
        args: ['--no-sandbox']
    }
});

let sorteioAtivo = false;
let participantes = [];
let nomeSorteio = "";
let quantidadeGanhadores = 1;
let timeoutSorteio = null;
let horaFimSorteio = null;
const HISTORICO_FILE = 'historico.json';
const RANKING_FILE = 'ranking.json';
const INFO_FILE = 'info.json';
const VENDAS_FILE = 'vendas.json';
const CUSTO_FILE = path.resolve(__dirname, "custo.json");
const aguardandoAdmin = {};
let aguardandoRespostaAdmin = null;
let rankingCache = {};
let aguardandoValor = {}; // Coloque isso no início do seu script
const aguardandoVenda = {};
const aguardandoDelecao = {};
const info = carregarCusto(); // deve conter info.custo100 (valor que você paga por 100 robux)
const vendas = carregarVendas(); // array de vendas
const { recalcularRankCompras} = require('./Sistemadevendas');
const totalRobuxSemTaxa = vendas.reduce((acc, v) => acc + (v.robux_sem_taxa || 0), 0);
const custoEstimado = (totalRobuxSemTaxa / 100) * (info.custo100 || 0);
const FILA_FILE = 'fila.json';
// Inicializar módulos
comprarBot(client);
//Bem vindo
const { setupBemvindo } = require('./bemvindo');
setupBemvindo(client);

const { setupAnunciar } = require('./anunciar');
setupAnunciar(client); // usa os defaults
//COMANDO GIFT:
const { setupComandoGift } = require("./comandoauxiliar");
setupComandoGift(client);


setupComandosRobux(client);
setupComandosgeral(client);

console.log("Custo estimado:", custoEstimado);


if (!fs.existsSync(FILA_FILE)) fs.writeFileSync(FILA_FILE, '[]');
if (!fs.existsSync(HISTORICO_FILE)) fs.writeFileSync(HISTORICO_FILE, '[]');
if (!fs.existsSync(RANKING_FILE)) fs.writeFileSync(RANKING_FILE, '{}');

if (!fs.existsSync(VENDAS_FILE)) fs.writeFileSync(VENDAS_FILE, '[]');

//fila clientes
function carregarFila() {
    try {
        return JSON.parse(fs.readFileSync(FILA_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function salvarFila(fila) {
    fs.writeFileSync(FILA_FILE, JSON.stringify(fila, null, 2));
}


// Função para carregar vendas
function carregarVendas() {
    try {
      if (!fs.existsSync(VENDAS_FILE)) return [];
      const data = fs.readFileSync(VENDAS_FILE, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

// Função para salvar vendas
function salvarVendas(vendas) {
    fs.writeFileSync(VENDAS_FILE, JSON.stringify(vendas, null, 2));
  }
  
  // Função para carregar custo
  function carregarCusto() {
    try {
      if (!fs.existsSync(CUSTO_FILE)) return { valor100: null };
      const data = fs.readFileSync(CUSTO_FILE, "utf-8");
      return JSON.parse(data);
    } catch {
      return { valor100: null };
    }
  }
  
  // Função para salvar custo
  function salvarCusto(custo) {
    fs.writeFileSync(CUSTO_FILE, JSON.stringify(custo, null, 2));
  }
  
  // Função para exportar uma lista de vendas para um arquivo XLSX estilizado
async function exportarVendasXLSX(vendas, caminhoArquivo) {
    const custo = carregarCusto();
    const custoRobux = custo?.valor100 ?? 0;
  
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Vendas");
  
    // Configurar colunas com largura e cabeçalho
    sheet.columns = [
      { header: "Data", key: "data", width: 25 },
      { header: "Valor Reais", key: "valor_reais", width: 15 },
      { header: "Robux Sem Taxa", key: "robux_sem_taxa", width: 18 },
      { header: "Robux Com Taxa", key: "robux_com_taxa", width: 18 },
      { header: "Lucro Líquido (R$)", key: "lucro_liquido", width: 20 },
      { header: "Lucro (%)", key: "lucro_percent", width: 15 },
    ];
  
    // Estilo cabeçalho: negrito, fundo azul, texto branco, centralizado
    sheet.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2F75B5" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    });
  
    // Acumular totais para resumo
    let totalReais = 0;
    let totalRobuxSemTaxa = 0;
    let totalRobuxComTaxa = 0;
    let totalLucro = 0;
  
    // Preencher dados das vendas e formatar células
    vendas.forEach(v => {
      const valor = v.valor_reais || 0;
      const robux = v.robux_sem_taxa || 0;
      const lucro_liquido = valor - (robux / 100) * custoRobux;
      const lucro_percent = valor === 0 ? 0 : (lucro_liquido / valor);
  
      totalReais += valor;
      totalRobuxSemTaxa += robux;
      totalRobuxComTaxa += v.robux_com_taxa || 0;
      totalLucro += lucro_liquido;
  
      const row = sheet.addRow({
        data: new Date(v.data).toLocaleString("pt-BR"),
        valor_reais: valor,
        robux_sem_taxa: robux,
        robux_com_taxa: v.robux_com_taxa || 0,
        lucro_liquido: lucro_liquido,
        lucro_percent: lucro_percent,
      });
  
      row.getCell("valor_reais").numFmt = '"R$"#,##0.00';
      row.getCell("lucro_liquido").numFmt = '"R$"#,##0.00';
      row.getCell("lucro_percent").numFmt = "0.00%";
  
      row.eachCell(cell => {
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
    });
  
    // Linha em branco
    sheet.addRow({});
  
    // Linha resumo
    const lucroTotalPercent = totalReais === 0 ? 0 : totalLucro / totalReais;
  
    const resumoRow = sheet.addRow({
      data: "RESUMO",
      valor_reais: totalReais,
      robux_sem_taxa: totalRobuxSemTaxa,
      robux_com_taxa: totalRobuxComTaxa,
      lucro_liquido: totalLucro,
      lucro_percent: lucroTotalPercent,
    });
  
    resumoRow.eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD9D9D9" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    });
  
    // Salva arquivo
    await workbook.xlsx.writeFile(caminhoArquivo);
  }
  
  // Função que gera os 4 arquivos separados
  async function exportarTodasVendasXLSX(todasVendas) {
    const pastaExportacao = path.resolve(__dirname, "exportacoes");
    if (!fs.existsSync(pastaExportacao)) fs.mkdirSync(pastaExportacao);
  
    const periodos = [
      { nome: "hoje", vendas: filtrarVendasPorPeriodo(todasVendas, "hoje") },
      { nome: "semana", vendas: filtrarVendasPorPeriodo(todasVendas, "semana") },
      { nome: "mes", vendas: filtrarVendasPorPeriodo(todasVendas, "mes") },
      { nome: "total", vendas: todasVendas },
    ];
  
    for (const periodo of periodos) {
      const nomeArquivo = `vendas_${periodo.nome}_${Date.now()}.xlsx`;
      const caminhoCompleto = path.join(pastaExportacao, nomeArquivo);
      await exportarVendasXLSX(periodo.vendas, caminhoCompleto);
      console.log(`✅ Arquivo gerado: ${nomeArquivo}`);
    }
  }
function salvarVenda(venda) {
    try {
        let vendas = [];

        if (fs.existsSync(VENDAS_FILE)) {
            vendas = JSON.parse(fs.readFileSync(VENDAS_FILE));
        }

        vendas.push({ ...venda, data: new Date().toISOString() });
        fs.writeFileSync(VENDAS_FILE, JSON.stringify(vendas, null, 2));
        console.log("📝 Venda registrada com sucesso.");
    } catch (e) {
        console.error("Erro ao salvar venda:", e);
    }
}

// Função para filtrar vendas por data (exemplo: hoje, semana, mês)
function filtrarVendasPorPeriodo(vendas, periodo) {
    const agora = new Date();
    return vendas.filter(venda => {
      const dataVenda = new Date(venda.data);
      if (periodo === "hoje") {
        return dataVenda.toDateString() === agora.toDateString();
      } else if (periodo === "semana") {
        const primeiroDiaSemana = new Date(agora);
        primeiroDiaSemana.setDate(agora.getDate() - agora.getDay());
        return dataVenda >= primeiroDiaSemana && dataVenda <= agora;
      } else if (periodo === "mes") {
        return dataVenda.getMonth() === agora.getMonth() && dataVenda.getFullYear() === agora.getFullYear();
      }
      return true;
    });
  }
  

 // Função para calcular resumo das vendas com logs para depuração
function calcularResumo(vendas, custoRobux) {
    let totalReais = 0;
    let totalRobuxSemTaxa = 0;
    let totalRobuxComTaxa = 0;
  
    for (const v of vendas) {
      totalReais += v.valor_reais || 0;
      totalRobuxSemTaxa += v.robux_sem_taxa || 0;
      totalRobuxComTaxa += v.robux_com_taxa || 0;
    }
  
    const custoTotal = custoRobux && totalRobuxSemTaxa
      ? (totalRobuxSemTaxa / 100) * custoRobux
      : 0;
  
    const lucroLiquido = totalReais - custoTotal;
  
    const porcentagemLucro = custoTotal > 0
      ? (lucroLiquido / custoTotal) * 100
      : 0;
  
    // Logs para depurar os valores
    console.log("=== Depuração do Resumo ===");
    console.log("Total em Reais (vendas):", totalReais.toFixed(2));
    console.log("Total Robux sem taxa:", totalRobuxSemTaxa);
    console.log("Custo por 100 Robux (R$):", custoRobux.toFixed(2));
    console.log("Custo total calculado (R$):", custoTotal.toFixed(2));
    console.log("Lucro líquido (R$):", lucroLiquido.toFixed(2));
    console.log("Porcentagem do lucro (%):", porcentagemLucro.toFixed(2));
    console.log("===========================");
  
    return {
      totalReais,
      totalRobuxSemTaxa,
      totalRobuxComTaxa,
      custoTotal,
      lucroLiquido,
      porcentagemLucro,
    };
  }
  
  // Função para exibir menu admin inicial
  function menuAdmin() {
    return `📊 *Painel Administrativo de Vendas*
  
  Escolha uma opção digitando o número:
  
  1️⃣ Vendas de hoje  
  2️⃣ Vendas da semana  
  3️⃣ Vendas do mês  
  4️⃣ Total geral de vendas  
  5️⃣ Exportar vendas (.txt)  
  6️⃣ Limpar todas as vendas  
  7️⃣ Ver valor atual do custo por 100 Robux  
  8️⃣ Atualizar valor de custo dos Robux  
  9️⃣ Exportar vendas (.xlsx)
  🔟 Gerenciar fila de entrega
  
  ❌ Digite *cancelar* para sair.`;
  }
  
  // Handler do comando admin
  async function handleVendasAdmin(msg, texto) {
    const from = msg.from;
  
    if (!aguardandoAdmin[from]) {
      aguardandoAdmin[from] = { etapa: "menu" };
      return msg.reply(menuAdmin());
    }
  
    const adminState = aguardandoAdmin[from];
    const input = texto.trim().toLowerCase();
  
    if (input === "cancelar") {
      delete aguardandoAdmin[from];
      return msg.reply("❌ Operação cancelada.");
    }
  
    // Carrega vendas e custo
    const vendas = carregarVendas();
    const custo = carregarCusto();
    const custoRobux = custo?.valor100 ?? 0;
  
    if (adminState.etapa === "menu") {
      switch (input) {
        case "1":
        case "2":
        case "3":
          {
            const periodo = input === "1" ? "hoje" : input === "2" ? "semana" : "mes";
            const vendasFiltradas = filtrarVendasPorPeriodo(vendas, periodo);
  
            if (vendasFiltradas.length === 0) {
              return msg.reply(`Nenhuma venda registrada no período: ${periodo}`);
            }
  
            const resumo = calcularResumo(vendasFiltradas, custoRobux);
  
            return msg.reply(
              `📅 Vendas ${periodo}:\n` +
                `💰 Total em Reais: R$ ${resumo.totalReais.toFixed(2)}\n` +
                `🎮 Total Robux sem taxa: ${resumo.totalRobuxSemTaxa}\n` +
                `🎯 Total Robux com taxa: ${resumo.totalRobuxComTaxa}\n` +
                `💸 Custo estimado: R$ ${resumo.custoTotal.toFixed(2)}\n` +
                `📈 Lucro líquido: R$ ${resumo.lucroLiquido.toFixed(2)} (${resumo.porcentagemLucro.toFixed(2)}%)`
            );
          }
        case "4":
          {
            if (vendas.length === 0) return msg.reply("Nenhuma venda registrada.");
  
            const resumoTotal = calcularResumo(vendas, custoRobux);
  
            return msg.reply(
              `📊 Total Geral de Vendas:\n` +
                `💰 Total em Reais: R$ ${resumoTotal.totalReais.toFixed(2)}\n` +
                `🎮 Total Robux sem taxa: ${resumoTotal.totalRobuxSemTaxa}\n` +
                `🎯 Total Robux com taxa: ${resumoTotal.totalRobuxComTaxa}\n` +
                `💸 Custo estimado: R$ ${resumoTotal.custoTotal.toFixed(2)}\n` +
                `📈 Lucro líquido: R$ ${resumoTotal.lucroLiquido.toFixed(2)} (${resumoTotal.porcentagemLucro.toFixed(2)}%)`
            );
          }
        case "5":
          {
            if (vendas.length === 0) return msg.reply("Nenhuma venda para exportar.");
  
            const caminhoTxt = path.resolve(__dirname, `vendas_export_${Date.now()}.txt`);
            exportarVendasTXT(vendas, caminhoTxt); // implemente esta função
            return msg.reply(`✅ Exportação para TXT realizada:\n${caminhoTxt}`);
          }
        case "6":
          aguardandoAdmin[from].etapa = "confirmar_limpar";
          return msg.reply(
            "⚠️ Tem certeza que deseja *limpar todas as vendas*? Digite *SIM* para confirmar ou *NÃO* para cancelar."
          );
        case "7":
          return msg.reply(`💵 Valor atual de custo por 100 Robux: R$ ${custoRobux.toFixed(2)}`);
  
        case "8":
          aguardandoAdmin[from].etapa = "atualizar_custo";
          return msg.reply("Digite o novo valor de custo por 100 Robux (ex: 2.30):");
  
        case "9":
            if (vendas.length === 0) return msg.reply("Nenhuma venda para exportar.");
            await exportarTodasVendasXLSX(vendas);
            return msg.reply("✅ Exportação completa: 4 arquivos XLSX gerados na pasta /exportacoes.");
        case "10":
                aguardandoAdmin[from].etapa = "fila_menu";
                return msg.reply(`📦 *Gerenciamento da Fila de Entrega*
              
              Escolha uma opção:
              1️⃣ Adicionar cliente à fila  
              2️⃣ Remover cliente da fila  
              3️⃣ Exibir fila atual
              
              Digite *1*, *2* ou *3*.`);  
        default:
          return msg.reply("❌ Opção inválida. Digite um número entre 1 e 9.");
      }
    }
// Gerenciar Fila
if (adminState.etapa === "fila_menu") {
    if (input === "1") {
        aguardandoAdmin[from] = { etapa: "fila_adicionar_telefone", filaTemp: {} };
        return msg.reply("📞 Digite o *número de telefone* do cliente.\n\nExemplo: +55 81 9160-7987");
    } else if (input === "2") {
        const fila = carregarFila();
        if (fila.length === 0) {
            delete aguardandoAdmin[from];
            return msg.reply("📭 A fila está vazia.");
        }

        let mensagem = `🗑️ *Fila Atual*\n\n`;
        fila.forEach((item, i) => {
            mensagem += `*${i + 1}.* ${item.telefone} - ${item.robux} Robux - ${item.link_or_username}\n`;
        });
        mensagem += `\n✏️ Digite o *número* do cliente que deseja remover.`;

        aguardandoAdmin[from].etapa = "fila_remover";
        return msg.reply(mensagem);
    } else if (input === "3") {
        const fila = carregarFila();
        if (fila.length === 0) {
            delete aguardandoAdmin[from];
            return msg.reply("📭 A fila está vazia.");
        }

        let mensagem = `📋 *Fila de Entrega Atual*\n\n`;
        fila.forEach((item, i) => {
            mensagem += `*${i + 1}.* ${item.telefone} - ${item.robux} Robux - ${item.link_or_username}\n`;
        });

        delete aguardandoAdmin[from];
        return msg.reply(mensagem);
    } else {
        return msg.reply("❌ Opção inválida. Digite *1*, *2* ou *3*.");
    }
}

// Etapas da adição da fila (telefone > robux > link/username)
if (adminState.etapa === "fila_adicionar_telefone") {
    if (!input.startsWith("+") || input.length < 10) {
        return msg.reply("❌ Número inválido. Exemplo de formato: +55 81 9160-7987");
    }
    aguardandoAdmin[from].filaTemp.telefone = input;
    aguardandoAdmin[from].etapa = "fila_adicionar_robux";
    return msg.reply("🎮 Digite a *quantidade de Robux* comprada:");
}

if (adminState.etapa === "fila_adicionar_robux") {
    const robux = parseInt(input);
    if (isNaN(robux) || robux <= 0 || robux > 100000) {
        return msg.reply("❌ Quantidade inválida. Digite um número entre 1 e 100000.");
    }
    aguardandoAdmin[from].filaTemp.robux = robux;
    aguardandoAdmin[from].etapa = "fila_adicionar_link";
    return msg.reply("🔗 Agora envie o *link do Game Pass* ou o *username do cliente*:");
}

if (adminState.etapa === "fila_adicionar_link") {
    const fila = carregarFila();
    const custo = carregarCusto();
    const valor100 = custo?.valor100 || 3.6;

    const { telefone, robux } = aguardandoAdmin[from].filaTemp;

    fila.push({
        telefone,
        robux,
        link_or_username: input
    });

    salvarFila(fila);

    const robuxComTaxa = Math.ceil(robux / 0.7);
    const valorReais = (robux / 100) * valor100;
    const custoTotal = (robux / 100) * valor100;
    const lucroLiquido = valorReais - custoTotal;
    const lucroPorcentagem = custoTotal > 0 ? (lucroLiquido / custoTotal) * 100 : 0;

    salvarVenda({
        telefone,
        robux_sem_taxa: robux,
        robux_com_taxa: robuxComTaxa,
        valor_reais: valorReais,
        link_or_username: input,
        lucro_reais: lucroLiquido,
        lucro_porcentagem: lucroPorcentagem
    });

    delete aguardandoAdmin[from];

    return msg.reply(`✅ Cliente adicionado à fila e venda registrada:\n📱 ${telefone}\n🎮 ${robux} Robux\n🔗 ${input}`);
}

// Remover da fila
if (adminState.etapa === "fila_remover") {
    const index = parseInt(input);
    const fila = carregarFila();

    if (isNaN(index) || index < 1 || index > fila.length) {
        delete aguardandoAdmin[from];
        return msg.reply("❌ Número inválido. Operação cancelada.");
    }

    const removido = fila.splice(index - 1, 1)[0];
    salvarFila(fila);
    delete aguardandoAdmin[from];

    return msg.reply(`🗑️ Cliente removido:\n📱 ${removido.telefone}\n🎮 ${removido.robux} Robux\n🔗 ${removido.link_or_username}`);
}
  
    if (adminState.etapa === "atualizar_custo") {
      const novoValor = parseFloat(input.replace(",", "."));
      if (isNaN(novoValor) || novoValor <= 0) {
        delete aguardandoAdmin[from];
        return msg.reply("❌ Valor inválido. Operação cancelada.");
      }
      salvarCusto({ valor100: novoValor }); // implemente esta função
      delete aguardandoAdmin[from];
      return msg.reply(`✅ Valor de custo atualizado para R$ ${novoValor.toFixed(2)}`);
    }
  
    return msg.reply("❌ Erro inesperado. Comece novamente com /vendas admin.");
  }



function carregarInfo() {
    if (!fs.existsSync(INFO_FILE)) {
        const padrao = { stock: 0, valor100: null, proximoEstoque: null };
        fs.writeFileSync(INFO_FILE, JSON.stringify(padrao, null, 2));
        return padrao;
    }
    try {
        return JSON.parse(fs.readFileSync(INFO_FILE));
    } catch (e) {
        console.error("Erro ao carregar info.json:", e);
        return { stock: 0, valor100: null, proximoEstoque: null };
    }
}

function salvarInfo(info) {
    fs.writeFileSync(INFO_FILE, JSON.stringify(info, null, 2));
}

function carregarRanking() {
    try {
        rankingCache = JSON.parse(fs.readFileSync(RANKING_FILE));
        console.log("📊 Ranking carregado com sucesso.");
    } catch (e) {
        console.error("❌ Erro ao carregar ranking:", e);
        rankingCache = {};
    }
}

function salvarRanking() {
    fs.writeFileSync(RANKING_FILE, JSON.stringify(rankingCache, null, 2));
}

client.on('qr', qr => {
    console.log('📱 Escaneie este QR Code para conectar:');
    qrcode.generate(qr, { small: true });
});

client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
});

client.on('disconnected', reason => {
    console.warn('⚠️ Bot foi desconectado:', reason);
});

client.on('ready', async () => {
    console.log('✅ Bot está pronto!');
    aplicarEstoqueAgendado(client)
    await recalcularRankCompras(); // recalcula no início
    carregarRanking(); // agora carrega o arquivo atualizado para memória
    setInterval(async () => {
        await recalcularRankCompras();
        carregarRanking();
    }, 60 * 60 * 1000);
  
    // inicializa agendamentos abrir/fechar após bot pronto
    // a cada 10 minutos verifica todos os agendamentos e reaplica os estados (resiliência extra)
    setInterval(() => {
        for (const chatId of Object.keys(abrirFechar.configs || {})) {
        const cfg = abrirFechar.configs[chatId];
        if (!cfg || !cfg.enabled) continue;
        const shouldOpen = isNowInOpenWindow(cfg.open, cfg.close);
        abrirFechar.applyStateWithRetry(chatId, shouldOpen, false).catch(e => {});
        }
    }, 10 * 60 * 8000);
  
  });

// LOGA toda vez que alguém entra no grupo
client.on('group_join', async (notification) => {
    console.log("🚪 [EVENTO] Novo membro entrou no grupo!");
    console.log("🔹 Grupo:", notification.chatId);
    console.log("🔹 Membro:", notification.id);
  
    try {
      const { handleMemberJoin } = require('./bemvindo');
      await handleMemberJoin(client, notification);
    } catch (e) {
      console.error("❌ Erro ao processar boas-vindas:", e);
    }
  });



client.on('message', async msg => {
    const texto = msg.body.trim();
    const chat = await msg.getChat().catch(() => null);
    const text = (msg.body || "").trim();
    if (await handleSetStock(client, msg, text)) return;
    //logMensagemPrivada(client,msg); [LOG DE MENSAGEM PV]
    
    if (!chat) return;

    if (aguardandoRespostaAdmin && msg.from === aguardandoRespostaAdmin.from) {
        processarRespostaPainel(msg, chat);
        return;
    }
    // Inicializa excluir.js passando o client
    const excluir = require('./excluir');
    await excluir.handleEncerrar(client, msg);
    // Processa comando /w
    if (texto.startsWith('/w')) {
        const processed = await handleCommand(client, msg, texto);
        if (processed) return; // comando tratado
    }

    // Encaminha mensagens se estiver no modo responder
    const redirected = await handleMessage(client, msg);
    if (redirected) return; // mensagem encaminhada


    const cmd = texto.toLowerCase();
     if (texto.startsWith("/vendas admin") || aguardandoAdmin[msg.from]) {
        return handleVendasAdmin(msg, texto);
      }       
     
    else if (cmd === "/stock") {
        const info = carregarInfo();
        const valorDefinido = info.valor100 != null;
        const valorFormatado = valorDefinido ? `R$ ${info.valor100.toFixed(2)}` : "❌ Ainda não definido";
    
        const agora = new Date();
        let estoqueDisponivel = info.stock > 0;
    
        if (info.proximoEstoque) {
            const [data, hora] = info.proximoEstoque.split(" ");
            const [dia, mes, ano] = data.split("/").map(Number);
            const [horas, minutos] = hora.split(":").map(Number);
            const dataEstoque = new Date(ano, mes - 1, dia, horas, minutos);
    
            if (dataEstoque > agora) {
                estoqueDisponivel = false;
            }
        }
    
        if (!estoqueDisponivel) {
            let mensagem = `🚫 *Estoque indisponível no momento.*\n`;
            if (info.proximoEstoque) {
                mensagem += `\n📦 O próximo estoque chegará em:\n🗓️ *${info.proximoEstoque}*`;
            }
            mensagem += `\n\n💡 Enquanto isso, você pode:\n🧾 Ver valores com */valor QUANTIDADE*\n🎯 Ver o cálculo do Game Pass com */gamepass QUANTIDADE*`;
            return msg.reply(mensagem);
        }
    
        let mensagem =
    `📦 *Estoque Atual de Robux* 📦
    
    🎮 Robux disponíveis: *${info.stock}*
    💰 Valor por 100 Robux: *${valorFormatado}*`;
    
        if (info.proximoEstoque) {
            mensagem += `\n\n⚠️ *Este estoque foi agendado para:*\n🗓️ *${info.proximoEstoque}*`;
        }
    
        mensagem += `
    
    🛒 Para comprar: */comprar QUANTIDADE*
    💵 Ver valores: */valor QUANTIDADE*
    🎯 Calcular Game Pass: */gamepass QUANTIDADE*`;
    
        msg.reply(mensagem);
    }
    

    else if (cmd.startsWith("/setvalor")) {
        if (!chat.isGroup) return msg.reply("⛔ Esse comando só pode ser usado em grupo.");
        if (!(await verificarAdmin(msg, chat))) return msg.reply("⛔ Apenas administradores podem usar esse comando.");

        const partes = texto.split(" ");
        if (partes.length < 2 || isNaN(parseFloat(partes[1]))) return msg.reply("❌ Uso: /setvalor VALOR_POR_100_ROBUX");

        const valor = parseFloat(partes[1]);
        const info = carregarInfo();
        info.valor100 = valor;
        salvarInfo(info);

        msg.reply(`💰 Valor atualizado para *R$ ${valor.toFixed(2)}* por 100 Robux.`);
    }
    else if (cmd.startsWith("/valor")) {
        if (texto.trim().toLowerCase() !== "/valor") {
            return msg.reply("❌ Use apenas */valor* (sem argumentos) para iniciar.");
        }
        
        // Verifica se já há uma sessão ativa para este usuário
        if (aguardandoValor[msg.from]) {
            const tempoDecorrido = Math.floor((Date.now() - aguardandoValor[msg.from].timestamp) / 1000);
            const tempoRestante = 120 - tempoDecorrido;
            return msg.reply(`⌛ Você já tem uma conversão ativa! (Tempo restante: ${tempoRestante}s)`);
        }
        
        // Inicia nova sessão com estrutura completa
        aguardandoValor[msg.from] = {
            etapa: "tipo",
            timestamp: Date.now(),
            tentativas: 0,
            chatOrigem: msg.from,
            timeout: setTimeout(() => {
                if (aguardandoValor[msg.from]) {
                    client.sendMessage(msg.from, "⏳ Tempo esgotado! Digite */valor* novamente se precisar.");
                    delete aguardandoValor[msg.from];
                }
            }, 120000)
        };
        
        msg.reply(
    `🔄 *Conversão de Valores* (2 minutos para responder)
    
    Você quer converter a partir de:
    1️⃣ Robux para Reais  
    2️⃣ Reais para Robux  
    
    ✏️ Digite *1* ou *2* para escolher a opção.
    💡 Digite *cancelar* a qualquer momento para sair.`
        );
        return;
    }
    
    // Processamento das respostas do /valor
    if (aguardandoValor[msg.from]) {
        const session = aguardandoValor[msg.from];
        
        // Verificação robusta de origem
        if (msg.from !== session.chatOrigem) {
            return; // Ignora mensagens de outros chats
        }
        
        // Verifica timeout
        if (Date.now() - session.timestamp > 120000) {
            delete aguardandoValor[msg.from];
            return msg.reply("⏳ Tempo esgotado! Use /valor novamente.");
        }
        
        // Cancelamento manual
        if (texto.toLowerCase() === "cancelar") {
            clearTimeout(session.timeout);
            delete aguardandoValor[msg.from];
            return msg.reply("❌ Conversão cancelada.");
        }
        
        // Incrementa tentativas
        session.tentativas++;
        
        // Bloqueia após 4 tentativas inválidas
        if (session.tentativas > 4) {
            clearTimeout(session.timeout);
            delete aguardandoValor[msg.from];
            return msg.reply("🚫 Limite de tentativas excedido. Espere 5 minutos.");
        }
        
        const info = carregarInfo();
        if (!info.valor100) {
            clearTimeout(session.timeout);
            delete aguardandoValor[msg.from];
            return msg.reply("⚠️ Valor não configurado. Admins devem usar /setvalor.");
        }
    
        // Etapa de escolha entre 1 ou 2
        if (session.etapa === "tipo") {
            if (texto === "1") {
                session.etapa = "robux";
                session.tentativas = 0;
                return msg.reply("🔢 Digite a quantidade de *Robux* para converter:");
            } else if (texto === "2") {
                session.etapa = "reais";
                session.tentativas = 0;
                return msg.reply("💵 Digite o valor em *Reais* para converter:");
            } else {
                return msg.reply("❌ Opção inválida. Digite *1* ou *2*:");
            }
        }
        
        // Etapa de cálculo: Robux → Reais
        if (session.etapa === "robux") {
            const robux = parseInt(texto);
            if (isNaN(robux) || robux <= 0 || robux > 100000) {
                return msg.reply("❌ Valor inválido! Digite um número entre 1-100000:");
            }
            
            const valor = (robux / 100) * info.valor100;
            clearTimeout(session.timeout);
            delete aguardandoValor[msg.from];
            return msg.reply(`💰 *${robux} Robux* = *R$ ${valor.toFixed(2)}*`);
        }
        
        // Etapa de cálculo: Reais → Robux
        if (session.etapa === "reais") {
            const reais = parseFloat(texto.replace(",", "."));
            if (isNaN(reais) || reais <= 0 || reais > 100000) {
                return msg.reply("❌ Valor inválido! Digite um número positivo:");
            }
            
            const robux = Math.floor((reais / info.valor100) * 100);
            clearTimeout(session.timeout);
            delete aguardandoValor[msg.from];
            return msg.reply(`🎮 *R$ ${reais.toFixed(2)}* = *${robux} Robux*`);
        }
    }
    

    if (cmd.startsWith("/iniciarsorteio")) {
        if (!(await verificarAdmin(msg, chat))) return msg.reply("⛔ Apenas administradores podem usar esse comando.");
        iniciarSorteio(msg, chat);
    } else if (cmd === "/sorteio") {
        entrarNoSorteio(msg);
    } else if (cmd === "/ajuda") {
        exibirAjuda(msg);
    } else if (cmd === "/cancelarsorteio") {
        if (!(await verificarAdmin(msg, chat))) return msg.reply("⛔ Apenas administradores podem usar esse comando.");
        confirmarCancelamento(msg);
    } else if (cmd === "/admin") {
        if (!(await verificarAdmin(msg, chat))) return msg.reply("⛔ Apenas administradores podem usar esse comando.");
        abrirMenuAdmin(msg, chat);
    } else if (cmd === "/liberar") {
        if (!(await verificarAdmin(msg, chat))) return msg.reply("⛔ Apenas administradores podem usar esse comando.");
        liberarGrupo(chat);
    } else if (cmd === "/silenciar") {
        if (!(await verificarAdmin(msg, chat))) return msg.reply("⛔ Apenas administradores podem usar esse comando.");
        silenciarGrupo(chat);
    } else if (cmd === "/participantes") {
        verParticipantes(chat);
    } else if (cmd === "/rank") {
        exibirRank(chat);
    } else if (cmd === "/menu") {
        exibirMenu(chat);
    } else if (cmd.startsWith("/pagamento")) {
        const partes = texto.split(" ");
        const valor = partes[1]; // valor opcional
    
        const chavePix = "12142986480";
        const caminhoPython = 'python';
        const caminhoScript = path.join(__dirname, 'qrcode3.py');
    
        const comando = valor
            ? `${caminhoPython} "${caminhoScript}" "${chavePix}" ${valor}`
            : `${caminhoPython} "${caminhoScript}" "${chavePix}"`;
    
        msg.reply("🧾 Gerando QR Code, aguarde...");
    
        exec(comando, async (err, stdout, stderr) => {
            if (err || stderr) {
                console.error("Erro ao gerar QR:", err || stderr);
                return msg.reply("❌ Erro ao gerar o QR Code.");
            }
    
            const linhas = stdout.trim().split("\n");
            const caminhoReal = linhas[0]?.trim();
            const codigoCopiaCola = linhas[1]?.trim();
    
            if (!fs.existsSync(caminhoReal)) {
                console.error("QR Code não encontrado:", caminhoReal);
                return msg.reply("❌ QR Code não encontrado.");
            }
    
            try {
                const media = MessageMedia.fromFilePath(caminhoReal);
    
                const textoPagamento = 
    `💳 *Pagamento via PIX*
    
Chave PIX: ${chavePix}
Valor: ${valor ? `R$ ${valor}` : "Valor não foi definido"}
👤 *Nome do titular:* Joao Pedro (NUBANK)

📤 *Após realizar o pagamento, envie o comprovante para um dos contatos abaixo:*
➡️ [WhatsApp +55 81 9160-7987](https://wa.me/558191607987)
➡️ [WhatsApp +55 81 9513-2076](https://wa.me/558195132076)`;
    
                await chat.sendMessage(media, { caption: textoPagamento });
    
                setTimeout(() => {
                    chat.sendMessage("🔗 *O código Copia e Cola será enviado em 1 segundo...*");
                }, 500);
    
                setTimeout(() => {
                    chat.sendMessage(`${codigoCopiaCola}`);
                }, 1500);
    
            } catch (e) {
                console.error("Erro ao enviar imagem:", e);
                msg.reply("❌ Erro ao enviar o QR Code.");
            }
        });
    }
     else if (cmd.startsWith("/qrcode")) {
        const partes = texto.split(" ");
        if (partes.length < 2) return msg.reply("❌ Uso: /qrcode CHAVE_PIX [VALOR_OPCIONAL]");
    
        const chavePix = partes[1];
        const valor = partes[2]; // valor opcional
    
        const caminhoPython = 'python';
        const caminhoScript = path.join(__dirname, 'qrcode3.py');
    
        const comando = valor
            ? `${caminhoPython} "${caminhoScript}" "${chavePix}" ${valor}`
            : `${caminhoPython} "${caminhoScript}" "${chavePix}"`;
    
        msg.reply("🧾 Gerando QR Code, aguarde...");
    
        exec(comando, async (err, stdout, stderr) => {
            if (err || stderr) {
                console.error("Erro ao gerar QR:", err || stderr);
                return msg.reply("❌ Erro ao gerar o QR Code.");
            }
    
            const linhas = stdout.trim().split("\n");
            const caminhoReal = linhas[0]?.trim();
            const codigoCopiaCola = linhas[1]?.trim();
    
            if (!fs.existsSync(caminhoReal)) {
                console.error("QR Code não encontrado:", caminhoReal);
                return msg.reply("❌ QR Code não encontrado.");
            }
    
            try {
                const media = MessageMedia.fromFilePath(caminhoReal);
    
                const textoQR = 
    `💳 *QR Code PIX Gerado*
    
    🔑 Chave: ${chavePix}
    💰 Valor: ${valor ? `R$ ${valor}` : "Não especificado"}`;
    
                await chat.sendMessage(media, { caption: textoQR });
    
                // Aviso do código Copia e Cola
                setTimeout(() => {
                    chat.sendMessage("🔗 *O código Copia e Cola será enviado em 1 segundo...*");
                }, 500);
    
                // Enviar código Copia e Cola
                setTimeout(() => {
                    chat.sendMessage(`${codigoCopiaCola}`);
                }, 1500);
    
            } catch (e) {
                console.error("Erro ao enviar imagem:", e);
                msg.reply("❌ Erro ao enviar o QR Code.");
            }
        });
     }
         else if (cmd.startsWith("/gamepass")) {
            const partes = texto.split(" ");
            if (partes.length < 2) return msg.reply("❌ Uso: /gamepass QUANTIDADE_DE_ROBUX\nExemplo: /gamepass 100");
        
            const robux = parseInt(partes[1]);
            if (isNaN(robux) || robux <= 0 || robux > 100000) {
                return msg.reply("❌ Quantidade inválida! Informe um número inteiro positivo até 100000.");
            }
        
            const valorGamepassRobux = Math.ceil(robux / 0.7);
        
            const resposta =
            `🎮 *Cálculo do Valor do Game Pass*

            Para receber *${robux} Robux* líquidos (após a taxa do Roblox),
            o valor do Game Pass deve ser de *${valorGamepassRobux} Robux*.

            💡 O Roblox cobra uma taxa de 30% sobre cada venda, por isso o valor precisa ser maior.

            📺 *Como criar um Game Pass:* https://www.youtube.com/watch?v=aLZx6B2tLmg`;
   
            msg.reply(resposta);
        }
        
        
        
});

// --- Funções auxiliares ---

async function verificarAdmin(msg, chat) {
    const userId = msg.author || msg.from;
    // Verifica se chat tem participantes (grupos)
    if (!chat.participants) return false;
    const participante = chat.participants.find(p => p.id._serialized === userId);
    return participante?.isAdmin || participante?.isSuperAdmin || false;
}

// após a função verificarAdmin estar declarada
const { setupAbrirFechar } = require('./abrirfechar');
const abrirFechar = setupAbrirFechar(client, { verificarAdmin });



function exibirAjuda(msg) {
    const ajuda = `
🎯 *Comandos do Bot de Sorteio* 🎯

📋 /admin – Painel de administração  
📂 /menu – Menu com informações do sorteio  
📤 /pagamento [valor] – Gera QR Code PIX com valor opcional  
🛒 /comprar QUANTIDADE – Calcula valor, gamepass e gera QR Code para compra  
🎲 /gamepass QUANTIDADE – Calcula valor do Game Pass considerando taxa  
💰 /valor QUANTIDADE – Calcula valor em reais para comprar Robux
🎁 /gift QUANTIDADE – Converte Gamepass com taxa para R$   
    `;
    msg.reply(ajuda);
}

function exibirMenu(chat) {
    const menu = `
📂 *MENU DE INFORMAÇÕES* 📂

🍀 /sorteio – Participa do sorteio atual  
📋 /participantes – Lista de participantes do sorteio atual  
🏆 /rank – Exibe o ranking de jogadores com mais vitórias
    `;
    chat.sendMessage(menu);
}

function iniciarSorteio(msg, chat) {
    if (sorteioAtivo) {
        msg.reply("⚠️ Um sorteio já está ativo. Cancele o atual antes de iniciar outro.");
        return;
    }

    const args = msg.body.split(" ");
    if (args.length < 4) return msg.reply("❌ Uso: /iniciarsorteio HH:mm quantidade nome");

    const [hora, minuto] = args[1].split(":").map(Number);
    if (isNaN(hora) || isNaN(minuto)) return msg.reply("⏰ Formato de hora inválido");

    quantidadeGanhadores = parseInt(args[2]) || 1;
    nomeSorteio = args.slice(3).join(" ");

    const agora = new Date();
    const fim = new Date();
    fim.setHours(hora, minuto, 0, 0);
    if (fim <= agora) fim.setDate(fim.getDate() + 1);

    horaFimSorteio = fim;
    const tempoRestante = fim.getTime() - agora.getTime();

    sorteioAtivo = true;
    participantes = [];

    chat.setMessagesAdminsOnly(true);

    msg.reply(`🎉 *Sorteio Iniciado!*\n📛 Nome: *${nomeSorteio}*\n🏆 Ganhadores: *${quantidadeGanhadores}*\n🕒 Termina às *${hora.toString().padStart(2, '0')}:${minuto.toString().padStart(2, '0')}*\n📩 Envie */sorteio* para participar!`);

    timeoutSorteio = setTimeout(() => finalizarSorteio(chat), tempoRestante);
}

async function entrarNoSorteio(msg) {
    if (!sorteioAtivo) return msg.reply("⚠️ Nenhum sorteio ativo.");

    const telefone = msg.author || msg.from;
    const contato = await msg.getContact();
    const nomeUsuario = contato.pushname || contato.name || "Participante";

    if (participantes.find(p => p.telefone === telefone)) return msg.reply("❌ Você já está participando!");

    const numero = participantes.length + 1;
    participantes.push({ numero, telefone, nome: nomeUsuario });
    msg.reply(`✅ Você entrou no sorteio *${nomeSorteio}* com o número *${numero}*! 🍀 Boa sorte, ${nomeUsuario}!`);
}

function finalizarSorteio(chat) {
    if (!sorteioAtivo) return;

    let resultado = `🎊 *Resultado do Sorteio: ${nomeSorteio}*\n\n`;

    if (participantes.length === 0) {
        resultado += "Ninguém participou 😢";
    } else {
        const ganhadores = [];
        const copia = [...participantes];

        for (let i = 0; i < Math.min(quantidadeGanhadores, copia.length); i++) {
            const idx = Math.floor(Math.random() * copia.length);
            ganhadores.push(copia[idx]);
            copia.splice(idx, 1);
        }

        ganhadores.forEach((g, i) => {
            resultado += `🥇 *Ganhador ${i + 1}*\n👤 ${g.nome}\n📞 ${g.telefone}\n🔢 Nº ${g.numero}\n\n`;

            if (!rankingCache[g.telefone]) {
                rankingCache[g.telefone] = { nome: g.nome, telefone: g.telefone, vitorias: 0 };
            }
            rankingCache[g.telefone].vitorias++;
        });

        salvarRanking();
        salvarHistorico(nomeSorteio, ganhadores);
    }

    chat.sendMessage(resultado.trim());
    sorteioAtivo = false;
    participantes = [];
    timeoutSorteio = null;
}

function salvarHistorico(nome, ganhadores) {
    let dados = [];
    try {
        dados = JSON.parse(fs.readFileSync(HISTORICO_FILE));
    } catch (e) {
        console.error("Erro ao ler histórico.");
    }
    dados.push({ nome, ganhadores, data: new Date().toISOString() });
    fs.writeFileSync(HISTORICO_FILE, JSON.stringify(dados, null, 2));
}

function exibirRank(chat) {
    const dados = Object.values(rankingCache);
    if (dados.length === 0) return chat.sendMessage("📭 Ninguém venceu sorteios ainda.");

    const lista = dados
        .sort((a, b) => b.vitorias - a.vitorias)
        .slice(0, 10)
        .map((u, i) =>
            `🏅 *#${i + 1}* - ${u.nome} (${u.telefone})\n🥇 Vitórias: *${u.vitorias}*`)
        .join("\n");

    chat.sendMessage(`📊 *RANKING DE GANHADORES*\n\n${lista}`);
}

function verParticipantes(chat) {
    if (participantes.length === 0) return chat.sendMessage("📭 Nenhum participante no sorteio.");
    const lista = participantes.map(p => `🔢 ${p.numero} - 👤 ${p.nome} (${p.telefone})`).join("\n");
    chat.sendMessage(`📋 *Lista de Participantes*\n\n${lista}`);
}

function confirmarCancelamento(msg) {
    msg.reply("❗ Tem certeza que quer cancelar o sorteio? Responda com *SIM* ou *NÃO*.");

    const listener = async resposta => {
        if (resposta.from !== msg.from) return;
        const confirm = resposta.body.trim().toLowerCase();
        const chat = await resposta.getChat();

        if (confirm === "sim") {
            cancelarSorteio(chat);
        } else {
            resposta.reply("❎ Cancelamento abortado.");
        }

        client.removeListener("message", listener);
    };

    client.on("message", listener);
}

function cancelarSorteio(chat) {
    if (!sorteioAtivo) return chat.sendMessage("⚠️ Nenhum sorteio ativo para cancelar.");
    clearTimeout(timeoutSorteio);
    sorteioAtivo = false;
    participantes = [];
    timeoutSorteio = null;
    chat.sendMessage("❌ O sorteio foi cancelado.");
}

function abrirMenuAdmin(msg, chat) {
    aguardandoRespostaAdmin = { from: msg.from };

    msg.reply(
        `🛠️ *Painel Admin* - Responda com o número ou comando:\n\n` +
        `1️⃣ /iniciarsorteio – Iniciar um novo sorteio\n` +
        `2️⃣ /liberar – Liberar mensagens\n` +
        `3️⃣ /silenciar – Silenciar grupo\n` +
        `4️⃣ /cancelarsorteio – Cancelar sorteio\n`
    );

    setTimeout(() => {
        if (aguardandoRespostaAdmin?.from === msg.from) {
            aguardandoRespostaAdmin = null;
        }
    }, 30000);
}

function processarRespostaPainel(msg, chat) {
    const texto = msg.body.trim().toLowerCase();
    aguardandoRespostaAdmin = null;

    switch (texto) {
        case "1":
        case "/iniciarsorteio":
            iniciarSorteio(msg, chat);
            break;
        case "2":
        case "/liberar":
            liberarGrupo(chat);
            break;
        case "3":
        case "/silenciar":
            silenciarGrupo(chat);
            break;
        case "4":
        case "/cancelarsorteio":
            confirmarCancelamento(msg);
            break;
        default:
            msg.reply("❌ Opção inválida.");
    }
}

function liberarGrupo(chat) {
    chat.setMessagesAdminsOnly(false);
    chat.sendMessage("🔓 Grupo liberado para todos.");
}

function silenciarGrupo(chat) {
    chat.setMessagesAdminsOnly(true);
    chat.sendMessage("🔒 Grupo silenciado (somente admins podem enviar mensagens).");
}

client.initialize();
