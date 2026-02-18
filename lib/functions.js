const { getBuffer, fetchJson } = require('./functions');
const config = require('../config');
const axios = require('axios');

const sms = (conn, m) => {
    if (!m) return m;
    let M = (msg._data === undefined ? m : msg._data);
    
    // Message properties
    m.isGroup = m.key.remoteJid.endsWith('@g.us');
    m.sender = m.isGroup ? (m.key.participant || m.key.remoteJid) : m.key.remoteJid;
    m.senderNumber = m.sender.split('@')[0];
    m.from = m.key.remoteJid;
    m.msg = m.message;
    
    // Message type
    m.type = Object.keys(m.message || {})[0];
    
    // Message text
    if (m.type === 'conversation') {
        m.text = m.message.conversation;
    } else if (m.type === 'extendedTextMessage') {
        m.text = m.message.extendedTextMessage.text;
    } else if (m.type === 'imageMessage') {
        m.text = m.message.imageMessage.caption || '';
    } else if (m.type === 'videoMessage') {
        m.text = m.message.videoMessage.caption || '';
    } else {
        m.text = '';
    }
    
    // Quoted message
    if (m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
        m.quoted = m.message.extendedTextMessage.contextInfo.quotedMessage;
        m.quotedType = Object.keys(m.quoted)[0];
        m.quotedSender = m.message.extendedTextMessage.contextInfo.participant;
        m.quotedFromMe = m.quotedSender === conn.user.id;
    }
    
    // Reply function
    m.reply = async (text, options = {}) => {
        return await conn.sendMessage(m.from, { text }, { quoted: m, ...options });
    };
    
    // React function
    m.react = async (emoji) => {
        return await conn.sendMessage(m.from, { react: { text: emoji, key: m.key } });
    };
    
    // Download function
    m.download = async () => {
        if (!m.msg) return null;
        const stream = await downloadContentFromMessage(m.msg, m.type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    };
    
    return m;
};

// Chatbot function
const chatbot = async (conn, m, q) => {
    try {
        // Get user config
        const { getUserConfigFromMongoDB } = require('./database');
        const userConfig = await getUserConfigFromMongoDB(m.senderNumber);
        
        // Check if chatbot is enabled for this user
        if (userConfig.CHATBOT_ENABLED !== 'true') return null;
        
        // Call AI API
        const response = await axios.get(`${config.CHATBOT_API}${encodeURIComponent(q)}`);
        
        if (response.data && response.data.result) {
            return response.data.result;
        }
        return null;
    } catch (error) {
        console.error('Chatbot error:', error.message);
        return null;
    }
};

module.exports = { sms, chatbot };
