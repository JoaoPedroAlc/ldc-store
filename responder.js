const sessionsResponder = {};

// Função para limpar número e formatar para o formato do WhatsApp Web (ex: 558195132076)
function formatarNumero(numeroRaw) {
  // Remove espaços, traços, parênteses e outros caracteres não numéricos
  return numeroRaw.replace(/\D/g, '');
}

/**
 * handleCommand - Processa comandos /w +5511999999999 e /w para ligar/desligar responder
 * @param {Client} client - instância do WhatsApp client
 * @param {Message} msg - mensagem recebida
 * @param {string} text - conteúdo da mensagem (msg.body)
 * @returns {Promise<boolean>} - true se comando foi processado, false se não
 */
async function handleCommand(client, msg, text) {
  const from = msg.from; // número do usuário que está enviando o comando
  const args = text.trim().split(' ').slice(1);

  if (args.length === 0) {
    // /w sem número -> desativa responder para esse usuário
    if (sessionsResponder[from]) {
      delete sessionsResponder[from];
      await msg.reply('✅ Modo responder desativado.');
    } else {
      await msg.reply('❌ Você não está no modo responder.');
    }
    return true;
  }

  // /w +55 81 9513-2076 (pode vir com espaços, traços etc)
  const numeroFormatado = formatarNumero(args.join(''));
  if (!numeroFormatado.match(/^\d{10,15}$/)) {
    await msg.reply('❌ Número inválido. Use o formato: /w +558195132076');
    return true;
  }

  sessionsResponder[from] = numeroFormatado;
  await msg.reply(
    `✅ Modo responder ativado para: wa.me/${numeroFormatado}\nEnvie mensagens ou mídia para encaminhar.\nEnvie /w para desativar.`
  );
  return true;
}

/**
 * handleMessage - Verifica se o usuário está em modo responder, e se sim encaminha mensagem para o número
 * @param {Client} client
 * @param {Message} msg
 * @returns {Promise<boolean>} true se encaminhou, false se não
 */
async function handleMessage(client, msg) {
  const from = msg.from;
  if (!sessionsResponder[from]) return false; // não está no modo responder

  const numeroDestino = sessionsResponder[from];

  try {
    const contatoAdmin = await msg.getContact();
    const nomeAdmin = contatoAdmin.pushname || contatoAdmin.name || 'Admin';

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (!media) {
        await msg.reply('❌ Falha ao baixar mídia para encaminhar.');
        return true;
      }

      const legenda = `*[Admin]:* ${nomeAdmin} \n\n ${msg.body || ''} `;
      await client.sendMessage(numeroDestino + '@c.us', media, { caption: legenda });
    } else if (msg.body && msg.body.trim() !== '') {
      const textoParaEnviar = `*[ADMIN]:* ${nomeAdmin} \n\n ${msg.body} `;
      await client.sendMessage(numeroDestino + '@c.us', textoParaEnviar);
    } else {
      await msg.reply('❌ Mensagem vazia ou formato não suportado.');
    }
  } catch (error) {
    console.error('Erro ao encaminhar mensagem no modo responder:', error);
    await msg.reply('❌ Erro ao enviar a mensagem. Tente novamente.');
  }

  return true;
}

module.exports = {
  handleCommand,
  handleMessage,
};