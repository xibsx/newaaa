const mongoose = require('mongoose');
const config = require('../config');
const bcrypt = require('bcrypt');

const connectdb = async () => {
    try {
        mongoose.set('strictQuery', false);
        
        // Disable auto indexes to prevent conflicts
        mongoose.set('autoIndex', false);
        
        await mongoose.connect(config.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        console.log("✅ MongoDB Connected Successfully");
        
        // Create indexes safely
        await createIndexesSafely();
        
    } catch (e) {
        console.error("❌ MongoDB Connection Failed:", e.message);
        process.exit(1);
    }
};

// Safe index creation - handles errors gracefully
const createIndexesSafely = async () => {
    try {
        console.log("📊 Setting up database indexes...");
        
        // Get all collections
        const collections = await mongoose.connection.db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        // ===== SESSIONS COLLECTION =====
        if (!collectionNames.includes('sessions')) {
            console.log("Creating sessions collection...");
            await mongoose.connection.db.createCollection('sessions');
        }
        
        try {
            // Drop existing index if any
            await mongoose.connection.collection('sessions').dropIndex('number_1');
        } catch (e) {}
        
        try {
            await mongoose.connection.collection('sessions').createIndex(
                { number: 1 }, 
                { unique: true, name: 'idx_sessions_number' }
            );
            console.log("✅ Sessions index created");
        } catch (e) {
            console.log("ℹ️ Sessions index may already exist");
        }
        
        // ===== USERS COLLECTION =====
        if (!collectionNames.includes('users')) {
            console.log("Creating users collection...");
            await mongoose.connection.db.createCollection('users');
        }
        
        // Username index
        try {
            await mongoose.connection.collection('users').dropIndex('username_1');
        } catch (e) {}
        
        try {
            await mongoose.connection.collection('users').createIndex(
                { username: 1 }, 
                { unique: true, name: 'idx_users_username' }
            );
            console.log("✅ Users username index created");
        } catch (e) {
            console.log("ℹ️ Users username index may already exist");
        }
        
        // Email index (non-unique to allow nulls)
        try {
            await mongoose.connection.collection('users').dropIndex('email_1');
        } catch (e) {}
        
        try {
            await mongoose.connection.collection('users').createIndex(
                { email: 1 }, 
                { sparse: true, name: 'idx_users_email' }
            );
            console.log("✅ Users email index created");
        } catch (e) {
            console.log("ℹ️ Users email index may already exist");
        }
        
        // ===== USERCONFIGS COLLECTION =====
        if (!collectionNames.includes('userconfigs')) {
            console.log("Creating userconfigs collection...");
            await mongoose.connection.db.createCollection('userconfigs');
        }
        
        try {
            await mongoose.connection.collection('userconfigs').dropIndex('number_1');
        } catch (e) {}
        
        try {
            await mongoose.connection.collection('userconfigs').createIndex(
                { number: 1 }, 
                { unique: true, name: 'idx_configs_number' }
            );
            console.log("✅ UserConfigs index created");
        } catch (e) {
            console.log("ℹ️ UserConfigs index may already exist");
        }
        
        // ===== ACTIVENUMBERS COLLECTION =====
        if (!collectionNames.includes('activenumbers')) {
            console.log("Creating activenumbers collection...");
            await mongoose.connection.db.createCollection('activenumbers');
        }
        
        try {
            await mongoose.connection.collection('activenumbers').dropIndex('number_1');
        } catch (e) {}
        
        try {
            await mongoose.connection.collection('activenumbers').createIndex(
                { number: 1 }, 
                { unique: true, name: 'idx_active_number' }
            );
            console.log("✅ ActiveNumbers index created");
        } catch (e) {
            console.log("ℹ️ ActiveNumbers index may already exist");
        }
        
        // ===== OTPS COLLECTION =====
        if (!collectionNames.includes('otps')) {
            console.log("Creating otps collection...");
            await mongoose.connection.db.createCollection('otps');
        }
        
        try {
            await mongoose.connection.collection('otps').createIndex(
                { expiresAt: 1 }, 
                { expireAfterSeconds: 0, name: 'idx_otps_expiry' }
            );
            console.log("✅ OTP TTL index created");
        } catch (e) {
            console.log("ℹ️ OTP index may already exist");
        }
        
        // ===== STATS COLLECTION =====
        if (!collectionNames.includes('stats')) {
            console.log("Creating stats collection...");
            await mongoose.connection.db.createCollection('stats');
        }
        
        try {
            await mongoose.connection.collection('stats').createIndex(
                { number: 1, date: 1 }, 
                { unique: true, name: 'idx_stats_number_date' }
            );
            console.log("✅ Stats index created");
        } catch (e) {
            console.log("ℹ️ Stats index may already exist");
        }
        
        // ===== WEBSESSIONS COLLECTION =====
        if (!collectionNames.includes('websessions')) {
            console.log("Creating websessions collection...");
            await mongoose.connection.db.createCollection('websessions');
        }
        
        try {
            await mongoose.connection.collection('websessions').createIndex(
                { session_token: 1 }, 
                { unique: true, name: 'idx_websessions_token' }
            );
            console.log("✅ WebSessions index created");
        } catch (e) {
            console.log("ℹ️ WebSessions index may already exist");
        }
        
        try {
            await mongoose.connection.collection('websessions').createIndex(
                { expires_at: 1 }, 
                { expireAfterSeconds: 0, name: 'idx_websessions_expiry' }
            );
            console.log("✅ WebSessions expiry index created");
        } catch (e) {
            console.log("ℹ️ WebSessions expiry index may already exist");
        }
        
        console.log("✅ Database setup completed");
        
    } catch (error) {
        console.error("❌ Error in database setup:", error.message);
        // Don't exit - continue even if indexes fail
    }
};

// ====================================
// SCHEMAS
// ====================================

// Users (for web login)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    email: { type: String, sparse: true },
    full_name: String,
    role: { type: String, default: 'user' },
    created_at: { type: Date, default: Date.now },
    last_login: Date
}, { autoIndex: false }); // Disable autoIndex

// WhatsApp Sessions
const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    credentials: { type: Object, required: true },
    is_active: { type: Boolean, default: true },
    bot_config: { type: Object, default: {} },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
    last_connected: Date
}, { autoIndex: false });

// User Config (per number)
const userConfigSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    config: {
        AUTO_RECORDING: { type: String, default: 'false' },
        AUTO_TYPING: { type: String, default: 'false' },
        ANTI_CALL: { type: String, default: 'false' },
        REJECT_MSG: { type: String, default: '*🔕 Your call was automatically rejected..!*' },
        READ_MESSAGE: { type: String, default: 'false' },
        AUTO_VIEW_STATUS: { type: String, default: 'false' },
        AUTO_LIKE_STATUS: { type: String, default: 'false' },
        AUTO_STATUS_REPLY: { type: String, default: 'false' },
        AUTO_STATUS_MSG: { type: String, default: 'Hello from SILA MD !' },
        AUTO_LIKE_EMOJI: { type: Array, default: ['❤️', '👍', '😮', '😎'] },
        CHATBOT_ENABLED: { type: String, default: 'false' }
    },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
}, { autoIndex: false });

// OTP
const otpSchema = new mongoose.Schema({
    number: { type: String, required: true },
    otp: { type: String, required: true },
    config: { type: Object, required: true },
    expires_at: { type: Date, default: () => new Date(Date.now() + 5 * 60000) },
    created_at: { type: Date, default: Date.now }
}, { autoIndex: false });

// Active Numbers
const activeNumberSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    last_connected: { type: Date, default: Date.now },
    is_active: { type: Boolean, default: true }
}, { autoIndex: false });

// Stats
const statsSchema = new mongoose.Schema({
    number: { type: String, required: true },
    date: { type: String, required: true },
    commands_used: { type: Number, default: 0 },
    messages_received: { type: Number, default: 0 },
    messages_sent: { type: Number, default: 0 },
    groups_interacted: { type: Number, default: 0 }
}, { autoIndex: false });

// Web Sessions (for login)
const webSessionSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    session_token: { type: String, required: true, unique: true },
    ip_address: String,
    user_agent: String,
    created_at: { type: Date, default: Date.now },
    expires_at: { type: Date, required: true }
}, { autoIndex: false });

// ====================================
// MODELS
// ====================================

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);
const UserConfig = mongoose.model('UserConfig', userConfigSchema);
const OTP = mongoose.model('OTP', otpSchema);
const ActiveNumber = mongoose.model('ActiveNumber', activeNumberSchema);
const Stats = mongoose.model('Stats', statsSchema);
const WebSession = mongoose.model('WebSession', webSessionSchema);

// ====================================
// USER AUTH FUNCTIONS
// ====================================

async function registerUser(username, password, email = null, fullName = null) {
    try {
        // Check if username exists
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return { success: false, error: 'Username already exists' };
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const userData = {
            username,
            password: hashedPassword,
            full_name: fullName || username,
            role: 'user',
            created_at: new Date()
        };
        
        // Only add email if provided and not empty
        if (email && email.trim() !== '') {
            userData.email = email;
        }
        
        const user = await User.create(userData);
        
        return { 
            success: true, 
            user: { 
                id: user._id, 
                username: user.username 
            } 
        };
        
    } catch (error) {
        console.error('❌ Register error:', error);
        
        // Handle duplicate key errors
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return { success: false, error: `${field} already exists` };
        }
        
        return { success: false, error: 'Registration failed' };
    }
}

async function loginUser(username, password) {
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return { success: false, error: 'Invalid username or password' };
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return { success: false, error: 'Invalid username or password' };
        }

        // Update last login
        user.last_login = new Date();
        await user.save();

        return {
            success: true,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                role: user.role
            }
        };
    } catch (error) {
        console.error('❌ Login error:', error);
        return { success: false, error: 'Login failed' };
    }
}

async function createUserSession(userId, sessionToken, ipAddress, userAgent) {
    try {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await WebSession.create({
            user_id: userId,
            session_token: sessionToken,
            ip_address: ipAddress,
            user_agent: userAgent,
            expires_at: expiresAt
        });
        
        return { success: true };
    } catch (error) {
        console.error('❌ Create session error:', error);
        return { success: false };
    }
}

async function validateSessionToken(sessionToken) {
    try {
        const session = await WebSession.findOne({
            session_token: sessionToken,
            expires_at: { $gt: new Date() }
        }).populate('user_id');

        if (!session) return { valid: false };

        return { valid: true, user: session.user_id };
    } catch (error) {
        console.error('❌ Validate session error:', error);
        return { valid: false };
    }
}

async function deleteUserSession(sessionToken) {
    try {
        await WebSession.deleteOne({ session_token: sessionToken });
        return { success: true };
    } catch (error) {
        console.error('❌ Delete session error:', error);
        return { success: false };
    }
}

async function getUserById(userId) {
    try {
        return await User.findById(userId).select('-password');
    } catch (error) {
        console.error('❌ Get user error:', error);
        return null;
    }
}

async function getUserWhatsAppNumbers(userId) {
    try {
        return await Session.find({ user_id: userId }).select('number is_active bot_config last_connected');
    } catch (error) {
        console.error('❌ Get user numbers error:', error);
        return [];
    }
}

// ====================================
// ADMIN FUNCTIONS
// ====================================

async function getAllUsers() {
    try {
        return await User.find().select('-password').sort({ created_at: -1 });
    } catch (error) {
        console.error('❌ Get all users error:', error);
        return [];
    }
}

async function getAllSessions() {
    try {
        return await Session.find().populate('user_id', 'username').sort({ created_at: -1 });
    } catch (error) {
        console.error('❌ Get all sessions error:', error);
        return [];
    }
}

async function adminDeleteSession(number) {
    try {
        await Session.deleteOne({ number });
        await UserConfig.deleteOne({ number });
        await ActiveNumber.deleteOne({ number });
        await Stats.deleteMany({ number });
        return { success: true };
    } catch (error) {
        console.error('❌ Admin delete session error:', error);
        return { success: false };
    }
}

async function adminDeleteUser(userId) {
    try {
        const sessions = await Session.find({ user_id: userId });
        for (const session of sessions) {
            await adminDeleteSession(session.number);
        }
        await User.deleteOne({ _id: userId });
        await WebSession.deleteMany({ user_id: userId });
        return { success: true };
    } catch (error) {
        console.error('❌ Admin delete user error:', error);
        return { success: false };
    }
}

// ====================================
// SESSION FUNCTIONS
// ====================================

async function saveSessionToMongoDB(number, credentials, userId = null) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        await Session.findOneAndUpdate(
            { number: cleanNumber },
            {
                credentials,
                user_id: userId,
                updated_at: new Date(),
                last_connected: new Date()
            },
            { upsert: true, new: true }
        );
        
        console.log(`📁 Session saved to MongoDB for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving session:', error);
        return false;
    }
}

async function getSessionFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: cleanNumber });
        return session ? session.credentials : null;
    } catch (error) {
        console.error('❌ Error getting session:', error);
        return null;
    }
}

async function deleteSessionFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await Session.deleteOne({ number: cleanNumber });
        await UserConfig.deleteOne({ number: cleanNumber });
        await ActiveNumber.deleteOne({ number: cleanNumber });
        console.log(`🗑️ Session deleted from MongoDB for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error deleting session:', error);
        return false;
    }
}

// ====================================
// USER CONFIG FUNCTIONS
// ====================================

async function getUserConfigFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        let config = await UserConfig.findOne({ number: cleanNumber });
        
        if (!config) {
            const defaultConfig = {
                AUTO_RECORDING: 'false',
                AUTO_TYPING: 'false',
                ANTI_CALL: 'false',
                REJECT_MSG: '*🔕 Your call was automatically rejected..!*',
                READ_MESSAGE: 'false',
                AUTO_VIEW_STATUS: 'false',
                AUTO_LIKE_STATUS: 'false',
                AUTO_STATUS_REPLY: 'false',
                AUTO_STATUS_MSG: 'Hello from SILA MD !',
                AUTO_LIKE_EMOJI: ['❤️', '👍', '😮', '😎'],
                CHATBOT_ENABLED: 'false'
            };
            
            config = await UserConfig.create({
                number: cleanNumber,
                config: defaultConfig
            });
        }
        
        return config.config;
    } catch (error) {
        console.error('❌ Error getting user config:', error);
        return {};
    }
}

async function updateUserConfigInMongoDB(number, newConfig) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await UserConfig.findOneAndUpdate(
            { number: cleanNumber },
            { config: newConfig, updated_at: new Date() },
            { upsert: true, new: true }
        );
        console.log(`⚙️ Config updated for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating user config:', error);
        return false;
    }
}

// ====================================
// OTP FUNCTIONS
// ====================================

async function saveOTPToMongoDB(number, otp, config) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await OTP.create({
            number: cleanNumber,
            otp,
            config,
            expires_at: new Date(Date.now() + 5 * 60000)
        });
        console.log(`🔐 OTP saved for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving OTP:', error);
        return false;
    }
}

async function verifyOTPFromMongoDB(number, otp) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const otpRecord = await OTP.findOne({
            number: cleanNumber,
            otp,
            expires_at: { $gt: new Date() }
        });
        
        if (!otpRecord) {
            return { valid: false, error: 'Invalid or expired OTP' };
        }
        
        await OTP.deleteOne({ _id: otpRecord._id });
        
        return {
            valid: true,
            config: otpRecord.config
        };
    } catch (error) {
        console.error('❌ Error verifying OTP:', error);
        return { valid: false, error: 'Verification error' };
    }
}

// ====================================
// ACTIVE NUMBERS FUNCTIONS
// ====================================

async function addNumberToMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await ActiveNumber.findOneAndUpdate(
            { number: cleanNumber },
            { last_connected: new Date(), is_active: true },
            { upsert: true, new: true }
        );
        return true;
    } catch (error) {
        console.error('❌ Error adding number:', error);
        return false;
    }
}

async function removeNumberFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await ActiveNumber.deleteOne({ number: cleanNumber });
        return true;
    } catch (error) {
        console.error('❌ Error removing number:', error);
        return false;
    }
}

async function getAllNumbersFromMongoDB() {
    try {
        const activeNumbers = await ActiveNumber.find({ is_active: true });
        return activeNumbers.map(num => num.number);
    } catch (error) {
        console.error('❌ Error getting numbers:', error);
        return [];
    }
}

// ====================================
// STATS FUNCTIONS
// ====================================

async function incrementStats(number, field) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const today = new Date().toISOString().split('T')[0];
        
        const fieldMap = {
            commandsUsed: 'commands_used',
            messagesReceived: 'messages_received',
            messagesSent: 'messages_sent',
            groupsInteracted: 'groups_interacted'
        };
        
        const dbField = fieldMap[field] || field;
        
        await Stats.findOneAndUpdate(
            { number: cleanNumber, date: today },
            { $inc: { [dbField]: 1 } },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('❌ Error updating stats:', error);
    }
}

async function getStatsForNumber(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        return await Stats.find({ number: cleanNumber }).sort({ date: -1 }).limit(30);
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return [];
    }
}

// ====================================
// EXPORTS
// ====================================

module.exports = {
    connectdb,
    
    // User auth
    registerUser,
    loginUser,
    createUserSession,
    validateSessionToken,
    deleteUserSession,
    getUserById,
    getUserWhatsAppNumbers,
    
    // Admin
    getAllUsers,
    getAllSessions,
    adminDeleteSession,
    adminDeleteUser,
    
    // Session
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    
    // User Config
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    
    // OTP
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    
    // Active Numbers
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    
    // Stats
    incrementStats,
    getStatsForNumber,
    
    // Legacy
    getUserConfig: getUserConfigFromMongoDB,
    updateUserConfig: updateUserConfigInMongoDB
};
