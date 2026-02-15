const { cmd } = require('../sila');

cmd({
  pattern: "block",
  alias: ["b", "blk", "blok", "bye", "khatam"],
  react: "🤐",
  category: "owner",
  desc: "Block user (reply or inbox)",
  filename: __filename
}, async (conn, mek, m, { from, reply, isOwner }) => {
  try {

    // 🔒 Owner only
    if (!isOwner) {
      return reply("*This command is for the bot owner only.*");
    }

    let jid;

    // 📌 Reply case
    if (m.quoted) {
      jid = m.quoted.sender;
    }
    // 📌 Inbox case
    else if (from.endsWith("@s.whatsapp.net")) {
      jid = from;
    } 
    else {
      return reply("*Reply to a message or send the number to block.*");
    }

    // Message before block
    await reply("*AP MUJHE BAHUT TANG KAR RAHE HO 😒 IS LIE MENE APKO BLOCK KAR DYA HAI 😏*");

    // ⏱️ Small delay
    setTimeout(async () => {
      await conn.updateBlockStatus(jid, "block");
      await conn.sendMessage(from, { react: { text: "😒", key: mek.key }});
    }, 1500);

  } catch (e) {
    console.log("BLOCK ERROR:", e);
    reply("*❌ Failed to block 😔*");
  }
});
