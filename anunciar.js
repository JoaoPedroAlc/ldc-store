// anunciar.js (com opção de marcar integrada + alternar online/offline)
// Versão avançada: integra a lógica de /marcar dentro do fluxo de /anunciar
const fs = require('fs');
const path = require('path');
let cron = null;
try { cron = require('node-cron'); } catch (e) { /* cron opcional */ }

const { MessageMedia } = require('whatsapp-web.js');

function defaultOptions() {
  return {
    announcementsFile: path.join(__dirname, 'announcements.json'),
    uploadsDir: path.join(__dirname, 'anunciar_uploads'),
    logger: console
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const s = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(s || '[]');
  } catch (e) {
    return fallback;
  }
}
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function genId() { return Date.now().toString() + Math.floor(Math.random()*1000); }

function setupAnunciar(client, opts = {}) {
  const o = Object.assign(defaultOptions(), opts);
  ensureDir(path.dirname(o.announcementsFile));
  ensureDir(o.uploadsDir);

  let announcements = loadJson(o.announcementsFile, []);
  const scheduledTasks = {};
  const menuState = new Map();

  const configFile = path.join(path.dirname(o.announcementsFile), 'anunciar_config.json');
  let config = loadJson(configFile, {});
  function saveConfig() { try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2)); } catch(e) { o.logger.error('Erro ao salvar config:', e); } }
  function setDefaultGroup(ownerId, groupId) { config[ownerId] = groupId; saveConfig(); }
  function getDefaultGroup(ownerId) { return config[ownerId] || null; }
  function getTargetGroup(ownerId, localChat) {
    const def = getDefaultGroup(ownerId);
    if (def) return def;
    if (localChat && localChat.isGroup) return (localChat.id && (localChat.id._serialized || localChat.id));
    return ownerId;
  }

  function persist() { saveJson(o.announcementsFile, announcements); }

  async function getChatFromMsg(msg) {
    try { return await msg.getChat(); } catch (e) { return null; }
  }

  async function isAdminOfChat(msg, chat) {
    try {
      if (!chat || !chat.participants) return false;
      const userId = msg.author || msg.from || msg.from;
      const p = chat.participants.find(pp => {
        if (!pp.id) return false;
        const pid = pp.id._serialized ? pp.id._serialized : pp.id;
        return pid === userId;
      });
      return !!(p && (p.isAdmin || p.isSuperAdmin));
    } catch (e) { return false; }
  }

  async function getAllGroupContacts(chat) {
    const mentions = [];
    if (!chat || !chat.participants) return mentions;
    for (const p of chat.participants) {
      try {
        const id = p.id._serialized ? p.id._serialized : p.id;
        const contact = await client.getContactById(id);
        if (contact) mentions.push(contact);
      } catch (e) {}
    }
    return mentions;
  }

  async function sendAnnouncement(ann) {
    if (!ann || !ann.groupId) throw new Error('Anúncio sem groupId');
    const to = ann.groupId;
    const mentions = ann.mention ? (await (async () => {
      try {
        const chat = await client.getChatById(to);
        return await getAllGroupContacts(chat);
      } catch { return []; }
    })()) : [];

    if (ann.media && fs.existsSync(ann.media)) {
      const media = MessageMedia.fromFilePath(ann.media);
      await client.sendMessage(to, media, { caption: ann.message || '', mentions });
    } else {
      await client.sendMessage(to, ann.message || '', { mentions });
    }

    const idx = announcements.findIndex(a => a.id === ann.id);
    if (idx !== -1) {
      announcements[idx].lastSent = new Date().toISOString();
      if (announcements[idx].once) announcements[idx].active = false;
      persist();
    }
  }

  function startTask(ann) {
    stopTask(ann.id);
    if (!ann.active) return;
    if (ann.once && ann.schedule) {
      const when = new Date(ann.schedule);
      const delay = when - Date.now();
      if (delay <= 0) return;
      const t = setTimeout(async () => {
        try { await sendAnnouncement(ann); } catch (e) { o.logger.error(e); }
        stopTask(ann.id);
      }, delay);
      scheduledTasks[ann.id] = { type: 'timeout', ref: t };
      return;
    }
    if (typeof ann.schedule === 'string' && ann.schedule.startsWith('interval:')) {
      const minutes = parseInt(ann.schedule.split(':')[1]);
      if (isNaN(minutes) || minutes <= 0) return;
      const ms = minutes * 60 * 1000;
      const id = setInterval(async () => {
        try { await sendAnnouncement(ann); } catch (e) { o.logger.error(e); }
      }, ms);
      scheduledTasks[ann.id] = { type: 'interval', ref: id };
      return;
    }
    if (ann.schedule) {
      if (!cron) {
        o.logger.warn('[anunciar] node-cron não instalado — ignorando cron schedule para', ann.id);
        return;
      }
      try {
        const task = cron.schedule(ann.schedule, async () => {
          try { await sendAnnouncement(ann); } catch (e) { o.logger.error(e); }
        }, { scheduled: true });
        scheduledTasks[ann.id] = { type: 'cron', ref: task };
      } catch (e) {
        o.logger.warn('Cron inválido:', ann.schedule);
      }
    }
  }

  function stopTask(id) {
    const t = scheduledTasks[id];
    if (!t) return;
    if (t.type === 'interval') clearInterval(t.ref);
    if (t.type === 'timeout') clearTimeout(t.ref);
    if (t.type === 'cron') t.ref.stop && t.ref.stop();
    delete scheduledTasks[id];
  }

  function initAllTasks() {
    announcements = loadJson(o.announcementsFile, []);
    for (const a of announcements) {
      try { if (a.active) startTask(a); } catch (e) { o.logger.error(e); }
    }
  }

  async function createAnnouncement({ title = 'Anúncio', message = '', mention = false, groupId = null, once = true, schedule = null, media = null, active = true }) {
    const id = genId();
    const ann = { id, title, message, mention, groupId, once, schedule, media, active, lastSent: null };
    announcements.push(ann);
    persist();
    if (active) startTask(ann);
    return ann;
  }
  function listAnnouncements() { return announcements.slice(); }
  function getAnnouncement(id) { return announcements.find(a => a.id === id); }
  function deleteAnnouncement(id) {
    const idx = announcements.findIndex(a => a.id === id);
    if (idx === -1) return false;
    stopTask(id);
    announcements.splice(idx, 1);
    persist();
    return true;
  }
  async function triggerAnnouncement(id) {
    const ann = getAnnouncement(id);
    if (!ann) throw new Error('Not found');
    await sendAnnouncement(ann);
    return ann;
  }

  // --- helpers de UI/estado ---
  async function sendInteractiveMenu(chat) {
    const id = chat && (chat.id && (chat.id._serialized || chat.id)) ? (chat.id._serialized || chat.id) : (chat && chat.from) || null;
    const text = `Painel Anúncios — escolha uma opção (responda com o número ou com a palavra):

1) Enviar agora
2) Agendar intervalo
3) Agendar data
4) Criar com mídia
5) Listar anúncios
6) Deletar anúncio
7) Trigger (forçar envio)
8) Definir grupo alvo (se usado dentro do grupo, define automaticamente)
9) Alternar online/offline
0) Cancelar

Atenção: ao enviar/agendar/criar você será perguntado se deseja marcar todos os membros do grupo (sim/não).
Use /setgroup anunciar no grupo desejado ou escolha 8 aqui para definir.
Responda apenas com o número ou com o texto da opção.`;
    await client.sendMessage(id, text);
    return true;
  }

  function clearState(chatId) { menuState.delete(chatId); }

  async function downloadAndSaveMedia(msg) {
    try {
      if (!msg.hasMedia) return null;
      const media = await msg.downloadMedia();
      if (!media) return null;
      const buffer = Buffer.from(media.data, 'base64');
      const ext = media.mimetype ? media.mimetype.split('/')[1] : 'bin';
      const filename = `${Date.now()}.${ext}`;
      const filepath = path.join(o.uploadsDir, filename);
      fs.writeFileSync(filepath, buffer);
      return filepath;
    } catch (e) {
      o.logger.error('Erro ao salvar mídia:', e);
      return null;
    }
  }

  async function requireDefaultGroup(ownerId, chatId) {
    const def = getDefaultGroup(ownerId);
    if (!def) {
      await client.sendMessage(chatId, '⚠️ Você precisa definir um grupo alvo antes de usar essa opção.\nUse /setgroup anunciar dentro do grupo desejado ou escolha 8 no painel para definir o grupo alvo.');
      return false;
    }
    return true;
  }

  function formatAnnouncementBrief(a) {
    const msgPreview = a.message ? (a.message.length > 60 ? a.message.slice(0,57)+'...' : a.message) : (a.media ? '[MÍDIA]' : '');
    return `ID: ${a.id}\nGrupo: ${a.groupId}\nMsg: ${msgPreview}\nSchedule: ${a.schedule || '—'}\nAtivo: ${a.active}\n---`;
  }

  // envia lista numerada de anúncios e grava mapeamento em menuState.temp.listMap
  async function sendAnnouncementsListForSelection(chatId, st, prompt) {
    const anns = listAnnouncements();
    if (!anns.length) {
      await client.sendMessage(chatId, 'Nenhum anúncio salvo.');
      clearState(chatId);
      return false;
    }
    // construímos listagem numerada
    const lines = anns.map((a, idx) => `${idx+1}) ${a.message ? (a.message.length>60 ? a.message.slice(0,60)+'...' : a.message) : (a.media ? '[MÍDIA]' : '')} — ID: ${a.id}`);
    const text = `${prompt}\n\n📋 Anúncios:\n\n` + lines.join('\n') + `\n\nResponda com o número do anúncio desejado.`;
    // salva mapeamento (número -> id) no estado temporário
    st.temp = st.temp || {};
    st.temp.listMap = anns.map(a => a.id);
    menuState.set(chatId, st);
    await client.sendMessage(chatId, text);
    return true;
  }

  // parse date dd/mm/yyyy hh:ii ou yyyy-mm-ddThh:mm:ss (ISO)
  function parseDateFlexible(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();
    // tentativa dd/mm/yyyy HH:MM
    const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (dmy) {
      let day = parseInt(dmy[1],10), mon = parseInt(dmy[2],10)-1, year = parseInt(dmy[3],10);
      if (year < 100) year += 2000;
      let hour = dmy[4] ? parseInt(dmy[4],10) : 0;
      let min = dmy[5] ? parseInt(dmy[5],10) : 0;
      const dt = new Date(year, mon, day, hour, min);
      if (!isNaN(dt.getTime())) return dt;
    }
    // tentativa ISO
    const iso = new Date(str);
    if (!isNaN(iso.getTime())) return iso;
    return null;
  }

  // ------------------------------------------------------------------------
  // Handler principal
  // ------------------------------------------------------------------------
  client.on('message', async (msg) => {
    try {
      const body = (msg.body || '').trim();
      const chat = await getChatFromMsg(msg);
      const chatId = chat ? (chat.id._serialized || chat.id) : (msg.from || msg.to);
      const ownerId = msg.author || msg.from || msg.from;
      if (!body && !msg.hasMedia) return;

      // fluxo quando há estado ativo
      if (menuState.has(chatId)) {
        const st = menuState.get(chatId);

        // ---------------- awaiting_choice (menu principal) ----------------
        if (st.step === 'awaiting_choice') {
          let choice = null;
          const n = body;
          const mapNum = {
            '1': 'send_now',
            '2': 'schedule_interval',
            '3': 'schedule_date',
            '4': 'create_with_media',
            '5': 'list',
            '6': 'delete',
            '7': 'trigger',
            '8': 'set_group',
            '9': 'toggle_status',
            '0': 'cancel'
          };
          if (mapNum[n]) choice = mapNum[n];
          else choice = body.toLowerCase();

          if (choice === 'cancel' || choice === '0') {
            await client.sendMessage(chatId, 'Operação cancelada.');
            clearState(chatId);
            return;
          }

          // opções que disparam/afetam envio precisam de grupo definido
          const needsGroup = ['send_now', 'schedule_interval', 'schedule_date', 'create_with_media'];
          if (needsGroup.includes(choice)) {
            const ok = await requireDefaultGroup(ownerId, chatId);
            if (!ok) { clearState(chatId); return; }
          }

          if (choice === 'send_now' || /enviar\s*agora|enviar agora/i.test(choice)) {
            menuState.set(chatId, { step: 'awaiting_message_sendnow', action: 'send_now', temp: {} });
            await client.sendMessage(chatId, '📨 OK — envie agora a mensagem que deseja enviar (texto).');
            return;
          }

          // AGENDAR INTERVALO: perguntar se usar existente ou criar novo
          if (choice === 'schedule_interval' || /intervalo|interval/i.test(choice)) {
            menuState.set(chatId, { step: 'awaiting_interval_choice', action: 'schedule_interval', temp: {} });
            await client.sendMessage(chatId, '⏱️ Agendar intervalo — escolha:\n1) Usar anúncio existente\n2) Criar novo anúncio e agendar\n\nResponda 1 ou 2.');
            return;
          }

          // AGENDAR DATA: perguntar se usar existente ou criar novo
          if (choice === 'schedule_date' || /agendar|data/i.test(choice)) {
            menuState.set(chatId, { step: 'awaiting_iso_choice', action: 'schedule_date', temp: {} });
            await client.sendMessage(chatId, '📅 Agendar data — escolha:\n1) Usar anúncio existente\n2) Criar novo anúncio e agendar\n\nResponda 1 ou 2.\nFormato de data aceito: DD/MM/YYYY HH:MM (ex: 22/08/2025 22:59) ou ISO.');
            return;
          }

          if (choice === 'create_with_media' || /mídia|midia|imagem|arquivo/i.test(choice)) {
            // cria agora (usa grupo alvo)
            menuState.set(chatId, { step: 'awaiting_media_or_text', action: 'create_with_media', temp: {} });
            await client.sendMessage(chatId, '📎 Envie a mídia (imagem/arquivo) com a legenda que deseja; ou envie \"texto\" para criar apenas com texto. Após enviar a mensagem/mídia você será perguntado se deseja marcar todos os membros do grupo.');
            return;
          }

          if (choice === 'list' || /listar/i.test(choice)) {
            const anns = listAnnouncements();
            if (!anns.length) {
              await client.sendMessage(chatId, 'Nenhum anúncio salvo.');
            } else {
              const resumo = anns.map(a => formatAnnouncementBrief(a)).join('\n');
              await client.sendMessage(chatId, '📋 Anúncios:\n\n' + resumo);
            }
            clearState(chatId);
            return;
          }

          // DELETAR: mostrar lista para seleção
          if (choice === 'delete' || /deletar|delete/i.test(choice)) {
            const st2 = { step: 'awaiting_delete_pick', action: 'delete', temp: {} };
            const ok = await sendAnnouncementsListForSelection(chatId, st2, 'Escolha qual anúncio deseja DELETAR:');
            if (!ok) return;
            // menuState set dentro da função
            return;
          }

          // TRIGGER: mostrar lista para seleção
          if (choice === 'trigger' || /trigger|forçar|disparar/i.test(choice)) {
            const st2 = { step: 'awaiting_trigger_pick', action: 'trigger', temp: {} };
            const ok = await sendAnnouncementsListForSelection(chatId, st2, 'Escolha qual anúncio deseja DISPARAR agora:');
            if (!ok) return;
            return;
          }

          // == Definir grupo alvo (opção 8) ==
          if (choice === 'set_group' || /definir\s*grupo|setgroup|set\s*group|grupo\s*alvo/i.test(choice)) {
            try {
              if (chat && chat.isGroup) {
                const target = (chat.id && (chat.id._serialized || chat.id));
                setDefaultGroup(ownerId, target);
                await client.sendMessage(chatId, `✅ Grupo alvo definido para você: ${target}`);
                clearState(chatId);
                return;
              } else {
                menuState.set(chatId, { step: 'awaiting_set_group', action: 'set_group', temp: {} });
                await client.sendMessage(chatId, 'Encaminhe uma mensagem do grupo alvo ou envie o ID do grupo (ex: 123456789-123456@g.us).');
                return;
              }
            } catch (e) {
              o.logger.error('Erro ao definir grupo alvo:', e);
              await client.sendMessage(chatId, '❌ Erro ao definir grupo alvo. Tente novamente.');
              clearState(chatId);
              return;
            }
          }

          // == Alternar status online/offline (opção 9) ==
          if (choice === 'toggle_status' || /online|offline|status|ativar|desativar|alternar/i.test(choice)) {
            const st2 = { step: 'awaiting_toggle_pick', action: 'toggle_status', temp: {} };
            const ok = await sendAnnouncementsListForSelection(chatId, st2, 'Escolha qual anúncio deseja alterar o status (online/offline):');
            if (!ok) return;
            return;
          }

          await client.sendMessage(chatId, 'Opção não reconhecida. Menu cancelado.');
          clearState(chatId);
          return;
        }

        // ---------------- awaiting_delete_pick ----------------
        if (st.step === 'awaiting_delete_pick') {
          const sel = parseInt(body, 10);
          const map = st.temp && st.temp.listMap;
          if (!map || !Array.isArray(map)) {
            await client.sendMessage(chatId, 'Estado inválido. Reabra o painel e tente novamente.');
            clearState(chatId);
            return;
          }
          if (isNaN(sel) || sel < 1 || sel > map.length) {
            return client.sendMessage(chatId, 'Seleção inválida. Envie o número correto da lista.');
          }
          const annId = map[sel-1];
          const ok = deleteAnnouncement(annId);
          await client.sendMessage(chatId, ok ? '✅ Anúncio deletado.' : '❌ ID não encontrado.');
          clearState(chatId);
          return;
        }

        // ---------------- awaiting_trigger_pick ----------------
        if (st.step === 'awaiting_trigger_pick') {
          const sel = parseInt(body, 10);
          const map = st.temp && st.temp.listMap;
          if (!map || !Array.isArray(map)) {
            await client.sendMessage(chatId, 'Estado inválido. Reabra o painel e tente novamente.');
            clearState(chatId);
            return;
          }
          if (isNaN(sel) || sel < 1 || sel > map.length) {
            return client.sendMessage(chatId, 'Seleção inválida. Envie o número correto da lista.');
          }
          const annId = map[sel-1];
          try {
            await triggerAnnouncement(annId);
            await client.sendMessage(chatId, '✅ Anúncio disparado com sucesso.');
          } catch (e) {
            await client.sendMessage(chatId, '❌ Erro ao disparar: ' + (e.message || e.toString()));
          }
          clearState(chatId);
          return;
        }

        // ---------------- awaiting_set_group ----------------
        if (st.step === 'awaiting_set_group') {
          let target = null;
          try {
            if (chat && chat.isGroup) target = chat.id._serialized || chat.id;
            if (!target && msg.hasQuotedMsg) {
              try {
                const q = await msg.getQuotedMessage();
                if (q && q.from && typeof q.from === 'string' && q.from.includes('-')) target = q.from;
              } catch (e) { }
            }
            if (!target && body && typeof body === 'string' && body.includes('-')) target = body.trim();
          } catch (e) { o.logger.error('Erro ao tentar definir grupo alvo:', e); }

          if (!target) {
            await client.sendMessage(chatId, 'ID de grupo inválido. Encaminhe uma mensagem do grupo alvo ou envie o ID do grupo (ex: 123456789-123456@g.us). Tente novamente.');
            return;
          }
          setDefaultGroup(ownerId, target);
          await client.sendMessage(chatId, `✅ Grupo alvo definido para você: ${target}`);
          clearState(chatId);
          return;
        }

        // ---------------- awaiting_confirm_mention (NOVO) ----------------
        // fluxo genérico: após coletar dados para criar/agendar, pergunta se deseja marcar todos
        if (st.step === 'awaiting_confirm_mention') {
          const ans = body.toLowerCase();
          const positive = ['1','s','sim','y','yes'];
          const negative = ['2','n','nao','não','no'];
          let mention = null;
          if (positive.includes(ans)) mention = true;
          else if (negative.includes(ans)) mention = false;
          else return client.sendMessage(chatId, 'Resposta inválida. Envie 1 para SIM (marcar todos) ou 2 para NÃO.');

          // ação baseado no tipo armazenado
          const t = st.temp && st.temp.creationType;
          if (!t) { await client.sendMessage(chatId, 'Estado inválido. Operação cancelada.'); clearState(chatId); return; }

          try {
            if (t === 'send_now') {
              const data = st.temp.creationData;
              const groupId = data.groupId;
              const ann = await createAnnouncement({ message: data.message, mention, groupId, once: true, schedule: null, media: null, active: true });
              await triggerAnnouncement(ann.id);
              await client.sendMessage(chatId, '✅ Mensagem enviada com sucesso.');
              clearState(chatId);
              return;
            }

            if (t === 'create_media' || t === 'create_text') {
              const data = st.temp.creationData;
              const ann = await createAnnouncement({ message: data.message, mention, groupId: data.groupId, once: true, schedule: null, media: data.media || null, active: true });
              await triggerAnnouncement(ann.id);
              await client.sendMessage(chatId, `✅ Anúncio ${data.media ? 'com mídia ' : ''}enviado/criado com sucesso. ID: ${ann.id}`);
              clearState(chatId);
              return;
            }

            if (t === 'interval_new') {
              const data = st.temp.creationData; // {message, media, groupId, minutes}
              const schedule = `interval:${data.minutes}`;
              const ann = await createAnnouncement({ message: data.message, mention, groupId: data.groupId, once: false, schedule, media: data.media || null, active: true });
              await client.sendMessage(chatId, `✅ Anúncio agendado a cada ${data.minutes} minutos. ID: ${ann.id}`);
              clearState(chatId);
              return;
            }

            if (t === 'interval_existing') {
              const { annId, minutes } = st.temp.creationData;
              const ann = getAnnouncement(annId);
              if (!ann) { await client.sendMessage(chatId, 'Anúncio não encontrado.'); clearState(chatId); return; }
              ann.schedule = `interval:${minutes}`;
              ann.once = false;
              ann.mention = mention;
              ann.active = true;
              persist();
              startTask(ann);
              await client.sendMessage(chatId, `✅ Anúncio (existente) agendado a cada ${minutes} minutos. ID: ${ann.id}`);
              clearState(chatId);
              return;
            }

            if (t === 'date_new') {
              const data = st.temp.creationData; // {message, media, groupId, datetime}
              const ann = await createAnnouncement({ message: data.message, mention, groupId: data.groupId, once: true, schedule: data.datetime, media: data.media || null, active: true });
              await client.sendMessage(chatId, `✅ Anúncio agendado para ${data.datetime}. ID: ${ann.id}`);
              clearState(chatId);
              return;
            }

            if (t === 'date_existing') {
              const { annId, datetime } = st.temp.creationData;
              const ann = getAnnouncement(annId);
              if (!ann) { await client.sendMessage(chatId, 'Anúncio não encontrado.'); clearState(chatId); return; }
              ann.schedule = datetime;
              ann.once = true;
              ann.mention = mention;
              ann.active = true;
              persist();
              startTask(ann);
              await client.sendMessage(chatId, `✅ Anúncio (existente) agendado para ${datetime}. ID: ${ann.id}`);
              clearState(chatId);
              return;
            }

            await client.sendMessage(chatId, 'Tipo não tratado. Operação cancelada.');
            clearState(chatId);
            return;

          } catch (e) {
            o.logger.error('Erro ao criar/anunciar com marcação:', e);
            await client.sendMessage(chatId, '❌ Erro ao processar a solicitação.');
            clearState(chatId);
            return;
          }
        }

        // ---------------- Enviar agora (awaiting_message_sendnow) ----------------
        if (st.step === 'awaiting_message_sendnow') {
          const message = body;
          const groupId = getTargetGroup(ownerId, chat);
          // Em vez de criar direto, pedimos confirmação de marcação
          st.step = 'awaiting_confirm_mention';
          st.temp.creationType = 'send_now';
          st.temp.creationData = { message, groupId };
          menuState.set(chatId, st);
          await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando enviar?\n1) Sim\n2) Não');
          return;
        }

        // ---------------- AGENDAR: escolha EXISTENTE/NOVO para INTERVALO ----------------
        if (st.step === 'awaiting_interval_choice') {
          if (body === '1' || /^usar/i.test(body)) {
            // listar e escolher anúncio existente
            const st2 = { step: 'awaiting_interval_pick', action: 'schedule_interval_existing', temp: {} };
            const ok = await sendAnnouncementsListForSelection(chatId, st2, 'Escolha qual anúncio EXISTENTE deseja agendar em intervalo:');
            if (!ok) clearState(chatId);
            return;
          } else if (body === '2' || /^criar/i.test(body)) {
            // criar novo: pedir minutos
            st.step = 'awaiting_interval_minutes_new';
            menuState.set(chatId, st);
            await client.sendMessage(chatId, '⏱️ Quantos minutos entre envios? Envie apenas um número (ex: 60).');
            return;
          } else {
            return client.sendMessage(chatId, 'Resposta inválida. Envie 1 para usar existente ou 2 para criar novo.');
          }
        }

        // escolher anúncio existente para intervalo
        if (st.step === 'awaiting_interval_pick') {
          const sel = parseInt(body,10);
          const map = st.temp && st.temp.listMap;
          if (!map || !Array.isArray(map)) {
            await client.sendMessage(chatId, 'Estado inválido. Reabra o painel e tente novamente.');
            clearState(chatId);
            return;
          }
          if (isNaN(sel) || sel < 1 || sel > map.length) {
            return client.sendMessage(chatId, 'Seleção inválida. Envie o número correto da lista.');
          }
          const annId = map[sel-1];
          // armazena e pede minutos
          st.temp.chosenAnnId = annId;
          st.step = 'awaiting_interval_minutes_existing';
          menuState.set(chatId, st);
          await client.sendMessage(chatId, '⏱️ Quantos minutos entre envios? Envie apenas um número (ex: 60).');
          return;
        }

        // minutos para EXISTENTE
        if (st.step === 'awaiting_interval_minutes_existing') {
          const minutes = parseInt(body,10);
          if (isNaN(minutes) || minutes <= 0) return client.sendMessage(chatId, 'Formato inválido. Envie apenas um número de minutos (ex: 60).');
          const annId = st.temp && st.temp.chosenAnnId;
          const ann = getAnnouncement(annId);
          if (!ann) { await client.sendMessage(chatId, 'Anúncio não encontrado.'); clearState(chatId); return; }
          // Ao invés de aplicar direto, perguntar se deseja marcar
          st.step = 'awaiting_confirm_mention';
          st.temp.creationType = 'interval_existing';
          st.temp.creationData = { annId, minutes };
          menuState.set(chatId, st);
          await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
          return;
        }

        // minutos para NOVO (criar novo anúncio com intervalo) - aqui aceitamos texto OU mídia
        if (st.step === 'awaiting_interval_minutes_new') {
          const minutes = parseInt(body,10);
          if (isNaN(minutes) || minutes <= 0) return client.sendMessage(chatId, 'Formato inválido. Envie apenas um número de minutos (ex: 60).');
          st.temp.minutes = minutes;
          st.step = 'awaiting_interval_message_new';
          menuState.set(chatId, st);
          await client.sendMessage(chatId, `✅ Intervalo definido: ${minutes} minutos.\nAgora envie a mensagem (texto) que será repetida, ou envie mídia com legenda. Se quiser apenas texto, envie o texto agora.`);
          return;
        }

        if (st.step === 'awaiting_interval_message_new') {
          // se enviar mídia -> salvar e criar com media; se texto -> criar com message
          if (msg.hasMedia) {
            const filepath = await downloadAndSaveMedia(msg);
            const caption = msg.caption || body || '';
            const groupId = getTargetGroup(ownerId, chat);
            // preparar criação e perguntar sobre marcar
            st.step = 'awaiting_confirm_mention';
            st.temp.creationType = 'interval_new';
            st.temp.creationData = { message: caption, media: filepath, groupId, minutes: st.temp.minutes };
            menuState.set(chatId, st);
            await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
            return;
          } else {
            const message = body;
            const groupId = getTargetGroup(ownerId, chat);
            st.step = 'awaiting_confirm_mention';
            st.temp.creationType = 'interval_new';
            st.temp.creationData = { message, media: null, groupId, minutes: st.temp.minutes };
            menuState.set(chatId, st);
            await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
            return;
          }
        }

        // ---------------- AGENDAR DATA: escolha EXISTENTE/NOVO ----------------
        if (st.step === 'awaiting_iso_choice') {
          if (body === '1' || /^usar/i.test(body)) {
            const st2 = { step: 'awaiting_iso_pick', action: 'schedule_date_existing', temp: {} };
            const ok = await sendAnnouncementsListForSelection(chatId, st2, 'Escolha qual anúncio EXISTENTE deseja agendar para uma data:');
            if (!ok) clearState(chatId);
            return;
          } else if (body === '2' || /^criar/i.test(body)) {
            st.step = 'awaiting_iso_datetime_new';
            menuState.set(chatId, st);
            await client.sendMessage(chatId, '📅 Envie a data/hora no formato DD/MM/YYYY HH:MM (ex: 22/08/2025 22:59) ou ISO.');
            return;
          } else {
            return client.sendMessage(chatId, 'Resposta inválida. Envie 1 para usar existente ou 2 para criar novo.');
          }
        }

        // selecionar existente para agendar data
        if (st.step === 'awaiting_iso_pick') {
          const sel = parseInt(body,10);
          const map = st.temp && st.temp.listMap;
          if (!map || !Array.isArray(map)) {
            await client.sendMessage(chatId, 'Estado inválido. Reabra o painel e tente novamente.');
            clearState(chatId);
            return;
          }
          if (isNaN(sel) || sel < 1 || sel > map.length) {
            return client.sendMessage(chatId, 'Seleção inválida. Envie o número correto da lista.');
          }
          st.temp.chosenAnnId = map[sel-1];
          st.step = 'awaiting_iso_datetime_existing';
          menuState.set(chatId, st);
          await client.sendMessage(chatId, '📅 Agora envie a data/hora no formato DD/MM/YYYY HH:MM (ex: 22/08/2025 22:59) ou ISO.');
          return;
        }

        // receber data para EXISTENTE
        if (st.step === 'awaiting_iso_datetime_existing') {
          const dt = parseDateFlexible(body);
          if (!dt) return client.sendMessage(chatId, 'Formato inválido. Use DD/MM/YYYY HH:MM (ex: 22/08/2025 22:59) ou formato ISO.');
          const annId = st.temp && st.temp.chosenAnnId;
          const ann = getAnnouncement(annId);
          if (!ann) { await client.sendMessage(chatId, 'Anúncio não encontrado.'); clearState(chatId); return; }
          // perguntar se deseja marcar para esse envio
          st.step = 'awaiting_confirm_mention';
          st.temp.creationType = 'date_existing';
          st.temp.creationData = { annId, datetime: dt.toISOString() };
          menuState.set(chatId, st);
          await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
          return;
        }

        // receber data inicial para NOVO: agora perguntar mensagem/mídia
        if (st.step === 'awaiting_iso_datetime_new') {
          const dt = parseDateFlexible(body);
          if (!dt) return client.sendMessage(chatId, 'Formato inválido. Use DD/MM/YYYY HH:MM (ex: 22/08/2025 22:59) ou formato ISO.');
          st.temp.datetime = dt.toISOString();
          st.step = 'awaiting_iso_message_new';
          menuState.set(chatId, st);
          await client.sendMessage(chatId, `✅ Data aceita: ${st.temp.datetime}\nAgora envie a mensagem (texto) que será enviada, ou envie mídia com legenda.`);
          return;
        }

        // criar novo com data: aceitar mídia/texto
        if (st.step === 'awaiting_iso_message_new') {
          if (msg.hasMedia) {
            const filepath = await downloadAndSaveMedia(msg);
            const caption = msg.caption || body || '';
            const groupId = getTargetGroup(ownerId, chat);
            // perguntar sobre marcar
            st.step = 'awaiting_confirm_mention';
            st.temp.creationType = 'date_new';
            st.temp.creationData = { message: caption, media: filepath, groupId, datetime: st.temp.datetime };
            menuState.set(chatId, st);
            await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
            return;
          } else {
            const message = body;
            const groupId = getTargetGroup(ownerId, chat);
            st.step = 'awaiting_confirm_mention';
            st.temp.creationType = 'date_new';
            st.temp.creationData = { message, media: null, groupId, datetime: st.temp.datetime };
            menuState.set(chatId, st);
            await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
            return;
          }
        }

        // ---------------- create_with_media flow (sem agendamento) ----------------
        if (st.step === 'awaiting_media_or_text') {
          if (msg.hasMedia) {
            const filepath = await downloadAndSaveMedia(msg);
            const caption = msg.caption || body || '';
            const groupId = getTargetGroup(ownerId, chat);
            // perguntar se quer marcar
            st.step = 'awaiting_confirm_mention';
            st.temp.creationType = 'create_media';
            st.temp.creationData = { message: caption, media: filepath, groupId };
            menuState.set(chatId, st);
            await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
            return;
          }
          if (body && body.toLowerCase() === 'texto') {
            st.step = 'awaiting_media_text_only';
            menuState.set(chatId, st);
            return client.sendMessage(chatId, 'OK — envie o texto da mensagem (sem mídia).');
          }
          return client.sendMessage(chatId, 'Envie a mídia (imagem/arquivo) com legenda, ou envie \"texto\" para criar apenas com texto.');
        }
        if (st.step === 'awaiting_media_text_only') {
          const message = body;
          const groupId = getTargetGroup(ownerId, chat);
          st.step = 'awaiting_confirm_mention';
          st.temp.creationType = 'create_text';
          st.temp.creationData = { message, media: null, groupId };
          menuState.set(chatId, st);
          await client.sendMessage(chatId, 'Deseja marcar todos os membros do grupo quando o anúncio for enviado?\n1) Sim\n2) Não');
          return;
        }

        // ---------------- Alternar status: escolha e confirmação ----------------
        if (st.step === 'awaiting_toggle_pick') {
          const sel = parseInt(body, 10);
          const map = st.temp && st.temp.listMap;
          if (!map || !Array.isArray(map)) {
            await client.sendMessage(chatId, 'Estado inválido. Reabra o painel e tente novamente.');
            clearState(chatId);
            return;
          }
          if (isNaN(sel) || sel < 1 || sel > map.length) {
            return client.sendMessage(chatId, 'Seleção inválida. Envie o número correto da lista.');
          }
          const annId = map[sel-1];
          const ann = getAnnouncement(annId);
          if (!ann) { await client.sendMessage(chatId, 'Anúncio não encontrado.'); clearState(chatId); return; }
          st.temp.chosenAnnId = annId;
          st.step = 'awaiting_toggle_choice';
          menuState.set(chatId, st);
          const statusText = ann.active ? 'ATUALMENTE: ONLINE (ativo)' : 'ATUALMENTE: OFFLINE (inativo)';
          await client.sendMessage(chatId, `${statusText}\nEscolha:\n1) Colocar ONLINE\n2) Colocar OFFLINE`);
          return;
        }

        if (st.step === 'awaiting_toggle_choice') {
          const sel = body.trim();
          const annId = st.temp && st.temp.chosenAnnId;
          if (!annId) { await client.sendMessage(chatId, 'Estado inválido. Operação cancelada.'); clearState(chatId); return; }
          const ann = getAnnouncement(annId);
          if (!ann) { await client.sendMessage(chatId, 'Anúncio não encontrado.'); clearState(chatId); return; }
          if (sel === '1' || /^online|ativar|ativado|on/i.test(sel)) {
            ann.active = true;
            persist();
            startTask(ann);
            await client.sendMessage(chatId, `✅ Anúncio ${ann.id} colocado ONLINE.`);
            clearState(chatId);
            return;
          }
          if (sel === '2' || /^offline|desativar|desativado|off/i.test(sel)) {
            ann.active = false;
            persist();
            stopTask(ann.id);
            await client.sendMessage(chatId, `✅ Anúncio ${ann.id} colocado OFFLINE.`);
            clearState(chatId);
            return;
          }
          return client.sendMessage(chatId, 'Opção inválida. Envie 1 para ONLINE ou 2 para OFFLINE.');
        }

        // ---------------- Intervalo/ISO fallbacks handled above ----------------

        // Se nenhuma condição bateu, limpa estado
        clearState(chatId);
        return;
      }

      // ---------------- Sem estado: comandos principais ----------------
      const lower = (body || '').toLowerCase();
      if (lower.startsWith('/anunciar')) {
        const chatObj = await getChatFromMsg(msg);
        const isGroup = chatObj ? chatObj.isGroup : false;
        const isAdmin = isGroup ? await isAdminOfChat(msg, chatObj) : true;
        if (isGroup && !isAdmin) return client.sendMessage(msg.from, '❌ Apenas administradores podem usar o painel de anúncios neste grupo.');

        menuState.set(chatId, { step: 'awaiting_choice', action: null, temp: {} });
        await sendInteractiveMenu(chatObj || { id: msg.from });
        return;
      }

      // /setgroup anunciar
      if (lower.startsWith('/setgroup')) {
        const arg = body.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
        const chatObj = await getChatFromMsg(msg);
        if (arg === 'anunciar') {
          if (chatObj && chatObj.isGroup) {
            const target = (chatObj.id && (chatObj.id._serialized || chatObj.id));
            setDefaultGroup(ownerId, target);
            await client.sendMessage(chatId, `✅ Grupo alvo para /anunciar definido para você: ${target}`);
            return;
          } else {
            menuState.set(chatId, { step: 'awaiting_set_group', action: 'set_group', temp: {} });
            await client.sendMessage(chatId, 'Execute esse comando dentro do grupo desejado para definir automaticamente, ou encaminhe aqui uma mensagem do grupo alvo / envie o ID do grupo.');
            return;
          }
        }
      }

      // removido: comando /marcar (lógica integrada no painel)

    } catch (e) {
      o.logger.error('Erro no módulo anunciar:', e);
    }
  });

  initAllTasks();

  return {
    createAnnouncement,
    listAnnouncements,
    getAnnouncement,
    deleteAnnouncement,
    triggerAnnouncement,
    startTask: (id) => { const a = getAnnouncement(id); if (a) startTask(a); },
    stopTask,
    announcementsFile: o.announcementsFile,
    uploadsDir: o.uploadsDir,
    _menuState: menuState
  };
}

module.exports = { setupAnunciar };