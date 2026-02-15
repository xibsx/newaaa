const axios = require("axios");
const { cmd } = require("../command");

// =============================================================
// 📌 TIKTOK DOWNLOADER COMMAND
// =============================================================
cmd({
  pattern: "tiktok",
  alias: ["ts", "ttsearch", "tt", "ttdl"],
  desc: "Download TikTok videos via link or search",
  react: "🎵",
  category: "download",
  filename: __filename
}, async (conn, mek, m, { from, args, reply, prefix, q }) => {

  try {
    // 1. Check Input
    if (!q) return reply(`*Please provide a TikTok link or search query.*\n\n*TIKTOK <link|query>*\n\n*POWERED BY 𝑵𝑰𝑶𝑹 𝑴𝑫 👑*`);

    await m.react("📥");

    // 2. Fetch from TikWM API
    const apiUrl = `https://tikwm.com/api/`;
    const response = await axios.post(apiUrl, new URLSearchParams({
        url: q,  // Agar link hai to link, varna search query
        count: 1,
        cursor: 0,
        hd: 1
    }));

    const data = response.data;

    // Check if video found
    if (!data || !data.data) {
        // If no link provided, user may be searching instead
        const searchRes = await axios.get(`https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(q)}`);
        if (!searchRes.data.data || !searchRes.data.data.videos) {
            return reply("*Sorry, video not found.*");
        }
        var videoData = searchRes.data.data.videos[0]; // Pehli video utha li
    } else {
        var videoData = data.data; // Direct link wala data
    }

    // 3. Design Caption
    let caption = `╭━━━〔 *TIKTOK DOWNLOADER* 〕━━━┈⊷
┃
┃ 👑 *TITLE:* ${videoData.title ? videoData.title.toUpperCase().slice(0, 50) : "TIKTOK VIDEO"}
┃ 👑 *AUTHOR:* ${videoData.author.nickname.toUpperCase()}
┃ 👑 *VIEWS:* ${videoData.play_count || "N/A"}
┃ 👑 *LIKES:* ${videoData.digg_count || "N/A"}
┃
╰━━━━━━━━━━━━━━━┈⊷

*POWERED BY 𝑵𝑰𝑶𝑹 𝑴𝑫* 👑`; 

    // 4. Send Video
    await conn.sendMessage(from, { 
      video: { url: videoData.play || videoData.hdplay }, 
      caption: caption,
      fileName: `tiktok.mp4` 
    }, { quoted: m });

    await m.react("✅");

  } catch (e) {
    console.error("TikTok Error:", e);
    reply("❌ *API down or invalid link!*");
    await m.react("❌");
  }
});
