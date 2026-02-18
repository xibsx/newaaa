const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
    makeInMemoryStore,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');

const config = require('./config');
const events = require('./sila');
const { sms, chatbot } = require('./lib/msg');
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
    registerUser,
    loginUser,
    createUserSession,
    validateSessionToken,
    deleteUserSession,
    getUserById,
    getUserWhatsAppNumbers,
    getAllUsers,
    getAllSessions,
    adminDeleteSession,
    adminDeleteUser
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');
const { getBuffer, getGroupAdmins, getRandom, runtime, fetchJson } = require('./lib/functions');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const bodyparser = require('body-parser');
const moment = require('moment-timezone');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================================================================
// 1. CORS CONFIGURATION - Allow all origins
// ==============================================================================
const corsOptions = {
    origin: function (origin, callback) {
        // Allow all origins
        callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Cookie'],
    credentials: true,
    optionsSuccessStatus: 200,
    preflightContinue: false,
    maxAge: 86400 // 24 hours
};

// Apply CORS globally
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Additional CORS headers middleware
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.header('Access-Control-Allow-Origin', origin);
    } else {
        res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// ==============================================================================
// 2. INITIALIZATION & DATABASE
// ==============================================================================

connectdb();

// Stockage en mémoire
const activeSockets = new Map();
const socketCreationTime = new Map();
const pairingCodes = new Map(); // Store pairing codes temporarily

// Store pour anti-delete
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });

// ==============================================================================
// 3. UTILITY FUNCTIONS
// ==============================================================================

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

function isNumberAlreadyConnected(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    return activeSockets.has(sanitizedNumber);
}

function getConnectionStatus(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(sanitizedNumber);
    const connectionTime = socketCreationTime.get(sanitizedNumber);
    const socket = activeSockets.get(sanitizedNumber);
    
    let connectionState = 'disconnected';
    if (socket && socket.user) {
        connectionState = 'connected';
    }
    
    return {
        isConnected,
        connectionState,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0,
        lastSeen: connectionTime ? new Date(connectionTime).toISOString() : null
    };
}

// ==============================================================================
// 4. SESSION DELETION ENDPOINT - /bot/delsession/:number
// ==============================================================================

/**
 * @route   DELETE /bot/delsession/:number
 * @route   POST /bot/delsession/:number
 * @desc    Delete bot session completely from system (disconnect + remove from DB + delete files)
 * @access  Public (with token) or Private (with user login)
 */
app.all('/bot/delsession/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const { token } = req.method === 'GET' ? req.query : req.body;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        console.log(`[SESSION DELETE] Request to delete session for ${cleanNumber}`);
        console.log(`[SESSION DELETE] Method: ${req.method}`);
        console.log(`[SESSION DELETE] Token provided: ${token ? 'Yes' : 'No'}`);
        
        // Verify authentication (either user login or valid token)
        let isAuthorized = false;
        let userId = null;
        let username = 'unknown';
        
        // Check if user is logged in via cookie
        if (req.user) {
            isAuthorized = true;
            userId = req.user.id;
            username = req.user.username;
            console.log(`[SESSION DELETE] Authorized via user login: ${username}`);
        }
        
        // Check if valid token is provided
        const validToken = process.env.API_SECRET_TOKEN || 'sila-md-secret-2024';
        if (token && token === validToken) {
            isAuthorized = true;
            console.log(`[SESSION DELETE] Authorized via API token`);
        }
        
        if (!isAuthorized) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Valid token required or login required'
            });
        }
        
        // Check if user owns this bot (if authenticated via cookie)
        if (req.user && !token) {
            const userNumbers = await getUserWhatsAppNumbers(req.user.id);
            const botOwned = userNumbers.some(n => n.number === cleanNumber);
            
            if (!botOwned) {
                return res.status(403).json({
                    success: false,
                    error: 'Forbidden',
                    message: 'You do not own this bot session'
                });
            }
        }
        
        // Result object
        const result = {
            success: true,
            number: cleanNumber,
            disconnected: false,
            session_deleted: false,
            files_deleted: false,
            details: {}
        };
        
        // 1. Disconnect if connected
        if (activeSockets.has(cleanNumber)) {
            try {
                const socket = activeSockets.get(cleanNumber);
                
                // Send goodbye message
                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        text: `🔴 *Session Deleted*\n\n` +
                              `📱 *Number:* ${cleanNumber}\n` +
                              `👤 *Action by:* ${username}\n` +
                              `⏰ *Time:* ${moment().format('YYYY-MM-DD HH:mm:ss')}\n\n` +
                              `_This session has been deleted from the system_`
                    });
                } catch (e) {
                    console.log(`[SESSION DELETE] Could not send goodbye message: ${e.message}`);
                }
                
                // Close connection
                await socket.ws.close();
                socket.ev.removeAllListeners();
                
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
                pairingCodes.delete(cleanNumber);
                
                result.disconnected = true;
                result.details.disconnected_at = new Date().toISOString();
                
                console.log(`[SESSION DELETE] Disconnected bot ${cleanNumber}`);
            } catch (e) {
                console.error(`[SESSION DELETE] Error disconnecting: ${e.message}`);
                result.details.disconnect_error = e.message;
            }
        } else {
            result.details.already_disconnected = true;
        }
        
        // 2. Delete session from MongoDB
        try {
            const dbResult = await deleteSessionFromMongoDB(cleanNumber);
            result.session_deleted = true;
            result.details.db_deleted_at = new Date().toISOString();
            console.log(`[SESSION DELETE] Deleted session from MongoDB for ${cleanNumber}`);
        } catch (e) {
            console.error(`[SESSION DELETE] Error deleting from MongoDB: ${e.message}`);
            result.details.db_error = e.message;
        }
        
        // 3. Remove from user's numbers in MongoDB
        try {
            await removeNumberFromMongoDB(cleanNumber);
            result.details.removed_from_user = true;
        } catch (e) {
            console.log(`[SESSION DELETE] Error removing from user: ${e.message}`);
        }
        
        // 4. Delete session files from disk
        try {
            const sessionDir = path.join(__dirname, 'session', `session_${cleanNumber}`);
            
            if (fs.existsSync(sessionDir)) {
                await fs.remove(sessionDir);
                result.files_deleted = true;
                result.details.files_deleted_at = new Date().toISOString();
                console.log(`[SESSION DELETE] Deleted session files for ${cleanNumber}`);
            } else {
                result.details.files_not_found = true;
            }
        } catch (e) {
            console.error(`[SESSION DELETE] Error deleting files: ${e.message}`);
            result.details.files_error = e.message;
        }
        
        // 5. Also try to delete any creds.json in root session folder
        try {
            const rootCredsPath = path.join(__dirname, 'session', 'creds.json');
            if (fs.existsSync(rootCredsPath)) {
                const content = fs.readFileSync(rootCredsPath, 'utf8');
                if (content.includes(cleanNumber)) {
                    await fs.remove(rootCredsPath);
                    console.log(`[SESSION DELETE] Deleted root creds.json`);
                }
            }
        } catch (e) {
            // Ignore
        }
        
        console.log(`[SESSION DELETE] Completed for ${cleanNumber}`);
        
        res.json({
            success: true,
            message: 'Session deleted successfully',
            number: cleanNumber,
            result: result,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[SESSION DELETE ERROR]', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete session',
            message: error.message
        });
    }
});

// ==============================================================================
// 5. BULK SESSION DELETION - Delete multiple sessions at once
// ==============================================================================

/**
 * @route   POST /bot/delsessions
 * @desc    Delete multiple bot sessions at once
 * @access  Private/Token
 */
app.post('/bot/delsessions', async (req, res) => {
    try {
        const { numbers, token } = req.body;
        const validToken = process.env.API_SECRET_TOKEN || 'sila-md-secret-2024';
        
        // Verify authorization
        let isAuthorized = false;
        
        if (req.user) {
            isAuthorized = true;
        } else if (token && token === validToken) {
            isAuthorized = true;
        }
        
        if (!isAuthorized) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }
        
        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Please provide an array of numbers'
            });
        }
        
        const results = [];
        
        for (const number of numbers) {
            const cleanNumber = number.replace(/[^0-9]/g, '');
            
            const numberResult = {
                number: cleanNumber,
                success: false,
                disconnected: false,
                session_deleted: false,
                files_deleted: false
            };
            
            try {
                // Disconnect if connected
                if (activeSockets.has(cleanNumber)) {
                    const socket = activeSockets.get(cleanNumber);
                    await socket.ws.close();
                    socket.ev.removeAllListeners();
                    activeSockets.delete(cleanNumber);
                    socketCreationTime.delete(cleanNumber);
                    pairingCodes.delete(cleanNumber);
                    numberResult.disconnected = true;
                }
                
                // Delete from MongoDB
                await deleteSessionFromMongoDB(cleanNumber);
                await removeNumberFromMongoDB(cleanNumber);
                numberResult.session_deleted = true;
                
                // Delete files
                const sessionDir = path.join(__dirname, 'session', `session_${cleanNumber}`);
                if (fs.existsSync(sessionDir)) {
                    await fs.remove(sessionDir);
                    numberResult.files_deleted = true;
                }
                
                numberResult.success = true;
                
            } catch (e) {
                numberResult.error = e.message;
            }
            
            results.push(numberResult);
        }
        
        res.json({
            success: true,
            message: `Processed ${results.length} sessions`,
            results: results,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==============================================================================
// 6. DELETE ALL SESSIONS (Admin only)
// ==============================================================================

/**
 * @route   DELETE /admin/delsessions/all
 * @desc    Delete ALL bot sessions (Admin only)
 * @access  Admin
 */
app.delete('/admin/delsessions/all', adminMiddleware, async (req, res) => {
    try {
        const { confirm } = req.query;
        
        if (confirm !== 'YES_DELETE_ALL') {
            return res.status(400).json({
                success: false,
                error: 'Confirmation required',
                message: 'Add ?confirm=YES_DELETE_ALL to confirm'
            });
        }
        
        console.log('[ADMIN] Deleting ALL sessions...');
        
        // Disconnect all active sockets
        const disconnectedBots = [];
        for (const [number, socket] of activeSockets) {
            try {
                await socket.ws.close();
                socket.ev.removeAllListeners();
                disconnectedBots.push(number);
            } catch (e) {
                console.error(`Error disconnecting ${number}:`, e);
            }
        }
        
        // Clear maps
        activeSockets.clear();
        socketCreationTime.clear();
        pairingCodes.clear();
        
        // Delete all sessions from MongoDB
        const allSessions = await getAllSessions();
        for (const session of allSessions) {
            await deleteSessionFromMongoDB(session.number);
        }
        
        // Delete all session folders
        const sessionDir = path.join(__dirname, 'session');
        if (fs.existsSync(sessionDir)) {
            const files = await fs.readdir(sessionDir);
            for (const file of files) {
                if (file.startsWith('session_')) {
                    await fs.remove(path.join(sessionDir, file));
                }
            }
        }
        
        res.json({
            success: true,
            message: 'All sessions deleted successfully',
            disconnected: disconnectedBots.length,
            total_sessions: allSessions.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==============================================================================
// 7. API INFORMATION ENDPOINT (Updated with session delete endpoints)
// ==============================================================================

app.get('/api/info', (req, res) => {
    res.json({
        success: true,
        name: 'SILA MD API',
        version: '3.1.0',
        description: 'WhatsApp Bot API with CORS support',
        author: 'SILA MD',
        endpoints: {
            // Session Management
            delete_session: {
                method: 'DELETE/POST',
                url: '/bot/delsession/:number',
                params: { 
                    number: 'Phone number',
                    token: 'API token (optional if logged in)' 
                },
                description: 'Delete bot session completely (disconnect + remove from DB + delete files)'
            },
            delete_multiple: {
                method: 'POST',
                url: '/bot/delsessions',
                body: { numbers: ['255...', '254...'], token: 'API_TOKEN' },
                description: 'Delete multiple bot sessions at once'
            },
            delete_all_admin: {
                method: 'DELETE',
                url: '/admin/delsessions/all?confirm=YES_DELETE_ALL',
                description: 'Delete ALL sessions (Admin only)'
            },
            // Other endpoints
            pair: {
                method: 'GET',
                url: '/api/pair',
                params: { number: 'Phone number (e.g., 255768026718)' },
                description: 'Generate pairing code for WhatsApp bot'
            },
            status: {
                method: 'GET',
                url: '/api/status/:number',
                description: 'Check bot connection status'
            },
            bots: {
                method: 'GET',
                url: '/api/bots',
                description: 'List all connected bots'
            },
            send: {
                method: 'POST',
                url: '/api/send/:number',
                body: { to: 'recipient', message: 'text', token: 'API_TOKEN' },
                description: 'Send message through bot (requires token)'
            },
            disconnect: {
                method: 'POST',
                url: '/api/disconnect/:number',
                description: 'Disconnect a bot'
            },
            logout: {
                method: 'POST',
                url: '/api/bot/:number/logout',
                description: 'Logout user\'s bot'
            },
            health: {
                method: 'GET',
                url: '/health',
                description: 'Server health check'
            }
        },
        cors: 'enabled for all origins',
        timestamp: new Date().toISOString(),
        server_time: moment().tz('Africa/Dar_es_Salaam').format('YYYY-MM-DD HH:mm:ss')
    });
});

// ==============================================================================
// 8. HEALTH CHECK ENDPOINT
// ==============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connected_bots: activeSockets.size,
        message: 'SILA MD API is running',
        cors: 'enabled'
    });
});

// ==============================================================================
// 9. PUBLIC API ENDPOINTS
// ==============================================================================

// Public API endpoint for pairing
app.get('/api/pair', async (req, res) => {
    try {
        const { number } = req.query;
        const origin = req.headers.origin || 'unknown';
        
        console.log(`[API] Pair request from ${origin} for number: ${number}`);
        
        if (!number) {
            return res.status(400).json({
                success: false,
                error: 'Number is required',
                example: '/api/pair?number=255768026718'
            });
        }

        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        if (cleanNumber.length < 10 || cleanNumber.length > 15) {
            return res.status(400).json({
                success: false,
                error: 'Invalid number format. Must be between 10-15 digits',
                provided: number,
                cleaned: cleanNumber
            });
        }

        // Check if already connected
        if (isNumberAlreadyConnected(cleanNumber)) {
            const status = getConnectionStatus(cleanNumber);
            return res.json({
                success: true,
                status: 'already_connected',
                message: 'Bot is already connected',
                number: cleanNumber,
                connection_info: status,
                note: 'Use /api/status/' + cleanNumber + ' for more details'
            });
        }

        // Check if pairing already in progress
        if (pairingCodes.has(cleanNumber)) {
            const existingCode = pairingCodes.get(cleanNumber);
            return res.json({
                success: true,
                status: 'pairing_in_progress',
                message: 'Pairing already initiated',
                number: cleanNumber,
                code: existingCode,
                expires_in: '5 minutes'
            });
        }

        // Start bot in background
        startBot(cleanNumber, null);
        
        // Wait for pairing code (max 10 seconds)
        let attempts = 0;
        const maxAttempts = 20;
        
        while (attempts < maxAttempts) {
            if (pairingCodes.has(cleanNumber)) {
                const code = pairingCodes.get(cleanNumber);
                return res.json({
                    success: true,
                    status: 'success',
                    message: 'Pairing code generated successfully',
                    number: cleanNumber,
                    code: code,
                    instructions: 'Open WhatsApp > Linked Devices > Link a Device > Pair with phone number',
                    expires_in: '5 minutes',
                    timestamp: new Date().toISOString()
                });
            }
            await delay(500);
            attempts++;
        }

        // If no code after timeout
        res.json({
            success: true,
            status: 'processing',
            message: 'Pairing initiated. Check console for code or try again in a few seconds.',
            number: cleanNumber,
            note: 'The code will appear here once generated'
        });

    } catch (error) {
        console.error('[API] Pair error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Public API endpoint to check bot status
app.get('/api/status/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        const status = getConnectionStatus(cleanNumber);
        const session = await getSessionFromMongoDB(cleanNumber);
        
        res.json({
            success: true,
            number: cleanNumber,
            ...status,
            has_session: !!session,
            session_age: session ? moment(session.created_at).fromNow() : null,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// Public API endpoint to get all connected bots
app.get('/api/bots', async (req, res) => {
    try {
        const connectedBots = [];
        
        for (const [number, socket] of activeSockets) {
            const status = getConnectionStatus(number);
            connectedBots.push({
                number,
                ...status,
                pushName: socket.user?.name || 'Unknown'
            });
        }
        
        // Get all sessions from DB
        const allSessions = await getAllSessions();
        
        res.json({
            success: true,
            total_connected: connectedBots.length,
            total_sessions: allSessions.length,
            connected: connectedBots,
            all_sessions: allSessions.map(s => ({
                number: s.number,
                user: s.user_id?.username || 'Unknown',
                last_connected: s.last_connected,
                status: isNumberAlreadyConnected(s.number) ? 'connected' : 'disconnected'
            })),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Public API endpoint to send message (requires token)
app.post('/api/send/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const { to, message, token } = req.body;
        
        // Verify token (you should store this in env)
        const validToken = process.env.API_SECRET_TOKEN || 'sila-md-secret-2024';
        
        if (token !== validToken) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized - Invalid token'
            });
        }
        
        if (!to || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: to, message'
            });
        }
        
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        if (!activeSockets.has(cleanNumber)) {
            return res.status(404).json({
                success: false,
                error: 'Bot not connected',
                number: cleanNumber
            });
        }
        
        const socket = activeSockets.get(cleanNumber);
        
        // Format recipient number
        let recipientJid = to;
        if (!to.includes('@')) {
            recipientJid = to.includes('g.us') ? to : `${to}@s.whatsapp.net`;
        }
        
        await socket.sendMessage(recipientJid, {
            text: message
        });
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            to: recipientJid,
            from: cleanNumber,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Public API endpoint to disconnect bot
app.post('/api/disconnect/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const { token } = req.body;
        
        // Verify token
        const validToken = process.env.API_SECRET_TOKEN || 'sila-md-secret-2024';
        
        if (token !== validToken) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized - Invalid token'
            });
        }
        
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        if (activeSockets.has(cleanNumber)) {
            const socket = activeSockets.get(cleanNumber);
            await socket.ws.close();
            socket.ev.removeAllListeners();
            activeSockets.delete(cleanNumber);
            socketCreationTime.delete(cleanNumber);
            pairingCodes.delete(cleanNumber);
            
            res.json({
                success: true,
                message: 'Bot disconnected successfully',
                number: cleanNumber,
                timestamp: new Date().toISOString()
            });
        } else {
            res.json({
                success: false,
                message: 'Bot not connected',
                number: cleanNumber
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Keep the original /code endpoint for backward compatibility
app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    
    const userId = req.user ? req.user.id : null;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    if (isNumberAlreadyConnected(cleanNumber)) {
        return res.json({ 
            status: 'already_connected',
            number: cleanNumber
        });
    }
    
    // Start bot in background
    startBot(cleanNumber, userId);
    
    // Wait for code
    let attempts = 0;
    while (attempts < 10) {
        if (pairingCodes.has(cleanNumber)) {
            return res.json({ 
                status: 'success',
                code: pairingCodes.get(cleanNumber),
                number: cleanNumber
            });
        }
        await delay(500);
        attempts++;
    }
    
    res.json({ 
        status: 'connecting', 
        message: 'Connection initiated',
        number: cleanNumber
    });
});

// ==============================================================================
// 10. BOT LOGOUT/DISCONNECT ENDPOINTS
// ==============================================================================

/**
 * @route   POST /api/bot/:number/logout
 * @desc    Disconnect and logout a specific bot (User authenticated)
 * @access  Private (Requires user login)
 */
app.post('/api/bot/:number/logout', async (req, res) => {
    try {
        // Check if user is authenticated
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'Not authenticated',
                message: 'Please login first'
            });
        }

        const { number } = req.params;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        console.log(`[LOGOUT] User ${req.user.username} attempting to disconnect bot ${cleanNumber}`);

        // Verify that the bot belongs to this user
        const userNumbers = await getUserWhatsAppNumbers(req.user.id);
        const botOwned = userNumbers.some(n => n.number === cleanNumber);
        
        if (!botOwned) {
            return res.status(403).json({
                success: false,
                error: 'Not authorized',
                message: 'This bot does not belong to you'
            });
        }

        // Check if bot is connected
        if (!activeSockets.has(cleanNumber)) {
            return res.json({
                success: true,
                message: 'Bot is already disconnected',
                number: cleanNumber,
                status: 'disconnected'
            });
        }

        // Get the socket and disconnect
        const socket = activeSockets.get(cleanNumber);
        
        // Send logout message to the bot's own chat (optional)
        try {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                text: `🔴 *Bot Disconnected*\n\n` +
                      `📱 *Number:* ${cleanNumber}\n` +
                      `👤 *User:* ${req.user.username}\n` +
                      `⏰ *Time:* ${moment().format('YYYY-MM-DD HH:mm:ss')}\n\n` +
                      `_Bot has been manually disconnected_`
            });
        } catch (e) {
            console.log('Could not send disconnect message:', e.message);
        }

        // Close the WebSocket connection
        await socket.ws.close();
        
        // Remove all event listeners
        socket.ev.removeAllListeners();
        
        // Remove from active sockets
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
        pairingCodes.delete(cleanNumber);
        
        // Delete session from MongoDB
        await deleteSessionFromMongoDB(cleanNumber);
        
        // Remove from user's numbers in MongoDB
        await removeNumberFromMongoDB(cleanNumber);

        console.log(`✅ Bot ${cleanNumber} disconnected successfully by user ${req.user.username}`);

        res.json({
            success: true,
            message: 'Bot disconnected successfully',
            number: cleanNumber,
            status: 'disconnected',
            disconnected_at: new Date().toISOString(),
            user: req.user.username
        });

    } catch (error) {
        console.error('[LOGOUT ERROR]', error);
        res.status(500).json({
            success: false,
            error: 'Failed to disconnect bot',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/logout-bot/:number
 * @desc    Quick disconnect a bot (Public - No auth required)
 * @access  Public
 */
app.get('/api/logout-bot/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const { token } = req.query;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        // Optional: Verify token for security
        const validToken = process.env.API_SECRET_TOKEN || 'sila-md-secret-2024';
        
        if (token !== validToken) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Invalid or missing token'
            });
        }

        console.log(`[PUBLIC LOGOUT] Disconnecting bot ${cleanNumber}`);

        if (!activeSockets.has(cleanNumber)) {
            return res.json({
                success: true,
                message: 'Bot is already disconnected',
                number: cleanNumber
            });
        }

        const socket = activeSockets.get(cleanNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
        pairingCodes.delete(cleanNumber);
        
        // Optional: Don't delete session from DB for quick reconnect
        // await deleteSessionFromMongoDB(cleanNumber);

        res.json({
            success: true,
            message: 'Bot disconnected successfully',
            number: cleanNumber,
            status: 'disconnected'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * @route   POST /api/user/logout-all-bots
 * @desc    Disconnect ALL bots belonging to the authenticated user
 * @access  Private
 */
app.post('/api/user/logout-all-bots', async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'Not authenticated'
            });
        }

        const userNumbers = await getUserWhatsAppNumbers(req.user.id);
        const disconnectedBots = [];
        const failedBots = [];

        for (const bot of userNumbers) {
            const number = bot.number;
            
            if (activeSockets.has(number)) {
                try {
                    const socket = activeSockets.get(number);
                    await socket.ws.close();
                    socket.ev.removeAllListeners();
                    
                    activeSockets.delete(number);
                    socketCreationTime.delete(number);
                    pairingCodes.delete(number);
                    
                    await deleteSessionFromMongoDB(number);
                    await removeNumberFromMongoDB(number);
                    
                    disconnectedBots.push(number);
                    console.log(`✅ Disconnected bot ${number} for user ${req.user.username}`);
                } catch (e) {
                    failedBots.push({ number, error: e.message });
                }
            }
        }

        res.json({
            success: true,
            message: `Disconnected ${disconnectedBots.length} bots`,
            disconnected: disconnectedBots,
            failed: failedBots,
            total: userNumbers.length
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/**
 * @route   POST /admin/api/bot/:number/force-logout
 * @desc    Force disconnect any bot (Admin only)
 * @access  Admin
 */
app.post('/admin/api/bot/:number/force-logout', adminMiddleware, async (req, res) => {
    try {
        const { number } = req.params;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        console.log(`[ADMIN] Force disconnecting bot ${cleanNumber}`);

        const result = {
            success: true,
            number: cleanNumber,
            was_connected: false,
            session_deleted: false
        };

        // Disconnect if connected
        if (activeSockets.has(cleanNumber)) {
            const socket = activeSockets.get(cleanNumber);
            await socket.ws.close();
            socket.ev.removeAllListeners();
            
            activeSockets.delete(cleanNumber);
            socketCreationTime.delete(cleanNumber);
            pairingCodes.delete(cleanNumber);
            
            result.was_connected = true;
        }

        // Delete session from database
        const sessionDeleted = await adminDeleteSession(cleanNumber);
        result.session_deleted = sessionDeleted;

        res.json({
            ...result,
            message: 'Bot force disconnected successfully',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * @route   POST /api/logout-by-token
 * @desc    Disconnect bot using API token (No login required)
 * @access  Public (Token based)
 */
app.post('/api/logout-by-token', async (req, res) => {
    try {
        const { number, token } = req.body;
        
        if (!number || !token) {
            return res.status(400).json({
                success: false,
                error: 'Number and token are required'
            });
        }

        // Verify token
        const validToken = process.env.API_SECRET_TOKEN || 'sila-md-secret-2024';
        
        if (token !== validToken) {
            return res.status(401).json({
                success: false,
                error: 'Invalid token'
            });
        }

        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (!activeSockets.has(cleanNumber)) {
            return res.json({
                success: true,
                message: 'Bot already disconnected',
                number: cleanNumber
            });
        }

        const socket = activeSockets.get(cleanNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
        pairingCodes.delete(cleanNumber);

        // Optional: Keep session for reconnection
        // await deleteSessionFromMongoDB(cleanNumber);

        res.json({
            success: true,
            message: 'Bot disconnected successfully',
            number: cleanNumber,
            disconnected_at: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * @route   GET /api/bot/:number/logout-status
 * @desc    Check if a bot is logged out/disconnected
 * @access  Public
 */
app.get('/api/bot/:number/logout-status', async (req, res) => {
    try {
        const { number } = req.params;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        const isConnected = activeSockets.has(cleanNumber);
        const session = await getSessionFromMongoDB(cleanNumber);
        
        res.json({
            success: true,
            number: cleanNumber,
            is_connected: isConnected,
            is_logged_out: !isConnected,
            has_session: !!session,
            status: isConnected ? 'connected' : 'disconnected',
            last_activity: socketCreationTime.get(cleanNumber) || null
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// ==============================================================================
// 11. MIDDLEWARE SETUP
// ==============================================================================

app.use(bodyparser.json({ limit: '50mb' }));
app.use(bodyparser.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${moment().format('YYYY-MM-DD HH:mm:ss')}] ${req.method} ${req.url} - Origin: ${req.headers.origin || 'same-origin'}`);
    next();
});

// Auth middleware
const authMiddleware = async (req, res, next) => {
    // Skip auth for public API endpoints
    if (req.path.startsWith('/api/') || req.path === '/code' || req.path === '/health' || req.path.startsWith('/bot/')) {
        return next();
    }
    
    const token = req.cookies?.session_token;
    
    if (!token) {
        if (req.path === '/' || req.path === '/login' || req.path === '/register' || req.path.startsWith('/admin')) {
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

app.use(authMiddleware);

// ==============================================================================
// 12. WEB ROUTES
// ==============================================================================

// Serve HTML pages
app.get('/', (req, res) => {
    if (req.user) {
        res.sendFile(path.join(__dirname, 'dashboard.html'));
    } else {
        res.sendFile(path.join(__dirname, 'pair.html'));
    }
});

// ==============================================================================
// 13. USER AUTHENTICATION ROUTES
// ==============================================================================

app.post('/api/register', async (req, res) => {
    const { username, password, email, full_name } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await registerUser(username, password, email, full_name);
    res.json(result);
});

app.post('/api/login', async (req, res) => {
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
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production'
        });
    }
    res.json(result);
});

app.post('/api/logout', async (req, res) => {
    const token = req.cookies?.session_token;
    if (token) {
        await deleteUserSession(token);
        res.clearCookie('session_token');
    }
    res.json({ success: true });
});

app.get('/api/user/data', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const numbers = await getUserWhatsAppNumbers(req.user.id);
    const numbersWithStatus = numbers.map(num => ({
        ...num.toObject(),
        connectionStatus: isNumberAlreadyConnected(num.number) ? 'connected' : 'disconnected',
        uptime: getConnectionStatus(num.number).uptime
    }));
    
    res.json({
        user: req.user,
        numbers: numbersWithStatus
    });
});

// ==============================================================================
// 14. BOT CONFIGURATION ROUTES
// ==============================================================================

app.post('/api/bot/:number/config', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { number } = req.params;
    const newConfig = req.body;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    if (!userNumbers.some(n => n.number === cleanNumber)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    const success = await updateUserConfigInMongoDB(cleanNumber, newConfig);
    res.json({ success });
});

app.get('/api/bot/:number/config', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    if (!userNumbers.some(n => n.number === cleanNumber)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    const config = await getUserConfigFromMongoDB(cleanNumber);
    res.json(config);
});

app.post('/api/bot/:number/disconnect', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    const userNumbers = await getUserWhatsAppNumbers(req.user.id);
    if (!userNumbers.some(n => n.number === cleanNumber)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (activeSockets.has(cleanNumber)) {
        const socket = activeSockets.get(cleanNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
        pairingCodes.delete(cleanNumber);
    }
    
    await deleteSessionFromMongoDB(cleanNumber);
    
    res.json({ success: true });
});

// Admin login page
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - SILA MD</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body { 
                    background: linear-gradient(135deg, #000000 0%, #0a0a0a 100%);
                    color: #00f3ff; 
                    font-family: 'Arial', sans-serif; 
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    min-height: 100vh;
                    margin: 0;
                    padding: 20px;
                }
                .container { 
                    background: rgba(17, 17, 17, 0.95);
                    padding: 40px; 
                    border: 2px solid #00f3ff; 
                    border-radius: 15px;
                    box-shadow: 0 0 30px rgba(0, 243, 255, 0.3);
                    width: 100%;
                    max-width: 400px;
                    backdrop-filter: blur(10px);
                }
                h2 { 
                    color: #bc13fe; 
                    text-align: center;
                    margin-bottom: 30px;
                    font-size: 2em;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    text-shadow: 0 0 10px #bc13fe;
                }
                input { 
                    display: block; 
                    width: 100%; 
                    padding: 15px; 
                    margin: 20px 0; 
                    background: rgba(34, 34, 34, 0.8);
                    border: 2px solid #00f3ff; 
                    border-radius: 8px;
                    color: #00f3ff; 
                    font-size: 1.1em;
                    outline: none;
                    transition: all 0.3s;
                }
                input:focus {
                    box-shadow: 0 0 20px rgba(0, 243, 255, 0.5);
                    border-color: #bc13fe;
                }
                button { 
                    width: 100%; 
                    padding: 15px; 
                    background: transparent; 
                    border: 2px solid #00f3ff; 
                    color: #00f3ff; 
                    font-size: 1.2em;
                    font-weight: bold;
                    cursor: pointer; 
                    border-radius: 8px;
                    transition: all 0.3s;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                }
                button:hover { 
                    background: #00f3ff; 
                    color: #000;
                    box-shadow: 0 0 20px #00f3ff;
                    transform: translateY(-2px);
                }
                .error { 
                    color: #ff3366; 
                    margin-top: 15px;
                    text-align: center;
                    font-size: 0.9em;
                }
                .footer {
                    margin-top: 20px;
                    text-align: center;
                    color: #666;
                    font-size: 0.8em;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>🔐 ADMIN LOGIN</h2>
                <input type="password" id="pin" placeholder="Enter PIN" autofocus>
                <button onclick="login()">LOGIN</button>
                <div id="error" class="error"></div>
                <div class="footer">SILA MD v3.1.0</div>
            </div>
            <script>
                document.getElementById('pin').addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') login();
                });
                
                async function login() {
                    const pin = document.getElementById('pin').value;
                    const errorDiv = document.getElementById('error');
                    
                    if (pin === 'bot0022') {
                        document.cookie = 'admin_token=' + btoa('admin:' + pin) + '; path=/; max-age=86400';
                        window.location.href = '/admin/dashboard';
                    } else {
                        errorDiv.innerText = '❌ Invalid PIN';
                        document.getElementById('pin').value = '';
                        document.getElementById('pin').focus();
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Admin middleware
const adminMiddleware = (req, res, next) => {
    const token = req.cookies?.admin_token;
    if (token) {
        try {
            const decoded = atob(token);
            if (decoded === 'admin:bot0022') {
                return next();
            }
        } catch (e) {
            console.error('Admin token decode error:', e);
        }
    }
    res.redirect('/admin');
};

// Admin dashboard
app.get('/admin/dashboard', adminMiddleware, async (req, res) => {
    const users = await getAllUsers();
    const sessions = await getAllSessions();
    
    const sessionsWithStatus = sessions.map(s => ({
        ...s.toObject(),
        connectionStatus: isNumberAlreadyConnected(s.number) ? '🟢 Connected' : '🔴 Disconnected',
        uptime: getConnectionStatus(s.number).uptime
    }));
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard - SILA MD</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body { 
                    background: #000; 
                    color: #00f3ff; 
                    font-family: 'Arial', sans-serif; 
                    padding: 20px;
                    min-height: 100vh;
                }
                .container { 
                    max-width: 1400px; 
                    margin: 0 auto;
                }
                h1 { 
                    color: #bc13fe; 
                    text-align: center;
                    margin-bottom: 30px;
                    font-size: 2.5em;
                    text-shadow: 0 0 15px #bc13fe;
                    padding-bottom: 20px;
                    border-bottom: 2px solid #00f3ff;
                }
                .stats {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .stat-card {
                    background: #111;
                    border: 1px solid #00f3ff;
                    border-radius: 10px;
                    padding: 20px;
                    text-align: center;
                }
                .stat-value {
                    font-size: 2.5em;
                    color: #bc13fe;
                    font-weight: bold;
                }
                .stat-label {
                    color: #666;
                    margin-top: 10px;
                    font-size: 0.9em;
                    text-transform: uppercase;
                }
                .nav { 
                    display: flex;
                    gap: 10px;
                    margin-bottom: 30px;
                    flex-wrap: wrap;
                    justify-content: center;
                }
                .nav button { 
                    background: transparent; 
                    border: 2px solid #00f3ff; 
                    color: #00f3ff; 
                    padding: 12px 25px; 
                    cursor: pointer; 
                    border-radius: 8px;
                    font-size: 1em;
                    font-weight: bold;
                    transition: all 0.3s;
                    min-width: 120px;
                }
                .nav button:hover { 
                    background: #00f3ff; 
                    color: #000;
                    box-shadow: 0 0 15px #00f3ff;
                    transform: translateY(-2px);
                }
                .section { 
                    display: none; 
                    background: #111;
                    border: 1px solid #333;
                    border-radius: 15px;
                    padding: 25px;
                }
                .section.active { 
                    display: block; 
                }
                h2 { 
                    color: #00f3ff; 
                    margin-bottom: 20px;
                    font-size: 1.8em;
                }
                table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    margin: 20px 0; 
                    overflow-x: auto;
                    display: block;
                }
                th, td { 
                    padding: 15px; 
                    text-align: left; 
                    border-bottom: 1px solid #333; 
                }
                th { 
                    background: #1a1a1a; 
                    color: #bc13fe; 
                    font-weight: bold;
                }
                tr:hover { 
                    background: #1a1a1a; 
                }
                .connected { 
                    color: #00ff88; 
                }
                .disconnected { 
                    color: #ff3366; 
                }
                button.delete { 
                    background: #ff3366; 
                    color: #fff; 
                    border: none; 
                    padding: 8px 15px; 
                    cursor: pointer; 
                    border-radius: 5px;
                    transition: all 0.3s;
                }
                button.delete:hover {
                    background: #ff0000;
                    transform: scale(1.05);
                }
                .timestamp {
                    color: #666;
                    font-size: 0.8em;
                    margin-top: 20px;
                    text-align: center;
                }
                @media (max-width: 768px) {
                    table {
                        font-size: 14px;
                    }
                    th, td {
                        padding: 10px;
                    }
                    .nav button {
                        padding: 10px 15px;
                        min-width: 100px;
                    }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>👑 SILA MD ADMIN PANEL</h1>
                
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-value">${users.length}</div>
                        <div class="stat-label">Total Users</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${sessions.length}</div>
                        <div class="stat-label">Total Sessions</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${activeSockets.size}</div>
                        <div class="stat-label">Connected Bots</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${Math.round(process.uptime() / 60)}</div>
                        <div class="stat-label">Uptime (min)</div>
                    </div>
                </div>
                
                <div class="nav">
                    <button onclick="showSection('users')">👥 Users</button>
                    <button onclick="showSection('sessions')">🤖 Sessions</button>
                    <button onclick="showSection('api')">📡 API Info</button>
                    <button onclick="location.href='/admin/logout'">🚪 Logout</button>
                </div>
                
                <div id="users-section" class="section active">
                    <h2>👥 Users (${users.length})</h2>
                    <div style="overflow-x: auto;">
                        <table>
                            <tr>
                                <th>Username</th>
                                <th>Full Name</th>
                                <th>Email</th>
                                <th>Role</th>
                                <th>Created</th>
                                <th>Last Login</th>
                                <th>Actions</th>
                            </tr>
                            ${users.map(u => `
                            <tr>
                                <td>${u.username}</td>
                                <td>${u.full_name || '-'}</td>
                                <td>${u.email || '-'}</td>
                                <td>${u.role}</td>
                                <td>${moment(u.created_at).format('YYYY-MM-DD HH:mm')}</td>
                                <td>${u.last_login ? moment(u.last_login).format('YYYY-MM-DD HH:mm') : '-'}</td>
                                <td><button class="delete" onclick="deleteUser('${u._id}')">Delete</button></td>
                            </tr>
                            `).join('')}
                        </table>
                    </div>
                </div>
                
                <div id="sessions-section" class="section">
                    <h2>🤖 Sessions (${sessions.length})</h2>
                    <div style="overflow-x: auto;">
                        <table>
                            <tr>
                                <th>Number</th>
                                <th>User</th>
                                <th>Status</th>
                                <th>Uptime</th>
                                <th>Last Connected</th>
                                <th>Actions</th>
                            </tr>
                            ${sessionsWithStatus.map(s => `
                            <tr>
                                <td>${s.number}</td>
                                <td>${s.user_id?.username || 'Unknown'}</td>
                                <td class="${s.connectionStatus.includes('🟢') ? 'connected' : 'disconnected'}">${s.connectionStatus}</td>
                                <td>${Math.floor(s.uptime / 60)}m ${s.uptime % 60}s</td>
                                <td>${s.last_connected ? moment(s.last_connected).format('YYYY-MM-DD HH:mm') : '-'}</td>
                                <td>
                                    <button class="delete" onclick="deleteSession('${s.number}')">Delete</button>
                                    <button class="delete" onclick="forceDeleteSession('${s.number}')" style="background:#ff0000; margin-left:5px;">Force Delete</button>
                                </td>
                            </tr>
                            `).join('')}
                        </table>
                    </div>
                </div>
                     <div id="api-section" class="section">
                    <h2>📡 API Information</h2>
                    <div style="background: #1a1a1a; padding: 20px; border-radius: 10px;">
                        <h3 style="color: #00f3ff;">Session Management Endpoints</h3>
                        <pre style="color: #0f0; margin-top: 15px; overflow-x: auto;">
DELETE/POST /bot/delsession/:number     - Delete single session
POST        /bot/delsessions             - Delete multiple sessions
DELETE      /admin/delsessions/all       - Delete ALL sessions (Admin)

GET         /api/pair?number=XXX         - Generate pairing code
GET         /api/status/:number          - Check bot status
GET         /api/bots                     - List all connected bots
POST        /api/send/:number             - Send message (requires token)
POST        /api/disconnect/:number       - Disconnect bot
GET         /health                        - Server health check
                        </pre>
                        <p style="color: #00f3ff; margin-top: 15px;">
                            🔓 CORS: Enabled for all origins<br>
                            🔑 API Token: ${process.env.API_SECRET_TOKEN ? 'Configured' : 'Using default token'}
                        </p>
                    </div>
                </div>
                
                <div class="timestamp">
                    Last Updated: ${moment().format('YYYY-MM-DD HH:mm:ss')}
                </div>
            </div>
            
            <script>
                function showSection(section) {
                    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
                    document.getElementById(section + '-section').classList.add('active');
                }
                
                async function deleteUser(userId) {
                    if (!confirm('⚠️ Delete user and all their sessions? This action cannot be undone.')) return;
                    try {
                        const res = await fetch('/admin/api/user/' + userId, { method: 'DELETE' });
                        if (res.ok) location.reload();
                        else alert('Failed to delete user');
                    } catch (e) {
                        alert('Error: ' + e.message);
                    }
                }
                
                async function deleteSession(number) {
                    if (!confirm('⚠️ Delete session? This will disconnect the bot.')) return;
                    try {
                        const res = await fetch('/admin/api/session/' + number, { method: 'DELETE' });
                        if (res.ok) location.reload();
                        else alert('Failed to delete session');
                    } catch (e) {
                        alert('Error: ' + e.message);
                    }
                }
                
                async function forceDeleteSession(number) {
                    if (!confirm('⚠️ FORCE DELETE session? This will completely remove all traces of this bot.')) return;
                    try {
                        const token = prompt('Enter admin token:');
                        if (!token) return;
                        
                        const res = await fetch('/bot/delsession/' + number, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token: token })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('Session deleted successfully');
                            location.reload();
                        } else {
                            alert('Failed: ' + data.error);
                        }
                    } catch (e) {
                        alert('Error: ' + e.message);
                    }
                }
                
                // Auto refresh data every 30 seconds
                setTimeout(() => location.reload(), 30000);
            </script>
        </body>
        </html>
    `);
});

// Admin API
app.delete('/admin/api/user/:userId', adminMiddleware, async (req, res) => {
    const { userId } = req.params;
    const result = await adminDeleteUser(userId);
    res.json(result);
});

app.delete('/admin/api/session/:number', adminMiddleware, async (req, res) => {
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    if (activeSockets.has(cleanNumber)) {
        const socket = activeSockets.get(cleanNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        activeSockets.delete(cleanNumber);
        socketCreationTime.delete(cleanNumber);
        pairingCodes.delete(cleanNumber);
    }
    
    const result = await adminDeleteSession(cleanNumber);
    res.json(result);
});

app.get('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin');
});


// ==============================================================================
// 16. AUTO FOLLOW & JOIN FUNCTIONS
// ==============================================================================

async function autoFollowChannels(conn) {
    try {
        for (const channelJid of config.AUTO_FOLLOW_CHANNELS) {
            try {
                await conn.newsletterFollow(channelJid);
                console.log(`✅ Followed channel: ${channelJid}`);
                await delay(2000);
            } catch (e) {
                console.error(`❌ Failed to follow channel ${channelJid}:`, e.message);
            }
        }
    } catch (error) {
        console.error('Auto follow channels error:', error);
    }
}

async function autoJoinGroups(conn) {
    try {
        for (const groupLink of config.AUTO_JOIN_GROUPS) {
            try {
                const code = groupLink.split('https://chat.whatsapp.com/')[1];
                if (code) {
                    await conn.groupAcceptInvite(code);
                    console.log(`✅ Joined group: ${groupLink}`);
                }
                await delay(3000);
            } catch (e) {
                console.error(`❌ Failed to join group ${groupLink}:`, e.message);
            }
        }
    } catch (error) {
        console.error('Auto join groups error:', error);
    }
}

// ==============================================================================
// 17. MESSAGE HANDLERS SETUP
// ==============================================================================

async function setupMessageHandlers(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
        
        if (userConfig.AUTO_TYPING === 'true') {
            try {
                await socket.sendPresenceUpdate('composing', msg.key.remoteJid);
            } catch (error) {}
        }
        
        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {}
        }
    });
}

async function setupCallHandlers(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    socket.ev.on('call', async (calls) => {
        try {
            const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
            if (userConfig.ANTI_CALL !== 'true') return;

            for (const call of calls) {
                if (call.status !== 'offer') continue;
                await socket.rejectCall(call.id, call.from);
                await socket.sendMessage(call.from, {
                    text: userConfig.REJECT_MSG || config.REJECT_MSG || '❌ Cannot answer calls right now'
                });
                console.log(`📞 Call rejected from ${call.from}`);
            }
        } catch (err) {
            console.error(`Anti-call error:`, err);
        }
    });
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 3;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            if (statusCode === 401 || errorMessage?.includes('401')) {
                console.log(`🔐 Manual unlink detected for ${sanitizedNumber}`);
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                pairingCodes.delete(sanitizedNumber);
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                socket.ev.removeAllListeners();
                return;
            }
            
            const isNormalError = statusCode === 408 || errorMessage?.includes('QR refs attempts ended');
            if (isNormalError) return;
            
            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                console.log(`🔄 Reconnecting ${sanitizedNumber} (${restartAttempts}/${maxRestartAttempts})...`);
                
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                pairingCodes.delete(sanitizedNumber);
                socket.ev.removeAllListeners();

                await delay(10000);
                
                try {
                    await startBot(number);
                    console.log(`✅ Reconnection initiated for ${sanitizedNumber}`);
                } catch (reconnectError) {
                    console.error(`❌ Reconnection failed:`, reconnectError);
                }
            }
        }
        
        if (connection === 'open') {
            console.log(`✅ ${sanitizedNumber} connected successfully`);
            restartAttempts = 0;
        }
    });
}

// ==============================================================================
// 18. CREATE BUTTON MESSAGE
// ==============================================================================

function createButtonMessage(text, buttons) {
    const buttonMessage = {
        text: text,
        footer: config.BOT_FOOTER || '© SILA MD',
        buttons: buttons,
        headerType: 1
    };
    return buttonMessage;
}

// ==============================================================================
// 19. START BOT FUNCTION
// ==============================================================================

async function startBot(number, userId = null) {
    let connectionLockKey;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        const sessionDir = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
        
        if (isNumberAlreadyConnected(sanitizedNumber)) {
            console.log(`⏩ ${sanitizedNumber} already connected`);
            return;
        }
        
        connectionLockKey = `connecting_${sanitizedNumber}`;
        if (global[connectionLockKey]) {
            console.log(`⏩ ${sanitizedNumber} connection in progress`);
            return;
        }
        global[connectionLockKey] = true;
        
        const existingSession = await getSessionFromMongoDB(sanitizedNumber);
        
        if (!existingSession) {
            if (fs.existsSync(sessionDir)) await fs.remove(sessionDir);
        } else {
            fs.ensureDirSync(sessionDir);
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
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
            generateHighQualityLink: true,
            getMessage: async (key) => {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
        });
        
        socketCreationTime.set(sanitizedNumber, Date.now());
        activeSockets.set(sanitizedNumber, conn);
        store.bind(conn.ev);
        
        // Handle pairing code for new sessions
        if (!existingSession) {
            conn.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect } = update;
                
                if (qr) {
                    console.log('QR Code received (ignored - using pairing code)');
                }
            });
            
            // Generate pairing code
            setTimeout(async () => {
                try {
                    const code = await conn.requestPairingCode(sanitizedNumber);
                    console.log(`🔑 Pairing Code for ${sanitizedNumber}: ${code}`);
                    
                    // Store the code
                    pairingCodes.set(sanitizedNumber, code);
                    
                    // Clear after 5 minutes
                    setTimeout(() => {
                        pairingCodes.delete(sanitizedNumber);
                    }, 300000);
                    
                    // Send code to owner if configured
                    if (config.OWNER_NUMBER) {
                        try {
                            await conn.sendMessage(`${config.OWNER_NUMBER}@s.whatsapp.net`, {
                                text: `*🔐 New Bot Connected*\n\n` +
                                      `📱 *Number:* ${sanitizedNumber}\n` +
                                      `🔑 *Pairing Code:* ${code}\n` +
                                      `⏰ *Time:* ${moment().format('YYYY-MM-DD HH:mm:ss')}\n\n` +
                                      `_This code expires in 5 minutes_`
                            });
                        } catch (e) {
                            console.error('Failed to send code to owner:', e.message);
                        }
                    }
                } catch (err) {
                    console.error('❌ Pairing error:', err.message);
                }
            }, 5000);
        }
        
        // Setup handlers
        setupMessageHandlers(conn, sanitizedNumber);
        setupCallHandlers(conn, sanitizedNumber);
        setupAutoRestart(conn, sanitizedNumber);
        
        // Auto follow & join on connection open
        conn.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await addNumberToMongoDB(sanitizedNumber, userId);
                
                // Auto follow channels
                await autoFollowChannels(conn);
                
                // Auto join groups
                await autoJoinGroups(conn);
                
                // Welcome message with buttons for new sessions
                if (!existingSession) {
                    const welcomeButtons = [
                        {
                            buttonId: '.channel',
                            buttonText: { displayText: '📢 CHANNEL' },
                            type: 1
                        },
                        {
                            buttonId: '.repo',
                            buttonText: { displayText: '💻 REPO' },
                            type: 1
                        },
                        {
                            buttonId: '.menu',
                            buttonText: { displayText: '📋 MENU' },
                            type: 1
                        }
                    ];
                    
                    const welcomeText = `*👑 ${config.BOT_NAME || 'SILA MD'} 👑*\n\n` +
                        `✅ *Connected Successfully*\n` +
                        `📱 *Number:* ${sanitizedNumber}\n` +
                        `⚡ *Version:* 3.1.0\n` +
                        `⏰ *Time:* ${moment().tz('Africa/Dar_es_Salaam').format('HH:mm:ss')}\n\n` +
                        `*Click buttons below to explore!*`;
                    
                    try {
                        await conn.sendMessage(jidNormalizedUser(conn.user.id), {
                            text: welcomeText,
                            footer: config.BOT_FOOTER || '© SILA MD',
                            buttons: welcomeButtons,
                            headerType: 1
                        });
                    } catch (e) {
                        console.error('Welcome message error:', e);
                    }
                }
            }
        });
        
           // Save session on update
        conn.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                const fileContent = fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8');
                const creds = JSON.parse(fileContent);
                await saveSessionToMongoDB(sanitizedNumber, creds, userId);
                console.log(`💾 Session saved for ${sanitizedNumber}`);
            } catch (e) {
                console.error('Failed to save session:', e);
            }
        });
        
        // Anti-delete handler
        conn.ev.on('messages.update', async (updates) => {
            await handleAntidelete(conn, updates, store);
        });
        
        // Main message handler
        conn.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const msg = messages[0];
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
                
                // Normalize message
                if (msg.message.ephemeralMessage) {
                    msg.message = msg.message.ephemeralMessage.message;
                }
                
                const m = sms(conn, msg);
                const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
                const type = getContentType(msg.message);
                const from = msg.key.remoteJid;
                const body = (type === 'conversation') ? msg.message.conversation :
                            (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : 
                            (type === 'imageMessage') ? msg.message.imageMessage.caption : 
                            (type === 'videoMessage') ? msg.message.videoMessage.caption : '';
                
                // Auto read
                if (userConfig && userConfig.READ_MESSAGE === 'true') {
                    try {
                        await conn.readMessages([msg.key]);
                    } catch (error) {}
                }
                
                // Status handling
                if (msg.key.remoteJid === 'status@broadcast') {
                    if (userConfig && userConfig.AUTO_VIEW_STATUS === 'true') {
                        try {
                            await conn.readMessages([msg.key]);
                        } catch (error) {}
                    }
                    
                    if (userConfig && userConfig.AUTO_LIKE_STATUS === 'true') {
                        try {
                            const emojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI || ['❤️', '👍', '🔥'];
                            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                            await conn.sendMessage(msg.key.remoteJid, {
                                react: { text: randomEmoji, key: msg.key }
                            });
                        } catch (error) {}
                    }
                    
                    if (userConfig && userConfig.AUTO_STATUS_REPLY === 'true') {
                        try {
                            const user = msg.key.participant;
                            const text = userConfig.AUTO_STATUS_MSG || config.AUTO_STATUS_MSG || 'Nice status! 🤗';
                            await conn.sendMessage(user, { text });
                        } catch (error) {}
                    }
                    return;
                }
                
                const isCmd = body.startsWith(config.PREFIX || '.');
                const command = isCmd ? body.slice((config.PREFIX || '.').length).trim().split(' ')[0].toLowerCase() : '';
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                
                // Increment stats
                await incrementStats(sanitizedNumber, 'messagesReceived');
                
                // CHATBOT - Reply to non-command messages
                if (!isCmd && userConfig && userConfig.CHATBOT_ENABLED === 'true' && body.trim()) {
                    const aiResponse = await chatbot(conn, m, body);
                    if (aiResponse) {
                        await m.reply(aiResponse);
                        await incrementStats(sanitizedNumber, 'messagesSent');
                    }
                }
                
                // Command handling
                if (isCmd) {
                    await incrementStats(sanitizedNumber, 'commandsUsed');
                    
                    const cmd = events.commands.find(c => c.pattern === command) || 
                               events.commands.find(c => c.alias && c.alias.includes(command));
                    
                    if (cmd) {
                        if (config.WORK_TYPE === 'private' && !config.OWNER_NUMBER?.includes(m.senderNumber)) return;
                        
                        if (cmd.react) {
                            try {
                                await conn.sendMessage(from, { react: { text: cmd.react, key: msg.key } });
                            } catch (error) {}
                        }
                        
                        // Get group info if in group
                        let isGroup = from.endsWith('@g.us');
                        let groupMetadata = null;
                        let groupAdmins = [];
                        let isAdmins = false;
                        let isBotAdmins = false;
                        
                        if (isGroup) {
                            try {
                                groupMetadata = await conn.groupMetadata(from);
                                groupAdmins = getGroupAdmins(groupMetadata.participants);
                                isAdmins = groupAdmins.includes(m.sender);
                                isBotAdmins = groupAdmins.includes(jidNormalizedUser(conn.user.id));
                            } catch (error) {
                                console.error('Group metadata error:', error);
                            }
                        }
                        
                        const context = {
                            from, m, body, isCmd, command, args, q,
                            isGroup, groupMetadata, groupAdmins, isAdmins, isBotAdmins,
                            sender: m.sender, senderNumber: m.senderNumber,
                            botNumber: conn.user.id.split(':')[0],
                            pushname: msg.pushName || 'User',
                            isOwner: config.OWNER_NUMBER?.includes(m.senderNumber) || false,
                            reply: m.reply,
                            react: m.react,
                            config
                        };
                        
                        try {
                            await cmd.function(conn, msg, m, context);
                        } catch (e) {
                            console.error(`Plugin error ${cmd.pattern}:`, e);
                            await m.reply(`❌ Error: ${e.message}`);
                        }
                    }
                }
                
            } catch (e) {
                console.error('Message handler error:', e);
            }
        });
        
    } catch (err) {
        console.error('StartBot error:', err);
    } finally {
        if (connectionLockKey) global[connectionLockKey] = false;
    }
}


// ==============================================================================
// 20. AUTO RECONNECT
// ==============================================================================

async function autoReconnect() {
    try {
        console.log('🔄 Auto-reconnecting from MongoDB...');
        const numbers = await getAllNumbersFromMongoDB();
        
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                console.log(`🔁 Reconnecting: ${number}`);
                await startBot(number);
                await delay(5000);
            }
        }
    } catch (error) {
        console.error('Auto-reconnect error:', error);
    }
}

// Start auto-reconnect after 10 seconds
setTimeout(autoReconnect, 10000);

// Run auto-reconnect every 30 minutes
setInterval(autoReconnect, 30 * 60 * 1000);

// ==============================================================================
// 21. START SERVER
// ==============================================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log(`🚀 SILA MD SERVER STARTED`);
    console.log('='.repeat(60));
    console.log(`📡 PORT: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`🌍 Public URL: https://your-domain.com`);
    console.log('\n📡 SESSION MANAGEMENT ENDPOINTS:');
    console.log('─'.repeat(40));
    console.log(`DELETE/POST /bot/delsession/:number     - Delete single session`);
    console.log(`POST        /bot/delsessions             - Delete multiple sessions`);
    console.log(`DELETE      /admin/delsessions/all       - Delete ALL sessions (Admin)`);
    console.log('─'.repeat(40));
    console.log('\n📡 OTHER API ENDPOINTS (CORS Enabled):');
    console.log('─'.repeat(40));
    console.log(`GET  /api/pair?number=XXX   - Generate Pairing Code`);
    console.log(`GET  /api/status/:number     - Check Bot Status`);
    console.log(`GET  /api/bots               - List All Bots`);
    console.log(`POST /api/send/:number       - Send Message`);
    console.log(`POST /api/disconnect/:number - Disconnect Bot`);
    console.log(`POST /api/bot/:number/logout - Logout User's Bot`);
    console.log(`GET  /health                  - Health Check`);
    console.log('─'.repeat(40));
    console.log(`🔓 CORS: Enabled for ALL origins`);
    console.log(`👑 Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`🔑 Admin PIN: bot0022`);
    console.log('='.repeat(60) + '\n');
});

// ==============================================================================
// 22. CLEANUP ON EXIT
// ==============================================================================

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n📴 Shutting down gracefully...');
    
    for (const [number, socket] of activeSockets) {
        try {
            await socket.ws.close();
            console.log(`✅ Disconnected ${number}`);
        } catch (e) {
            console.error(`❌ Error disconnecting ${number}:`, e);
        }
    }
    
    activeSockets.clear();
    socketCreationTime.clear();
    pairingCodes.clear();
    
    console.log('👋 Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n📴 Received SIGTERM, shutting down...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
    console.error(err.stack);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled rejection:', err);
});

module.exports = app;