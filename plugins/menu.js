const { cmd } = require('../sila');
const config = require('../config');
const os = require('os');
const process = require('process');
const moment = require('moment-timezone');

cmd({
  pattern: "menu",
  alias: ["help", "m", "list"],
  react: "👑",
  category: "menu",
  desc: "Show custom menu message with info",
  filename: __filename
}, async (conn, mek, m, { from, reply }) => {
  try {
    const sender = m.sender || 'unknown@s.whatsapp.net';

    const prefix = config.PREFIX || ".";
    const mode = config.WORK_TYPE?.toUpperCase() || "PUBLIC";

    // Uptime
    const uptime = () => {
      let sec = process.uptime();
      let h = Math.floor(sec / 3600);
      let mns = Math.floor((sec % 3600) / 60);
      let s = Math.floor(sec % 60);
      return `${h}H ${mns}M ${s}S`;
    };

    // Ping calculation
    const start = Date.now();
    await conn.sendPresenceUpdate('composing', from); // dummy update to calculate ping
    const ping = Date.now() - start;

    // Platform
    const platform = `${os.type()} ${os.arch()} Node:${process.version}`;

    // ================= Custom Menu Text =================
    const customMenu = `
*╔══〘 👑 MENU 👑 〙══╗*
*║👑 PREFIX :❯ ❮ ${prefix} ❯*
*║👑 MODE :❯ ${mode}*
*║👑 UPTIME :❯ ${uptime()}*
*║👑 PING :❯ ${ping} MS*
*║👑 PLATFORM :❯ 𝑵𝑰𝑶𝑹 ❯*
*╚═════════════════╝*

*HI @${sender.split("@")[0]} G 🥰*
*MERE BOT KA MENU 😍*
*YEH HAI G 😘*

*╔══〘 👑 OWNER 👑 〙══╗
*║ 👑 SETPREFIX*
*║ 👑 AUTOVIEWSTATUS*
*║ 👑 AUTOREAD*
*║ 👑 AUTOLIKESTATUS*
*║ 👑 SETPREFIX*
*║ 👑 WELCOME*
*║ 👑 GOODBYE*
*║ 👑 ANTIDELETE*
*║ 👑 ANTICALL*
*║ 👑 MODE*
*║ 👑 AUTOBIO*
*║ 👑 BLOCK*
*║ 👑 UNBLOCK*
*╚═════════════════╝*

*╔══〘 👑 DOWNLOAD 👑 〙══╗*
*║ 👑 VIDEO*
*║ 👑 TIKTOK*
*║ 👑 FB*
*╚═════════════════╝*

*╔══〘 👑 GROUP 👑 〙══╗*
*║ 👑 ONLINE*
*║ 👑 TAGALL*
*╚═════════════════╝*

*╔══〘 👑 AI 👑 〙══╗*
*║ 👑 GPT*
*╚═════════════════╝*

*╔══〘 👑 XTRA 👑 〙══╗*
*║ 👑 TRT*
*║ 👑 ATTP*
*║ 👑 TRT*
*║ 👑 SS*
*╚═════════════════╝*


*👑 ClICK HERE FOR HELP 👑*

*👑 DEVELEPER 👑*
*https://akaserein.github.io/Bilal/*

*👑 SUPPORT CHANNEL 👑* 
*https://whatsapp.com/channel/0029VbBXuGe4yltMLngL582d*

*👑 SUPPORT GROUP 👑*
*https://chat.whatsapp.com/BwWffeDwiqe6cjDDklYJ5m?mode=ems_copy_t*

*👑 𝑵𝑰𝑶𝑹 𝑴𝑫 WHATSAPP BOT 👑*
`;

  // ✅ First Message (Menu Image + Caption)
    await conn.sendMessage(from, {
      image: { url: config.IMAGE_PATH || "https://files.catbox.moe/kunzpz.png" },
      caption: customMenu,
      contextInfo: { mentionedJid: [sender] }
    }, { quoted: m });

    // ✅ Second Message (Buttons Separate)
    await conn.sendMessage(from, {
      text: "👑 Support Links Buttons 👇",
      footer: "👑 𝑵𝑰𝑶𝑹 𝑴𝑫 Support",

      templateButtons: [
        {
          index: 1,
          urlButton: {
            displayText: "📢 Channel 1",
            url: "https://whatsapp.com/channel/0029VbAPgH78PgsENxv1Ej43"
          }
        },
        {
          index: 2,
          urlButton: {
            displayText: "📢 Channel 2",
            url: "https://whatsapp.com/channel/0029VbAfR3Z4CrfrBQe5EX43"
          }
        },
        {
          index: 3,
          urlButton: {
            displayText: "💬 Support Group",
            url: "https://chat.whatsapp.com/BwWffeDwiqe6cjDDklYJ5m"
          }
        }
      ]
    }, { quoted: m });

  } catch (err) {
    console.log("❌ MENU ERROR:", err);

    reply("❌ Menu command error! Check console logs.");
  }
});
