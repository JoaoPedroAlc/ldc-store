const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { exec } = require('child_process');




const pedidosPath = path.join(__dirname, 'pedidos.json');
const configPath = path.join(__dirname, 'config.json');
const rankPath = path.join(__dirname, 'rankcompras.json'); // NOVO arquivo rankcompras.json
const caminhoPython = 'python';
const caminhoScript = path.join(__dirname, 'qrcode3.py');
// Adicione no início do arquivo, com os outros requires
const addemgrupo = require('./criargrupo.js');
const chavePix = '12142986480';
const valor100 = 4;
const videoGamepassURL = 'https://www.youtube.com/watch?v=B-LQU3J24pI&t=6s';

const pathPedidosBase = path.join(__dirname, 'pedidos');

let sessions = {};
let entregarSession = {};
let adminGroupId = null;
let editarSession = {};

if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath));
  adminGroupId = config.adminGroupId || null;
}

async function recalcularRankCompras() {
  const rank = [];

  if (!fs.existsSync(pathPedidosBase)) {
    console.log('recalcularRankCompras: pasta pedidos não existe:', pathPedidosBase);
    await salvarRankCompras([]);
    return [];
  }

  const clientes = await fsPromises.readdir(pathPedidosBase, { withFileTypes: true });

  for (const clienteDir of clientes) {
    if (!clienteDir.isDirectory()) continue; // ignora arquivos soltos
    const numero = clienteDir.name;
    let totalGasto = 0;

    const pastaCliente = path.join(pathPedidosBase, numero);
    const pastasPedidos = await fsPromises.readdir(pastaCliente, { withFileTypes: true });

    for (const pedidoDir of pastasPedidos) {
      if (!pedidoDir.isDirectory()) continue;
      const caminhoInfo = path.join(pastaCliente, pedidoDir.name, 'info.txt');

      if (!fs.existsSync(caminhoInfo)) continue;

      try {
        const infoTxt = JSON.parse(await fsPromises.readFile(caminhoInfo, 'utf-8'));
        const valor = parseFloat(infoTxt.valorReais) || 0;
        totalGasto += valor;
      } catch (e) {
        console.error('Erro ao ler/parsear arquivo info.txt:', caminhoInfo, e);
      }
    }

    // Adiciona mesmo que seja zero (opcional) — aqui eu adiciono apenas se > 0
    if (totalGasto > 0) {
      rank.push({ number: numero, totalGasto: Number(totalGasto.toFixed(2)) });
    }
  }

  rank.sort((a, b) => b.totalGasto - a.totalGasto);
  await salvarRankCompras(rank);

  console.log(`♻️ Ranking recalculado com sucesso — clientes processados: ${rank.length}`);
  return rank;
}



function garantirPasta(pasta) {
  if (!fs.existsSync(pasta)) {
    fs.mkdirSync(pasta, { recursive: true });
  }
}

function formatTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`;
}

function recalcularPorMetodoEQuantidade(info) {
  const robux = Number(info.robux) || 0;
  const metodo = String(info.metodo || '').toLowerCase();

  if (metodo === 'grupo') {
    info.valorReais = Number(((robux / 100) * 4.6).toFixed(2));
    info.valorgamepass = 0;
  } else if (metodo === 'gift') {
    info.valorReais = Number(((robux / 100) * 2.8).toFixed(2));
    info.valorgamepass = 0;
  } else { // gamepass
    info.valorReais = Number(((robux / 100) * 4.0).toFixed(2));
    // 30% de taxa -> necessário subir o preço
    info.valorgamepass = Math.ceil(robux / 0.7);
  }

  return info;
}



function formatDataHoraBR(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${d}/${m}/${y}, ${hh}:${mm}:${ss}`;
}


async function contarPedidosAbertosCliente(numero) {
  const pastaCliente = path.join(pathPedidosBase, numero);
  if (!fs.existsSync(pastaCliente)) return 0;

  let pastasPedidos = await fsPromises.readdir(pastaCliente, { withFileTypes: true });
  pastasPedidos = pastasPedidos.filter(d => d.isDirectory());

  let count = 0;

  for (const pedidoDir of pastasPedidos) {
    const pastaPedido = path.join(pastaCliente, pedidoDir.name);
    const caminhoInfo = path.join(pastaPedido, 'info.txt');

    if (!fs.existsSync(caminhoInfo)) continue;

    const infoTxt = JSON.parse(await fsPromises.readFile(caminhoInfo, 'utf-8'));
    if (infoTxt.status === 'aberto') {
      count++;
    }
  }

  return count;
}

async function carregarRankCompras() {
  if (!fs.existsSync(rankPath)) {
    return [];
  }
  try {
    const raw = await fsPromises.readFile(rankPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function salvarRankCompras(rank) {
  await fsPromises.writeFile(rankPath, JSON.stringify(rank, null, 2));
}

// Atualiza o ranking com base no pedido
async function atualizarRankCompras(number, valorReais) {
  let rank = await carregarRankCompras();

  let usuario = rank.find(u => u.number === number);
  if (!usuario) {
    usuario = { number, totalGasto: 0 };
    rank.push(usuario);
  }

  usuario.totalGasto += valorReais;

  // Ordena do maior para menor gasto
  rank.sort((a, b) => b.totalGasto - a.totalGasto);

  await salvarRankCompras(rank);
  return rank;
}

// Obtém a posição do número no ranking
async function obterPosicaoRank(number) {
  const rank = await carregarRankCompras();
  const pos = rank.findIndex(u => u.number === number);
  return pos >= 0 ? pos + 1 : null; // posição começando em 1
}



// No setupComandosRobux, adicione os comandos de admin:
// Função principal para configurar comandos de admin
function setupComandosRobux(client) {
  const sessaoDM = {};

  client.on('message', async (msg) => {
    const text = msg.body.trim();
    const autor = msg.from;

   

    // /dm
    if (text.toLowerCase().startsWith('/dm')) {
      const apenasNumeros = text.replace(/\D/g, '');
      const regexNumero = /^55(\d{2})(\d{8,9})$/;
      const match = apenasNumeros.match(regexNumero);

      if (!match) {
        return msg.reply('❌ Número inválido. Use o formato: `/dm +55 81 91234-5678` ou `/dm 5581912345678`');
      }

      const ddd = match[1];
      const numero = match[2];
      const destino = `55${ddd}${numero}@c.us`;

      sessaoDM[autor] = destino;

      return msg.reply(`✅ Mensagens serão encaminhadas para: *+55 ${ddd} ${numero}*\n\nDigite *finalizar* ou *finalizar 2* para encerrar a sessão.`);
    }

    // finalizar com mensagem padrão
    if (text.toLowerCase() === 'finalizar' && sessaoDM[autor]) {
      const destino = sessaoDM[autor];
      const mensagemEntrega = `
🎉 *Pedido Entregue com Sucesso!* 🎉

Olá! Informamos que seu pedido foi entregue com sucesso.

Agradecemos imensamente a sua preferência e confiança em nossos serviços. Esperamos que aproveite seu Robux ao máximo!

Qualquer dúvida ou suporte, estamos à disposição. Muito obrigado pela compra!

Atenciosamente,  
*Equipe de Atendimento* 🚀`;

      await client.sendMessage(destino, mensagemEntrega.trim());
      delete sessaoDM[autor];
      return msg.reply('🛑 Sessão de DM encerrada com sucesso e mensagem final enviada ao cliente.');
    }

    // finalizar 2
    if (text.toLowerCase() === 'finalizar 2' && sessaoDM[autor]) {
      delete sessaoDM[autor];
      return msg.reply('🛑 Sessão de DM encerrada com sucesso.');
    }

    // Encaminhar mensagens se estiver em sessão
    if (sessaoDM[autor]) {
      const destino = sessaoDM[autor];

      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        await client.sendMessage(destino, media, { caption: msg.caption || '' });
      } else {
        await client.sendMessage(destino, msg.body);
      }
    }
  });




  const adminSessions = {}; // Para armazenar sessões de criação de pedidos

client.on('message', async (msg) => {
  const chat = await msg.getChat();
  const contact = await msg.getContact();
  const text = msg.body.trim();
  const number = contact.number;

  // COMANDO /criarpedido (apenas para admin)
  if (text === '/criarpedido' && adminGroupId && (chat.id._serialized === adminGroupId || !chat.isGroup)) {
    // Verificar se é admin (pode adicionar verificação mais robusta se necessário)
    adminSessions[number] = {
      state: 'await_number',
      data: {}
    };

    await msg.reply(`📝 *Criar Pedido Manual - Passo 1/6*\n\nPor favor, envie o número do cliente no formato:\n\nExemplo: +55 81 91234-5678\nou 5581912345678`);
    return;
  }

  // Processamento das respostas do admin
  if (adminSessions[number]) {
    const session = adminSessions[number];

    try {
      // PASSO 1: Obter número do cliente
      if (session.state === 'await_number') {
        const numeroCliente = text.replace(/\D/g, ''); // Limpa o número
        
        if (!numeroCliente || numeroCliente.length < 11) {
          return msg.reply('❌ Número inválido. Por favor, envie novamente no formato:\n\nExemplo: +55 81 91234-5678\nou 5581912345678');
        }

        session.data.number = numeroCliente;
        session.state = 'await_metodo';
        
        await msg.reply(`📝 *Criar Pedido Manual - Passo 2/6*\n\nMétodo de recebimento:\n\n1️⃣ *gamepass* (padrão - 100 Robux = R$ ${valor100})\n2️⃣ *gift* (100 Robux = R$ 2,80)\n3️⃣ *grupo* (100 Robux = R$ 4,60)\n\nDigite o método desejado:`);
        return;
      }

      // PASSO 2: Obter método
      if (session.state === 'await_metodo') {
        const metodo = text.trim().toLowerCase();
        
        if (!['gamepass', 'gift', 'grupo', '1', '2', '3'].includes(metodo)) {
          return msg.reply('❌ Método inválido. Por favor, digite:\n\n*gamepass* (ou 1)\n*gift* (ou 2)\n*grupo* (ou 3)');
        }

        // Normaliza o método
        let metodoFinal = metodo;
        if (metodo === '1') metodoFinal = 'gamepass';
        if (metodo === '2') metodoFinal = 'gift';
        if (metodo === '3') metodoFinal = 'grupo';

        session.data.metodo = metodoFinal;
        session.state = 'await_robux';
        
        await msg.reply(`📝 *Criar Pedido Manual - Passo 3/6*\n\nDigite a quantidade de Robux desejada:`);
        return;
      }

      // PASSO 3: Obter quantidade de Robux
      if (session.state === 'await_robux') {
        const robux = parseInt(text);
        
        if (isNaN(robux) || robux <= 0 || robux > 100000) {
          return msg.reply('❌ Quantidade inválida. Digite um número entre 1 e 100000:');
        }

        session.data.robux = robux;
        
        // Calcular valor automaticamente baseado no método
        let valorReais = 0;
        if (session.data.metodo === 'gift') valorReais = (robux / 100) * 2.8;
        else if (session.data.metodo === 'grupo') valorReais = (robux / 100) * 4.6;
        else valorReais = (robux / 100) * valor100; // gamepass
        
        session.data.valorReais = parseFloat(valorReais.toFixed(2));
        
        // Se for gamepass, calcular neededRobux
        if (session.data.metodo === 'gamepass') {
          session.data.neededRobux = Math.ceil(robux / 0.7);
        } else {
          session.data.neededRobux = 0;
        }

        session.state = 'await_link';
        
        await msg.reply(`📝 *Criar Pedido Manual - Passo 4/6*\n\nRobux: ${robux}\nValor: R$ ${session.data.valorReais.toFixed(2)}\n\nAgora envie:\n\n🔗 Para *gamepass*: Link do Game Pass\n🎁 Para *gift*: Link da conta Roblox\n👥 Para *grupo*: Link da conta Roblox`);
        return;
      }

      // PASSO 4: Obter link
      if (session.state === 'await_link') {
        const link = text.trim();
        
        if (!link.startsWith('http')) {
          return msg.reply('❌ Link inválido. Deve começar com http ou https. Por favor, envie novamente:');
        }

        session.data.link = link;
        session.state = 'await_status';
        
        await msg.reply(`📝 *Criar Pedido Manual - Passo 5/6*\n\nStatus do pedido:\n\n1️⃣ *aberto* (padrão)\n2️⃣ *finalizado*\n\nDigite o status desejado:`);
        return;
      }

      // PASSO 5: Obter status
      if (session.state === 'await_status') {
        const status = text.trim().toLowerCase();
        
        if (!['aberto', 'finalizado', '1', '2'].includes(status)) {
          return msg.reply('❌ Status inválido. Por favor, digite:\n\n*aberto* (ou 1)\n*finalizado* (ou 2)');
        }

        // Normaliza o status
        let statusFinal = status;
        if (status === '1') statusFinal = 'aberto';
        if (status === '2') statusFinal = 'finalizado';

        session.data.status = statusFinal;
        session.state = 'await_comprovante';
        
        await msg.reply(`📝 *Criar Pedido Manual - Passo 6/6*\n\nPor favor, envie o comprovante de pagamento (imagem/documento) ou digite *pular* para continuar sem comprovante.`);
        return;
      }

      // PASSO 6: Obter comprovante (opcional)
      if (session.state === 'await_comprovante') {
        if (msg.hasMedia || msg.type === 'DOCUMENT') {
          session.data.comprovante = await msg.downloadMedia();
          await msg.reply('✅ Comprovante recebido!');
        } else if (text.toLowerCase() !== 'pular') {
          return msg.reply('❌ Por favor, envie o comprovante (imagem/documento) ou digite *pular* para continuar sem comprovante.');
        }

        // Tudo coletado, criar o pedido
        const pedidoData = new Date();
        const pedidoDataStr = formatTimestamp(pedidoData);
        const pedidoDataExibicao = formatDataHoraBR(pedidoData);

        const pastaCliente = path.join(pathPedidosBase, session.data.number);
        const pastaData = path.join(pastaCliente, pedidoDataStr);

        garantirPasta(pastaData);

        // Criar info.txt
        const infoPedido = {
          valorReais: session.data.valorReais,
          robux: session.data.robux,
          gamepass: session.data.link,
          valorgamepass: session.data.neededRobux,
          data: pedidoDataExibicao,
          status: session.data.status,
          metodo: session.data.metodo
        };

        const caminhoInfo = path.join(pastaData, 'info.txt');
        fs.writeFileSync(caminhoInfo, JSON.stringify(infoPedido, null, 2));

        // Criar comprovante_entrega.txt
        const caminhoComprovanteEntrega = path.join(pastaData, 'comprovante_entrega.txt');
        fs.writeFileSync(caminhoComprovanteEntrega, session.data.status === 'finalizado' ? 
          `Entregue em: ${formatDataHoraBR(new Date())}` : 
          'Comprovante de entrega não enviado ainda.');

        // Salvar comprovante se existir
        if (session.data.comprovante) {
          const ext = session.data.comprovante.mimetype.split('/')[1] || 'png';
          const nomeComprovante = `comprovante_pagamento.${ext}`;
          const caminhoComprovante = path.join(pastaData, nomeComprovante);

          const buffer = Buffer.from(session.data.comprovante.data, 'base64');
          fs.writeFileSync(caminhoComprovante, buffer);
        }

        // Adicionar ao pedidos.json
        let all = [];
        if (fs.existsSync(pedidosPath)) all = JSON.parse(fs.readFileSync(pedidosPath));
        all.push({
          number: session.data.number,
          valorReais: session.data.valorReais,
          robux: session.data.robux,
          gamepass: session.data.link,
          data: pedidoDataExibicao
        });
        fs.writeFileSync(pedidosPath, JSON.stringify(all, null, 2));

        // Atualizar ranking de compras
        await atualizarRankCompras(session.data.number, session.data.valorReais);

        // Resumo do pedido criado
        let resposta = `✅ *Pedido criado manualmente com sucesso!*\n\n`;
        resposta += `👤 Cliente: ${session.data.number}\n`;
        resposta += `🎮 Robux: ${session.data.robux}\n`;
        resposta += `💰 Valor: R$ ${session.data.valorReais.toFixed(2)}\n`;
        resposta += `📌 Método: ${session.data.metodo}\n`;
        resposta += `🔗 Link: ${session.data.link}\n`;
        resposta += `📦 Status: ${session.data.status}\n`;
        resposta += `🕒 Criado em: ${pedidoDataExibicao}\n`;
        resposta += `📁 Pasta: ${pastaData}`;

        await msg.reply(resposta);

        // Limpar sessão
        delete adminSessions[number];
        return;
      }

    } catch (error) {
      console.error('Erro ao criar pedido manual:', error);
      await msg.reply('❌ Ocorreu um erro ao processar o pedido. Por favor, comece novamente com /criarpedido');
      delete adminSessions[number];
    }
    return;
  }

  // Cancelar comando se digitar "cancelar" em qualquer etapa
  if (adminSessions[number] && text.toLowerCase() === 'cancelar') {
    delete adminSessions[number];
    await msg.reply('❌ Criação de pedido cancelada.');
    return;
  }

    
   
    // --- Comando /perfil (método por robux/100 e valor/hundreds) ---
    if (text.startsWith('/perfil')) {
      try {
        let targetNumber = number; // padrão: quem digitou
    
        // aceita /perfil 5599xxxx, /perfil +55 84 99999-9999 etc.
        const args = text.split(' ');
        if (args.length > 1) {
          targetNumber = args.slice(1).join('').replace(/\D/g, ''); 
          // junta todos os pedaços depois de /perfil e remove tudo que não for dígito
}
    
        const pastaCliente = path.join(pathPedidosBase, targetNumber);
        if (!fs.existsSync(pastaCliente)) {
          return msg.reply(`❌ Nenhum pedido encontrado para o número ${targetNumber}.`);
        }
    
        // utils
        const addDays = (d, days) => new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
    
        function determineTier(totalSpentBRL, totalOrders) {
          if (totalSpentBRL >= 2000 || totalOrders >= 40) {
            return { key: 'legendario', name: 'Imperador dos Robux', emoji: '👑', label: 'Express — fila VIP (prioridade máxima)' };
          }
          if (totalSpentBRL >= 800 || totalOrders >= 15) {
            return { key: 'comandante', name: 'Magnata Pixelado', emoji: '💎', label: 'Alta prioridade na fila' };
          }
          if (totalSpentBRL >= 300 || totalOrders >= 5) {
            return { key: 'viajante', name: 'Barão dos Robux', emoji: '💰', label: 'Prioridade média na fila' };
          }
          if (totalSpentBRL >= 100) {
            return { key: 'guardiao', name: 'Gamer ativo', emoji: '🎮', label: 'Pequena prioridade na fila' };
          }
          return { key: 'iniciante', name: 'Iniciante', emoji: '🔰', label: 'Sem prioridade adicional' };
        }
    
        // parse DD/MM/YYYY, HH:mm:ss
        function parseInfoData(infoData) {
          if (!infoData) return null;
          try {
            const partes = infoData.split(',');
            const parteData = partes[0].trim();
            const dparts = parteData.split('/');
            if (dparts.length === 3) {
              const d = parseInt(dparts[0], 10);
              const m = parseInt(dparts[1], 10) - 1;
              const y = parseInt(dparts[2], 10);
              let h = 0, mi = 0, s = 0;
              if (partes[1]) {
                const hp = partes[1].trim().split(':');
                h = parseInt(hp[0] || '0', 10);
                mi = parseInt(hp[1] || '0', 10);
                s = parseInt(hp[2] || '0', 10);
              }
              return new Date(y, m, d, h, mi, s);
            }
          } catch {}
          return null;
        }
    
        // *** DETECÇÃO DE MÉTODO ***
        // hundreds = robux/100; precoPor100 = valorReais / hundreds (2 casas);
        // '4.00' => gamepass | '4.60' => grupo | '2.80' => gift
        function detectMethod(valorReais, robux) {
          const hundreds = robux / 100;
          if (!isFinite(hundreds) || hundreds <= 0 || !isFinite(valorReais) || valorReais <= 0) {
            return 'desconhecido';
          }
          const precoPor100Str = (valorReais / hundreds).toFixed(2); // string
          if (precoPor100Str === '4.00') return 'gamepass';
          if (precoPor100Str === '4.60') return 'grupo';
          if (precoPor100Str === '2.80') return 'gift';
          return 'desconhecido';
        }
    
        // ler pastas de pedidos
        let pastasPedidos = await fsPromises.readdir(pastaCliente, { withFileTypes: true });
        pastasPedidos = pastasPedidos.filter(d => d.isDirectory());
    
        if (pastasPedidos.length === 0) {
          return msg.reply(`❌ Nenhum pedido registrado para o número ${targetNumber}.`);
        }
    
        // agregados
        let totalReais = 0;
        let totalRobux = 0;
        let ultimaCompraData = null;
        const detalhesPedidos = [];
    
        for (const pedidoDir of pastasPedidos) {
          const pastaPedido = path.join(pastaCliente, pedidoDir.name);
          const caminhoInfo = path.join(pastaPedido, 'info.txt');
          if (!fs.existsSync(caminhoInfo)) continue;
    
          let infoTxt = {};
          try { infoTxt = JSON.parse(await fsPromises.readFile(caminhoInfo, 'utf-8')); } catch {}
    
          const robux = Number(infoTxt.robux || infoTxt.quantidade || 0);
          const valorReais = Number(infoTxt.valorReais || infoTxt.valor || 0);
    
          totalRobux += robux;
          totalReais += valorReais;
    
          // data do pedido
          let dataPedido = null;
          if (infoTxt.data) dataPedido = parseInfoData(infoTxt.data);
          if (!dataPedido) {
            try {
              const nome = pedidoDir.name.replace('_', 'T').replace(/_/g, ' ');
              const poss = new Date(nome);
              if (!isNaN(poss.getTime())) dataPedido = poss;
            } catch {}
          }
          if (!dataPedido) {
            try { const st = await fsPromises.stat(caminhoInfo); dataPedido = st.mtime ? new Date(st.mtime) : null; } catch {}
          }
          if (!ultimaCompraData || (dataPedido && dataPedido > ultimaCompraData)) ultimaCompraData = dataPedido;
    
          // comprovante_entrega*
          const arquivos = await fsPromises.readdir(pastaPedido);
          const comp = arquivos.find(f => f.toLowerCase().startsWith('comprovante_entrega'));
          let comprovanteDate = null;
          if (comp) {
            try {
              const st = await fsPromises.stat(path.join(pastaPedido, comp));
              comprovanteDate = st.birthtime || st.ctime || st.mtime || null;
            } catch {}
          }
    
          // mtime do info.txt
          let infoMtime = null;
          try { const stInfo = await fsPromises.stat(caminhoInfo); infoMtime = stInfo.mtime || stInfo.ctime || null; } catch {}
    
          const statusRaw = (infoTxt.status || infoTxt.Status || '').toString().trim();
          const statusLower = statusRaw.toLowerCase();
          const status = statusRaw || (comprovanteDate ? 'finalizado' : 'pendente');
    
          // método — IGNORA campo infoTxt.gamepass e usa APENAS a regra definida
          const metodo = detectMethod(valorReais, robux); // 'gamepass' | 'grupo' | 'gift' | 'desconhecido'
    
          // estimativa:
          // - gamepass: base + 5 dias (preferir comprovante -> info.txt.data -> info.txt.mtime)
          // - grupo/gift: data do arquivo (info.txt.data -> info.txt.mtime -> comprovante) (sem +5)
          let estimativaEntrada = null;
          let baseParaEntrada = null;
          if (statusLower === 'finalizado') {
            if (metodo === 'gamepass') {
              baseParaEntrada = comprovanteDate || parseInfoData(infoTxt.data) || infoMtime || null;
              if (baseParaEntrada) estimativaEntrada = addDays(new Date(baseParaEntrada), 5);
            } else if (metodo === 'grupo' || metodo === 'gift') {
              baseParaEntrada = parseInfoData(infoTxt.data) || infoMtime || comprovanteDate || null;
              if (baseParaEntrada) estimativaEntrada = new Date(baseParaEntrada);
            } else {
              // fallback conservador
              baseParaEntrada = comprovanteDate || parseInfoData(infoTxt.data) || infoMtime || null;
              if (baseParaEntrada) estimativaEntrada = addDays(new Date(baseParaEntrada), 5);
            }
          }
    
          detalhesPedidos.push({
            id: pedidoDir.name,
            dataPedido,
            robux,
            valorReais,
            status,
            statusLower,
            metodo,
            estimativaEntrada
          });
        }
    
        // ordenar
        detalhesPedidos.sort((a, b) => {
          const ta = a.dataPedido ? a.dataPedido.getTime() : 0;
          const tb = b.dataPedido ? b.dataPedido.getTime() : 0;
          return ta - tb;
        });
    
        // tier & rank
        const totalOrders = detalhesPedidos.length;
        const tier = determineTier(totalReais, totalOrders);
        const posicaoRank = await obterPosicaoRank(targetNumber);
    
        // resposta
        let resposta = '';
        resposta += `📊 Perfil de compras do número: ${targetNumber}\n\n`;
    
        resposta += `📅 Última compra: ${ultimaCompraData ? formatDataHoraBR(ultimaCompraData) : 'Não disponível'}\n`;
        resposta += `💰 Total gasto: R$ ${totalReais.toFixed(2)}\n`;
        resposta += `🎮 Total comprado: ${totalRobux} Robux\n\n`;
    
        resposta += `🏆 Rank: ${posicaoRank ? `${posicaoRank}º` : 'Ainda não no ranking'}\n`;
        resposta += `Classe: ${tier.name} ${tier.emoji}\n`;
        resposta += `Prioridade na fila: ${tier.label}\n\n`;
    
        resposta += `📝 Pedidos:\n`;
        for (const p of detalhesPedidos) {
          resposta += `• Pedido em: ${p.dataPedido ? formatDataHoraBR(p.dataPedido) : p.id}\n`;
          resposta += `  Robux: ${p.robux}\n`;
          resposta += `  Valor: R$ ${p.valorReais.toFixed(2)}\n`;
          resposta += `  Status: ${p.status}\n`;
          resposta += `  Método: ${p.metodo === 'gamepass' ? 'Gamepass' : (p.metodo === 'grupo' ? 'Grupo' : (p.metodo === 'gift' ? 'Gift' : 'Desconhecido'))}\n`;
    
          if (p.statusLower === 'finalizado') {
            resposta += `  → Robux estimado para entrar em: *${p.estimativaEntrada ? formatDataHoraBR(p.estimativaEntrada) : 'Não foi possível detectar'}*\n`;
          }
          resposta += `\n`;
        }
    
        return msg.reply(resposta);
    
      } catch (err) {
        console.error('Erro no /perfil (método por valor/hundreds):', err);
        return msg.reply('❌ Ocorreu um erro ao gerar o perfil. Verifique os logs.');
      }
    }



  
// Comando /entregar atualizado
// Comando /entregar atualizado
else if (text === '/entregar') {
  const allPedidos = [];

  if (!fs.existsSync(pathPedidosBase)) {
      return msg.reply('❌ Nenhum pedido encontrado');
  }

  // Carrega todos os pedidos abertos
  const clientes = await fsPromises.readdir(pathPedidosBase, { withFileTypes: true });
  for (const clienteDir of clientes.filter(d => d.isDirectory())) {
      const pastaCliente = path.join(pathPedidosBase, clienteDir.name);

      let pastasPedidos = await fsPromises.readdir(pastaCliente, { withFileTypes: true });
      pastasPedidos = pastasPedidos.filter(d => d.isDirectory());

      for (const pedidoDir of pastasPedidos) {
          const pastaPedido = path.join(pastaCliente, pedidoDir.name);
          const caminhoInfo = path.join(pastaPedido, 'info.txt');

          if (!fs.existsSync(caminhoInfo)) continue;

          const infoTxt = JSON.parse(await fsPromises.readFile(caminhoInfo, 'utf-8'));

          // Verifica se o pedido está aberto
          if (infoTxt.status && infoTxt.status.toLowerCase() === 'aberto') {
              // Determina o método de entrega com base no valor
              let metodo = 'gamepass'; // padrão
              
              if (infoTxt.valorgamepass === 0 || infoTxt.valorgamepass === '0') {
                  // Se valorgamepass é 0, verifica pelo valor pago
                  const valorPor100 = (infoTxt.valorReais / infoTxt.robux) * 100;
                  
                  if (Math.abs(valorPor100 - 4.60) < 0.1) { // ~4.60 (grupo)
                      metodo = 'grupo';
                  } else if (Math.abs(valorPor100 - 2.80) < 0.1) { // ~2.80 (gift)
                      metodo = 'gift';
                  }
              }

              allPedidos.push({
                  number: clienteDir.name,
                  robux: infoTxt.robux,
                  valorReais: infoTxt.valorReais,
                  metodo: metodo,
                  gamepass: infoTxt.gamepass || 'Não informado',
                  valorgamepass: infoTxt.valorgamepass || 0,
                  dataPasta: pedidoDir.name,
                  dataExibicao: infoTxt.data || '',
                  pastaPedido,
                  status: infoTxt.status || 'aberto'
              });
          }
      }
  }

  if (allPedidos.length === 0) {
      return msg.reply('❌ Nenhum pedido aberto para entrega');
  }

  // Ordena por data mais antiga primeiro
  allPedidos.sort((a, b) => {
      try {
          // Tenta converter nomes de pastas para datas
          const dateA = new Date(a.dataPasta.replace('_', 'T').replace(/-/g, ':'));
          const dateB = new Date(b.dataPasta.replace('_', 'T').replace(/-/g, ':'));
          return dateA - dateB;
      } catch (e) {
          return 0;
      }
  });

  // Cria sessão de entrega
  entregarSession[msg.from] = {
      state: 'await_pedido_choice',
      pedidos: allPedidos,
      entregasSalvas: 0,
      currentDeliveryPaths: null,
      robux: null,
      valorReais: null,
      target: null,
      clientNumber: null,
      gamepass: null,
      metodo: null,
      chatId: chat.id._serialized,
      logMessages: []
  };

  let menu = '📬 *Pedidos Abertos - Mais Antigos Primeiro*\n\n';

  // Na listagem de pedidos dentro do menu (dentro do allPedidos.forEach)
  allPedidos.forEach((p, i) => {
    const metodoFormatado = 
        p.metodo === 'gift' ? '🎁 Gift (R$ 2,80/100)' :
        p.metodo === 'grupo' ? '👥 Grupo (R$ 4,60/100)' : 
        '🎟️ Gamepass (R$ 4,00/100)';

    const valorPor100 = (p.valorReais / p.robux) * 100;

    menu += `*${i + 1} - Pedido de ${p.number}*\n`;
    menu += `🎮 Robux: ${p.robux}\n`;
    menu += `💰 Valor Total: R$ ${p.valorReais.toFixed(2)}\n`;
    menu += `📦 Método: ${metodoFormatado}\n`;
    menu += `💲 Valor por 100: R$ ${valorPor100.toFixed(2)}\n`;

    if (p.valorgamepass && p.valorgamepass > 0) {
      menu += `🎫 Valor Gamepass: ${parseFloat(p.valorgamepass)}\n`;
    }

    menu += `📅 Data: ${p.dataExibicao || p.dataPasta}\n`;
    menu += `🔗 Link: ${p.gamepass}\n\n`;
  });
  menu += `✏️ Digite o número do pedido ou *cancelar* para sair`;

  return msg.reply(menu);
}

// Fluxo de mensagens da sessão de entrega
if (entregarSession[msg.from]) {
  const state = entregarSession[msg.from];
  const logMsg = { sender: msg.author || msg.from, text: msg.body, timestamp: new Date() };
  state.logMessages.push(logMsg);

  // Espelha mensagens para o chat do admin
  if (state.chatId && state.chatId !== msg.from) {
      const prefix = msg.from === state.target ? '👤 Client:' : '👨‍💼 Admin:';
      await client.sendMessage(state.chatId, `${prefix} ${msg.body}`);
  }

  if (state.state === 'await_pedido_choice') {
      if (text.toLowerCase() === 'cancelar') {
          delete entregarSession[msg.from];
          return msg.reply('❌ Entrega cancelada');
      }

      const index = parseInt(text);
      if (isNaN(index) || index < 1 || index > state.pedidos.length) {
          return msg.reply('❌ Número inválido. Escolha da lista ou digite *cancelar*');
      }

      const pedidoEscolhido = state.pedidos[index - 1];
      
      state.state = 'typing_message';
      state.target = pedidoEscolhido.number + '@c.us';
      state.clientNumber = pedidoEscolhido.number;
      state.currentDeliveryPaths = pedidoEscolhido.pastaPedido;
      state.robux = pedidoEscolhido.robux;
      state.valorReais = pedidoEscolhido.valorReais;
      state.gamepass = pedidoEscolhido.gamepass;
      state.metodo = pedidoEscolhido.metodo;

      const metodoFormatado = state.metodo === 'gift' ? '🎁 Gift' : 
                            state.metodo === 'grupo' ? '👥 Grupo' : '🎟️ Gamepass';
      
      await msg.reply(
          `✅ Pedido selecionado:\n` +
          `👤 Cliente: ${state.clientNumber}\n` +
          `${metodoFormatado} | ${state.robux} Robux | R$ ${state.valorReais.toFixed(2)}\n` +
          `🔗 ${state.gamepass}\n\n` +
          `✍️ Agora envie:\n- Mensagens\n- Imagens/comprovantes\n` +
          `✅ Digite *finalizar* quando terminar`
      );

      await client.sendMessage(
          state.target,
          `📦 *Atualização de Pedido*\n\n` +
          `Seu pedido de ${state.robux} Robux (${metodoFormatado}) está sendo processado!\n` +
          `Você receberá atualizações em breve.`
      );
      return;
  }

  if (state.state === 'typing_message') {
    if (text.toLowerCase() === 'finalizar') {
      const metodoFormatado = state.metodo === 'gift' ? '🎁 Gift' : 
                            state.metodo === 'grupo' ? '👥 Grupo' : '🎟️ Gamepass';
  
      // Mensagem personalizada para o cliente
      const mensagemFinalizadoCliente = 
          `🎉 Pedido Entregue com Sucesso! 🎉\n\n` +
          `Olá! Informamos que seu pedido de ${state.robux} Robux no valor de R$ ${state.valorReais.toFixed(2)} foi entregue com sucesso.\n\n` +
          `Agradecemos imensamente a sua preferência e confiança em nossos serviços. Esperamos que aproveite seu Robux ao máximo!\n\n` +
          `Qualquer dúvida ou suporte, estamos à disposição. Muito obrigado pela compra!\n\n` +
          `Atenciosamente,\n` +
          `Equipe de Atendimento 🚀`;
  
      await client.sendMessage(
          state.target,
          mensagemFinalizadoCliente
      );
  
      // Atualiza status do pedido
      const caminhoInfo = path.join(state.currentDeliveryPaths, 'info.txt');
      if (fs.existsSync(caminhoInfo)) {
          const infoTxt = JSON.parse(fs.readFileSync(caminhoInfo, 'utf-8'));
          infoTxt.status = 'finalizado';
          fs.writeFileSync(caminhoInfo, JSON.stringify(infoTxt, null, 2));
      }
  
      // Salva log da entrega
      const caminhoComprovante = path.join(state.currentDeliveryPaths, 'delivery_log.txt');
      const logFormatado = state.logMessages.map(m => 
          `[${new Date(m.timestamp).toLocaleString()}] ${m.sender}: ${m.text}`
      ).join('\n');
      
      fs.writeFileSync(caminhoComprovante, 
          `DELIVERY COMPLETED: ${new Date().toLocaleString()}\n\n` +
          `CONVERSATION LOG:\n${logFormatado}`
      );
  
      // Confirmação para admin
      await client.sendMessage(
          state.chatId,
          `✅ Entrega finalizada:\n` +
          `👤 Cliente: ${state.clientNumber}\n` +
          `📦 ${state.robux} Robux (${metodoFormatado})\n` +
          `💰 R$ ${state.valorReais.toFixed(2)}\n` +
          `⏱️ ${new Date().toLocaleString()}`
      );
  
      delete entregarSession[msg.from];
      return;
  }

      // Caso receba mídia ou documento
      if (msg.hasMedia || msg.type === 'DOCUMENT') {
          const media = await msg.downloadMedia();
          state.entregasSalvas++;

          const ext = media.mimetype.split('/')[1] || 'png';
          const nomeArquivo = `delivery_${state.entregasSalvas}.${ext}`;
          const caminhoSalvar = path.join(state.currentDeliveryPaths, nomeArquivo);
          
          fs.writeFileSync(caminhoSalvar, Buffer.from(media.data, 'base64'));

          // Envia mídia para o cliente
          await client.sendMessage(
              state.target, 
              media, 
              { caption: msg.caption || `Comprovante de entrega ${state.entregasSalvas}` }
          );

          // Notificação para admin
          await client.sendMessage(
              state.chatId,
              `📎 Comprovante ${state.entregasSalvas} enviado para ${state.clientNumber}` +
              (msg.caption ? `\n📝 ${msg.caption}` : '')
          );

          return msg.reply(`✅ Comprovante ${state.entregasSalvas} salvo e enviado`);
      }

      // Encaminha mensagem de texto para o cliente e para o admin
      await client.sendMessage(state.target, msg.body);
      await client.sendMessage(
          state.chatId,
          `💬 Mensagem enviada para ${state.clientNumber}:\n${msg.body}`
      );
  }
}

  




    // Adicione este código após o comando /entregar

// COMANDO /editar (apenas admin)
// COMANDO /editar (apenas admin)
// Versão revisada: corrige problemas de indexação e torna o fluxo mais robusto
if (text === '/editar' && adminGroupId && chat.id._serialized === adminGroupId) {
  editarSession[number] = { state: 'await_number', data: {} };
  await msg.reply('✏️ *Editar Pedido - Passo 1/3*\n\nPor favor, envie o número do cliente para buscar os pedidos.');
  return;
}

if (!editarSession[number]) return; // nada a fazer se não houver sessão
const session = editarSession[number];

try {
  // Passo 1: pegar número do cliente
  if (session.state === 'await_number') {
    const numeroCliente = (text || '').replace(/\D/g, '');
    if (!numeroCliente || numeroCliente.length < 11) {
      return msg.reply('❌ Número inválido. Envie novamente no formato: 5581999999999');
    }
    session.data.number = numeroCliente;

    const pastaCliente = path.join(pathPedidosBase, numeroCliente);
    if (!fs.existsSync(pastaCliente)) {
      delete editarSession[number];
      return msg.reply('❌ Nenhum pedido encontrado para este cliente.');
    }

    // ler apenas subpastas (pedidos) — evita arquivos soltos como info.txt
    const entries = await fsPromises.readdir(pastaCliente);
    const pedidos = [];
    for (const entry of entries) {
      const full = path.join(pastaCliente, entry);
      try {
        const st = await fsPromises.stat(full);
        if (st.isDirectory()) pedidos.push(entry);
      } catch (e) {
        // ignora itens que não conseguimos stat
        console.warn('Falha ao stat:', full, e && e.message);
      }
    }

    if (!pedidos || pedidos.length === 0) {
      delete editarSession[number];
      return msg.reply('❌ Nenhum pedido encontrado para este cliente.');
    }

    // ordenar para consistência (opcional)
    pedidos.sort();

    session.data.pedidos = pedidos;
    session.state = 'await_pedido';

    let lista = '📂 *Pedidos encontrados:*\n\n';
    pedidos.forEach((p, i) => { lista += `*${i + 1}.* ${p}\n`; });
    lista += '\nDigite o número do pedido que deseja editar (ex: 1).';

    await msg.reply(lista);
    return;
  }

  // Passo 2: escolher pedido
  if (session.state === 'await_pedido') {
    const choice = (text || '').trim();
    if (!/^\d+$/.test(choice)) {
      return msg.reply('❌ Entrada inválida. Envie apenas o número do pedido (ex: 1).');
    }
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || !session.data.pedidos || idx >= session.data.pedidos.length) {
      return msg.reply('❌ Número inválido. Digite novamente.');
    }
    session.data.pedidoSelecionado = session.data.pedidos[idx];
    session.state = 'await_campo';
    await msg.reply('✏️ Qual campo deseja editar?\nOpções: *status*, *robux*, *valor*, *link*, *metodo*, *comprovante*, *excluir*, *cancelar*');
    return;
  }

  // Passo 3: escolher campo
  if (session.state === 'await_campo') {
    const campoRaw = (text || '').toLowerCase().trim();

    // validar existencia do pedido selecionado
    if (!session.data.pedidoSelecionado) {
      delete editarSession[number];
      return msg.reply('❌ Pedido não selecionado. Reinicie o /editar.');
    }

    // Opções especiais: excluir / cancelar (ambos removem o pedido, mas cancelar também notifica o cliente)
    if (campoRaw === 'excluir' || campoRaw === 'cancelar') {
      const pastaPedido = path.join(pathPedidosBase, session.data.number, session.data.pedidoSelecionado);

      if (!fs.existsSync(pastaPedido)) {
        delete editarSession[number];
        return msg.reply('❌ Pedido não encontrado para exclusão.');
      }

      try {
        if (typeof fsPromises.rm === 'function') {
          await fsPromises.rm(pastaPedido, { recursive: true, force: true });
        } else {
          // fallback para Node antigo
          await fsPromises.rmdir(pastaPedido, { recursive: true });
        }
      } catch (e) {
        console.error('Erro ao remover pasta do pedido:', e);
        delete editarSession[number];
        return msg.reply('❌ Falha ao excluir o pedido. Tente novamente.');
      }

      const mensagemCancelamento = '❌ Pedido Cancelado ❌\n\nOlá! Informamos que seu pedido foi cancelado com sucesso.  \nEsperamos que em uma próxima oportunidade possamos atendê-lo novamente. 💙  \n\nAtenciosamente,  \nEquipe de Atendimento 🚀';

      if (campoRaw === 'cancelar') {
        const clienteId = `${session.data.number}@c.us`;
        let enviado = false;
        try {
          if (typeof client !== 'undefined' && client && typeof client.sendMessage === 'function') {
            await client.sendMessage(clienteId, mensagemCancelamento);
            enviado = true;
          } else if (msg && msg.client && typeof msg.client.sendMessage === 'function') {
            await msg.client.sendMessage(clienteId, mensagemCancelamento);
            enviado = true;
          } else {
            console.warn('Objeto client não disponível para notificar o cliente.');
          }
        } catch (err) {
          console.error('Erro ao enviar mensagem de cancelamento ao cliente:', err);
        }

        await msg.reply(
          `✅ Pedido *${session.data.pedidoSelecionado}* cancelado e excluído com sucesso!` +
          (enviado ? '\n✉️ Notificação enviada ao cliente.' : '\n⚠️ Não foi possível notificar o cliente (client não disponível).')
        );
      } else {
        await msg.reply(`✅ Pedido *${session.data.pedidoSelecionado}* excluído com sucesso!`);
      }

      delete editarSession[number];
      return;
    }

    if (campoRaw === 'comprovante') {
      session.state = 'await_comprovante_tipo';
      return msg.reply('📎 Deseja adicionar comprovante de *pagamento* ou *entrega*?');
    }

    if (!['status', 'robux', 'valor', 'link', 'metodo'].includes(campoRaw)) {
      return msg.reply('❌ Campo inválido. Digite: status, robux, valor, link, metodo ou comprovante ou use excluir/cancelar');
    }

    session.data.campo = campoRaw;
    session.state = 'await_valor';
    await msg.reply(`Digite o novo valor para *${campoRaw}* :`);
    return;
  }

  // Fluxo: escolher tipo de comprovante
  if (session.state === 'await_comprovante_tipo') {
    const tipo = (text || '').toLowerCase().trim();
    if (!['pagamento', 'entrega'].includes(tipo)) {
      return msg.reply('❌ Tipo inválido. Digite: pagamento ou entrega');
    }
    session.data.comprovanteTipo = tipo;
    session.state = 'await_comprovante_upload';
    session.data.comprovantesSalvos = 0;
    return msg.reply(`📎 Envie os comprovantes de ${tipo} (imagem ou documento).\nℹ️ Digite */sim* quando terminar.`);
  }

  // Fluxo: upload dos comprovantes
  if (session.state === 'await_comprovante_upload') {
    if ((text || '').toLowerCase() === '/sim') {
      delete editarSession[number];
      return msg.reply('✅ Todos os comprovantes foram salvos com sucesso!');
    }

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (!media) return msg.reply('❌ Falha ao baixar mídia.');

      session.data.comprovantesSalvos = (session.data.comprovantesSalvos || 0) + 1;
      const ext = (media.mimetype && media.mimetype.split('/')[1]) || 'png';

      const pastaPedido = path.join(pathPedidosBase, session.data.number, session.data.pedidoSelecionado);
      // garante que a pasta exista
      try { await fsPromises.mkdir(pastaPedido, { recursive: true }); } catch (e) { /* ok */ }

      const nomeArquivo = `comprovante_${session.data.comprovanteTipo}_${session.data.comprovantesSalvos}.${ext}`;
      const caminhoArquivo = path.join(pastaPedido, nomeArquivo);

      fs.writeFileSync(caminhoArquivo, Buffer.from(media.data, 'base64'));

      return msg.reply(`✅ Comprovante salvo como *${nomeArquivo}*.\nℹ️ Digite */sim* quando terminar.`);
    }

    return msg.reply('❌ Envie uma imagem ou documento válido, ou digite /sim para concluir.');
  }

  // Passo 4: salvar alteração (quando não é comprovante)
  if (session.state === 'await_valor') {
    const { number: numCliente, pedidoSelecionado, campo } = session.data;
    if (!numCliente || !pedidoSelecionado || !campo) {
      delete editarSession[number];
      return msg.reply('❌ Dados da sessão incompletos. Reinicie o /editar.');
    }

    const caminhoInfo = path.join(pathPedidosBase, numCliente, pedidoSelecionado, 'info.txt');
    if (!fs.existsSync(caminhoInfo)) {
      delete editarSession[number];
      return msg.reply('❌ Arquivo info.txt não encontrado.');
    }

    let info;
    try {
      const raw = await fsPromises.readFile(caminhoInfo, 'utf-8');
      info = JSON.parse(raw);
    } catch (e) {
      console.error('Erro ao ler/parsear info.txt:', e);
      delete editarSession[number];
      return msg.reply('❌ Arquivo info.txt inválido.');
    }

    if (campo === 'robux') {
      const novoRobux = parseInt((text || '').replace(/\D/g, ''), 10);
      if (Number.isNaN(novoRobux) || novoRobux <= 0) return msg.reply('❌ Valor inválido. Digite um número maior que 0.');
      info.robux = novoRobux;
      if (typeof recalcularPorMetodoEQuantidade === 'function') recalcularPorMetodoEQuantidade(info);

    } else if (campo === 'valor') {
      const novoValor = parseFloat((text || '').replace(',', '.'));
      if (Number.isNaN(novoValor) || novoValor <= 0) return msg.reply('❌ Valor inválido. Digite um número maior que 0.');
      info.valorReais = Number(novoValor.toFixed(2));
      if ((info.metodo || '').toLowerCase() !== 'gamepass') {
        info.valorgamepass = 0;
      }

    } else if (campo === 'status') {
      const statusValido = (text || '').toLowerCase().trim();
      if (!['aberto', 'finalizado'].includes(statusValido)) return msg.reply('❌ Status inválido. Use: aberto ou finalizado');
      info.status = statusValido;

    } else if (campo === 'link') {
      if (!/^https?:\/\//i.test(text || '')) return msg.reply('❌ Link inválido. Deve começar com http ou https');
      info.gamepass = (text || '').trim();

    } else if (campo === 'metodo') {
      const metodoValido = (text || '').toLowerCase().trim();
      if (!['gamepass', 'gift', 'grupo'].includes(metodoValido))
        return msg.reply('❌ Método inválido. Use: gamepass, gift ou grupo');
      info.metodo = metodoValido;
      if (typeof recalcularPorMetodoEQuantidade === 'function') recalcularPorMetodoEQuantidade(info);
    }

    await fsPromises.writeFile(caminhoInfo, JSON.stringify(info, null, 2));

    await msg.reply(
      `✅ Pedido atualizado!\n` +
      `• método: ${info.metodo}\n` +
      `• robux: ${info.robux}\n` +
      `• valorReais: R$ ${Number(info.valorReais).toFixed(2)}\n` +
      `• valorgamepass: ${info.valorgamepass}`
    );

    delete editarSession[number];
    return;
  }

} catch (err) {
  console.error('Erro no fluxo /editar:', err);
  delete editarSession[number];
  await msg.reply('❌ Ocorreu um erro durante a edição. Tente novamente.');
}



    if (text === '/rank compras') {
      const rank = await carregarRankCompras();
    
      if (!rank || rank.length === 0) {
        return msg.reply('📉 O ranking de compras ainda está vazio.');
      }
    
      const top10 = rank.slice(0, 10);
      let mensagem = '🏆 *Ranking dos 10 Maiores Compradores da Loja*\n';
      mensagem += '━━━━━━━━━━━━━━━━━━━━━━\n';
    
      top10.forEach((cliente, index) => {
        const posicao = index + 1;
        const robuxComprado = Math.round((cliente.totalGasto / valor100) * 100);
    
        let medalha = '🔟';
        if (posicao === 1) medalha = '🥇';
        else if (posicao === 2) medalha = '🥈';
        else if (posicao === 3) medalha = '🥉';
        else if (posicao === 4) medalha = '🏅';
        else if (posicao === 5) medalha = '🎖️';
        else if (posicao <= 10) medalha = '⭐';
    
        mensagem += `${medalha} *${posicao}º Lugar*\n`;
        mensagem += `👤 Número: *${cliente.number}*\n`;
        mensagem += `💰 Total gasto: *R$ ${cliente.totalGasto.toFixed(2)}*\n`;
        mensagem += `🎮 Robux comprados: *${robuxComprado}*\n`;
        mensagem += '━━━━━━━━━━━━━━━━━━━━━━\n';
      });
    
      return msg.reply(mensagem.trim());
    }
    
    
    
    
    
  });
}

module.exports = {
  atualizarRankCompras,
  obterPosicaoRank,
  setupComandosRobux,
  recalcularRankCompras
};