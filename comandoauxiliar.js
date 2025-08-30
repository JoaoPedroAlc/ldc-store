// comandoauxiliar.js
// Módulo para comando /gift - fluxo de criação e compra de gifts
// Requer: whatsapp-web.js (MessageMedia), fs, path
// Exporta: setupComandoGift(client)

const fs = require("fs");
const path = require("path");
const { MessageMedia } = require("whatsapp-web.js");

const GIFT_FILE = path.resolve(__dirname, "gifts.json");
const IMAGES_DIR = path.resolve(__dirname, "gifts_images");
const PEDIDOS_FILE = path.resolve(__dirname, "pedidos.json");

if (!fs.existsSync(GIFT_FILE)) fs.writeFileSync(GIFT_FILE, "[]", "utf8");
if (!fs.existsSync(PEDIDOS_FILE)) fs.writeFileSync(PEDIDOS_FILE, "[]", "utf8");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Taxa de conversão (por 100 Robux)
const RATE_PER_100 = 2.80; // R$ por 100 Robux (ajuste conforme necessário)
const SESSION_TTL_MS = 3 * 60 * 1000; // 3 minutos por sessão

// Sessions temporárias (por usuário)
const sessions = {}; // sessions[from] = { etapa, ... }

function carregarGifts() {
  try { return JSON.parse(fs.readFileSync(GIFT_FILE, "utf8")); } catch { return []; }
}
function salvarGifts(list) { fs.writeFileSync(GIFT_FILE, JSON.stringify(list, null, 2), "utf8"); }

function carregarPedidos() {
  try { return JSON.parse(fs.readFileSync(PEDIDOS_FILE, "utf8")); } catch { return []; }
}
function salvarPedidos(list) { fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(list, null, 2), "utf8"); }

function newId() { return `${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`; }
function startSession(from, data = {}) {
  if (sessions[from] && sessions[from].timeout) clearTimeout(sessions[from].timeout);
  sessions[from] = { ...data };
  sessions[from].timeout = setTimeout(() => { delete sessions[from]; }, SESSION_TTL_MS);
}
function endSession(from) {
  if (!sessions[from]) return;
  if (sessions[from].timeout) clearTimeout(sessions[from].timeout);
  delete sessions[from];
}

function reaisToRobux(reais) { return Math.round((reais / RATE_PER_100) * 100); }
function robuxToReais(robux) { return (robux / 100) * RATE_PER_100; }

// aceita: "1,2" ou "1x2,2" -> retorna array { index, qty } ou null
function parseMultiSelectInput(raw, maxIndex) {
  if (!raw || typeof raw !== "string") return null;
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const res = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)(?:x(\d+))?$/i);
    if (!m) return null;
    const idx = parseInt(m[1], 10);
    const qty = m[2] ? parseInt(m[2], 10) : 1;
    if (isNaN(idx) || idx < 1 || idx > maxIndex || isNaN(qty) || qty < 1) return null;
    res.push({ index: idx, qty });
  }
  return res;
}

function isUserAdminInGroup(msg, chat) {
  try {
    if (!chat || !chat.isGroup) return true;
    const userId = msg.author || msg.from;
    const participant = chat.participants.find(p => p.id && p.id._serialized === userId);
    return !!(participant && (participant.isAdmin || participant.isSuperAdmin));
  } catch { return false; }
}

function safeParseNumber(s) {
  const n = Number(String(s).replace(",", ".").replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n;
}

// Formata resumo rápido do gift (para listagem)
function formatGiftSummary(g, idx) {
  const title = g.title || (g.text ? g.text.slice(0, 40) : `Gift ${g.id}`);
  const kind = g.type && g.type.startsWith("image") ? "[IMG]" : "[TXT]";
  const opts = (g.options && g.options.length) ? ` — ${g.options.length} opções` : "";
  return `${idx + 1}) ${kind} ${title}${opts} (id:${g.id})`;
}

// ----------------- Export: setupComandoGift -----------------
function setupComandoGift(client) {
  client.on("message", async (msg) => {
    try {
      const from = msg.from;
      const chat = await msg.getChat().catch(() => null);
      const raw = (msg.body || "").trim();
      const txt = raw.toLowerCase();

      // abrir painel
      if (txt === "/gift") {
        startSession(from, { etapa: "menu" });
        return msg.reply(
`🎁 *Painel gift:*
1️⃣ Conversão (Robux ↔ Reais)
2️⃣ Ver gifts adicionados
3️⃣ Comprar gift (escolha 1 ou mais)
4️⃣ Painel admin

Digite o número da opção ou "cancelar".`
        );
      }

      // if no session -- ignore unless command opens session
      if (!sessions[from]) return;
      const s = sessions[from];
      if (txt === "cancelar") { endSession(from); return msg.reply("❌ Operação cancelada."); }

      // ===== MENU =====
      if (s.etapa === "menu") {
        if (txt === "1") { s.etapa = "conversao_choose"; startSession(from, s); return msg.reply("🔄 Conversão — escolha:\n1) Robux → Reais\n2) Reais → Robux\nDigite 1 ou 2."); }
        if (txt === "2") {
          const gifts = carregarGifts();
          if (gifts.length === 0) { endSession(from); return msg.reply("📭 Nenhum gift cadastrado."); }
          let lista = "📦 *Gifts disponíveis:*\n\n";
          gifts.forEach((g, i) => lista += `${i+1}) ${g.title || "(sem título)"} — ${(g.options && g.options.length) ? `${g.options.length} opções` : "sem opções"}\n`);
          lista += `\nPara comprar, volte ao menu e escolha opção 3.`;
          endSession(from);
          return msg.reply(lista);
        }
        if (txt === "3") {
          const gifts = carregarGifts();
          if (gifts.length === 0) { endSession(from); return msg.reply("📭 Nenhum gift cadastrado para comprar."); }
          s.etapa = "request_choose_gift"; s.giftsList = gifts; startSession(from, s);
          let menu = "🎯 Comprar Gift — escolha um ou mais gifts (ex: 1,2):\n\n";
          gifts.forEach((g,i) => menu += `${i+1}) ${g.title || "(sem título)"} — ${ (g.options && g.options.length) ? `${g.options.length} opções` : "sem opções" }\n`);
          menu += `\nDigite sua seleção:`;
          return msg.reply(menu);
        }
        if (txt === "4") {
          if (chat && chat.isGroup && !isUserAdminInGroup(msg, chat)) { endSession(from); return msg.reply("⛔ Apenas admins do grupo podem abrir painel admin."); }
          s.etapa = "admin_menu"; startSession(from, s);
          return msg.reply(`🛠️ Painel Admin
1) Criar gift
2) Remover gift
3) Listar detalhado
4) Editar gift
5) Sair
Digite o número.`);
        }
        return msg.reply("❌ Opção inválida. Digite 1..4 ou cancelar.");
      }

      // ===== Conversão =====
      if (s.etapa === "conversao_choose") {
        if (txt === "1") { s.etapa = "conversao_robux"; startSession(from, s); return msg.reply("🔢 Digite a quantidade de Robux (ex: 1500):"); }
        if (txt === "2") { s.etapa = "conversao_reais"; startSession(from, s); return msg.reply("🔢 Digite o valor em R$ (ex: 10.50):"); }
        return msg.reply("❌ Digite 1 ou 2.");
      }
      if (s.etapa === "conversao_robux") {
        const n = parseInt(raw.replace(/\D/g,""),10);
        if (isNaN(n)||n<=0) return msg.reply("❌ Número inválido.");
        const r = robuxToReais(n); endSession(from); return msg.reply(`🎮 ${n} Robux = 💵 R$ ${r.toFixed(2)} (100 Robux = R$ ${RATE_PER_100.toFixed(2)})`);
      }
      if (s.etapa === "conversao_reais") {
        const v = parseFloat(raw.replace(",",".")) ;
        if (isNaN(v)||v<=0) return msg.reply("❌ Valor inválido.");
        const rob = reaisToRobux(v); endSession(from); return msg.reply(`💵 R$ ${v.toFixed(2)} = 🎮 ${rob} Robux (100 Robux = R$ ${RATE_PER_100.toFixed(2)})`);
      }

      // ===== Comprar gift (seleção múltipla) =====
      if (s.etapa === "request_choose_gift") {
        const parsed = parseMultiSelectInput(raw, s.giftsList.length);
        if (!parsed) { endSession(from); return msg.reply("❌ Seleção inválida. Digite por exemplo: 1 ou 1,2 ou 1x2,3"); }

        // cria pending array com entradas para processar
        s.pendingGifts = parsed.map(p => ({
          giftIndex: p.index - 1,
          requestedQtyShortcut: p.qty, // qty embutida (mas vamos pedir quantidade explicitamente depois)
          gift: s.giftsList[p.index - 1],
          optionSelections: [], // será preenchido
          summary: null,
          totalReais: 0,
          totalRobux: 0
        }));
        s.currentPending = 0;
        startSession(from, s);
        return processNextPendingGift(client, msg, from);
      }

      // etapas interativas durante pedido múltiplo
      if (s.etapa && ["processing_options_select","processing_options_ask_qty","processing_options_confirm_add_more","processing_options_wait_next_choice","processing_freeform"].includes(s.etapa)) {
        return handlePendingGiftFlows(client, msg, from);
      }

      // ===== ADMIN =====
      if (s.etapa === "admin_menu") {
        if (txt === "1") { s.etapa = "admin_create_choose_type"; startSession(from, s); return msg.reply("✳️ Criar gift - escolha tipo:\n1) Texto apenas\n2) Foto + Texto\n3) Foto apenas"); }
        if (txt === "2") {
          const gifts = carregarGifts();
          if (!gifts.length) { endSession(from); return msg.reply("📭 Nenhum gift para remover."); }
          s.etapa = "admin_remove";
          s.toRemove = gifts;
          startSession(from, s);
          let menu = "🗑️ Escolha o número do gift para remover:\n\n";
          gifts.forEach((g,i)=> menu += `${i+1}) ${g.title || "(sem título)"}\n`);
          return msg.reply(menu);
        }
        if (txt === "3") {
          const gifts = carregarGifts();
          if (!gifts.length) { endSession(from); return msg.reply("📭 Nenhum gift cadastrado."); }
          for (let i=0;i<gifts.length;i++) {
            const g = gifts[i];
            const caption = `#${i+1} - ${g.title || "(sem título)"}\nID:${g.id}\nTipo:${g.type}\nOpções:${(g.options||[]).length}\nTexto:${g.text||"(sem texto)"}`;
            if (g.type && g.type.startsWith("image") && g.imagePath) {
              try { const fp = path.resolve(__dirname, g.imagePath); if (fs.existsSync(fp)) { const media = MessageMedia.fromFilePath(fp); await msg.reply(media, null, { caption }); continue; } }
              catch(e){ /* ignore */ }
            }
            await msg.reply(caption);
          }
          endSession(from);
          return;
        }
        if (txt === "4") {
          const gifts = carregarGifts();
          if (!gifts.length) { endSession(from); return msg.reply("📭 Nenhum gift para editar."); }
          s.etapa = "admin_edit_choose"; s.editList = gifts; startSession(from, s);
          let menu = "✏️ Escolha o número do gift para editar:\n";
          gifts.forEach((g,i)=> menu += `${i+1}) ${g.title || "(sem título)"}\n`);
          return msg.reply(menu);
        }
        if (txt === "5") { endSession(from); return msg.reply("✅ Saindo do painel admin."); }
        return msg.reply("❌ Opção inválida. Digite 1..5");
      }

      // ---- admin create (fluxos)
      if (s.etapa === "admin_create_choose_type") {
        if (!["1","2","3"].includes(txt)) return msg.reply("❌ Digite 1,2 ou 3.");
        s.create = { type: txt === "1" ? "text" : (txt === "2" ? "image_text" : "image_only"), options: [] };
        if (s.create.type === "text") { s.etapa = "admin_create_title"; startSession(from, s); return msg.reply("✍️ Envie o *NOME* do gift (este nome aparecerá para os clientes):"); }
        s.etapa = "admin_create_wait_image"; startSession(from, s); return msg.reply("📸 Envie a imagem do gift. Você pode incluir legenda que será o nome.");
      }

      if (s.etapa === "admin_create_title") {
        const nome = raw; if (!nome || nome.length < 1) return msg.reply("❌ Nome inválido. Envie o nome do gift:");
        s.create.title = nome; s.etapa = "admin_create_options_ask"; startSession(from, s);
        return msg.reply(`Deseja adicionar opções (tiers) para este gift?\n1) Sim\n2) Não`);
      }

      if (s.etapa === "admin_create_wait_image") {
        if (!msg.hasMedia) return msg.reply("📎 Aguardo uma imagem (envie foto).");
        try {
          const media = await msg.downloadMedia();
          const mime = media.mimetype || "image/jpeg";
          let ext = mime.includes("/") ? mime.split("/")[1].split(";")[0] : "jpg";
          const id = newId(); const filename = `${id}.${ext}`; const filepath = path.join(IMAGES_DIR, filename);
          fs.writeFileSync(filepath, Buffer.from(media.data, "base64"));
          s.create.imagePath = path.relative(__dirname, filepath);
          s.create.title = msg.caption || msg.body || "";
          if (!s.create.title) { s.etapa = "admin_create_title_after_image"; startSession(from, s); return msg.reply("📛 Não detectei um nome na legenda. Envie o *NOME* do gift:"); }
          s.etapa = "admin_create_options_ask"; startSession(from, s); return msg.reply("Imagem recebida. Deseja adicionar opções? 1) Sim 2) Não");
        } catch (e) { console.error(e); endSession(from); return msg.reply("❌ Erro ao processar imagem."); }
      }

      if (s.etapa === "admin_create_title_after_image") {
        const nome = raw; if (!nome || nome.length < 1) return msg.reply("❌ Nome inválido. Envie o NOME do gift:");
        s.create.title = nome; s.etapa = "admin_create_options_ask"; startSession(from, s); return msg.reply("Deseja adicionar opções? 1) Sim 2) Não");
      }

      if (s.etapa === "admin_create_options_ask") {
        if (txt === "2") {
          const gifts = carregarGifts();
          const g = { id: newId(), type: s.create.imagePath ? "image" : "text", title: s.create.title || "(sem título)", text: s.create.title || "", imagePath: s.create.imagePath || null, options: [], createdAt: new Date().toISOString(), createdBy: from };
          gifts.push(g); salvarGifts(gifts); endSession(from); return msg.reply(`✅ Gift criado: ${g.title} (id:${g.id})`);
        }
        if (txt === "1") {
          s.etapa = "admin_create_options_add"; s.create.options = s.create.options || []; startSession(from, s);
          return msg.reply(
`Adicione opções — UMA opção por mensagem.
Formato aceito:
- "20 Diamantes"
- ou "20 Diamantes | 2.77"  (já inclui preço)
Envie UMA opção por vez. Depois envie "fim".`
          );
        }
        return msg.reply("❌ Digite 1 (Sim) ou 2 (Não).");
      }

      if (s.etapa === "admin_create_options_add") {
        const line = raw;
        if (line.toLowerCase() === "fim") {
          const gifts = carregarGifts();
          const g = { id: newId(), type: s.create.imagePath ? "image" : "text", title: s.create.title || "(sem título)", text: s.create.title || "", imagePath: s.create.imagePath || null, options: s.create.options || [], createdAt: new Date().toISOString(), createdBy: from };
          gifts.push(g); salvarGifts(gifts); endSession(from); return msg.reply(`✅ Gift criado: ${g.title} com ${g.options.length} opções (id:${g.id}).`);
        }
        if (line.includes("|")) {
          const parts = line.split("|").map(p => p.trim()).filter(Boolean);
          const label = parts[0];
          let price = null;
          if (parts.length >= 2) { price = parseFloat(parts[1].replace(",", ".")); }
          if (!price || isNaN(price) || price <= 0) return msg.reply("Formato inválido com '|'. Ex: 20 Diamantes | 2.77");
          const option = { id: newId(), label, quantity: (label.match(/(\d+)/)||[])[1] ? Number((label.match(/(\d+)/)||[])[1]) : null, price_reais: Number(price.toFixed(2)), price_robux_equivalent: reaisToRobux(price) };
          s.create.options.push(option); startSession(from, s); return msg.reply(`✅ Opção adicionada: ${label} — R$ ${option.price_reais.toFixed(2)}\nEnvie outra opção (UMA por mensagem) ou 'fim'.`);
        }
        // sem preço: pedir preço
        const label = line.replace(/^\d+\)\s*/,"").trim();
        if (!label) return msg.reply("Formato inválido. Ex: '20 Diamantes' ou '20 Diamantes | 2.77'");
        s.create.pendingOptionLabel = label; s.etapa = "admin_create_options_await_price"; startSession(from, s);
        return msg.reply(`Você adicionou a opção: "${label}"\nAgora envie o *preço em R$* para essa opção (ex: 2.77).`);
      }

      if (s.etapa === "admin_create_options_await_price") {
        const v = parseFloat(raw.replace(",", "."));
        if (isNaN(v) || v <= 0) return msg.reply("Preço inválido. Envie o valor em R$ (ex: 2.77) ou 'cancelar'.");
        const option = { id: newId(), label: s.create.pendingOptionLabel, quantity: (s.create.pendingOptionLabel.match(/(\d+)/)||[])[1] ? Number((s.create.pendingOptionLabel.match(/(\d+)/)||[])[1]) : null, price_reais: Number(v.toFixed(2)), price_robux_equivalent: reaisToRobux(v) };
        s.create.options.push(option); delete s.create.pendingOptionLabel; s.etapa = "admin_create_options_add"; startSession(from, s);
        return msg.reply(`✅ Opção adicionada: ${option.label} — R$ ${option.price_reais.toFixed(2)}\nEnvie outra opção (UMA por mensagem) ou 'fim'.`);
      }

      // ---- admin remove
      if (s.etapa === "admin_remove") {
        const idx = parseInt(raw.replace(/\D/g,""),10);
        if (isNaN(idx) || idx < 1 || idx > s.toRemove.length) { endSession(from); return msg.reply("Índice inválido."); }
        const gifts = carregarGifts();
        const removed = gifts.splice(idx-1,1)[0];
        if (removed && removed.imagePath) { try { const fp = path.resolve(__dirname, removed.imagePath); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e){} }
        salvarGifts(gifts); endSession(from); return msg.reply(`🗑️ Gift removido: ${removed.title || removed.id}`);
      }

      // ---- admin edit choose
      if (s.etapa === "admin_edit_choose") {
        const idx = parseInt(raw.replace(/\D/g,""),10);
        if (isNaN(idx) || idx < 1 || idx > s.editList.length) { endSession(from); return msg.reply("Índice inválido."); }
        s.editTargetIndex = idx - 1; s.editTarget = s.editList[s.editTargetIndex]; s.etapa = "admin_edit_menu"; startSession(from, s);
        return msg.reply(`✏️ Editando: ${s.editTarget.title || s.editTarget.text || s.editTarget.id}\n1) Editar texto/título\n2) Trocar imagem\n3) Gerenciar opções\n4) Cancelar`);
      }

      // (continuação da edição não implementada em detalhe para manter foco; pode-se estender conforme necessário)
      // fallback
      return msg.reply("❌ Fluxo não reconhecido. Digite /gift para abrir o painel.");
    } catch (e) {
      console.error("Erro no comandoauxiliar /gift:", e);
    }
  });

  // ----------------- Funções internas para pedido múltiplo -----------------

  async function processNextPendingGift(client, msg, from) {
    const s = sessions[from];
    if (!s || !s.pendingGifts) { endSession(from); return msg.reply("Erro interno: sessão perdida."); }
    if (s.currentPending >= s.pendingGifts.length) {
      // todos processados -> resumo final, salvar pedido automaticamente e enviar apenas resumo (sem pedir "confirmar")
      let totalReais = 0; let totalRobux = 0; let resumo = "🧾 *Resumo do pedido múltiplo:*\n\n";
      s.pendingGifts.forEach(it => {
        resumo += `${it.summary || ("• " + (it.gift && it.gift.title ? it.gift.title : "gift desconhecido"))}\n`;
        totalReais += it.totalReais || 0;
        totalRobux += it.totalRobux || 0;
      });
      resumo += `\n💰 *Total: R$ ${totalReais.toFixed(2)}*\n🎮 *Equivalente: ${totalRobux} Robux*`;

      // instrução de compra
      resumo += `\n\nSe quiser comprar, digite: /comprar ${totalRobux} e selecione *gift*`;

      // salvar pedido automaticamente
      try {
        const pedidos = carregarPedidos();
        const pedido = {
          id: newId(), from, timestamp: new Date().toISOString(),
          items: s.pendingGifts.map(it => ({ giftId: it.gift.id, title: it.gift.title, summary: it.summary, totalReais: it.totalReais || 0, totalRobux: it.totalRobux || 0 })),
          totalReais: Number(totalReais.toFixed(2)),
          totalRobux: totalRobux
        };
        pedidos.push(pedido);
        salvarPedidos(pedidos);
      } catch (e) { console.error("Erro ao salvar pedidos.json:", e); }

      endSession(from);
      return msg.reply(resumo);
    }

    const current = s.pendingGifts[s.currentPending];
    const gift = current.gift;
    if (!gift) {
      current.summary = `• Gift inválido`; current.totalReais = 0; current.totalRobux = 0;
      s.currentPending++; startSession(from, s);
      return processNextPendingGift(client, msg, from);
    }

    // SE TEM OPTIONS -> instruções + se tiver imagem, enviar imagem com legenda das opções
    if (gift.options && gift.options.length > 0) {
      let legenda = `📦 *${gift.title || gift.text}* — opções:\n\n`;
      gift.options.forEach((o,i) => legenda += `${i+1}) ${o.label} — R$ ${Number(o.price_reais).toFixed(2)}\n`);
      legenda += `\nSelecione as opções que quer (ex: 1 ou 1,2 ou 1x2,3).\nDepois eu pedirei a quantidade para cada opção.\nOu envie 'pular' para não incluir este gift.`;

      // se existe imagem do gift, enviar a imagem com a legenda
      if (gift.imagePath) {
        try {
          const fp = path.resolve(__dirname, gift.imagePath);
          if (fs.existsSync(fp)) {
            const media = MessageMedia.fromFilePath(fp);
            s.etapa = "processing_options_select";
            startSession(from, s);
            return msg.reply(media, null, { caption: legenda });
          }
        } catch (e) {
          console.error("Erro ao enviar imagem do gift:", e);
          // se falhar, cairá para enviar texto abaixo
        }
      }

      // enviar apenas texto se não houver imagem
      s.etapa = "processing_options_select";
      startSession(from, s);
      return msg.reply(legenda);
    } else {
      // gift sem opções -> pedir valor/quantidade (livre)
      s.etapa = "processing_freeform"; startSession(from, s);
      return msg.reply(`📦 *${gift.title || gift.text}* — sem opções predefinidas.\nInforme a quantidade (número inteiro) ou o valor em R$ (ex: 5.00). Ou envie 'pular' para não incluir este gift.`);
    }
  }

  async function handlePendingGiftFlows(client, msg, from) {
    const s = sessions[from]; if (!s) return;
    const raw = (msg.body || "").trim(); const txt = raw.toLowerCase();

    const current = s.pendingGifts[s.currentPending];
    const gift = current.gift;

    // ---------- PROCESSAMENTO DE OPTIONS ----------
    if (s.etapa === "processing_options_select") {
      if (txt === "pular") {
        current.summary = `• ${gift.title} — PULADO`; current.totalReais = 0; current.totalRobux = 0;
        s.currentPending++; startSession(from, s); return processNextPendingGift(client, msg, from);
      }
      // espera seleção inicial: "1,2" ou "1x2,2"
      const parsed = parseMultiSelectInput(raw, gift.options.length);
      if (!parsed) return msg.reply("Entrada inválida. Envie números das opções (ex: 1 ou 1,2) ou 'pular'.");
      // cria fila de opções selecionadas (ignoramos qty embutido e pediremos quantidade explicitamente)
      s.currentOptionQueue = parsed.map(p => ({ optIndex: p.index - 1, requestedQtyShortcut: p.qty }));
      s.currentOptionProcessingIndex = 0;
      s.optionSelections = []; // array { optIndex, qty, priceRTotal, priceRobux, label }
      // pedir quantidade para a primeira opção da fila
      const opt = gift.options[s.currentOptionQueue[0].optIndex];
      s.etapa = "processing_options_ask_qty"; startSession(from, s);
      return msg.reply(`Informe a quantidade que você quer de "${opt.label}" (envie um número inteiro).`);
    }

    if (s.etapa === "processing_options_ask_qty") {
      const qty = parseInt(raw.replace(/\D/g,""),10);
      if (isNaN(qty) || qty <= 0) return msg.reply("Quantidade inválida. Envie um número inteiro maior que 0.");
      const queue = s.currentOptionQueue;
      const processingIdx = s.currentOptionProcessingIndex || 0;
      const optIndex = queue[processingIdx].optIndex;
      const opt = gift.options[optIndex];
      const priceRTotal = Number((opt.price_reais * qty).toFixed(2));
      const priceRobux = reaisToRobux(priceRTotal);
      s.optionSelections.push({ optIndex, qty, priceRTotal, priceRobux, label: opt.label });
      // perguntar se quer adicionar mais (pode ser da fila restante ou nova escolha)
      s.etapa = "processing_options_confirm_add_more"; startSession(from, s);
      return msg.reply("Deseja adicionar mais opções para este gift? Responda 'sim' para continuar, ou 'finalizar' para finalizar este gift.");
    }

    if (s.etapa === "processing_options_confirm_add_more") {
      if (txt === "sim") {
        // avançar no queue se houver mais
        s.currentOptionProcessingIndex = (s.currentOptionProcessingIndex || 0) + 1;
        const queue = s.currentOptionQueue;
        if (s.currentOptionProcessingIndex < queue.length) {
          // pedir quantidade para próxima da fila
          const nextOpt = gift.options[ queue[s.currentOptionProcessingIndex].optIndex ];
          s.etapa = "processing_options_ask_qty"; startSession(from, s);
          return msg.reply(`Informe a quantidade que você quer de "${nextOpt.label}" (envie um número inteiro).`);
        } else {
          // fila acabou — permitir adicionar nova opção manualmente (digitando número)
          s.etapa = "processing_options_wait_next_choice"; startSession(from, s);
          return msg.reply("Envie outra opção (ex: 1) para adicionar mais ou digite 'finalizar' para finalizar este gift.");
        }
      }
      if (txt === "finalizar") {
        // finalizar este gift: montar resumo parcial
        let summaryLines = [];
        let totalReais = 0; let totalRobux = 0;
        for (const sel of s.optionSelections) {
          summaryLines.push(`${sel.qty}x ${sel.label} (R$ ${sel.priceRTotal.toFixed(2)})`);
          totalReais += sel.priceRTotal;
          totalRobux += sel.priceRobux;
        }
        current.summary = `• ${gift.title} — ${summaryLines.join(", ")}`;
        current.totalReais = Number(totalReais.toFixed(2));
        current.totalRobux = totalRobux;
        s.currentPending++; startSession(from, s);
        return processNextPendingGift(client, msg, from);
      }
      // texto inesperado
      return msg.reply("Resposta inválida. Digite 'sim' para adicionar mais ou 'finalizar' para finalizar este gift.");
    }

    if (s.etapa === "processing_options_wait_next_choice") {
      if (txt === "finalizar") {
        // mesmo comportamento de finalizar: compor resumo
        let summaryLines = [];
        let totalReais = 0; let totalRobux = 0;
        for (const sel of s.optionSelections) {
          summaryLines.push(`${sel.qty}x ${sel.label} (R$ ${sel.priceRTotal.toFixed(2)})`);
          totalReais += sel.priceRTotal;
          totalRobux += sel.priceRobux;
        }
        current.summary = `• ${gift.title} — ${summaryLines.join(", ")}`;
        current.totalReais = Number(totalReais.toFixed(2));
        current.totalRobux = totalRobux;
        s.currentPending++; startSession(from, s);
        return processNextPendingGift(client, msg, from);
      }
      if (txt === "pular") {
        current.summary = `• ${gift.title} — PULADO`; current.totalReais = 0; current.totalRobux = 0;
        s.currentPending++; startSession(from, s); return processNextPendingGift(client, msg, from);
      }
      // tentar interpretar como número de opção nova
      const singleChoice = parseInt(raw.replace(/\D/g,""),10);
      if (!isNaN(singleChoice) && singleChoice >= 1 && singleChoice <= gift.options.length) {
        // adicionar nova opção
        const newOptIndex = singleChoice - 1;
        s.currentOptionQueue = [{ optIndex: newOptIndex }]; s.currentOptionProcessingIndex = 0; // mantemos escolhas anteriores
        s.etapa = "processing_options_ask_qty"; startSession(from, s);
        const opt = gift.options[newOptIndex];
        return msg.reply(`Informe a quantidade que você quer de "${opt.label}" (envie um número inteiro).`);
      }
      return msg.reply("Entrada inválida. Envie o número da opção (ex: 1) para adicionar mais, ou 'finalizar' para finalizar este gift.");
    }

    // ---------- FREEFORM (gift sem opções) ----------
    if (s.etapa === "processing_freeform") {
      if (txt === "pular") {
        current.summary = `• ${gift.title} — PULADO`; current.totalReais = 0; current.totalRobux = 0;
        s.currentPending++; startSession(from, s); return processNextPendingGift(client, msg, from);
      }
      // tentar interpretar como inteiro (quantidade) ou valor em reais (float)
      const asInt = parseInt(raw.replace(/\D/g,""),10);
      const asFloat = parseFloat(raw.replace(",", "."));
      if (!isNaN(asInt) && asInt > 0 && (!raw.includes(".") && !raw.includes(","))) {
        // quantidade interpretada — se gift tem preço unitário desconhecido, registramos apenas como quantidade sem preço
        current.summary = `• ${gift.title} — ${asInt} unidades (quantidade informada, sem preço)`;
        current.totalReais = 0; current.totalRobux = 0;
        s.currentPending++; startSession(from, s); return processNextPendingGift(client, msg, from);
      }
      if (!isNaN(asFloat) && asFloat > 0) {
        // usuário enviou valor em reais
        const priceRTotal = Number(asFloat.toFixed(2));
        const priceRobux = reaisToRobux(priceRTotal);
        current.summary = `• ${gift.title} — Valor R$ ${priceRTotal.toFixed(2)}`;
        current.totalReais = priceRTotal; current.totalRobux = priceRobux;
        s.currentPending++; startSession(from, s); return processNextPendingGift(client, msg, from);
      }
      return msg.reply("Entrada inválida. Envie a quantidade (ex: 2) ou o valor em R$ (ex: 5.00), ou 'pular'.");
    }

    // fallback
    return msg.reply("Entrada não esperada. Reinicie com /gift se necessário.");
  }

} // fim setupComandoGift

module.exports = { setupComandoGift };
