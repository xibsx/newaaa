const { cmd } = require('../sila')
const axios = require('axios')

cmd({
    pattern: "trt",
    alias: ["translate"],
    react: "🥺",
    desc: "Translate text between languages",
    category: "other",
    use: ".trt <lang> <text>",
    filename: __filename
},
async (conn, mek, m, { q, reply }) => {
    try {

        // 📘 Guide message
        const guide =
`*🌍 TRANSLATE GUIDE 🌍*

*Use:*
.trt ur Hello how are you
.trt en السلام علیکم

*Languages:*
• ur = Urdu
• en = English

*👑 𝑵𝑰𝑶𝑹 𝑴𝑫 WHATSAPP BOT 👑*`

        // ❌ No input
        if (!q) {
            return reply(guide)
        }

        const parts = q.trim().split(/\s+/)

        // ❌ Wrong format
        if (parts.length < 2) {
            return reply(
`*❌ Incorrect format 🥺*

*Use:*
.trt ur Your English text
.trt en Urdu text`
            )
        }

        const lang = parts[0].toLowerCase()
        const text = parts.slice(1).join(" ")

        // 🌐 Translation API
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${lang}`
        const res = await axios.get(url)

        if (!res.data?.responseData?.translatedText) {
            return reply("*❌ Failed to translate 🥺*")
        }

        const translated = res.data.responseData.translatedText

        reply(
`*✅ TRANSLATION COMPLETE ☺️*

*━━━━━━━━━━━━━━━*
${translated}
*━━━━━━━━━━━━━━━*

*👑 𝑵𝑰𝑶𝑹 𝑴𝑫 WHATSAPP BOT 👑*`
        )

    } catch (e) {
        console.log("TRT ERROR:", e)
        reply("*❌ Error translating 🥺*")
    }
})
