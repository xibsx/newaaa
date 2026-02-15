const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    generateForwardMessageContent,
    generateWAMessageFromContent,
    downloadContentFromMessage,
    getContentType,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const config = require('./config');
const events = require('./sila');
const { sms } = require('./lib/msg');
const { 
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber,
    
    // New auth functions
    registerUser,
    loginUser,
    createUserSession,
    validateSessionToken,
    deleteUserSession,
    getUserById,
    getUserWhatsAppNumbers
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const bodyparser = require('body-parser');
const moment = require('moment-timezone');
const session = require('express-session');
const bcrypt = require('bcrypt');

const prefix = config.PREFIX;
const mode = config.MODE;
const router = express.Router();

// Session middleware for web login
const sessionMiddleware = session({
    secret: 'sila-md-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to true if using HTTPS
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
});

// ==============================================================================
// 1. INITIALIZATION & DATABASE
// ==============================================================================

connectdb();

// Stockage en mémoire
const activeSockets = new Map();
const socketCreationTime = new Map();

// Store pour anti-delete et messages
const store = makeInMemoryStore({ 
    logger: pino().child({ level: 'silent', stream: 'store' }) 
});

// Fonctions utilitaires
const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

const getGroupAdmins = (participants) => {
    let admins = [];
    for (let i of participants) {
        if (i.admin == null) continue;
        admins.push(i.id);
    }
    return admins;
}

// Vérification connexion existante
function isNumberAlreadyConnected(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    return activeSockets.has(sanitizedNumber);
}

function getConnectionStatus(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(sanitizedNumber);
    const connectionTime = socketCreationTime.get(sanitizedNumber);
    
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

// Load Plugins
const pluginsDir = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
}

const files = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
console.log(`📦 Loading ${files.length} plugins...`);
for (const file of files) {
    try {
        require(path.join(pluginsDir, file));
    } catch (e) {
        console.error(`❌ Failed to load plugin ${file}:`, e);
    }
}

// ==============================================================================
// 2. HANDLERS SPÉCIFIQUES
// ==============================================================================

async function setupMessageHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const userConfig = await getUserConfigFromMongoDB(number);
        
        if (userConfig.AUTO_TYPING === 'true') {
            try {
                await socket.sendPresenceUpdate('composing', msg.key.remoteJid);
            } catch (error) {
                console.error(`Failed to set typing presence:`, error);
            }
        }
        
        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {
                console.error(`Failed to set recording presence:`, error);
            }
        }
    });
}

async function setupCallHandlers(socket, number) {
    socket.ev.on('call', async (calls) => {
        try {
            const userConfig = await getUserConfigFromMongoDB(number);
            if (userConfig.ANTI_CALL !== 'true') return;

            for (const call of calls) {
                if (call.status !== 'offer') continue;
                const id = call.id;
                const from = call.from;

                await socket.rejectCall(id, from);
                await socket.sendMessage(from, {
                    text: userConfig.REJECT_MSG || '*Please do not call — calls are automatically rejected ☺️*'
                });
                console.log(`CALL REJECTED ${number} from ${from}`);
            }
        } catch (err) {
            console.error(`Anti-call error for ${number}:`, err);
        }
    });
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 3;
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        console.log(`Connection update for ${number}:`, { connection, lastDisconnect });
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            console.log(`Connection closed for ${number}:`, {
                statusCode,
                errorMessage,
                isManualUnlink: statusCode === 401
            });
            
            if (statusCode === 401 || errorMessage?.includes('401')) {
                console.log(`🔐 Manual unlink detected for ${number}, cleaning up...`);
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                
                socket.ev.removeAllListeners();
                return;
            }
            
            const isNormalError = statusCode === 408 || 
                                errorMessage?.includes('QR refs attempts ended');
            
            if (isNormalError) {
                console.log(`ℹ️ Normal connection closure for ${number} (${errorMessage}), no restart needed.`);
                return;
            }
            
            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                console.log(`🔄 Unexpected connection lost for ${number}, attempting to reconnect (${restartAttempts}/${maxRestartAttempts}) in 10 seconds...`);
                
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                socket.ev.removeAllListeners();

                await delay(10000);
                
                try {
                    const mockRes = { 
                        headersSent: false, 
                        send: () => {}, 
                        status: () => mockRes,
                        setHeader: () => {},
                        json: () => {}
                    };
                    await startBot(number, mockRes);
                    console.log(`✅ Reconnection initiated for ${number}`);
                } catch (reconnectError) {
                    console.error(`❌ Reconnection failed for ${number}:`, reconnectError);
                }
            } else {
                console.log(`❌ Max restart attempts reached for ${number}. Manual intervention required.`);
            }
        }
        
        if (connection === 'open') {
            console.log(`✅ Connection established for ${number}`);
            restartAttempts = 0;
        }
    });
}

// ==============================================================================
// 3. FONCTION PRINCIPALE STARTBOT
// ==============================================================================

async function startBot(number, res = null, userId = null) {
    let connectionLockKey;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        const sessionDir = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
        
        if (isNumberAlreadyConnected(sanitizedNumber)) {
            console.log(`⏩ ${sanitizedNumber} is already connected, skipping...`);
            const status = getConnectionStatus(sanitizedNumber);
            
            if (res && !res.headersSent) {
                return res.json({ 
                    status: 'already_connected', 
                    message: 'Number is already connected and active',
                    connectionTime: status.connectionTime,
                    uptime: `${status.uptime} seconds`
                });
            }
            return;
        }
        
        connectionLockKey = `connecting_${sanitizedNumber}`;
        if (global[connectionLockKey]) {
            console.log(`⏩ ${sanitizedNumber} is already in connection process, skipping...`);
            if (res && !res.headersSent) {
                return res.json({ 
                    status: 'connection_in_progress', 
                    message: 'Number is currently being connected'
                });
            }
            return;
        }
        global[connectionLockKey] = true;
        
        const existingSession = await getSessionFromMongoDB(sanitizedNumber);
        
        if (!existingSession) {
            console.log(`🧹 No PostgreSQL session found for ${sanitizedNumber} - requiring NEW pairing`);
            
            if (fs.existsSync(sessionDir)) {
                await fs.remove(sessionDir);
                console.log(`🗑️ Cleaned leftover local session for ${sanitizedNumber}`);
            }
        } else {
            fs.ensureDirSync(sessionDir);
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
            console.log(`🔄 Restored existing session from PostgreSQL for ${sanitizedNumber}`);
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            usePairingCode: !existingSession, 
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Safari'),
            syncFullHistory: false,
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return { conversation: 'Hello' };
            }
        });
        
        socketCreationTime.set(sanitizedNumber, Date.now());
        activeSockets.set(sanitizedNumber, conn);
        store.bind(conn.ev);
        
        setupMessageHandlers(conn, number);
        setupCallHandlers(conn, number);
        setupAutoRestart(conn, number);
        
        conn.decodeJid = jid => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid;
            } else return jid;
        };
        
        conn.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };
        
        if (!existingSession) {
            setTimeout(async () => {
                try {
                    await delay(1500);
                    const code = await conn.requestPairingCode(sanitizedNumber);
                    console.log(`🔑 Pairing Code: ${code}`);
                    if (res && !res.headersSent) {
                        return res.json({ 
                            code: code, 
                            status: 'new_pairing',
                            message: 'New pairing required'
                        });
                    }
                } catch (err) {
                    console.error('❌ Pairing Error:', err.message);
                    if (res && !res.headersSent) {
                        return res.json({ 
                            error: 'Failed to generate pairing code',
                            details: err.message 
                        });
                    }
                }
            }, 3000);
        } else if (res && !res.headersSent) {
            res.json({
                status: 'reconnecting',
                message: 'Attempting to reconnect with existing session data'
            });
        }
        
        conn.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8');
            const creds = JSON.parse(fileContent);
            
            await saveSessionToMongoDB(sanitizedNumber, creds, userId);
            console.log(`💾 Session updated in PostgreSQL for ${sanitizedNumber}`);
        });
        
        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                const userJid = jidNormalizedUser(conn.user.id);
                
                await addNumberToMongoDB(sanitizedNumber);
                
                const connectText = `
               *👑 𝑺𝑰𝑳𝑨 𝑴𝑫 WHATSAPP BOT 👑*
               *🌹 CONNECTED AND WORKING WELL 🌹*
              
              *👑 CLICK HERE FOR HELP 👑*

*👑 DEVELOPER 👑*
*https://akaserein.github.io/Bilal/*

*👑 SUPPORT CHANNEL 👑* 
*https://whatsapp.com/channel/0029VbBXuGe4yltMLngL582d*

*👑 SUPPORT GROUP 👑*
*https://chat.whatsapp.com/BwWffeDwiqe6cjDDklYJ5m*

               
               `;
                
                if (!existingSession) {
                    await conn.sendMessage(userJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: connectText
                    });
                }
                
                console.log(`🎉 ${sanitizedNumber} successfully connected!`);
            }
            
            if (connection === 'close') {
                let reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`❌ Session closed: Logged Out.`);
                }
            }
        });
        
        conn.ev.on('call', async (calls) => {
            try {
                const userConfig = await getUserConfigFromMongoDB(number);
                if (userConfig.ANTI_CALL !== 'true') return;
                
                for (const call of calls) {
                    if (call.status !== 'offer') continue;
                    const id = call.id;
                    const from = call.from;
                    await conn.rejectCall(id, from);
                    await conn.sendMessage(from, { 
                        text: userConfig.REJECT_MSG || config.REJECT_MSG 
                    });
                }
            } catch (err) { 
                console.error("Anti-call error:", err); 
            }
        });
        
        conn.ev.on('messages.update', async (updates) => {
            await handleAntidelete(conn, updates, store);
        });
        
        conn.ev.on('messages.upsert', async (msg) => {
            try {
                let mek = msg.messages[0];
                if (!mek.message) return;
                
                const userConfig = await getUserConfigFromMongoDB(number);
                
                mek.message = (getContentType(mek.message) === 'ephemeralMessage') 
                    ? mek.message.ephemeralMessage.message 
                    : mek.message;
                
                if (mek.message.viewOnceMessageV2) {
                    mek.message = (getContentType(mek.message) === 'ephemeralMessage') 
                        ? mek.message.ephemeralMessage.message 
                        : mek.message;
                }
                
                if (userConfig.READ_MESSAGE === 'true') {
                    await conn.readMessages([mek.key]);
                }
                
                const newsletterJids = ["120363296818107681@newsletter"];
                const newsEmojis = ["❤️", "👍", "😮", "😎", "💀", "💫", "🔥", "👑"];
                if (mek.key && newsletterJids.includes(mek.key.remoteJid)) {
                    try {
                        const serverId = mek.newsletterServerId;
                        if (serverId) {
                            const emoji = newsEmojis[Math.floor(Math.random() * newsEmojis.length)];
                            await conn.newsletterReactMessage(mek.key.remoteJid, serverId.toString(), emoji);
                        }
                    } catch (e) {}
                }
                
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    if (userConfig.AUTO_VIEW_STATUS === "true") await conn.readMessages([mek.key]);
                    
                    if (userConfig.AUTO_LIKE_STATUS === "true") {
                        const jawadlike = await conn.decodeJid(conn.user.id);
                        const emojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await conn.sendMessage(mek.key.remoteJid, {
                            react: { text: randomEmoji, key: mek.key } 
                        }, { statusJidList: [mek.key.participant, jawadlike] });
                    }
                    
                    if (userConfig.AUTO_STATUS_REPLY === "true") {
                        const user = mek.key.participant;
                        const text = userConfig.AUTO_STATUS_MSG || config.AUTO_STATUS_MSG;
                        await conn.sendMessage(user, { 
                            text: text, 
                            react: { text: '👑', key: mek.key } 
                        }, { quoted: mek });
                    }
                    return; 
                }
                
                const m = sms(conn, mek);
                const type = getContentType(mek.message);
                const from = mek.key.remoteJid;
                const quoted = type == 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null ? mek.message.extendedTextMessage.contextInfo.quotedMessage || [] : [];
                const body = (type === 'conversation') ? mek.message.conversation : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';
                
                const isCmd = body.startsWith(config.PREFIX);
                const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : '';
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                const text = q;
                const isGroup = from.endsWith('@g.us');
                
                const sender = mek.key.fromMe ? (conn.user.id.split(':')[0]+'@s.whatsapp.net' || conn.user.id) : (mek.key.participant || mek.key.remoteJid);
                const senderNumber = sender.split('@')[0];
                const botNumber = conn.user.id.split(':')[0];
                const botNumber2 = await jidNormalizedUser(conn.user.id);
                const pushname = mek.pushName || 'User';
                
                const isMe = botNumber.includes(senderNumber);
                const isOwner = config.OWNER_NUMBER.includes(senderNumber) || isMe;
                const isCreator = isOwner;
                
                let groupMetadata = null;
                let groupName = null;
                let participants = null;
                let groupAdmins = null;
                let isBotAdmins = null;
                let isAdmins = null;
                
                if (isGroup) {
                    try {
                        groupMetadata = await conn.groupMetadata(from);
                        groupName = groupMetadata.subject;
                        participants = await groupMetadata.participants;
                        groupAdmins = await getGroupAdmins(participants);
                        isBotAdmins = groupAdmins.includes(botNumber2);
                        isAdmins = groupAdmins.includes(sender);
                    } catch(e) {}
                }
                
                if (userConfig.AUTO_TYPING === 'true') await conn.sendPresenceUpdate('composing', from);
                if (userConfig.AUTO_RECORDING === 'true') await conn.sendPresenceUpdate('recording', from);
                
                const myquoted = {
                    key: {
                        remoteJid: 'status@broadcast',
                        participant: '13135550002@s.whatsapp.net',
                        fromMe: false,
                        id: createSerial(16).toUpperCase()
                    },
                    message: {
                        contactMessage: {
                            displayName: "© 𝑺𝑰𝑳𝑨 𝑴𝑫",
                            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:𝑺𝑰𝑳𝑨 𝑴𝑫\nORG:𝑺𝑰𝑳𝑨 𝑴𝑫;\nTEL;type=CELL;type=VOICE;waid=13135550002:13135550002\nEND:VCARD`,
                            contextInfo: {
                                stanzaId: createSerial(16).toUpperCase(),
                                participant: "0@s.whatsapp.net",
                                quotedMessage: { conversation: "© 𝑺𝑰𝑳𝑨 𝑴𝑫" }
                            }
                        }
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    status: 1,
                    verifiedBizName: "Meta"
                };
                
                const reply = (text) => conn.sendMessage(from, { text: text }, { quoted: myquoted });
                const l = reply;
                
                const cmdNoPrefix = body.toLowerCase().trim();
                if (["send", "sendme", "sand"].includes(cmdNoPrefix)) {
                    if (!mek.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        await conn.sendMessage(from, { text: "*Please reply to a status to use this command 😊*" }, { quoted: mek });
                    } else {
                        try {
                            let qMsg = mek.message.extendedTextMessage.contextInfo.quotedMessage;
                            let mtype = Object.keys(qMsg)[0];
                            const stream = await downloadContentFromMessage(qMsg[mtype], mtype.replace('Message', ''));
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                            
                            let content = {};
                            if (mtype === 'imageMessage') content = { image: buffer, caption: qMsg[mtype].caption };
                            else if (mtype === 'videoMessage') content = { video: buffer, caption: qMsg[mtype].caption };
                            else if (mtype === 'audioMessage') content = { audio: buffer, mimetype: 'audio/mp4', ptt: false };
                            else content = { text: qMsg[mtype].text || qMsg.conversation };
                            
                            if (content) await conn.sendMessage(from, content, { quoted: mek });
                        } catch (e) { console.error(e); }
                    }
                }
                
                const cmdName = isCmd ? body.slice(config.PREFIX.length).trim().split(" ")[0].toLowerCase() : false;
                if (isCmd) {
                    await incrementStats(sanitizedNumber, 'commandsUsed');
                    
                    const cmd = events.commands.find((cmd) => cmd.pattern === (cmdName)) || events.commands.find((cmd) => cmd.alias && cmd.alias.includes(cmdName));
                    if (cmd) {
                        if (config.WORK_TYPE === 'private' && !isOwner) return;
                        if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
                        
                        try {
                            cmd.function(conn, mek, m, {
                                from, quoted: mek, body, isCmd, command, args, q, text, isGroup, sender, 
                                senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, 
                                groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, 
                                reply, config, myquoted
                            });
                        } catch (e) {
                            console.error("[PLUGIN ERROR] " + e);
                        }
                    }
                }
                
                await incrementStats(sanitizedNumber, 'messagesReceived');
                if (isGroup) {
                    await incrementStats(sanitizedNumber, 'groupsInteracted');
                }
                
                events.commands.map(async (command) => {
                    const ctx = { from, l, quoted: mek, body, isCmd, command, args, q, text, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply, config, myquoted };
                    
                    if (body && command.on === "body") command.function(conn, mek, m, ctx);
                    else if (mek.q && command.on === "text") command.function(conn, mek, m, ctx);
                    else if ((command.on === "image" || command.on === "photo") && mek.type === "imageMessage") command.function(conn, mek, m, ctx);
                    else if (command.on === "sticker" && mek.type === "stickerMessage") command.function(conn, mek, m, ctx);
                });
                
            } catch (e) {
                console.error(e);
            }
        });
        
    } catch (err) {
        console.error(err);
        if (res && !res.headersSent) {
            return res.json({ 
                error: 'Internal Server Error', 
                details: err.message 
            });
        }
    } finally {
        if (connectionLockKey) {
            global[connectionLockKey] = false;
        }
    }
}

// ==============================================================================
// 4. ROUTES API
// ==============================================================================

// Authentication middleware
const authMiddleware = async (req, res, next) => {
    const token = req.cookies?.session_token || req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        if (req.path === '/' || req.path === '/login' || req.path === '/register' || req.path.startsWith('/public/')) {
            return next();
        }
        return res.redirect('/');
    }
    
    const result = await validateSessionToken(token);
    if (!result.valid) {
        res.clearCookie('session_token');
        if (req.path === '/' || req.path === '/login' || req.path === '/register') {
            return next();
        }
        return res.redirect('/');
    }
    
    req.user = result.user;
    next();
};

// Apply middleware
router.use(sessionMiddleware);
router.use(bodyparser.json());
router.use(bodyparser.urlencoded({ extended: true }));
router.use(authMiddleware);

// Serve login page
router.get('/', (req, res) => {
    if (req.user) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'pair.html'));
});

// Register API
router.post('/api/register', async (req, res) => {
    const { username, password, email, full_name } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    const result = await registerUser(username, password, email, full_name);
    
    if (result.success) {
        res.json({ success: true, message: 'Registration successful' });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Login API
router.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    const result = await loginUser(username, password);
    
    if (result.success) {
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];
        
        await createUserSession(result.user.id, sessionToken, ip, userAgent);
        
        res.cookie('session_token', sessionToken, {
            maxAge: 7 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        });
        
        res.json({ success: true, user: result.user });
    } else {
        res.status(401).json({ error: result.error });
    }
});

// Logout API
router.post('/api/logout', async (req, res) => {
    const token = req.cookies?.session_token;
    if (token) {
        await deleteUserSession(token);
        res.clearCookie('session_token');
    }
    res.json({ success: true });
});

// Dashboard - Main page
router.get('/dashboard', async (req, res) => {
    if (!req.user) {
        return res.redirect('/');
    }
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API to get user data for dashboard
router.get('/api/user/data', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    
    // Get status for each number
    const numbersWithStatus = userNumbers.map(num => {
        const status = getConnectionStatus(num.number);
        return {
            ...num,
            connectionStatus: status.isConnected ? 'connected' : 'disconnected',
            uptime: status.uptime
        };
    });
    
    res.json({
        user: {
            id: req.user.id,
            username: req.user.username,
            email: req.user.email,
            full_name: req.user.full_name
        },
        numbers: numbersWithStatus
    });
});

// API to update bot config for a number
router.post('/api/bot/:number/config', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { number } = req.params;
    const config = req.body;
    
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    // Verify this number belongs to the user
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    const belongs = userNumbers.some(n => n.number === cleanNumber);
    
    if (!belongs) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    const success = await updateUserConfigInMongoDB(cleanNumber, config);
    
    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// API to disconnect bot
router.post('/api/bot/:number/disconnect', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    // Verify this number belongs to the user
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    const belongs = userNumbers.some(n => n.number === cleanNumber);
    
    if (!belongs) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (activeSockets.has(cleanNumber)) {
        const socket = activeSockets.get(cleanNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
    }
    
    await deleteSessionFromMongoDB(cleanNumber);
    
    res.json({ success: true });
});

// API to get bot config
router.get('/api/bot/:number/config', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    // Verify this number belongs to the user
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    const belongs = userNumbers.some(n => n.number === cleanNumber);
    
    if (!belongs) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    const config = await getUserConfigFromMongoDB(cleanNumber);
    
    res.json(config);
});

// Original pairing route (updated to save with user ID)
router.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    
    const userId = req.user ? req.user.id : null;
    await startBot(number, res, userId);
});

// Status route
router.get('/status', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        const activeConnections = Array.from(activeSockets.keys()).map(num => {
            const status = getConnectionStatus(num);
            return {
                number: num,
                status: 'connected',
                connectionTime: status.connectionTime,
                uptime: `${status.uptime} seconds`
            };
        });
        
        return res.json({
            totalActive: activeSockets.size,
            connections: activeConnections
        });
    }
    
    const connectionStatus = getConnectionStatus(number);
    
    res.json({
        number: number,
        isConnected: connectionStatus.isConnected,
        connectionTime: connectionStatus.connectionTime,
        uptime: `${connectionStatus.uptime} seconds`,
        message: connectionStatus.isConnected 
            ? 'Number is actively connected' 
            : 'Number is not connected'
    });
});

// Disconnect route
router.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).json({ error: 'Number parameter is required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    if (!activeSockets.has(sanitizedNumber)) {
        return res.status(404).json({ 
            error: 'Number not found in active connections' 
        });
    }

    try {
        const socket = activeSockets.get(sanitizedNumber);
        
        await socket.ws.close();
        socket.ev.removeAllListeners();
        
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        await removeNumberFromMongoDB(sanitizedNumber);
        await deleteSessionFromMongoDB(sanitizedNumber);
        
        console.log(`✅ Manually disconnected ${sanitizedNumber}`);
        
        res.json({ 
            status: 'success', 
            message: 'Number disconnected successfully' 
        });
        
    } catch (error) {
        console.error(`Error disconnecting ${sanitizedNumber}:`, error);
        res.status(500).json({ 
            error: 'Failed to disconnect number' 
        });
    }
});

// Active numbers route
router.get('/active', (req, res) => {
    res.json({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

// Ping route
router.get('/ping', (req, res) => {
    res.json({
        status: 'active',
        message: '𝑺𝑰𝑳𝑨 𝑴𝑫 is running',
        activeSessions: activeSockets.size,
        database: 'PostgreSQL Integrated'
    });
});

// Connect all route
router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) {
            return res.status(404).json({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { 
                headersSent: false, 
                json: () => {}, 
                status: () => mockRes 
            };
            await startBot(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
            await delay(1000);
        }

        res.json({
            status: 'success',
            total: numbers.length,
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).json({ error: 'Failed to connect all bots' });
    }
});

// Update config route
router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).json({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).json({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).json({ error: 'No active session found for this number' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    await saveOTPToMongoDB(sanitizedNumber, otp, newConfig);

    try {
        const userJid = jidNormalizedUser(socket.user.id);
        await socket.sendMessage(userJid, {
            text: `*🔐 CONFIGURATION UPDATE*\n\nYour OTP: *${otp}*\nValid for 5 minutes\n\nUse: /verify-otp ${otp}`
        });
        
        res.json({ 
            status: 'otp_sent', 
            message: 'OTP sent to your number' 
        });
    } catch (error) {
        console.error('Failed to send OTP:', error);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// Verify OTP route
router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).json({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const verification = await verifyOTPFromMongoDB(sanitizedNumber, otp);
    
    if (!verification.valid) {
        return res.status(400).json({ error: verification.error });
    }

    try {
        await updateUserConfigInMongoDB(sanitizedNumber, verification.config);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                text: `*✅ CONFIG UPDATED*\n\nYour configuration has been successfully updated!\n\nChanges saved in PostgreSQL.`
            });
        }
        res.json({ 
            status: 'success', 
            message: 'Config updated successfully in PostgreSQL' 
        });
    } catch (error) {
        console.error('Failed to update config in PostgreSQL:', error);
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// Stats route
router.get('/stats', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        return res.status(400).json({ error: 'Number is required' });
    }
    
    try {
        const stats = await getStatsForNumber(number);
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const connectionStatus = getConnectionStatus(sanitizedNumber);
        
        res.json({
            number: sanitizedNumber,
            connectionStatus: connectionStatus.isConnected ? 'Connected' : 'Disconnected',
            uptime: connectionStatus.uptime,
            stats: stats
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

// ==============================================================================
// 5. RECONNEXION AUTOMATIQUE AU DÉMARRAGE
// ==============================================================================

async function autoReconnectFromPostgreSQL() {
    try {
        console.log('🔁 Attempting auto-reconnect from PostgreSQL...');
        const numbers = await getAllNumbersFromMongoDB();
        
        if (numbers.length === 0) {
            console.log('ℹ️ No numbers found in PostgreSQL for auto-reconnect');
            return;
        }
        
        console.log(`📊 Found ${numbers.length} numbers in PostgreSQL`);
        
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                console.log(`🔁 Reconnecting: ${number}`);
                const mockRes = { 
                    headersSent: false, 
                    json: () => {}, 
                    status: () => mockRes 
                };
                await startBot(number, mockRes);
                await delay(2000);
            } else {
                console.log(`✅ Already connected: ${number}`);
            }
        }
        
        console.log('✅ Auto-reconnect completed');
    } catch (error) {
        console.error('❌ autoReconnectFromPostgreSQL error:', error.message);
    }
}

// Démarrer reconnexion automatique après 3 secondes
setTimeout(() => {
    autoReconnectFromPostgreSQL();
}, 3000);

// ==============================================================================
// 6. CLEANUP ON EXIT
// ==============================================================================

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) {
        fs.emptyDirSync(sessionDir);
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    if (process.env.PM2_NAME) {
        const { exec } = require('child_process');
        exec(`pm2 restart ${process.env.PM2_NAME}`);
    }
});

module.exports = router;
