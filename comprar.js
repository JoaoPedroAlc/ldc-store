const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { exec } = require('child_process');
const configPath = path.join(__dirname, 'config.json');
// Import ranking updater (adjust path if necessary)
const { atualizarRankCompras } = require('./Sistemadevendas');

// --- Helpers to load/save conexoes (persistent mapping groupId -> { numero_cliente, status })
let conexoesAtivas = {};
let adicionarConexao = (groupId, numero, status = 'em_andamento') => {
    conexoesAtivas[groupId] = { numero_cliente: numero, status };
    _saveConexoes();
};
let removerConexao = (groupId) => {
    delete conexoesAtivas[groupId];
    _saveConexoes();
};
const conexoesFile = path.join(__dirname, 'conexoes.json');
function _saveConexoes() {
    try {
        fs.writeFileSync(conexoesFile, JSON.stringify(conexoesAtivas, null, 2));
    } catch (e) {
        console.error('Erro ao salvar conexoes.json', e);
    }
}
function _loadConexoes() {
    // Try to require ./excluir.js first (if it exports conexoes and functions)
    try {
        const excl = require('./excluir');
        if (excl && typeof excl === 'object') {
            if (excl.conexoes) conexoesAtivas = { ...excl.conexoes };
            if (excl.adicionarConexao) adicionarConexao = excl.adicionarConexao;
            if (excl.removerConexao) removerConexao = excl.removerConexao;
            return;
        }
    } catch (e) {
        // ignore
    }
    // fallback to conexoes.json
    try {
        if (fs.existsSync(conexoesFile)) {
            conexoesAtivas = JSON.parse(fs.readFileSync(conexoesFile, 'utf8') || '{}');
        } else {
            conexoesAtivas = {};
            _saveConexoes();
        }
    } catch (e) {
        console.error('Erro ao carregar conexoes.json', e);
        conexoesAtivas = {};
    }
}
_loadConexoes();

// rastreia mensagens já encaminhadas para evitar duplicatas
const forwardedMessageIds = new Set();

// Main export function
function comprarBot(client) {
    // Configs and files
    const PEDIDOS_FILE = path.join(__dirname, 'pedidos.json');
    const INFO_FILE = path.join(__dirname, 'info.json');
    const QRCODE_SCRIPT = path.join(__dirname, 'qrcode3.py');

    // Ensure files exist
    if (!fs.existsSync(PEDIDOS_FILE)) fs.writeFileSync(PEDIDOS_FILE, '[]');
    if (!fs.existsSync(INFO_FILE)) fs.writeFileSync(INFO_FILE, JSON.stringify({
        valor100: 4,
        chave_pix: "12142986480",
        nome_titular: "Joao Pedro (NUBANK)"
    }, null, 2));

    // In-memory session store
    const sessions = {};
    const grupoInfoMap = {}; // groupId -> info

    // forward function moved inside to have access to `client`
    async function forwardToGroupsIfNeeded(grupos, contact, msg, text) {
      try {
        if (!grupos || grupos.length === 0) return;
        const msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : null;
        if (msgId && forwardedMessageIds.has(msgId)) return; // já encaminhada

        const header = `*${contact.pushname || contact.name || ''} - ${(contact.id && contact.id._serialized) ? contact.id._serialized.split('@')[0] : ''}*`;

        for (const gid of grupos) {
          // some groups may no longer exist; ignore errors
          try {
            if (msg.hasMedia || msg.type === 'DOCUMENT') {
              const media = await msg.downloadMedia();
              const mediaToSend = new MessageMedia(media.mimetype, media.data, media.filename || undefined);
              if (text && text.trim().length > 0) {
                await client.sendMessage(gid, mediaToSend, { caption: `${header}\n${text}` });
              } else {
                await client.sendMessage(gid, mediaToSend, { caption: header });
              }
            } else {
              await client.sendMessage(gid, `${header}\n${text}`);
            }
          } catch (e) {
            console.error('Erro ao encaminhar para grupo', gid, e);
          }
        }

        if (msgId) forwardedMessageIds.add(msgId);
      } catch (e) {
        console.error('Erro forwardToGroupsIfNeeded', e);
      }
    }

    // Utility functions
    function formatTimestamp(date) {
        return date.toISOString().replace(/[:.]/g, '-');
    }
    function formatDataHoraBR(date) {
        return date.toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }
    function garantirPasta(pasta) {
        if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
    }
    async function contarPedidosAbertosCliente(number) {
        // Simple implementation: count folders under ./pedidos/number where info.txt status === 'aberto'
        try {
            const base = path.join(__dirname, 'pedidos', number);
            if (!fs.existsSync(base)) return 0;
            const datas = fs.readdirSync(base);
            let count = 0;
            for (const d of datas) {
                const infoPath = path.join(base, d, 'info.txt');
                if (fs.existsSync(infoPath)) {
                    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                    if (!info.status || info.status === 'aberto') count++;
                }
            }
            return count;
        } catch (e) {
            console.error('Erro contarPedidosAbertosCliente', e);
            return 0;
        }
    }

    // Load adminGroupId if configured
    let adminGroupId = null;
    if (fs.existsSync(configPath)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(configPath));
            adminGroupId = cfg.adminGroupId || null;
        } catch (e) { /* ignore */ }
    }

    // Core message handler (single handler to avoid duplicate logic)
    client.on('message', async (msg) => {
        // variables declared outside try so finally can access them
        let chat, contact, privateId, number, isGroup, groupId, text;
        let gruposDoCliente = [];

        try {
            chat = await msg.getChat();
            contact = await msg.getContact();
            privateId = contact.id._serialized;
            number = privateId.split('@')[0];
            isGroup = chat.isGroup;
            groupId = chat.id._serialized;
            text = msg.body || '';

            // precoleta grupos / flags (usadas no forward ao final)
            gruposDoCliente = Object.keys(conexoesAtivas).filter(gid => conexoesAtivas[gid].numero_cliente === number);
            const isCommand = (text && text.trim().startsWith('/'));
            const hasActiveSession = sessions[number] && !!sessions[number].state;

            // --- IMPORTANT: do NOT forward private messages here before processing.
            // We'll forward *after* processing in the finally block so the flow isn't interrupted.

            // 2) Se a mensagem é no grupo e o grupo tem conexão ativa -> ponte admin → cliente
            if (isGroup && conexoesAtivas[groupId]) {
              const conexao = conexoesAtivas[groupId];

              // Se o cliente mandar no grupo, ignora (pra evitar loop)
              if (number === conexao.numero_cliente) {
                return;
              }

              // Se for um comando (começa com '/'), NÃO encaminhar para o cliente,
              // mas permitir que o restante do handler processe o comando localmente.
              if (text.trim().startsWith('/')) {
                // não forward; apenas continue o fluxo para permitir comandos como /info funcionar
              } else {
                // Caso contrário, envia para o cliente (comportamento anterior)
                const clienteId = conexao.numero_cliente + '@c.us';
                const nomeAdmin = contact.pushname || contact.name || number;
                const header = `*[ADMIN]* ${nomeAdmin} - ${number}`;
                if (msg.hasMedia || msg.type === 'DOCUMENT') {
                  const media = await msg.downloadMedia();
                  const mediaToSend = new MessageMedia(media.mimetype, media.data, media.filename || undefined);
                  if (text && text.trim().length > 0) {
                    await client.sendMessage(clienteId, mediaToSend, { caption: `${header}\n${text}` });
                  } else {
                    await client.sendMessage(clienteId, mediaToSend, { caption: header });
                  }
                } else {
                  await client.sendMessage(clienteId, `${header}\n${text}`);
                }
                return; // já encaminhou, finaliza aqui (não precisamos processar mais essa mensagem)
              }
            }

            // --- /info handler (substitua o bloco antigo por este) ---
            if (text.startsWith('/info') && isGroup) {
              const titulo = (chat.name || '').trim();

              function parseGroupTitle(t) {
                  const parts = t.split(' - ').map(p => p.trim());
                  const result = {};
                  if (parts.length < 3) return null;
                  const possibleNumber = parts[0].replace(/\D/g, '');
                  if (!possibleNumber) return null;
                  result.numero = possibleNumber;

                  const robuxPart = parts.find(p => /robux/i.test(p));
                  if (robuxPart) {
                      const match = robuxPart.match(/(\d{1,7})/);
                      if (match) result.robux = parseInt(match[1], 10);
                  }

                  const valorPart = parts.find(p => /R\$\s*[\d.,]+/i.test(p));
                  if (valorPart) {
                      const match = valorPart.match(/R\$\s*([\d.,]+)/i);
                      if (match) {
                          const num = parseFloat(match[1].replace(/\./g,'').replace(',', '.'));
                          if (!isNaN(num)) result.valorReais = num;
                      }
                  }

                  const lastPart = parts[parts.length - 1];
                  if (/\d{2}\/\d{2}\/\d{4}/.test(lastPart) || /\d{2}:\d{2}/.test(lastPart)) {
                      result.dataHora = lastPart;
                  }

                  return result;
              }

              const parsed = parseGroupTitle(titulo);
              if (!parsed) {
                  await msg.reply('❌ Este comando só pode ser usado em grupos de pedido (nome do grupo no formato de pedido).');
                  return;
              }

              const numero = parsed.numero;
              const esperadoRobux = parsed.robux || null;
              const esperadoValor = parsed.valorReais || null;

              function findMatchingInfo(numero, esperadoRobux, esperadoValor) {
                  try {
                      const pastaCliente = path.join(__dirname, 'pedidos', numero);
                      if (!fs.existsSync(pastaCliente)) return null;
                      const datas = fs.readdirSync(pastaCliente).sort().reverse(); // mais recentes primeiro
                      for (const dataFolder of datas) {
                          const caminhoInfo = path.join(pastaCliente, dataFolder, 'info.txt');
                          if (!fs.existsSync(caminhoInfo)) continue;
                          try {
                              const dados = JSON.parse(fs.readFileSync(caminhoInfo, 'utf8'));
                              let ok = true;
                              if (esperadoRobux && dados.robux && parseInt(dados.robux,10) !== parseInt(esperadoRobux,10)) ok = false;
                              if (esperadoValor && dados.valorReais) {
                                  const a = Math.round(parseFloat(dados.valorReais) * 100);
                                  const b = Math.round(parseFloat(esperadoValor) * 100);
                                  if (a !== b) ok = false;
                              }
                              if (ok) {
                                  dados._pasta = path.join(pastaCliente, dataFolder);
                                  return dados;
                              }
                          } catch (e) {
                              console.error('Erro parse info.txt', caminhoInfo, e);
                          }
                      }
                      // fallback: retorna o mais recente
                      const recent = datas.find(df => fs.existsSync(path.join(pastaCliente, df, 'info.txt')));
                      if (recent) {
                          const caminhoInfo = path.join(pastaCliente, recent, 'info.txt');
                          const dados = JSON.parse(fs.readFileSync(caminhoInfo, 'utf8'));
                          dados._pasta = path.join(pastaCliente, recent);
                          return dados;
                      }
                      return null;
                  } catch (e) {
                      console.error('Erro findMatchingInfo', e);
                      return null;
                  }
              }

              let infoPedido = findMatchingInfo(numero, esperadoRobux, esperadoValor);

              if (!infoPedido) {
                  // fallback tentando a partir de conexoesAtivas[groupId]
                  if (conexoesAtivas[groupId] && conexoesAtivas[groupId].numero_cliente === numero) {
                      const pastaCliente = path.join(__dirname, 'pedidos', numero);
                      let fallbackInfo = {};
                      try {
                          if (fs.existsSync(pastaCliente)) {
                              const datas = fs.readdirSync(pastaCliente).sort().reverse();
                              for (const dataFolder of datas) {
                                  const caminhoInfo = path.join(pastaCliente, dataFolder, 'info.txt');
                                  if (fs.existsSync(caminhoInfo)) {
                                      fallbackInfo = JSON.parse(fs.readFileSync(caminhoInfo, 'utf8'));
                                      fallbackInfo._pasta = path.join(pastaCliente, dataFolder);
                                      break;
                                  }
                              }
                          }
                      } catch (err) {
                          console.error('Erro fallback info.txt', err);
                      }
                      if (!fallbackInfo || Object.keys(fallbackInfo).length === 0) {
                          await msg.reply('❌ Não foi possível localizar informações do pedido para este grupo. Verifique se existe um arquivo `pedidos/<numero>/.../info.txt`.');
                          return;
                      }
                      infoPedido = fallbackInfo;
                  } else {
                      await msg.reply('❌ Não foi possível encontrar o pedido correspondente a este grupo. Certifique-se de que o nome do grupo esteja no formato de pedido e que exista `pedidos/<numero>/.../info.txt`.');
                      return;
                  }
              }

              // monta resposta
              const finalInfo = infoPedido;
              finalInfo.numero = finalInfo.numero || numero;
              const linkGamepass = finalInfo.gamepass || 'Não informado';
              const valorPor100 = finalInfo.robux ? (finalInfo.valorReais / finalInfo.robux) * 100 : 0;
              let metodo = '';
              if (valorPor100 === 4.0) metodo = '🎟️ Gamepass';
              else if (valorPor100 === 4.6) metodo = '👥 Grupo';
              else if (valorPor100 === 2.8) metodo = '🎁 Gift';
              else metodo = '❓ Desconhecido';
              const valorgamepass = finalInfo.robux ? Math.ceil(finalInfo.robux / 0.7) : 'N/D';

              // tenta localizar comprovante_pagamento.* na pasta (finalInfo._pasta) ou em ./pedidos/<numero>/*
              try {
                  let comprovantePath = null;
                  if (finalInfo._pasta && fs.existsSync(finalInfo._pasta)) {
                      const files = fs.readdirSync(finalInfo._pasta);
                      const found = files.find(f => /^comprovante_pagamento\./i.test(f));
                      if (found) comprovantePath = path.join(finalInfo._pasta, found);
                  }
                  if (!comprovantePath) {
                      const pastaCliente = path.join(__dirname, 'pedidos', finalInfo.numero || numero);
                      if (fs.existsSync(pastaCliente)) {
                          const datas = fs.readdirSync(pastaCliente).sort().reverse();
                          for (const dataFolder of datas) {
                              const candidate = path.join(pastaCliente, dataFolder);
                              if (!fs.existsSync(candidate)) continue;
                              const files = fs.readdirSync(candidate);
                              const found = files.find(f => /^comprovante_pagamento\./i.test(f));
                              if (found) { comprovantePath = path.join(candidate, found); break; }
                          }
                      }
                  }

                  if (comprovantePath && fs.existsSync(comprovantePath)) {
                      try {
                          const comprovanteMedia = MessageMedia.fromFilePath(comprovantePath);
                          await client.sendMessage(groupId, comprovanteMedia, { caption: `📎 Comprovante de ${finalInfo.nomeCliente || finalInfo.numero}` });
                      } catch (e) {
                          console.error('Erro ao enviar comprovante no /info:', e);
                      }
                  }
              } catch (e) {
                  console.error('Erro ao procurar comprovante para /info:', e);
              }

              const resposta =
                  `📦 *Informações do Pedido*\n\n` +
                  `👤 Cliente: ${finalInfo.nomeCliente || 'N/D'}\n` +
                  `📱 Número: ${finalInfo.numero || 'N/D'}\n` +
                  `🎮 Robux: ${finalInfo.robux || 'N/D'}\n` +
                  `💰 Valor: R$ ${finalInfo.valorReais?.toFixed(2) || 'N/D'}\n` +
                  `🧮 Gamepass precisa ser criado com: *${valorgamepass} Robux*\n` +
                  `📦 Método: ${metodo}\n` +
                  `🔗 Link: ${linkGamepass}\n` +
                  `🕒 Data: *${finalInfo.data || finalInfo.dataHora || 'N/D'}*`;

              await msg.reply(resposta);
              return;
            }


            // /setadmingroup (only in group)
            if (text.startsWith('/setadmingroup') && isGroup) {
                adminGroupId = groupId;
                const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};
                config.adminGroupId = adminGroupId;
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                await msg.reply('✅ Grupo de administração definido com sucesso!');
                return;
            }

            // /comprar command (can be in group or private)
            if (text.startsWith('/comprar')) {
                // reload adminGroupId if needed
                if (!adminGroupId && fs.existsSync(configPath)) {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(configPath));
                        adminGroupId = cfg.adminGroupId || null;
                    } catch (e) { /* ignore */ }
                }
                if (!adminGroupId) {
                    await msg.reply('⚠️ Grupo de administração não definido. Use /setadmingroup em um grupo primeiro.');
                    return;
                }

                if (isGroup) {
                    await msg.reply(`✅ Olá ${contact.pushname || ''}, recebemos seu pedido. Continuaremos no privado.`);
                }

                const parts = text.split(' ');
                if (parts.length < 2) {
                    await msg.reply('❌ Uso: /comprar QUANTIDADE\nEx: /comprar 100');
                    return;
                }
                const robux = parseInt(parts[1]);
                if (isNaN(robux) || robux <= 0 || robux > 100000) {
                    await msg.reply('❌ Quantidade inválida. Informe entre 1 e 100000.');
                    return;
                }

                const pedidosAbertos = await contarPedidosAbertosCliente(number);
                if (pedidosAbertos >= 5) {
                    await msg.reply(`❌ Você já possui ${pedidosAbertos} pedidos abertos. Aguarde a finalização antes de fazer um novo pedido.`);
                    return;
                }

                const privateId = number + '@c.us';
                if (!sessions[number]) sessions[number] = { grupos: [] };
                sessions[number].robux = robux;
                sessions[number].state = 'await_metodo';
                sessions[number].nomeCliente = contact.pushname || number;

                await client.sendMessage(privateId,
                    `👋 Olá ${contact.pushname || ''}!\n\nRecebemos seu pedido de *${robux} Robux*.\n\nPor favor, escolha o método de recebimento:\n\n1️⃣ *gamepass* (padrão)\n💳 *gift* \n👥 *grupo* (100 Robux = R$ 4,50)\n\nDigite o método desejado.`
                );
                return;
            }

            // Handle ongoing session states (private only)
            const session = sessions[number];
            if (session && !isGroup) {

                if (/^cancelar$/i.test(text.trim())) {
                    delete sessions[number];
                    await client.sendMessage(privateId, '❌ Pedido cancelado com sucesso.');
                    return;
                }    

                // Various states: await_metodo, await_receipt, await_gamepass, await_confirm, etc.
                if (session.state === 'await_metodo') {
                    const metodo = text.trim().toLowerCase();
                    let valor100Final = 4;
                    if (metodo === 'gift') valor100Final = 2.8;
                    else if (metodo === 'grupo') valor100Final = 4.6;
                    else if (metodo !== 'gamepass' && metodo !== '1' && metodo !== 'gamepass') {
                        await client.sendMessage(privateId, '❌ Método inválido. Digite *gamepass*, *gift* ou *grupo*.');
                        return;
                    }
                    // Accept '1' as gamepass alias
                    session.metodo = metodo === '1' ? 'gamepass' : metodo;
                    session.valorReais = parseFloat(((session.robux / 100) * valor100Final).toFixed(2));

                    // Generate QR code via external script (if present)
                    const chavePix = "12142986480";
                    const caminhoPython = "python";
                    const caminhoScript = QRCODE_SCRIPT;
                    const fileName = `${chavePix}_${Date.now()}.png`;
                    const cmd = `${caminhoPython} "${caminhoScript}" "${chavePix}" ${session.valorReais.toFixed(2)} "${fileName}"`;

                    await client.sendMessage(privateId, '💳 Gerando QR Code, aguarde...');
                    exec(cmd, async (err, stdout) => {
                        if (err) {
                            console.error('Erro gerar QR:', err);
                            await client.sendMessage(privateId, '❌ Erro ao gerar QR Code.');
                            session.state = 'await_metodo';
                            return;
                        }
                        const [qrPathRaw, copiaColaRaw] = stdout.trim().split('\n');
                        const qrPath = (qrPathRaw || '').trim().replace(/\r/g, '');
                        const copiaCola = (copiaColaRaw || '').trim();
                        if (fs.existsSync(qrPath)) {
                            const media = MessageMedia.fromFilePath(qrPath);
                            session.copiaCola = copiaCola;
                            let txtMetodo = session.metodo === 'gift' ? '🎁 *Gift*' : session.metodo === 'grupo' ? '👥 *Grupo*' : '🎟️ *Gamepass*';
                            await client.sendMessage(privateId, media, {
                                caption: `🎮 *Compra de Robux* 🎮\n\nVocê solicitou *${session.robux} Robux* via ${txtMetodo}.\n💵 Valor: R$ ${session.valorReais.toFixed(2)}\n💳 PIX: ${chavePix}\n👤 Titular: Joao Pedro\n\nEnvie o comprovante do pagamento ou digite "cancelar" para desistir.`
                            });
                            await client.sendMessage(privateId, '🔗 *O código Copia e Cola será enviado em 1 segundo...*');
                            setTimeout(() => client.sendMessage(privateId, copiaCola), 1000);
                        } else {
                            await client.sendMessage(privateId, '❌ Não foi possível localizar o QR gerado.');
                        }
                        session.state = 'await_receipt';
                    });
                    return;
                }

                if (session.state === 'await_receipt') {
                    if (msg.hasMedia || msg.type === 'DOCUMENT') {
                        const media = await msg.downloadMedia();
                        session.comprovante = media;
                        // create group for admins
                        try {
                            const { criarGrupoPedido } = require('./criargrupo.js');
                            const dataHora = new Date().toLocaleString('pt-BR', {
                                day: '2-digit', month: '2-digit', year: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                            });
                            const nomeGrupo = `${number} - ${session.metodo} - ${session.robux} Robux - R$ ${session.valorReais?.toFixed(2) || 'N/A'} - ${dataHora}`;
                            const { grupo, grupoLink } = await criarGrupoPedido(client, nomeGrupo);
                            const gid = grupo.id._serialized;
                            session.grupoId = gid;
                            session.grupoLink = grupoLink;
                            // persist connection
                            conexoesAtivas[gid] = { numero_cliente: number, status: 'em_andamento' };
                            adicionarConexao(gid, number, 'em_andamento');
                            grupoInfoMap[gid] = {
                                nomeCliente: contact.pushname || number,
                                numero: number,
                                robux: session.robux,
                                valorReais: session.valorReais,
                                dataHora
                            };
                            // notify adminGroupId if set
                            if (adminGroupId) {
                                await client.sendMessage(adminGroupId, `📌 *Novo grupo criado para pedido:*\n👤 Cliente: ${contact.pushname || number}\n📱 Número: ${number}\n🎮 Robux: ${session.robux}\n💰 Valor: R$ ${session.valorReais?.toFixed(2) || 'N/A'}\n🕒 Data: *${dataHora}*\n🔗 Link: ${grupoLink || 'N/D'}`);
                            }
                        } catch (e) {
                            console.error('Erro criar grupo:', e);
                            await client.sendMessage(privateId, '⚠️ Erro ao criar grupo do pedido, mas continuaremos atendimento.');
                        }

                        if (session.metodo === 'gift' || session.metodo === 'grupo') {
                            session.neededRobux = 0;
                            await client.sendMessage(privateId,
                                `👍 Comprovante recebido!
                                
                                🎮 Agora envie o link da sua conta Roblox aqui.
                                
                                Exemplo: https://www.roblox.com/users/123456789/profile
                                
                                🔎 Como pegar o link da sua conta Roblox pelo navegador:
                                1. Abra o site do Roblox e faça login.  
                                2. Clique no seu avatar (canto superior direito → "Perfil").  
                                3. Copie o link da barra de endereço do navegador.  
                                   → Ele será parecido com: https://www.roblox.com/users/SEU-ID/profile  
                                4. Cole esse link aqui no chat.`);
                        } else {
                            const neededRobux = Math.ceil(session.robux / 0.7);
                            session.neededRobux = neededRobux;
                            const message = [
                                "👍 Comprovante recebido!",
                                "",
                                "*⚠️ NÃO ESQUECER DE DESATIVAR O PREÇO REGIONAL!*",
                                "",
                                "🎮 Agora siga estas etapas:",
                                `1️⃣ Crie um Game Pass com o valor de *${neededRobux} Robux*.`,
                                "2️⃣ Use o vídeo: https://www.youtube.com/watch?v=aLZx6B2tLmg",
                                "",
                                "👉 Envie o link do Game Pass ou o link da sua conta Roblox aqui."
                            ].join("\n");
                            
                            await client.sendMessage(privateId, message);
                        }
                        session.state = 'await_gamepass';
                        return;
                    } else if (/^cancelar$/i.test(text)) {
                        delete sessions[number];
                        await client.sendMessage(privateId, '❌ Pedido cancelado com sucesso.');
                        return;
                    } else {
                        await client.sendMessage(privateId, '❌ Por favor, envie o comprovante do pagamento ou digite "cancelar".');
                        return;
                    }
                }

                if (session.state === 'await_gamepass') {
                    const link = text.trim();
                    const linkValido = link.startsWith('https://www.roblox.com/game-pass/') ||
                        link.startsWith('https://www.roblox.com/users/') ||
                        /^https?:\/\/.+/.test(link);
                    if (!linkValido) {
                        await client.sendMessage(privateId, '❌ Envie um link válido do gamepass ou da conta Roblox, ou digite "cancelar".');
                        return;
                    }
                    session.gamepass = link;
                    await client.sendMessage(privateId, `📦 Confirme seu pedido:\nRobux: ${session.robux}\nValor: R$ ${session.valorReais.toFixed(2)}\nGame Pass / Conta Roblox: ${session.gamepass}\n🔁 Criado com valor de ${session.neededRobux} Robux\n\n❓Você confirma? (sim/não)`);
                    session.state = 'await_confirm';
                    return;
                }

                if (session.state === 'await_confirm') {
                    if (/^sim$/i.test(text)) {
                        const pedidoData = new Date();
                        const pedidoDataStr = formatTimestamp(pedidoData);
                        const pedidoDataExibicao = formatDataHoraBR(pedidoData);
                        const pastaCliente = path.join(__dirname, 'pedidos', number);
                        const pastaData = path.join(pastaCliente, pedidoDataStr);
                        garantirPasta(pastaData);
                        if (session.comprovante) {
                            const ext = session.comprovante.mimetype.split('/')[1] || 'png';
                            const nomeComprovante = `comprovante_pagamento.${ext}`;
                            const caminhoComprovante = path.join(pastaData, nomeComprovante);
                            const buffer = Buffer.from(session.comprovante.data, 'base64');
                            fs.writeFileSync(caminhoComprovante, buffer);
                        }
                        const infoPedido = {
                            valorReais: session.valorReais,
                            robux: session.robux,
                            gamepass: session.gamepass,
                            valorgamepass: session.neededRobux,
                            data: pedidoDataExibicao,
                            status: 'aberto'
                        };
                        const caminhoInfo = path.join(pastaData, 'info.txt');
                        fs.writeFileSync(caminhoInfo, JSON.stringify(infoPedido, null, 2));
                        const caminhoComprovanteEntrega = path.join(pastaData, 'comprovante_entrega.txt');
                        if (!fs.existsSync(caminhoComprovanteEntrega)) fs.writeFileSync(caminhoComprovanteEntrega, 'Comprovante de entrega não enviado ainda.');
                        let all = [];
                        if (fs.existsSync(path.join(__dirname, 'pedidos.json'))) all = JSON.parse(fs.readFileSync(path.join(__dirname, 'pedidos.json')));
                        all.push({
                            number,
                            valorReais: session.valorReais,
                            robux: session.robux,
                            gamepass: session.gamepass,
                            data: pedidoDataExibicao
                        });
                        fs.writeFileSync(path.join(__dirname, 'pedidos.json'), JSON.stringify(all, null, 2));
                        // Atualiza ranking compras
                        try { await atualizarRankCompras(number, session.valorReais); } catch (e) { console.error('Erro atualizar rank', e); }
                        await client.sendMessage(privateId, '✅ Pedido registrado com sucesso e arquivos salvos no servidor!');
                        // Send comprovante to group if exists
                        if (session.grupoId && session.comprovante) {
                            const comprovanteMedia = new MessageMedia(session.comprovante.mimetype, session.comprovante.data, session.comprovante.filename || undefined);
                            await client.sendMessage(session.grupoId, comprovanteMedia, { caption: `📎 Comprovante de ${contact.pushname || number}` });
                            // marca a mensagem original como encaminhada para evitar re-forward automático
                            if (msg.id && msg.id._serialized) forwardedMessageIds.add(msg.id._serialized);
                        }
                        if (session.grupoId) {
                            conexoesAtivas[session.grupoId] = { numero_cliente: number, status: 'registrado' };
                            adicionarConexao(session.grupoId, number, 'registrado');
                        }
                        delete sessions[number];
                        return;
                    } else if (/^não$/i.test(text)) {
                        await client.sendMessage(privateId, 'Deseja editar ou cancelar o pedido? (editar/cancelar)');
                        session.state = 'await_edit_cancel';
                        return;
                    } else {
                        await client.sendMessage(privateId, 'Responda com "sim" ou "não".');
                        return;
                    }
                }

                if (session.state === 'await_edit_cancel') {
                    if (/^cancelar$/i.test(text)) {
                        delete sessions[number];
                        await client.sendMessage(privateId, '❌ Pedido cancelado.');
                        return;
                    } else if (/^editar$/i.test(text)) {
                        await client.sendMessage(privateId, 'Qual campo deseja editar? (valor/robux/gamepass)');
                        session.state = 'await_edit_field';
                        return;
                    } else {
                        await client.sendMessage(privateId, 'Responda com "editar" ou "cancelar".');
                        return;
                    }
                }

                if (session.state === 'await_edit_field') {
                    const field = text.toLowerCase();
                    if (!['valor', 'robux', 'gamepass'].includes(field)) {
                        await client.sendMessage(privateId, 'Campo inválido. Escolha entre valor, robux ou gamepass.');
                        return;
                    }
                    session.editField = field;
                    await client.sendMessage(privateId, `Digite o novo valor para ${field}:`);
                    session.state = 'await_edit_value';
                    return;
                }

                if (session.state === 'await_edit_value') {
                    const field = session.editField;
                    const val = text.trim();
                    if (field === 'valor') {
                        const novoValor = parseFloat(val);
                        if (isNaN(novoValor) || novoValor <= 0) { await client.sendMessage(privateId, 'Valor inválido.'); return; }
                        const fator = novoValor / session.valorReais;
                        session.valorReais = novoValor;
                        session.robux = Math.round(session.robux * fator);
                        session.neededRobux = Math.ceil(session.robux / 0.7);
                    } else if (field === 'robux') {
                        const novoRobux = parseInt(val);
                        if (isNaN(novoRobux) || novoRobux <= 0) { await client.sendMessage(privateId, 'Robux inválido.'); return; }
                        session.robux = novoRobux;
                        session.valorReais = parseFloat(((novoRobux / 100) * 4).toFixed(2));
                        session.neededRobux = Math.ceil(session.robux / 0.7);
                    } else if (field === 'gamepass') {
                        session.gamepass = val;
                    }
                    await client.sendMessage(privateId, 'Campo atualizado. Confirma? (sim/não)');
                    session.state = 'await_confirm';
                    return;
                }
            }

        } catch (err) {
            console.error('Erro no handler de mensagem:', err);
        } finally {
            // após processar tudo, encaminha a mensagem privada para os grupos (se houver)
            try {
                if (!isGroup && gruposDoCliente && gruposDoCliente.length > 0) {
                    await forwardToGroupsIfNeeded(gruposDoCliente, contact, msg, text);
                }
            } catch (e) {
                console.error('Erro ao encaminhar mensagem no finally:', e);
            }
        }
    });

    // On group join show info if available
    client.on('group_join', async (notification) => {
        try {
            const chat = await notification.getChat();
            const groupId = chat.id._serialized;
            const number = notification.id.participant.split('@')[0];
            const info = grupoInfoMap[groupId];
            if (!info) return;
            const dataHora = new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
            const valorPor100 = (info.valorReais / info.robux) * 100;
            let metodo = '';
            if (valorPor100 === 4.0) metodo = '🎟️ Gamepass';
            else if (valorPor100 === 4.6) metodo = '👥 Grupo';
            else if (valorPor100 === 2.8) metodo = '🎁 Gift';
            else metodo = '❓ Desconhecido';
            const valorgamepass = Math.ceil(info.robux / 0.7);
            await chat.sendMessage(
                `📦 *Informações do Pedido*\n\n`+
                `👤 Cliente: ${info.nomeCliente}\n`+
                `📱 Número: ${info.numero}\n`+
                `🎮 Robux: ${info.robux}\n`+
                `💰 Valor: R$ ${info.valorReais?.toFixed(2) || 'N/A'}\n`+
                `🧮 Gamepass precisa ser criado com: *${valorgamepass} Robux*\n`+
                `📦 Método: ${metodo}\n`+
                `🕒 *Data:* *${dataHora}*`
            );
            await chat.sendMessage('/info  - informação sobre o pedido\n/finalizar SENHA - Fecha pedido\n/gerarsenha SENHA_MESTRA [tempoEmMinutos] - gera senha para fechar pedido');
        } catch (err) {
            console.error('Erro ao processar entrada no grupo:', err);
        }
    });

    return { runBot: () => console.log('comprarBot pronto (use a função runBot interna ao inicializar cliente)') };
}

// Export module: expect to be called with the client instance
module.exports = function (client) {
    const bot = comprarBot(client);
    // If you want to explicitly call runBot, you can; the handlers are attached immediately above via client.on
    return bot;
};
