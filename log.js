const fs = require('fs');
const path = require('path');
const os = require('os');
const { MessageMedia } = require('whatsapp-web.js');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

async function logMensagemPrivada(client, msg) {
  const chat = await msg.getChat();
  if (chat.isGroup) return;

  const adminGroupId = config.adminGroupId;
  const contato = await msg.getContact();
  const nome = contato.pushname || contato.name || contato.number;
  const numero = contato.number;

  async function enviarTexto(texto) {
    try {
      await client.sendMessage(adminGroupId, texto);
    } catch (err) {
      console.error("Erro ao enviar mensagem ao grupo admin:", err);
    }
  }

  if (!msg.hasMedia && msg.body && msg.body.trim() !== '') {
    const mensagem = msg.body;
    const logTexto =
      `📩 *MENSAGEM PRIVADA RECEBIDA*\n` +
      `────────────────────────\n` +
      `👤 *Nome:* ${nome}\n` +
      `📞 *Número:* wa.me/${numero}\n` +
      `💬 *Mensagem:*\n` +
      `────────────────────────\n` +
      `\`\`\`\n${mensagem}\n\`\`\``;
    await enviarTexto(logTexto);
    return;
  }

  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (!media || !media.data) {
        await enviarTexto(`❌ *Falha ao baixar mídia de:* wa.me/${numero}`);
        return;
      }

      // Salvar mídia temporariamente
      const ext = media.mimetype.split('/')[1].split(';')[0];
      const tmpFilePath = path.join(os.tmpdir(), `media_${Date.now()}.${ext}`);

      const buffer = Buffer.from(media.data, 'base64');
      fs.writeFileSync(tmpFilePath, buffer);

      const tipoMedia = media.mimetype.split('/')[0];
      const legenda = 
        `📩 *MENSAGEM PRIVADA COM MÍDIA*\n` +
        `────────────────────────\n` +
        `👤 *Nome:* ${nome}\n` +
        `📞 *Número:* wa.me/${numero}\n` +
        `📎 *Tipo:* ${tipoMedia}\n` +
        `💬 *Legenda/Texto:* ${msg.body || '[Nenhum texto]'}\n` +
        `────────────────────────`;

      const mediaMessage = MessageMedia.fromFilePath(tmpFilePath);
      await client.sendMessage(adminGroupId, mediaMessage, { caption: legenda });

      fs.unlinkSync(tmpFilePath);

    } catch (error) {
      console.error('Erro ao processar mídia:', error);
      await enviarTexto(`❌ *Erro ao processar mídia de:* wa.me/${numero}`);
    }

    return;
  }

  await enviarTexto(
    `📩 *MENSAGEM PRIVADA RECEBIDA*\n` +
    `────────────────────────\n` +
    `👤 *Nome:* ${nome}\n` +
    `📞 *Número:* wa.me/${numero}\n` +
    `💬 *Mensagem:* [Conteúdo não reconhecido ou vazio]`
  );
}

module.exports = logMensagemPrivada;
