const { cmd } = require('../sila');
const axios = require('axios');

cmd({
  pattern: "song",
  react: "😇",
  category: "download",
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply("*Please provide the song name to download.*\n\nUsage: .song <song name>\n\nI'll search and send the audio for you.");

    let ytUrl = q;

    // 🔍 If it's not a link → perform a search
    if (!q.startsWith("http")) {
      const searchApi = `https://www.movanest.xyz/v2/ytsearch?query=${encodeURIComponent(q)}`;
      const searchRes = await axios.get(searchApi);
      const searchData = searchRes.data;

      if (!searchData.status || !searchData.results || searchData.results.length === 0) {
        return reply("*Audio not found 🥺*");
      }

      ytUrl = searchData.results[0].url; // first result
    }

    // 🎵 MP3 API
    const apiUrl = `https://www.movanest.xyz/v2/ytmp3?url=${encodeURIComponent(ytUrl)}`;
    const { data } = await axios.get(apiUrl);

    if (data.status !== true || !data.results) {
      return reply("*Audio not found 🥺*");
    }

    const meta = data.results.metadata;
    const dl = data.results.download;

    if (!dl?.url) return reply("*Please provide a valid YouTube video link.*");

    // ℹ️ Simple info
    await reply(
      `*👑 AUDIO INFO 👑*\n\n` +
      `*👑 AUDIO NAME 👑* \n${meta.title}\n\n` +
      `*👑 TIKTOK ID 👑* \n ${meta.author.name}\n\n` +
      `*👑 TIME 👑* \n ${meta.duration.timestamp}\n\n*👑 BY :❯ 𝑵𝑰𝑶𝑹 𝑴𝑫 👑*`
    );

    // 🔊 Direct audio
    await conn.sendMessage(
      from,
      {
        audio: { url: dl.url },
        mimetype: "audio/mpeg"
      },
      { quoted: mek }
    );

  } catch (err) {
    console.log("SONG CMD ERROR:", err);
    reply("❌ An unexpected error occurred");
  }
});
