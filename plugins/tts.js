const { cmd } = require('../sila')
const googleTTS = require('google-tts-api')
const axios = require('axios')

cmd({
    pattern: "tts",
    react: "☺️",
    desc: "Convert text to voice",
    category: "fun",
    filename: __filename
},
async (conn, mek, m, { from, q, args, reply }) => {
    try {
        // 🟡 MANUAL REACT (VERY IMPORTANT)
        await conn.sendMessage(from, {
            react: { text: "☺️", key: m.key }
        })

        if (!q) {
            return reply(
                "*🗣️ Please provide the text to convert into speech.*\n\n" +
                "*Use:*\n.tts Hello how are you\n\n" +
                "*Urdu ke liye:*\n.tts ur السلام علیکم"
            )
        }

        // 🌍 Language select
        let lang = "en"
        let text = q

        if (args[0] === "ur" || args[0] === "urdu") {
            lang = "ur"
            text = args.slice(1).join(" ")
        }

        if (!text) {
            return reply("*❌ TEXT KHALI HAI 🥺*")
        }

        // 🎙️ Google TTS URL
        const audioUrl = googleTTS.getAudioUrl(text, {
            lang,
            slow: false,
            host: "https://translate.google.com"
        })

        // ⬇️ Download audio
        const res = await axios.get(audioUrl, {
            responseType: "arraybuffer"
        })

        const audioBuffer = Buffer.from(res.data)

        // 📤 SEND AUDIO
        await conn.sendMessage(
            from,
            {
                audio: audioBuffer,
                mimetype: "audio/mp4",
                ptt: false
            },
            { quoted: mek }
        )

    } catch (e) {
        console.log("TTS ERROR:", e)

        await conn.sendMessage(from, {
            react: { text: "😔", key: m.key }
        })

        reply("*❌ VOICE BANANE ME ERROR AYA 🥺*")
    }
})
