const { cmd } = require('../sila');
const axios = require('axios');

cmd({
  pattern: "ai",
  alias: ["gpt", "ask", "chatgpt"],
  react: "🤖",
  category: "ai",
  desc: "Chat with AI",
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  try {

    if (!q) {
      return reply(
        "*🤖 AI COMMAND*\n\n" +
        "Use:\n" +
        "*.ai apna sawal*\n\n" +
        "Example:\n" +
        "*.ai How are you*"
      );
    }

    await conn.sendPresenceUpdate('composing', from);

    // ✅ YOUR API
    const API_URL = `https://bilal-md-ai-d1191ad3f31f.herokuapp.com/api/ask?q=${encodeURIComponent(q)}`;

    const res = await axios.get(API_URL, { timeout: 60000 });

    if (res.data && res.data.reply) {
      await reply(res.data.reply);
    } else {
      await reply("❌ No response from AI");
    }

  } catch (err) {
    console.log("AI COMMAND ERROR:", err.message);
    reply("❌ AI server error / busy hai");
  }
});
