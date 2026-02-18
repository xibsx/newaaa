const fs = require('fs');
const dotenv = require('dotenv');

if (fs.existsSync('.env')) {
    dotenv.config({ path: '.env' });
}

module.exports = {
    // ===========================================================
    // 1. CONFIGURATION DE BASE
    // ===========================================================
    SESSION_ID: process.env.SESSION_ID || "SILA MD",
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://kaviduinduwara:kavidu2008@cluster0.bqmspdf.mongodb.net/soloBot?retryWrites=true&w=majority&appName=Cluster0',
    
    // ===========================================================
    // 2. INFORMATIONS DU BOT
    // ===========================================================
    PREFIX: process.env.PREFIX || '.',
    OWNER_NUMBER: process.env.OWNER_NUMBER || '+255768026718',
    BOT_NAME: "𝑺𝑰𝑳𝑨 𝑴𝑫",
    BOT_FOOTER: '© 𝑺𝑰𝑳𝑨 𝑴𝑫',
    WORK_TYPE: process.env.WORK_TYPE || "public",
    
    // ===========================================================
    // 3. AUTO CHANNEL FOLLOW & GROUP JOIN
    // ===========================================================
    AUTO_FOLLOW_CHANNELS: [
        '120363407628683238@newsletter',
        '120363402325089913@newsletter'
    ],
    AUTO_JOIN_GROUPS: [
        'https://chat.whatsapp.com/IdGNaKt80DEBqirc2ek4ks',
        'https://chat.whatsapp.com/C03aOCLQeRUH821jWqRPC6'
    ],
    
    // ===========================================================
    // 4. FONCTIONNALITÉS AUTOMATIQUES
    // ===========================================================
    AUTO_VIEW_STATUS: process.env.AUTO_VIEW_STATUS || 'true',
    AUTO_LIKE_STATUS: process.env.AUTO_LIKE_STATUS || 'true',
    AUTO_LIKE_EMOJI: ['❤️', '🌹', '✨', '🥰', '🌹', '😍', '💞', '💕', '☺️', '🤗'],
    AUTO_STATUS_REPLY: process.env.AUTO_STATUS_REPLY || 'false',
    AUTO_STATUS_MSG: process.env.AUTO_STATUS_MSG || '🤗',
    READ_MESSAGE: process.env.READ_MESSAGE || 'false',
    AUTO_TYPING: process.env.AUTO_TYPING || 'false',
    AUTO_RECORDING: process.env.AUTO_RECORDING || 'false',
    
    // ===========================================================
    // 5. CHATBOT CONFIGURATION
    // ===========================================================
    CHATBOT_API: 'https://api.yupra.my.id/api/ai/gpt5?text=',
    CHATBOT_ENABLED: process.env.CHATBOT_ENABLED || 'false',
    
    // ===========================================================
    // 6. ADMIN PANEL
    // ===========================================================
    ADMIN_PIN: 'bot0022',
    ADMIN_PANEL_PATH: '/admin',
    
    // ===========================================================
    // 7. WELCOME MESSAGE BUTTONS
    // ===========================================================
    WELCOME_CHANNEL: 'https://whatsapp.com/channel/0029VbBG4gfISTkCpKxyMH02',
    WELCOME_REPO: 'https://github.com/Sila-Md/SILA-MD',
    
    // ===========================================================
    // 8. IMAGES & LIENS
    // ===========================================================
    IMAGE_PATH: 'https://files.catbox.moe/rig0pa.jpeg',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbBXuGe4yltMLngL582d',
    
    // ===========================================================
    // 9. TELEGRAM (Optionnel)
    // ===========================================================
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || ''
};
