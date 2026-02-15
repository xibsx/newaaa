const { cmd } = require('../sila');
const axios = require('axios');

cmd({
  pattern: "tiktok",
  react: "☺️",
  alias: ["tiktok", "ttdl", "tt", "tiktokvideo", "ttvideo"],
  category: "download",
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply("*Please provide a TikTok link to download.*\n\nUsage: .tiktok <link>");

    const apiUrl = `https://www.movanest.xyz/v2/tiktok?url=${encodeURIComponent(q)}`;
    const { data } = await axios.get(apiUrl);

    // 🔎 API status check
    if (data.status !== true || !data.results) {
      return reply("API ERROR");
    }

    const res = data.results;

    if (!res.no_watermark) {
      return reply("*TikTok video not found 🥺*");
    }

    // 🔹 Simple info (optional but clean)
    await reply(
      `*👑 TIKTOK VIDEO 👑*\n\n*👑 VIDEO NAME 👑\n` +
      `${res.title || "No title"}\n\n*👑 BY :❯ 𝑵𝑰𝑶𝑹 𝑴𝑫 👑*`
    );

    // 🔹 Send no-watermark video
    await conn.sendMessage(
      from,
      {
        video: { url: res.no_watermark },
        mimetype: "video/mp4"
      },
      { quoted: mek }
    );

  } catch (err) {
    console.log("TIKTOK CMD ERROR:", err);
    reply("❌ An unexpected error occurred");
  }
});
