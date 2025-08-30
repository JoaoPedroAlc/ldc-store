const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Bot conectado e pronto para criar grupos!'));



async function criarGrupoPedido(client, nomeGrupo) {
  try {
    const chat = await client.createGroup(nomeGrupo);
    const grupo = await client.getChatById(chat.gid._serialized);
    const code = await grupo.getInviteCode();
    const grupoLink = `https://chat.whatsapp.com/${code}`;
    
    return { grupo, grupoLink }; // retorna os dois
  } catch (error) {
    console.error('Erro ao criar grupo:', error);
    return null;
  }
}
module.exports = { criarGrupoPedido };






