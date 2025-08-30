const fs = require('fs');
const path = require('path');

const CONEXOES_FILE = path.join(__dirname, 'conexoes.json');
const SENHA_FILE = path.join(__dirname, 'senha_finalizar.txt');

// Configuração
const SENHA_MESTRA = '***'; // Troque pela senha mestra real

// Cria arquivos se não existirem
if (!fs.existsSync(CONEXOES_FILE)) fs.writeFileSync(CONEXOES_FILE, '{}');
if (!fs.existsSync(SENHA_FILE)) fs.writeFileSync(SENHA_FILE, JSON.stringify({ senha: null, expira: 0 }));

let conexoes = JSON.parse(fs.readFileSync(CONEXOES_FILE, 'utf8'));
let senhaData = JSON.parse(fs.readFileSync(SENHA_FILE, 'utf8'));

// Salvar conexões
function salvarConexoes() {
    fs.writeFileSync(CONEXOES_FILE, JSON.stringify(conexoes, null, 2));
}

// Salvar senha
function salvarSenha() {
    fs.writeFileSync(SENHA_FILE, JSON.stringify(senhaData, null, 2));
}

// Gera senha aleatória de 4 dígitos
function gerarSenhaAleatoria() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// Atualiza senha com duração personalizada
function atualizarSenha(minutos = 10) {
    senhaData.senha = gerarSenhaAleatoria();
    senhaData.expira = Date.now() + minutos * 60 * 1000;
    salvarSenha();
    console.log(`🔐 Nova senha gerada: ${senhaData.senha} (expira em ${minutos} minutos)`);
}

// Verifica se senha é válida
function senhaValida(senha) {
    return senhaData.senha && Date.now() < senhaData.expira && senha === senhaData.senha;
}

// Gera senha inicial se não existir ou expirou
if (!senhaData.senha || Date.now() >= senhaData.expira) {
    atualizarSenha();
}

// Checa a cada 1 minuto se a senha expirou e regenera
setInterval(() => {
    if (Date.now() >= senhaData.expira) {
        atualizarSenha();
    }
}, 60 * 1000);

// Adiciona conexão sem sobrescrever
function adicionarConexao(grupoId, numeroCliente, status = "em_andamento") {
    const conexoesPath = path.join(__dirname, 'conexoes.json');
    let conexoes = fs.existsSync(conexoesPath) ? JSON.parse(fs.readFileSync(conexoesPath)) : {};

    conexoes[grupoId] = {
        numero_cliente: numeroCliente,
        status: status
    };

    fs.writeFileSync(conexoesPath, JSON.stringify(conexoes, null, 2));
}

// =====================
// Cancelar grupo
// =====================
async function cancelarGrupo(client, msg, chat, grupoId) {
    try {
        // Remove participantes
        const participantesParaRemover = chat.participants
            .filter(p => p.id._serialized !== client.info.wid._serialized)
            .map(p => p.id._serialized);

        if (participantesParaRemover.length > 0) {
            try {
                await chat.removeParticipants(participantesParaRemover);
            } catch (e) {
                console.log('⚠️ Não consegui remover alguns participantes:', e);
            }
        }

        // Extrair dados do nome do grupo
        const nomeGrupo = chat.name;
        const partesGrupo = nomeGrupo.split(" - ");
        let numeroCliente = partesGrupo[0] || null;

        // Excluir a pasta do pedido
        if (numeroCliente) {
            const pastaCliente = path.join(__dirname, "pedidos", numeroCliente);
            if (fs.existsSync(pastaCliente)) {
                const subpastas = fs.readdirSync(pastaCliente)
                    .map(nome => {
                        const fullPath = path.join(pastaCliente, nome);
                        return { nome, time: fs.statSync(fullPath).mtime.getTime() };
                    })
                    .sort((a, b) => b.time - a.time);

                if (subpastas.length > 0) {
                    const pastaMaisRecente = path.join(pastaCliente, subpastas[0].nome);
                    fs.rmSync(pastaMaisRecente, { recursive: true, force: true });
                    console.log(`🗑️ Pedido cancelado e pasta removida → ${pastaMaisRecente}`);
                }
            }
        }

        // Mensagem de cancelamento ao cliente
        if (numeroCliente) {
            const mensagemCancelamento =
`❌ *Pedido Cancelado* ❌

Olá! Informamos que seu pedido foi cancelado com sucesso.  
Esperamos que em uma próxima oportunidade possamos atendê-lo novamente. 💙  

Atenciosamente,  
*Equipe de Atendimento* 🚀`;

            try {
                await client.sendMessage(`${numeroCliente}@c.us`, mensagemCancelamento);
                console.log(`✅ Mensagem de cancelamento enviada ao cliente ${numeroCliente}`);
            } catch (err) {
                console.error("⚠️ Erro ao enviar mensagem de cancelamento ao cliente:", err);
                await msg.reply("⚠️ Não consegui enviar a mensagem de cancelamento ao cliente, veja os logs.");
            }
        }

        // Limpar conexões
        if (conexoes[grupoId]) {
            delete conexoes[grupoId];
            salvarConexoes();
        }

        await chat.sendMessage('❌ Pedido cancelado. O bot sairá agora.');
        await chat.leave();
        try {
            await chat.clearMessages();
            await chat.archive();
        } catch (e) {
            console.log('Aviso: Não foi possível limpar/arquivar:', e);
        }

        console.log(`❌ Grupo ${chat.name} cancelado e arquivado.`);
    } catch (err) {
        console.error('❌ Erro no cancelamento:', err);
        await msg.reply('❌ Ocorreu um erro ao cancelar.');
    }
}




// =====================
// Finalizar grupo
// =====================
async function finalizarGrupo(client, msg, chat, grupoId) {
    try {
        // Remove participantes
        const participantesParaRemover = chat.participants
            .filter(p => p.id._serialized !== client.info.wid._serialized)
            .map(p => p.id._serialized);

        if (participantesParaRemover.length > 0) {
            try {
                await chat.removeParticipants(participantesParaRemover);
            } catch (e) {
                console.log('⚠️ Não consegui remover alguns participantes:', e);
            }
        }

        // Extrair dados do nome do grupo
        const nomeGrupo = chat.name;
        const partesGrupo = nomeGrupo.split(" - ");

        let numeroCliente = partesGrupo[0] || null;
        let robux = partesGrupo[2] ? parseInt(partesGrupo[2].replace(" Robux", "").trim()) : 0;
        let valorReais = partesGrupo[3] ? parseFloat(partesGrupo[3].replace("R$", "").trim()) : 0;

        // Atualizar info.txt na última pasta do cliente
        if (numeroCliente) {
            const pastaCliente = path.join(__dirname, "pedidos", numeroCliente);
            if (fs.existsSync(pastaCliente)) {
                const subpastas = fs.readdirSync(pastaCliente)
                    .map(nome => {
                        const fullPath = path.join(pastaCliente, nome);
                        return { nome, time: fs.statSync(fullPath).mtime.getTime() };
                    })
                    .sort((a, b) => b.time - a.time);

                if (subpastas.length > 0) {
                    const pastaMaisRecente = path.join(pastaCliente, subpastas[0].nome);
                    const infoPath = path.join(pastaMaisRecente, "info.txt");

                    if (fs.existsSync(infoPath)) {
                        const raw = fs.readFileSync(infoPath, "utf8");
                        let dadosPedido = JSON.parse(raw);

                        dadosPedido.status = "finalizado";
                        fs.writeFileSync(infoPath, JSON.stringify(dadosPedido, null, 2));

                        console.log(`✅ Pedido atualizado → ${infoPath}`);
                    } else {
                        console.log(`⚠️ info.txt não encontrado em: ${infoPath}`);
                        await msg.reply("⚠️ Não encontrei o info.txt do pedido. Verifique os diretórios.");
                    }
                } else {
                    console.log("⚠️ Nenhuma subpasta encontrada para este cliente.");
                }
            } else {
                console.log(`⚠️ Pasta do cliente não encontrada: ${pastaCliente}`);
            }
        }

        // Mensagem final ao cliente
        if (numeroCliente) {
            const mensagemEntrega =
`🎉 *Pedido Entregue com Sucesso!* 🎉

Olá! Informamos que seu pedido de *${robux} Robux* no valor de *R$ ${valorReais.toFixed(2)}* foi entregue com sucesso.

Agradecemos imensamente a sua preferência e confiança em nossos serviços. Esperamos que aproveite seu Robux ao máximo!

Qualquer dúvida ou suporte, estamos à disposição. Muito obrigado pela compra!

Atenciosamente,  
*Equipe de Atendimento* 🚀`;

            try {
                await client.sendMessage(`${numeroCliente}@c.us`, mensagemEntrega);
                console.log(`✅ Mensagem final enviada ao cliente ${numeroCliente}`);
            } catch (err) {
                console.error("⚠️ Erro ao enviar mensagem final ao cliente:", err);
                await msg.reply("⚠️ Não consegui enviar a mensagem final ao cliente, veja os logs.");
            }
        }

        // Limpar conexões
        if (conexoes[grupoId]) {
            delete conexoes[grupoId];
            salvarConexoes();
        }

        await chat.sendMessage('✅ Todos foram removidos. O bot sairá agora.');
        await chat.leave();
        try {
            await chat.clearMessages();
            await chat.archive();
        } catch (e) {
            console.log('Aviso: Não foi possível limpar/arquivar:', e);
        }

        console.log(`✅ Grupo ${chat.name} encerrado e arquivado.`);
    } catch (err) {
        console.error('❌ Erro na finalização direta:', err);
        await msg.reply('❌ Ocorreu um erro ao finalizar.');
    }
}

// =====================
// Handle Encerrar + comprovantes
// =====================
async function handleEncerrar(client, msg) {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;
    const texto = msg.body.trim().toLowerCase();
    const grupoId = chat.id._serialized;

    // Gerar senha
    if (texto.startsWith('/gerarsenha')) {
        const partes = texto.trim().split(/\s+/);
        if (!partes[1]) return msg.reply('❌ Uso correto: /gerarsenha SENHA_MESTRA [tempoEmMinutosEx: 1m]');

        const senhaMaster = partes[1];
        const tempoStr = partes[2] || '10m';
        const tempo = parseInt(tempoStr.replace('m', ''));

        if (senhaMaster === SENHA_MESTRA) {
            atualizarSenha(isNaN(tempo) ? 10 : tempo);
            return msg.reply(`✅ Nova senha gerada: *${senhaData.senha}* (expira em ${isNaN(tempo) ? 10 : tempo} minutos)`);
        } else {
            return msg.reply('🔐 Senha mestra incorreta.');
        }
    }

    // Cancelar grupo
    if (texto.startsWith('/cancelar')) {
        const partes = texto.split(' ');
        if (!partes[1]) return msg.reply('❌ Uso correto: /cancelar SENHA');

        const senha = partes[1];
        if (senhaValida(senha)) {
            await cancelarGrupo(client, msg, chat, grupoId);
        } else {
            await msg.reply('🔐 Senha inválida ou expirada.');
        }
    }


    // Finalizar grupo
    if (texto.startsWith('/finalizar')) {
        const partes = texto.split(' ');
        if (!partes[1]) return msg.reply('❌ Uso correto: /finalizar SENHA');

        const senha = partes[1];
        if (senhaValida(senha)) {
            await finalizarGrupo(client, msg, chat, grupoId);
        } else {
            await msg.reply('🔐 Senha inválida ou expirada.');
        }
    }

    // =====================
// Salvar comprovantes de entrega numerados
// =====================
if (msg.hasMedia) {
    try {
        const media = await msg.downloadMedia();
        if (media) {
            const nomeGrupo = chat.name;
            const numeroCliente = nomeGrupo.split(" - ")[0];
            const pastaCliente = path.join(__dirname, "pedidos", numeroCliente);

            if (fs.existsSync(pastaCliente)) {
                const subpastas = fs.readdirSync(pastaCliente)
                    .map(nome => {
                        const fullPath = path.join(pastaCliente, nome);
                        return { nome, time: fs.statSync(fullPath).mtime.getTime() };
                    })
                    .sort((a, b) => b.time - a.time);

                if (subpastas.length > 0) {
                    const pastaMaisRecente = path.join(pastaCliente, subpastas[0].nome);

                    // Descobrir extensão correta
                    let extensao = ".bin";
                    if (media.mimetype) {
                        const tipo = media.mimetype.split("/")[1];
                        extensao = "." + tipo;
                    }

                    // Descobrir próximo número do comprovante
                    const arquivosExistentes = fs.readdirSync(pastaMaisRecente)
                        .filter(arq => arq.startsWith("comprovante_entrega"))
                        .length;

                    const proximoNumero = arquivosExistentes + 1;
                    const nomeArquivo = `comprovante_entrega${proximoNumero}${extensao}`;
                    const arquivoPath = path.join(pastaMaisRecente, nomeArquivo);

                    fs.writeFileSync(arquivoPath, media.data, "base64");
                    console.log(`📎 Comprovante salvo → ${arquivoPath}`);
                    await msg.reply(`📎 Comprovante salvo como *${nomeArquivo}*`);
                }
            }
        }
    } catch (err) {
        console.error("❌ Erro ao salvar comprovante:", err);
        await msg.reply("❌ Ocorreu um erro ao salvar o comprovante.");
    }
}
}

// Exporta funções
module.exports = {
    conexoes,
    salvarConexoes,
    adicionarConexao,
    atualizarSenha,
    handleEncerrar,
    cancelarGrupo
};
