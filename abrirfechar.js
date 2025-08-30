// abrirfechar.js
// Versão final: fluxos separados (abrir/fechar), reconhece apenas o iniciador,
// menu dinâmico alinhado, sem /config apply nem help.
// Inclui menuActive para evitar conflito com outros fluxos (/valor etc).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'abrirfechar.json');

const PENDING_TIMEOUT = 2 * 60 * 1000; // 2 minutos
let SAFE_GET_RETRIES = 8;
let SAFE_GET_DELAY = 1500;
const APPLY_MAX_IMMEDIATE_RETRIES = 8;
const APPLY_RETRY_BACKOFF = 2000;
const APPLY_SCHEDULE_RETRY = 60 * 1000;
const APPLY_SCHEDULE_MAX = 20;
const DEFAULT_RECONCILE_INTERVAL = 10 * 60 * 1000;

function loadConfigs() {
  try {
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, JSON.stringify({}, null, 2));
      return {};
    }
    return JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}');
  } catch (e) {
    console.error('Erro ao carregar abrirfechar.json', e);
    return {};
  }
}

function saveConfigs(cfg) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Erro ao salvar abrirfechar.json', e);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseHHMM(hhmm) {
  if (!hhmm) return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function todayAt(hh, mm) {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d;
}

function addDays(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function msUntil(date) {
  return Math.max(0, date.getTime() - Date.now());
}

async function safeGetChat(client, chatId) {
  for (let attempt = 0; attempt < SAFE_GET_RETRIES; attempt++) {
    try {
      if (typeof client.getChats === 'function') {
        try {
          const chats = await client.getChats();
          if (Array.isArray(chats)) {
            const found = chats.find(c => c && c.id && c.id._serialized === chatId);
            if (found) return found;
          }
        } catch (e) {}
      }

      if (typeof client.getChatById === 'function') {
        try {
          const chat = await client.getChatById(chatId);
          if (chat) return chat;
        } catch (e) {}
      }

      if (typeof client.getAllChats === 'function') {
        try {
          const chats = await client.getAllChats();
          if (Array.isArray(chats)) {
            const found = chats.find(c => c && c.id && c.id._serialized === chatId);
            if (found) return found;
          }
        } catch (e) {}
      }
    } catch (outer) {
      console.error('safeGetChat erro', outer && outer.message ? outer.message : outer);
    }
    if (attempt < SAFE_GET_RETRIES - 1) await sleep(SAFE_GET_DELAY);
  }
  return null;
}

function isNowInOpenWindow(openHHMM, closeHHMM) {
  const p1 = parseHHMM(openHHMM);
  const p2 = parseHHMM(closeHHMM);
  if (!p1 || !p2) return false;
  const now = new Date();
  const open = todayAt(p1.hh, p1.mm);
  const close = todayAt(p2.hh, p2.mm);

  if (open.getTime() === close.getTime()) return true;
  if (open < close) return now >= open && now < close;
  return now >= open || now < close; // atravessa meia-noite
}

module.exports = {
  setupAbrirFechar: function(client, opts = {}) {
    const verificarAdmin = opts.verificarAdmin;
    if (opts.safeRetries) SAFE_GET_RETRIES = opts.safeRetries;
    if (opts.safeDelay) SAFE_GET_DELAY = opts.safeDelay;
    const autoReconcile = typeof opts.reconcile === 'boolean' ? opts.reconcile : true;
    const reconcileInterval = opts.reconcileInterval || DEFAULT_RECONCILE_INTERVAL;

    const configs = loadConfigs(); // chatId -> { open, close, enabled, title, savedAt }
    const timers = {};
    const pending = {}; // chatId -> { action: 'set_open'|'set_close', timeoutId, initiator }
    const applyFailCounts = {};
    // novo: menu ativo para evitar conflitos com outros fluxos (ex: /valor)
    const menuActive = {}; // chatId -> { initiator, expires, timeoutId }
    let reconcileTimer = null;

    function clearTimersFor(chatId) {
      const t = timers[chatId];
      if (!t) return;
      if (t.openTimer) clearTimeout(t.openTimer);
      if (t.closeTimer) clearTimeout(t.closeTimer);
      delete timers[chatId];
    }

    async function applyStateWithRetry(chatId, shouldBeOpen, notify = true) {
      applyFailCounts[chatId] = applyFailCounts[chatId] || 0;

      for (let i = 0; i < APPLY_MAX_IMMEDIATE_RETRIES; i++) {
        const chat = await safeGetChat(client, chatId);
        if (chat) {
          try {
            if (!chat.isGroup) return;
            if (typeof chat.setMessagesAdminsOnly === 'function') {
              await chat.setMessagesAdminsOnly(!shouldBeOpen);
            } else if (typeof client.setGroupToAdminsOnly === 'function') {
              await client.setGroupToAdminsOnly(chatId, !shouldBeOpen);
            } else {
              console.warn('Método para admin-only não encontrado');
            }
            if (notify) {
              try { await chat.sendMessage(shouldBeOpen ? '🔓 Grupo aberto automaticamente (agendamento).' : '🔒 Grupo fechado automaticamente (agendamento).'); } catch (e) {}
            }
            applyFailCounts[chatId] = 0;
            return;
          } catch (e) {
            console.error('Erro aplicando estado:', e && e.message ? e.message : e);
          }
        }
        await sleep(APPLY_RETRY_BACKOFF);
      }

      applyFailCounts[chatId] = (applyFailCounts[chatId] || 0) + 1;
      if (applyFailCounts[chatId] <= APPLY_SCHEDULE_MAX) {
        setTimeout(() => {
          applyStateWithRetry(chatId, shouldBeOpen, notify).catch(() => {});
        }, APPLY_SCHEDULE_RETRY);
      } else {
        console.error(`Excedeu tentativas para ${chatId}`);
      }
    }

    function scheduleForGroup(chatId) {
      clearTimersFor(chatId);
      const cfg = configs[chatId];
      if (!cfg || !cfg.enabled) return;

      const openP = parseHHMM(cfg.open);
      const closeP = parseHHMM(cfg.close);
      if (!openP || !closeP) return; // não agenda se não tiver ambos válidos

      const now = new Date();
      let nextOpen = todayAt(openP.hh, openP.mm);
      if (nextOpen.getTime() <= now.getTime()) nextOpen = addDays(nextOpen, 1);

      let nextClose = todayAt(closeP.hh, closeP.mm);
      if (nextClose.getTime() <= now.getTime()) nextClose = addDays(nextClose, 1);

      const msOpen = msUntil(nextOpen);
      const msClose = msUntil(nextClose);

      timers[chatId] = {};

      timers[chatId].openTimer = setTimeout(async () => {
        await applyStateWithRetry(chatId, true, true);
        scheduleForGroup(chatId);
      }, msOpen);

      timers[chatId].closeTimer = setTimeout(async () => {
        await applyStateWithRetry(chatId, false, true);
        scheduleForGroup(chatId);
      }, msClose);
    }

    async function initAllSchedules() {
      for (const chatId of Object.keys(configs)) {
        try {
          const cfg = configs[chatId];
          if (!cfg || !cfg.enabled) continue;
          const shouldOpen = isNowInOpenWindow(cfg.open, cfg.close);
          applyStateWithRetry(chatId, shouldOpen, false).catch(() => {});
          scheduleForGroup(chatId);
        } catch (e) {
          console.error('Erro initAllSchedules', e && e.message ? e.message : e);
        }
      }

      if (autoReconcile && !reconcileTimer) {
        reconcileTimer = setInterval(() => {
          for (const chatId of Object.keys(configs)) {
            const cfg = configs[chatId];
            if (!cfg || !cfg.enabled) continue;
            const shouldOpen = isNowInOpenWindow(cfg.open, cfg.close);
            applyStateWithRetry(chatId, shouldOpen, false).catch(() => {});
          }
        }, reconcileInterval);
      }
    }

    // ---------------- comandos ----------------

    async function cmdSetOpen(msg, chat) {
      if (!verificarAdmin) return msg.reply('❌ Função de verificação de admin não está disponível (config incorreta).');
      if (!(await verificarAdmin(msg, chat))) return msg.reply('⛔ Apenas administradores podem configurar o agendamento.');

      const chatId = chat.id._serialized;
      if (pending[chatId]) {
        clearTimeout(pending[chatId].timeoutId);
      }
      const initiator = msg.author || msg.from;
      const timeoutId = setTimeout(() => {
        if (pending[chatId]) delete pending[chatId];
      }, PENDING_TIMEOUT);
      pending[chatId] = { action: 'set_open', timeoutId, initiator };

      return msg.reply(
`✏️ *Definir Horário de Abertura* (responda apenas *${initiator}*):
Envie o horário no formato \`HH:MM\` (ex: \`08:00\`).
Digite *cancel* para cancelar. Você tem 2 minutos.`
      );
    }

    async function cmdSetClose(msg, chat) {
      if (!verificarAdmin) return msg.reply('❌ Função de verificação de admin não está disponível (config incorreta).');
      if (!(await verificarAdmin(msg, chat))) return msg.reply('⛔ Apenas administradores podem configurar o agendamento.');

      const chatId = chat.id._serialized;
      if (pending[chatId]) {
        clearTimeout(pending[chatId].timeoutId);
      }
      const initiator = msg.author || msg.from;
      const timeoutId = setTimeout(() => {
        if (pending[chatId]) delete pending[chatId];
      }, PENDING_TIMEOUT);
      pending[chatId] = { action: 'set_close', timeoutId, initiator };

      return msg.reply(
`✏️ *Definir Horário de Fechamento* (responda apenas *${initiator}*):
Envie o horário no formato \`HH:MM\` (ex: \`22:00\`).
Digite *cancel* para cancelar. Você tem 2 minutos.`
      );
    }

    async function cmdRemove(msg, chat) {
      if (!verificarAdmin) return msg.reply('⛔ Apenas administradores podem remover o agendamento.');
      const chatId = chat.id._serialized;
      if (!configs[chatId]) return msg.reply('❌ Não há agendamento para este grupo.');
      clearTimersFor(chatId);
      delete configs[chatId];
      saveConfigs(configs);
      return msg.reply('✅ Agendamento removido para este grupo.');
    }

    async function cmdStatus(msg, chat) {
      const chatId = chat.id._serialized;
      const cfg = configs[chatId];
      if (!cfg) return msg.reply('ℹ️ Nenhum agendamento configurado para este grupo.');
      const abertoAgora = isNowInOpenWindow(cfg.open, cfg.close);
      return msg.reply(`📌 Status:\n🔓 Abre: ${cfg.open || '—'}\n🔒 Fecha: ${cfg.close || '—'}\n⚙️ Habilitado: ${cfg.enabled ? 'Sim' : 'Não'}\n🔔 Estado atual: ${abertoAgora ? 'Aberto' : 'Fechado'}\n🏷️ ${cfg.title || '—'}`);
    }

    function cancelPending(chatId) {
      const p = pending[chatId];
      if (!p) return;
      clearTimeout(p.timeoutId);
      delete pending[chatId];
    }

    // showMenu DINÂMICO (alinha conforme conteúdo) + ativa menuActive
    async function showMenu(msg) {
      const lines = [
        '⚙  Menu de Configuração  ⚙',
        '',
        '1) Definir horário de Abertura',
        '2) Definir horário de Fechamento',
        '3) Ver Status do agendamento',
        '4) Ativar / Desativar agendamento',
        '5) Remover agendamento',
        '',
        'Digite o número (ex: 1) ou o comando:',
        '/config abrir  -> definir abertura',
        '/config fechar -> definir fechamento'
      ];

      const MIN_WIDTH = 38;
      const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
      const width = Math.max(maxLen, MIN_WIDTH);
      const interior = width + 2;
      const top = '╔' + '═'.repeat(interior) + '╗';
      const sep = '╠' + '═'.repeat(interior) + '╣';
      const bottom = '╚' + '═'.repeat(interior) + '╝';

      function centerText(text, w) {
        const t = String(text);
        const totalPad = Math.max(0, w - t.length);
        const left = Math.floor(totalPad / 2);
        const right = totalPad - left;
        return ' '.repeat(left) + t + ' '.repeat(right);
      }

      const content = lines.map((line, idx) => {
        if (idx === 0) {
          const centered = centerText(line, width);
          return ' ' + centered + ' ';
        } else {
          const filled = String(line).padEnd(width, ' ');
          return ' ' + filled + ' ';
        }
      });

      const blankIdx = lines.indexOf('');
      const insertAfter = blankIdx >= 0 ? blankIdx : 0;
      content.splice(insertAfter + 1, 0, sep);

      const menu = [top, ...content, bottom].join('\n');

      try {
        await msg.reply(menu);
      } catch (e) {
        console.error('showMenu falhou ao enviar:', e && e.message ? e.message : e);
      }

      // --- ativa o menu para esse chat por PENDING_TIMEOUT (2 minutos) ---
      try {
        const chatObj = await msg.getChat().catch(() => null);
        const chatId = (chatObj && chatObj.id && chatObj.id._serialized) ? chatObj.id._serialized : (msg.from || null);
        const initiator = msg.author || msg.from;
        if (chatId) {
          if (menuActive[chatId] && menuActive[chatId].timeoutId) clearTimeout(menuActive[chatId].timeoutId);
          menuActive[chatId] = {
            initiator,
            expires: Date.now() + PENDING_TIMEOUT,
            timeoutId: setTimeout(() => {
              delete menuActive[chatId];
            }, PENDING_TIMEOUT)
          };
        }
      } catch (e) {
        // se falhar, não bloqueia o envio do menu
      }
    }

    function mapBodyToAction(body) {
      if (!body) return null;
      const b = body.trim().toLowerCase();

      if (b === '1' || b === 'definir abertura' || b === 'abrir' || b === 'cfg_abertura' || b === '/config abrir') return 'set_open';
      if (b === '2' || b === 'definir fechamento' || b === 'fechar' || b === 'cfg_fechamento' || b === '/config fechar') return 'set_close';
      if (b === '3' || b.includes('status') || b === 'cfg_status') return 'status';
      if (b === '4' || b.includes('ativar') || b.includes('desativar') || b === 'cfg_toggle') return 'toggle';
      if (b === '5' || b.includes('remover') || b === 'cfg_remove') return 'remove';

      if (b.startsWith('/config')) {
        const parts = b.split(/\s+/);
        if (parts[1]) {
          if (['abrir', 'set_open'].includes(parts[1])) return 'set_open';
          if (['fechar', 'set_close'].includes(parts[1])) return 'set_close';
          if (['status','toggle','remove'].includes(parts[1])) return parts[1];
        }
      }
      return null;
    }

    client.on('message', async (msg) => {
      try {
        const bodyRaw = (msg.body || '').trim();
        if (!bodyRaw) return;

        const chat = await msg.getChat().catch(() => null);
        if (!chat || !chat.isGroup) return;
        const chatId = chat.id._serialized;

        // Se houver fluxo pendente, somente o iniciador pode responder
        if (pending[chatId]) {
          const p = pending[chatId];
          const senderId = msg.author || msg.from;
          if (senderId !== p.initiator) {
            // avisa e ignora
            return msg.reply('🔒 Só a pessoa que iniciou a configuração pode responder a este menu. Abra seu próprio menu com /config.');
          }

          // cancel
          if (bodyRaw.toLowerCase() === 'cancel') {
            cancelPending(chatId);
            return msg.reply('❌ Operação cancelada.');
          }

          // se ação for set_open ou set_close, espera apenas um HH:MM
          if (p.action === 'set_open' || p.action === 'set_close') {
            const time = bodyRaw.split(/\s+/)[0];
            const parsed = parseHHMM(time);
            if (!parsed) { cancelPending(chatId); return msg.reply('❌ Formato inválido. Operação cancelada. Use HH:MM (ex: 08:00).'); }

            // atualiza configs (cria se não existir)
            const cfgExisting = configs[chatId] || {};
            const cfg = {
              open: cfgExisting.open || null,
              close: cfgExisting.close || null,
              enabled: cfgExisting.enabled || false,
              title: cfgExisting.title || 'unknown',
              savedAt: cfgExisting.savedAt || null
            };

            try {
              const c = await msg.getChat();
              cfg.title = c.name || c.formattedTitle || cfg.title;
            } catch (e) {}

            if (p.action === 'set_open') cfg.open = time;
            if (p.action === 'set_close') cfg.close = time;
            cfg.savedAt = new Date().toISOString();

            // só habilita se ambos horários válidos
            if (parseHHMM(cfg.open) && parseHHMM(cfg.close)) {
              cfg.enabled = true;
              configs[chatId] = cfg;
              saveConfigs(configs);
              scheduleForGroup(chatId);
              applyStateWithRetry(chatId, isNowInOpenWindow(cfg.open, cfg.close), true).catch(() => {});
              cancelPending(chatId);
              return msg.reply(`✅ Horário salvo:\n🔓 Abre: ${cfg.open}\n🔒 Fecha: ${cfg.close}\n⏱️ Agendamento ativado.`);
            } else {
              // salva mas não ativa
              cfg.enabled = false;
              configs[chatId] = cfg;
              saveConfigs(configs);
              cancelPending(chatId);
              if (!parseHHMM(cfg.open)) {
                return msg.reply(`✅ Horário de *fechamento* atualizado para ${cfg.close || '—'}.\n⚠️ Falta definir *horário de abertura* para ativar o agendamento. Use /config e escolha 'Definir horário de Abertura'.`);
              } else {
                return msg.reply(`✅ Horário de *abertura* atualizado para ${cfg.open || '—'}.\n⚠️ Falta definir *horário de fechamento* para ativar o agendamento. Use /config e escolha 'Definir horário de Fechamento'.`);
              }
            }
          }
        }

        // Somente processa /config e opções 1-5 — números só são aceitos se menu estiver ativo
        const isConfigCmd = bodyRaw.toLowerCase().startsWith('/config') || ['/config','cfg_set','cfg_status','cfg_toggle','cfg_remove','cfg_apply','cfg_help'].includes(bodyRaw.toLowerCase());
        const isDigit = /^[1-5](\.|$)/.test(bodyRaw);

        // checa menu ativo neste chat
        const menu = menuActive[chatId];
        const menuAllowed = !!(menu && menu.expires > Date.now());

        // permitir quando: é comando /config (qualquer forma) OU é dígito E o menu está ativo
        if (!isConfigCmd && !(isDigit && menuAllowed)) return;

        const parts = bodyRaw.split(/\s+/).filter(Boolean);
        if (parts.length === 1 && parts[0].toLowerCase() === '/config') return showMenu(msg);

        // se veio via número e o menu estava ativo, expire o menu imediatamente para evitar reuso
        if (isDigit && menuActive[chatId]) {
          try {
            clearTimeout(menuActive[chatId].timeoutId);
          } catch (e) {}
          delete menuActive[chatId];
        }

        const actionFromBody = mapBodyToAction(bodyRaw);
        if (!actionFromBody) return showMenu(msg);

        switch (actionFromBody) {
          case 'set_open': return cmdSetOpen(msg, chat);
          case 'set_close': return cmdSetClose(msg, chat);
          case 'status': return cmdStatus(msg, chat);
          case 'toggle': {
            if (!verificarAdmin) return msg.reply('❌ Verificação de admin não está configurada.');
            if (!(await verificarAdmin(msg, chat))) return msg.reply('⛔ Apenas administradores podem ativar/desativar o agendamento.');
            const cfgExisting = configs[chatId] || {};
            const cfg = {
              open: cfgExisting.open || null,
              close: cfgExisting.close || null,
              enabled: typeof cfgExisting.enabled === 'boolean' ? cfgExisting.enabled : false,
              title: cfgExisting.title || (chat.name || chat.formattedTitle) || 'unknown',
              savedAt: cfgExisting.savedAt || new Date().toISOString()
            };
            cfg.enabled = !cfg.enabled;
            if (!cfg.enabled) clearTimersFor(chatId);
            configs[chatId] = cfg;
            saveConfigs(configs);
            if (cfg.enabled) scheduleForGroup(chatId);
            return msg.reply(`✅ Agendamento ${cfg.enabled ? 'ativado' : 'desativado'} para este grupo.`);
          }
          case 'remove': return cmdRemove(msg, chat);
          default:
            return showMenu(msg);
        }
      } catch (e) {
        console.error('Erro no listener abrirfechar:', e && e.message ? e.message : e);
      }
    });

    // inicializa schedules
    setTimeout(() => {
      initAllSchedules().catch(e => console.error('initAllSchedules falhou:', e && e.message ? e.message : e));
    }, 1000);

    // API pública
    return {
      configs,
      applyStateWithRetry,
      scheduleForGroup,
      isNowInOpenWindow
    };
  }
};
