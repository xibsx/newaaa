const { cmd } = require('../sila')

cmd({
    pattern: "time",
    react: "☺️",
    desc: "Check current Pakistan time",
    category: "utility",
    filename: __filename
},
async (conn, mek, m, { reply }) => {
    try {
        const now = new Date()
        const time = now.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
            timeZone: "Asia/Karachi"
        })

        reply(`*🇵🇰 PAKISTAN ME ABHI YEH TIME HAI 🥰*\n\n⏰ *${time}*`)

    } catch (e) {
        console.log("TIME ERROR:", e)
        reply("*❌ TIME CHECK KARNE ME ERROR AYA 🥺*")
    }
})
