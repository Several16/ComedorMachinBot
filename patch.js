const fs = require('fs');
let code = fs.readFileSync('telegram-bot.js', 'utf8');

code = code.replace('"⚙️ *Tarea Programada Windows*",', '"⚙️ *Tarea Automática*",');
code = code.replace('nextRun: activeCronJob ? "Hoy a las " + currentCronTime : "-",', 'nextRun: activeCronJob ? "A las " + currentCronTime : "-",');
code = code.replace('base.push(["🛠️ Admin", "📋 Licencias", "🧹 Limpiar"]);', 'base.push(["🛠️ Admin", "📋 Licencias", "🧹 Limpiar", "⏰ Auto"]);');
code = code.replace('"🧹 Limpiar": "/limpiar_capturas",', '"🧹 Limpiar": "/limpiar_capturas",\n    "⏰ Auto": "/menu_tarea",');

const menuCommand = `
  if (command === "/menu_tarea") {
    if (!adminRequired(chatId)) return;
    const task = await getTaskStatus();
    const txt = \`⚙️ *Tarea Automática (Diaria)*\\n───────────────\\n*Estado:* \${task.state}\\n*Hora:* \${currentCronTime || "No configurada"}\\n*Plataforma:* \${task.taskState}\\n\\nSelecciona una acción:\`;
    const opts = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Habilitar", callback_data: "cron_enable" }, { text: "❌ Deshabilitar", callback_data: "cron_disable" }],
          [{ text: "🕒 Cambiar Hora", callback_data: "cron_time" }],
          [{ text: "▶️ Ejecutar Ahora", callback_data: "cron_run" }]
        ]
      }
    };
    await bot.sendMessage(chatId, txt, opts);
    return;
  }
`;
code = code.replace('if (command === "/cancel") {', menuCommand + '\n  if (command === "/cancel") {');

const flowInput = `
  if (flow.type === "cron_time") {
    const time = text.trim();
    if (!/^\\d{2}:\\d{2}$/.test(time)) {
      await bot.sendMessage(chatId, "Formato inválido. Usa HH:mm (ejemplo 07:00).", { reply_markup: cancelKeyboard() });
      return true;
    }
    clearFlow(chatId);
    const r = await ensureTaskAt(time);
    if (!r.ok) {
      await bot.sendMessage(chatId, \`Error: \${r.stderr}\`, { reply_markup: userKeyboard(admin) });
      return true;
    }
    await bot.sendMessage(chatId, \`✅ Hora actualizada a las \${time} (Perú).\\nAsegúrate de habilitar la tarea usando el menú ⏰ Auto.\`, { reply_markup: userKeyboard(admin) });
    return true;
  }
`;
code = code.replace('if (flow.type === "activate_code") {', flowInput + '\n  if (flow.type === "activate_code") {');

const callbackQuery = `
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  if (!isAdmin(chatId)) return bot.answerCallbackQuery(query.id, { text: "No autorizado.", show_alert: true });
  
  const data = query.data;
  try {
    if (data === "cron_enable") {
      await runTaskCommand(["/Change", "", "", "/ENABLE"]);
      await bot.answerCallbackQuery(query.id, { text: "Tarea habilitada." });
      await bot.sendMessage(chatId, "✅ Tarea automática habilitada.");
    } else if (data === "cron_disable") {
      await runTaskCommand(["/Change", "", "", "/DISABLE"]);
      await bot.answerCallbackQuery(query.id, { text: "Tarea deshabilitada." });
      await bot.sendMessage(chatId, "❌ Tarea automática deshabilitada.");
    } else if (data === "cron_run") {
      await bot.answerCallbackQuery(query.id, { text: "Iniciando proceso..." });
      await runTaskCommand(["/Run"]);
    } else if (data === "cron_time") {
      setFlow(chatId, { type: "cron_time", step: "time" });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, "Envíame la nueva hora en formato HH:mm (ejemplo: 07:00).", { reply_markup: cancelKeyboard() });
    }
  } catch (err) {
    console.error(err);
  }
});
`;
code = code.replace('bot.on("polling_error", (error) => {', callbackQuery + '\nbot.on("polling_error", (error) => {');

fs.writeFileSync('telegram-bot.js', code);
console.log("Patched.");
