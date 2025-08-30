const fs = require('fs');
const path = require('path');


function setupComandosgeral(client) {
    

    client.on('message', async msg => {
        if (!msg.from.endsWith('@g.us')) return;

        const chat = await msg.getChat();
        const command = msg.body.trim().toLowerCase();
        const args = msg.body.trim().split(' ').slice(1);
        const textoAdicional = args.join(' ');
        const texto = msg.body.toLowerCase().trim();

        // Verifica se é admin
        const authorId = msg.author || msg.from;
        const participante = chat.participants.find(p => p.id._serialized === authorId);
        const isAdmin = participante?.isAdmin || false;

       
      
       // Comando principal /link
        if (texto === '/link') {
            await msg.reply(
                `🔗 *Escolha qual link você deseja:*\n\n` +
                `📱 WhatsApp → */link whats*\n` +
                `🎮 Grupo do Roblox → */link roblox*\n` +
                `🌐 Site Oficial → */site*`
            );
            return;
        }

        // Link do WhatsApp
        if (texto === '/link whats') {
            await msg.reply(`📱 *Link do WhatsApp:*

        ✦ 」 𝙊𝙞𝙞𝙞! 𝖤𝗌𝗍𝖺𝗏𝖺 𝖺 𝗉𝗋𝗈𝖼𝗎𝗋𝖺 𝖽𝖾 𝗎𝗆𝖺 l̳o̳j̳a̳ ̳d̳e̳ ̳r̳o̳b̳u̳x̳ ̳m̳e̳g̳a̳ ̳c̳o̳n̳f̳i̳á̳v̳e̳l̳ ̳𝖾 𝖼𝗈𝗆 𝗈𝗌 𝗺𝗲𝗹𝗵𝗈𝗋𝗲𝘀 𝗉𝗋𝖾𝗈𝗌 𝖽𝗈 𝗆𝖾𝗋𝖼𝖺𝖽𝗈?  

        જ⁀➴ *𝐒𝖾 𝗌𝗎𝖺 𝗋𝖾𝗌𝗉𝗈𝗌𝗍𝖺 𝖿𝗈𝗋 𝗌𝗂𝗆*, 𝖺𝗊𝗎𝗂 𝗇𝗈 ‧˚ʚ. ⏣ ʟᴅᴄ ʀᴏʙᴜx.⏣ ɞ˚‧ ｡⋆ 𝗈𝖿𝖾𝗋𝖾𝖼𝗂𝗆𝗈𝗌 𝖾𝗑𝖺𝗍𝖺𝗆𝖾𝗇𝗍𝖾 𝗂𝗌𝗌𝗈! 💱  

        ꒷𖦹˙— 𝐀𝗅𝖾́𝗆 𝖽𝗈𝗌 𝙢𝙚𝙡𝙝𝙤𝙧𝙚𝙨 𝙖𝙙𝙢𝙞𝙣𝙞𝙨𝙩𝙧𝙖𝙙𝙤𝙧𝙚𝙨, 𝗀𝗋𝗎𝗉𝗈 𝗈𝗋𝗀𝖺𝗇𝗂𝗓𝖺𝖽𝗈 𝖾 𝖺𝗍𝖾𝗇𝖽𝗂𝗆𝖾𝗇𝗍𝗈 𝖼𝖺𝗋𝗂𝗌𝗆𝖺́𝗍𝗂𝖼𝗈.  

        𝕹𝖆̃𝗈 𝗉𝖾𝗇𝗌𝖾 𝗆𝗎𝗂𝗍𝗈, ᥉ᥱ jᥙᥒtᥱ ᥲ ᥒ᥆́᥉! ❣  

        🔗 *Entre agora:*  
        https://chat.whatsapp.com/HIHO5OwdNam53GEyounVig`);
            return;
        }

        // Link do Roblox
        if (texto === '/link roblox') {
            await msg.reply(`🎮 *Nosso Grupo Oficial no Roblox*

        Você joga Roblox e quer fazer parte da nossa comunidade?  
        Aqui no *TeamEXP* você encontra os melhores preços.  

        💬 Participe do nosso grupo!  

        🔗 *Entre agora no nosso grupo oficial:*  
        https://www.roblox.com/pt/communities/34782963/TeamEXP#!/about`);
            return;
        }


        // /site - Mostra o link do site
        if (command === '/site') {
            const siteLink = 'https://ldcstore.mycartpanda.com/';
            await msg.reply(`🛒 *Loja Online*\n\n` +
                        `🌐 Acesse nosso site oficial:\n` +
                        `${siteLink}\n\n` +
                        `_Confira nossos produtos e promoções!_`);
        }
       
        // /marcar - Marca todos os membros do grupo
        if (command === '/marcar' || command === '/mark') {
            if (!chat.isGroup) return msg.reply("❌ Esse comando só pode ser usado em grupos.");
            if (!isAdmin) return msg.reply("❌ Apenas administradores podem usar esse comando.");

            try {
                const participants = chat.participants;
                
                if (participants.length === 0) {
                    return msg.reply('❌ Não há membros para marcar neste grupo.');
                }

                let mentionedJids = [];
                let text = `📢 *Menção para todos os membros:*\n`;
                
                if (textoAdicional) {
                    text += `💬 Mensagem: ${textoAdicional}\n\n`;
                }

                for (let participant of participants) {
                    try {
                        mentionedJids.push(participant.id._serialized);
                        text += `@${participant.id.user} `;
                    } catch (err) {
                        console.error(`Erro ao obter participante ${participant.id._serialized}:`, err);
                    }
                }

                await chat.sendMessage(text.trim(), { mentions: mentionedJids });
                
            } catch (err) {
                console.error('Erro no comando /marcar:', err);
                msg.reply('❌ Ocorreu um erro ao tentar marcar os membros.');
            }
        }

        
    });
    
 
}

module.exports = { setupComandosgeral };