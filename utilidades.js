const fs = require("fs");
const path = require("path");

const INFO_FILE = path.resolve(__dirname, "info.json");

function carregarInfo() {
  try {
    if (!fs.existsSync(INFO_FILE)) {
      return { valor100: null, stock: 0, proximoEstoque: null };
    }
    return JSON.parse(fs.readFileSync(INFO_FILE, "utf-8"));
  } catch {
    return { valor100: null, stock: 0, proximoEstoque: null };
  }
}

function salvarInfo(info) {
  fs.writeFileSync(INFO_FILE, JSON.stringify(info, null, 2));
}

function aplicarEstoqueAgendado(client) {
  const info = carregarInfo();
  if (!info.proximoEstoque) return;

  const [data, hora] = info.proximoEstoque.split(" ");
  const [dia, mes, ano] = data.split("/").map(Number);
  const [horas, minutos] = hora.split(":").map(Number);
  const dataAgendada = new Date(ano, mes - 1, dia, horas, minutos);

  const delay = dataAgendada.getTime() - Date.now();
  if (delay <= 0) {
    // Já passou → aplicar agora
    info.proximoEstoque = null;
    salvarInfo(info);
    return;
  }

  if (delay < 2147483647) {
    setTimeout(() => {
      const infoAtual = carregarInfo();
      infoAtual.proximoEstoque = null;
      salvarInfo(infoAtual);
      console.log(`✅ Estoque agendado ativado automaticamente: ${infoAtual.stock}`);
      if (client) {
        client.sendMessage(
          "status@broadcast",
          `📦 Estoque de ${infoAtual.stock} Robux agora disponível (agendamento liberado)!`
        );
      }
    }, delay);
  }
}

// ===================================================
// Handler do /setstock
// ===================================================
async function handleSetStock(client, msg, text) {
  if (!text.toLowerCase().startsWith("/setstock")) return false;

  const args = text.split(" ").slice(1);
  if (args.length < 1) {
    await msg.reply("❌ Uso correto:\n/setstock <quantidade> [dd/mm/aaaa hh:mm]");
    return true;
  }

  const quantidade = parseInt(args[0]);
  if (isNaN(quantidade) || quantidade <= 0) {
    await msg.reply("❌ Quantidade inválida. Exemplo: /setstock 1000 04/07/2025 11:59");
    return true;
  }

  const info = carregarInfo();

  if (args.length >= 3) {
    const [dia, mes, ano] = args[1].split("/").map(Number);
    const [hora, minuto] = args[2].split(":").map(Number);
    const dataAgendada = new Date(ano, mes - 1, dia, hora, minuto);

    if (isNaN(dataAgendada.getTime()) || dataAgendada <= new Date()) {
      await msg.reply("❌ Data/Hora inválida ou já passou. Exemplo: /setstock 1000 04/07/2025 11:59");
      return true;
    }

    info.stock = quantidade;
    info.proximoEstoque = `${args[1]} ${args[2]}`;
    salvarInfo(info);

    aplicarEstoqueAgendado(client);

    await msg.reply(`⏳ Estoque de *${quantidade}* será liberado em ${dataAgendada.toLocaleString("pt-BR")}.`);
  } else {
    info.stock = quantidade;
    info.proximoEstoque = null;
    salvarInfo(info);

    await msg.reply(`✅ Estoque atualizado imediatamente para ${quantidade}.`);
  }

  return true;
}

module.exports = {
  handleSetStock,
  aplicarEstoqueAgendado,
};
