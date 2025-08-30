// bemvindo.js
const fs = require('fs');
const path = require('path');
const util = require('util');

const BEMVINDO_FILE = path.join(__dirname, 'bemvindo.json');

// DEBUG: coloque true para logs detalhados durante testes
const DEBUG = false;

function safeDump(obj) {
  try {
    return util.inspect(obj, { depth: 4, maxArrayLength: 200 });
  } catch (e) {
    try { return JSON.stringify(obj); } catch (e2) { return String(obj); }
  }
}

// ----------------- Persistência -----------------
function _loadBemvindo() {
  try {
    if (!fs.existsSync(BEMVINDO_FILE)) {
      fs.writeFileSync(BEMVINDO_FILE, JSON.stringify({}, null, 2));
    }
    const raw = fs.readFileSync(BEMVINDO_FILE, 'utf-8') || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('Erro ao ler bemvindo.json', e);
    return {};
  }
}
function _saveBemvindo(data) {
  try {
    fs.writeFileSync(BEMVINDO_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Erro ao salvar bemvindo.json', e);
  }
}

// ----------------- Helpers -----------------
const sessions = {}; // chave: `${chatId}:${authorId}`
const lastIndex = {}; // evita repetição imediata por grupo

function _sessionKey(chatId, authorId) { return `${chatId}:${authorId}`; }

function formatMenuMessages(msgs) {
  if (!msgs || msgs.length === 0) return '*Nenhuma mensagem de boas-vindas configurada.*';
  return msgs.map((m, i) => `*${i + 1}* — ${m.split('\n')[0].slice(0, 150)}`).join('\n\n');
}

/**
 * Extrai uma string de id a partir de diferentes formatos que a lib pode retornar.
 * Aceita: string, objeto com ._serialized, objeto com .id._serialized, objeto notification, etc.
 */
function extractIdString(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (raw._serialized && typeof raw._serialized === 'string') return raw._serialized;
  if (raw.id && typeof raw.id === 'string') return raw.id;
  if (raw.id && raw.id._serialized && typeof raw.id._serialized === 'string') return raw.id._serialized;
  if (raw.participant && typeof raw.participant === 'string') return raw.participant;
  if (raw.participant && raw.participant._serialized) return raw.participant._serialized;
  if (raw.remote && typeof raw.remote === 'string') return raw.remote;
  // tentar achar alguma string com '@' dentro do objeto
  try {
    for (const k of Object.keys(raw)) {
      if (typeof raw[k] === 'string' && raw[k].includes('@')) return raw[k];
      if (raw[k] && raw[k]._serialized && typeof raw[k]._serialized === 'string') return raw[k]._serialized;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function replacePlaceholders(template, member, chat) {
  // member pode ser: string id, contato object ou fallback { id: '...' }
  let name = '';
  let idStr = null;

  if (!member) {
    name = '';
    idStr = null;
  } else if (typeof member === 'string') {
    idStr = member;
    name = '';
  } else {
    // membro como objeto retornado por client.getContactById normalmente tem .pushname/.name e .id/_serialized
    name = member.pushname || member.name || '';
    idStr = extractIdString(member.id || member);
  }

  const number = idStr ? (String(idStr).split('@')[0]) : '';
  const groupName = (chat && (chat.name || '')) || '';
  const memberCount = (chat && chat.participants) ? chat.participants.length : '';

  return template
    .replace(/{{\s*name\s*}}/gi, name || '')
    .replace(/{{\s*nome\s*}}/gi, name || '')
    .replace(/{{\s*number\s*}}/gi, number)
    .replace(/{{\s*numero\s*}}/gi, number)
    .replace(/{{\s*group\s*}}/gi, groupName)
    .replace(/{{\s*grupo\s*}}/gi, groupName)
    .replace(/{{\s*membercount\s*}}/gi, memberCount)
    .replace(/{{\s*contador\s*}}/gi, memberCount);
}

function normalizeId(raw) {
  if (!raw) return null;
  // se for objeto, prefira participant, id, _serialized
  if (typeof raw === 'object') {
    if (raw.participant) raw = raw.participant;
    else if (raw.id && typeof raw.id === 'string') raw = raw.id;
    else if (raw._serialized && typeof raw._serialized === 'string') raw = raw._serialized;
    else {
      const s = extractIdString(raw);
      if (s) raw = s;
      else return null;
    }
  }
  if (typeof raw !== 'string') return null;
  raw = raw.trim();
  if (raw.includes('@')) return raw;
  if (/^\d+$/.test(raw)) return `${raw}@c.us`;
  return raw;
}

// ----------------- Principal (comandos) -----------------
function setupBemvindo(client) {
  let store = _loadBemvindo();

  // recarregar se arquivo mudar
  fs.watchFile(BEMVINDO_FILE, { interval: 2000 }, () => {
    try { store = _loadBemvindo(); } catch (e) { /* ignore */ }
  });

  function getGroupConfig(groupId) {
    if (!store[groupId]) store[groupId] = { enabled: false, messages: [] };
    return store[groupId];
  }

  function isGroupAdmin(chat, authorId) {
    try {
      if (!chat || !chat.participants) return false;
      const p = chat.participants.find(x => x.id && x.id._serialized === authorId);
      return !!p && (p.isAdmin || p.isSuperAdmin);
    } catch (e) {
      return false;
    }
  }

  client.on('message', async (msg) => {
    try {
      if (!msg.from || !msg.from.endsWith('@g.us')) return;
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const authorId = msg.author || msg.from;
      const isAdmin = isGroupAdmin(chat, authorId);
      const body = (msg.body || '').trim();
      if (!body) return;

      const parts = body.split(' ');
      const cmd = parts[0].toLowerCase();
      const rest = parts.slice(1).join(' ').trim();
      const skey = _sessionKey(chat.id._serialized, authorId);

      // sessões interativas
      if (sessions[skey]) {
        const sess = sessions[skey];

        if (body.toLowerCase() === 'cancelar') {
          delete sessions[skey];
          await msg.reply('❌ Operação cancelada.');
          return;
        }

        if (sess.action === 'await_add') {
          const toAdd = body;
          if (!toAdd || toAdd.length < 2) {
            await msg.reply('❌ Mensagem vazia. Envie o texto da mensagem de boas-vindas ou `cancelar`.');
            return;
          }
          const cfg = getGroupConfig(chat.id._serialized);
          cfg.messages.push(toAdd);
          cfg.enabled = true;
          _saveBemvindo(store);
          delete sessions[skey];
          await msg.reply('✅ Mensagem adicionada com sucesso. Use /bemvindo para ver o menu.');
          return;
        }

        if (sess.action === 'await_delete') {
          const num = parseInt(body);
          if (isNaN(num) || num < 1 || num > sess.messages.length) {
            await msg.reply('❌ Número inválido. Envie o número da mensagem a excluir ou `cancelar`.');
            return;
          }
          const cfg = getGroupConfig(chat.id._serialized);
          const removed = cfg.messages.splice(num - 1, 1);
          _saveBemvindo(store);
          delete sessions[skey];
          await msg.reply(`🗑️ Mensagem removida com sucesso:\n\n${removed[0]}`);
          return;
        }

        if (sess.action === 'await_toggle') {
          const val = body.toLowerCase();
          if (val === 'on' || val === '1') {
            getGroupConfig(chat.id._serialized).enabled = true;
            _saveBemvindo(store);
            delete sessions[skey];
            await msg.reply('✅ Boas-vindas ativadas para este grupo.');
            return;
          }
          if (val === 'off' || val === '0') {
            getGroupConfig(chat.id._serialized).enabled = false;
            _saveBemvindo(store);
            delete sessions[skey];
            await msg.reply('✅ Boas-vindas desativadas para este grupo.');
            return;
          }
          await msg.reply('❌ Opção inválida. Envie `on` ou `off`, ou `cancelar`.');
          return;
        }
      }

      // comandos principais
      if (cmd === '/bemvindo') {
        const cfg = getGroupConfig(chat.id._serialized);
        const msgs = cfg.messages || [];
        let reply = `📬 *Menu de Boas-vindas*\n\n`;
        reply += `✅ Estado: *${cfg.enabled ? 'Ativado' : 'Desativado'}*\n`;
        reply += `📌 Mensagens configuradas: *${msgs.length}*\n\n`;
        if (msgs.length > 0) reply += formatMenuMessages(msgs) + '\n\n';

        reply += '*Comandos (apenas administradores podem editar):*\n';
        reply += '`/setbemvindo <texto>` — adiciona rapidamente\n';
        reply += '`/setbemvindo` — inicia modo interativo para adicionar\n';
        reply += '`/delbemvindo` — inicia modo interativo para remover\n';
        reply += '`/bemvindo on` ou `/bemvindo off` — ativa / desativa\n';
        reply += '`/bemvindo test` — envia uma mensagem de teste para verificar placeholders\n\n';
        reply += 'Placeholders: `{{name}}`, `{{number}}`, `{{group}}`, `{{memberCount}}`\n\n';
        reply += 'Obs: as mensagens só serão enviadas automaticamente quando alguém ENTRAR no grupo e as boas-vindas estiverem ativadas.';
        await msg.reply(reply);
        return;
      }

      if (cmd === '/setbemvindo') {
        if (!isAdmin) return msg.reply('❌ Apenas administradores podem configurar mensagens de boas-vindas.');
        if (rest && rest.length > 0) {
          const cfg = getGroupConfig(chat.id._serialized);
          cfg.messages.push(rest);
          cfg.enabled = true;
          _saveBemvindo(store);
          await msg.reply('✅ Mensagem adicionada. Use /bemvindo para ver o menu.');
          return;
        }
        sessions[skey] = { action: 'await_add' };
        await msg.reply('✍️ Envie agora a mensagem que deseja adicionar como boas-vindas. Use placeholders `{{name}}`, `{{group}}`, `{{number}}`, `{{memberCount}}`. Envie `cancelar` para abortar.');
        return;
      }

      if (cmd === '/delbemvindo') {
        if (!isAdmin) return msg.reply('❌ Apenas administradores podem remover mensagens de boas-vindas.');
        const cfg = getGroupConfig(chat.id._serialized);
        const msgs = cfg.messages || [];
        if (!msgs || msgs.length === 0) return msg.reply('⚠️ Não há mensagens configuradas para este grupo.');
        const menu = msgs.map((m, i) => `*${i + 1}* — ${m.split('\n')[0].slice(0, 120)}`).join('\n\n');
        sessions[skey] = { action: 'await_delete', messages: msgs.slice() };
        await msg.reply(`🗑️ *Remover Mensagem de Boas-vindas*\n\nSelecione o número da mensagem que deseja excluir:\n\n${menu}\n\nEnvie *cancelar* para abortar.`);
        return;
      }

      if (cmd === '/bemvindo' && rest) {
        if (!isAdmin) return msg.reply('❌ Apenas administradores podem alterar o estado.');
        const val = rest.toLowerCase();
        if (val === 'on' || val === 'off') {
          getGroupConfig(chat.id._serialized).enabled = (val === 'on');
          _saveBemvindo(store);
          await msg.reply(`✅ Boas-vindas ${val === 'on' ? 'ativadas' : 'desativadas'} para este grupo.`);
        } else if (val === 'toggle') {
          sessions[skey] = { action: 'await_toggle' };
          await msg.reply('Envie `on` para ativar ou `off` para desativar. Envie `cancelar` para abortar.');
        } else if (val === 'test') {
          const cfg = getGroupConfig(chat.id._serialized);
          if (!cfg.messages || cfg.messages.length === 0) return msg.reply('⚠️ Não há mensagens configuradas para este grupo.');
          const testMember = { id: msg.author || msg.from, pushname: contact.pushname || contact.name };
          const template = cfg.messages[Math.floor(Math.random() * cfg.messages.length)];
          const text = replacePlaceholders(template, testMember, chat);
          await msg.reply(`📨 Teste de mensagem:\n\n${text}`);
        }
        return;
      }

    } catch (err) {
      console.error('bemvindo command handler error', err);
    }
  });

  // Retorna utilitários para uso programático se necessária
  return {
    getGroupConfig,
    addMessage(groupId, text) {
      const cfg = getGroupConfig(groupId);
      cfg.messages.push(text);
      cfg.enabled = true;
      _saveBemvindo(store);
    },
    removeMessage(groupId, index) {
      const cfg = getGroupConfig(groupId);
      if (index >= 0 && index < cfg.messages.length) {
        const removed = cfg.messages.splice(index, 1);
        _saveBemvindo(store);
        return removed[0];
      }
      return null;
    }
  };
}

// ----------------- Função para lidar com entrada de membro (exportada) -----------------
async function handleMemberJoin(client, notification) {
  try {
    if (DEBUG) {
      console.log('--- bemvindo.handleMemberJoin chamado ---');
      console.log('notification:', safeDump(notification));
    }

    // possível caminhos para chatId
    const chatId = notification && (notification.chatId || notification.from || notification.groupId || notification.remote) || null;

    // montar lista de membros (pode ser single ou array)
    let memberRaw = null;
    if (notification) {
      if (notification.participant) memberRaw = notification.participant;
      else if (notification.id) memberRaw = notification.id;
      else if (notification.invitee) memberRaw = notification.invitee;
      else if (notification.who) memberRaw = notification.who;
      else if (notification.participants) memberRaw = notification.participants;
      else memberRaw = notification;
    }

    if (!chatId) {
      if (DEBUG) console.log('bemvindo: chatId não encontrado na notification. Abortando.');
      return;
    }

    const store = _loadBemvindo();
    const cfg = store[chatId] || store[chatId._serialized] || null;
    if (!cfg || !cfg.enabled || !cfg.messages || cfg.messages.length === 0) {
      if (DEBUG) console.log(`bemvindo: nenhuma config ativa para ${chatId}`);
      return;
    }

    // obter objeto chat
    let chat = null;
    try {
      if (typeof client.getChatById === 'function') {
        chat = await client.getChatById(chatId);
      } else if (typeof client.getChat === 'function') {
        chat = await client.getChat(chatId);
      } else if (typeof client.getChats === 'function') {
        const all = await client.getChats();
        chat = all.find(c => c.id && c.id._serialized === chatId) || null;
      }
    } catch (e) {
      if (DEBUG) console.error('bemvindo: erro ao obter chat', e);
      chat = null;
    }
    if (!chat) {
      if (DEBUG) console.log('bemvindo: não conseguiu carregar o objeto chat, abortando.');
      return;
    }

    // normalize list
    const members = Array.isArray(memberRaw) ? memberRaw : [memberRaw];

    for (const mRaw of members) {
      const normalized = normalizeId(mRaw);
      if (!normalized) {
        if (DEBUG) console.log('bemvindo: não conseguiu normalizar membro:', safeDump(mRaw));
        continue;
      }

      // tenta obter o contato (pode falhar)
      let memberContact = null;
      try {
        memberContact = await client.getContactById(normalized);
      } catch (e) {
        memberContact = { id: normalized, pushname: null };
      }

      // seleciona mensagem aleatória (evitar repetir a última)
      const msgs = cfg.messages;
      let idx = Math.floor(Math.random() * msgs.length);
      if (msgs.length > 1 && typeof lastIndex[chat.id._serialized] === 'number') {
        let tries = 0;
        while (idx === lastIndex[chat.id._serialized] && tries < 8) {
          idx = Math.floor(Math.random() * msgs.length);
          tries++;
        }
      }
      lastIndex[chat.id._serialized] = idx;

      const template = msgs[idx];
      const text = replacePlaceholders(template, memberContact, chat);

      try {
        await chat.sendMessage(text, { mentions: [memberContact] });
        if (DEBUG) console.log(`bemvindo: mensagem enviada para ${normalized} no grupo ${chatId}`);
      } catch (e) {
        console.error('Erro ao enviar mensagem de boas-vindas:', e);
      }
    }

  } catch (err) {
    console.error('bemvindo.handleMemberJoin error', err);
  }
}

module.exports = { setupBemvindo, handleMemberJoin };
