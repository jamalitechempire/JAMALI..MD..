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
    getContentType
} = require('@whiskeysockets/baileys');

const config = require('./config');
const events = require('./momy');
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
    getStatsForNumber
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');
const { handleAntilink } = require('./lib/antilink');
const { setupAutoStatus } = require('./sila/autostatus');
const { startTelegramBot } = require('./sila/telegram-bot');

const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const path = require('path');

const prefix = config.PREFIX;
const router = express.Router();

// ==============================================================================
// 1. INITIALIZATION & DATABASE
// ==============================================================================

connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();

const store = {
    bind: (ev) => {
        console.log('📦 Store bound');
    },
    loadMessage: async (jid, id) => {
        return undefined;
    }
};

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

// ==================== AUTO-FOLLOW (SINGLE CHANNEL JID + SINGLE GROUP LINK) ====================
async function autoFollowNewsletters(conn) {
    try {
        // Follow channel using JID from config
        if (config.CHANNEL_JID) {
            console.log(`📰 Auto‑follow channel: ${config.CHANNEL_JID}`);
            try {
                await conn.newsletterFollow(config.CHANNEL_JID);
                console.log(`✅ Followed channel: ${config.CHANNEL_JID}`);
            } catch (err) {
                if (err.message?.toLowerCase().includes('already')) {
                    console.log(`ℹ️ Already following channel: ${config.CHANNEL_JID}`);
                } else {
                    console.error(`❌ Failed to follow channel: ${err.message}`);
                }
            }
        } else {
            console.log('⚠️ No CHANNEL_JID configured, skipping channel follow');
        }

        // Join group using link from config
        if (config.GROUP_LINK) {
            console.log(`👥 Auto‑join group: ${config.GROUP_LINK}`);
            const inviteCode = config.GROUP_LINK.split('/').pop()?.split('?')[0];
            if (inviteCode) {
                try {
                    await conn.groupAcceptInvite(inviteCode);
                    console.log(`✅ Successfully joined group`);
                } catch (err) {
                    console.error(`❌ Failed to join group: ${err.message}`);
                }
            } else {
                console.log(`⚠️ Invalid group link: ${config.GROUP_LINK}`);
            }
        } else {
            console.log('⚠️ No GROUP_LINK configured, skipping group join');
        }
    } catch (error) {
        console.error('❌ Auto‑follow/join error:', error.message);
    }
}

// Auto update bio (unchanged, but uses config.BIO_LIST)
async function autoUpdateBio(conn, number) {
    try {
        if (config.AUTO_BIO === 'true' && config.BIO_LIST && config.BIO_LIST.length > 0) {
            const bioList = config.BIO_LIST;
            let currentIndex = 0;
            
            const isConnectionActive = () => {
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                return activeSockets.has(sanitizedNumber) && conn.user && conn.user.id;
            };
            
            const updateBio = async () => {
                try {
                    if (!isConnectionActive()) {
                        console.log(`⚠️ Skipping bio update - connection closed for ${number}`);
                        return;
                    }
                    const bioText = bioList[currentIndex];
                    if (!conn.user || !conn.user.id) {
                        console.log(`⚠️ Skipping bio update - no user data for ${number}`);
                        return;
                    }
                    await conn.updateProfileStatus(bioText);
                    console.log(`📝 Updated bio for ${number}: ${bioText}`);
                    currentIndex = (currentIndex + 1) % bioList.length;
                } catch (error) {
                    console.error(`❌ Error updating bio for ${number}:`, error.message);
                    currentIndex = (currentIndex + 1) % bioList.length;
                }
            };
            
            if (isConnectionActive()) await updateBio();
            
            const bioInterval = setInterval(() => {
                if (isConnectionActive()) updateBio();
                else {
                    console.log(`🔌 Stopping bio update for ${number} - connection lost`);
                    clearInterval(bioInterval);
                }
            }, 30 * 60 * 1000);
            
            const sanitizedNumber = number.replace(/[^0-9]/g, '');
            if (!global.bioIntervals) global.bioIntervals = {};
            global.bioIntervals[sanitizedNumber] = bioInterval;
        }
    } catch (error) {
        console.error(`❌ Error in auto-bio function for ${number}:`, error.message);
    }
}

function cleanupBioInterval(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (global.bioIntervals && global.bioIntervals[sanitizedNumber]) {
        clearInterval(global.bioIntervals[sanitizedNumber]);
        delete global.bioIntervals[sanitizedNumber];
        console.log(`🧹 Cleaned up bio interval for ${number}`);
    }
}

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

// Load silatech commands (kept as is)
const silatechDir = path.join(__dirname, 'silatech');
if (!fs.existsSync(silatechDir)) fs.mkdirSync(silatechDir, { recursive: true });
const files = fs.readdirSync(silatechDir).filter(file => file.endsWith('.js'));
console.log(`📦 Loading ${files.length} silatech commands...`);
for (const file of files) {
    try {
        require(path.join(silatechDir, file));
    } catch (e) {
        console.error(`❌ Failed to load silatech command ${file}:`, e);
    }
}

// ==============================================================================
// 2. SPECIFIC HANDLERS
// ==============================================================================

async function setupMessageHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const userConfig = await getUserConfigFromMongoDB(number);

        if (userConfig.AUTO_TYPING === 'true') {
            try { await socket.sendPresenceUpdate('composing', msg.key.remoteJid); } catch (error) {}
        }
        if (userConfig.AUTO_RECORDING === 'true') {
            try { await socket.sendPresenceUpdate('recording', msg.key.remoteJid); } catch (error) {}
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
                await socket.rejectCall(call.id, call.from);
                await socket.sendMessage(call.from, { text: userConfig.REJECT_MSG || 'Please do not call me! 😊' });
                console.log(`📞 Call rejected for ${number} from ${call.from}`);
            }
        } catch (err) { console.error(`Anti-call error for ${number}:`, err); }
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
            cleanupBioInterval(number);
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
            const isNormalError = statusCode === 408 || errorMessage?.includes('QR refs attempts ended');
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
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes, setHeader: () => {}, json: () => {} };
                    await startBot(number, mockRes);
                    console.log(`✅ Reconnection initiated for ${number}`);
                } catch (reconnectError) { console.error(`❌ Reconnection failed for ${number}:`, reconnectError); }
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
// 3. MAIN STARTBOT FUNCTION
// ==============================================================================

async function startBot(number, res = null) {
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
            if (res && !res.headersSent) return res.json({ status: 'connection_in_progress', message: 'Number is currently being connected' });
            return;
        }
        global[connectionLockKey] = true;

        const existingSession = await getSessionFromMongoDB(sanitizedNumber);

        if (!existingSession) {
            console.log(`🧹 No MongoDB session found for ${sanitizedNumber} - requiring NEW pairing`);
            if (fs.existsSync(sessionDir)) await fs.remove(sessionDir);
        } else {
            fs.ensureDirSync(sessionDir);
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
            console.log(`🔄 Restored existing session from MongoDB for ${sanitizedNumber}`);
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
            getMessage: async (key) => null
        });

        socketCreationTime.set(sanitizedNumber, Date.now());
        activeSockets.set(sanitizedNumber, conn);
        store.bind(conn.ev);

        setupMessageHandlers(conn, number);
        setupCallHandlers(conn, number);
        setupAutoRestart(conn, number);
        await setupAutoStatus(conn);

        conn.decodeJid = jid => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid;
            } else return jid;
        };

        conn.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
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
                    if (res && !res.headersSent) return res.json({ code: code, status: 'new_pairing', message: 'New pairing required' });
                } catch (err) {
                    console.error('❌ Pairing Error:', err.message);
                    if (res && !res.headersSent) return res.json({ error: 'Failed to generate pairing code', details: err.message });
                }
            }, 3000);
        } else if (res && !res.headersSent) {
            res.json({ status: 'reconnecting', message: 'Attempting to reconnect with existing session data' });
        }

        conn.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8');
            const creds = JSON.parse(fileContent);
            await saveSessionToMongoDB(sanitizedNumber, creds);
            console.log(`💾 Session updated in MongoDB for ${sanitizedNumber}`);
        });

        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                const userJid = jidNormalizedUser(conn.user.id);
                await addNumberToMongoDB(sanitizedNumber);

                // ==================== NEW WELCOME MESSAGE (JAMALI MD) ====================
                const connectText = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         🔥 JAMALI MD IS ACTIVE 🔥        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌─────────────────────────────────────────┐
│ ✅ Your bot is now ONLINE & READY!       │
│ 📌 ENJOY FREE BOT DONT FOLGET DO SHARE FOR FRIEND       │
│ ⌨️  Command prefix: ${config.PREFIX}      │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ 📢 *CHANNEL INFO*                        │
│ 🔗 Link : ${config.CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbC7AgJK5cD71vGIpO3h'}
│ 🆔 JID  : ${config.CHANNEL_JID || '120363425061263455@newsletter'}
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ 👥 *GROUP SUPPORT*                       │
│ 🔗 ${config.GROUP_LINK || 'https://chat.whatsapp.com/GPdlJ8ip88K39E5Hok7rJh'}
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ ⭐ STAR • 🔄 FORK • 📢 SHARE             │
│ 🐙 GitHub: https://github.com/Jamali-md/JAMALI-MD
└─────────────────────────────────────────┘

${config.BOT_FOOTER || '> 🔥 Powered by JAMALI TECH TZ'}`;

                try {
                    await conn.sendMessage(userJid, {
                        image: { url: config.IMAGE_PATH || 'https://files.catbox.moe/0e3rok.jpg' },
                        caption: connectText
                    });
                    console.log(`✅ Welcome message sent to ${sanitizedNumber}`);
                } catch (error) {
                    console.log(`⚠️ Could not send welcome message: ${error.message}`);
                    try {
                        await conn.sendMessage(userJid, { text: connectText });
                    } catch (err2) { /* ignore */ }
                }

                setTimeout(async () => {
                    try {
                        await autoFollowNewsletters(conn);
                        await autoUpdateBio(conn, number);
                    } catch (error) {
                        console.error('❌ Error in auto‑follow or bio update:', error.message);
                    }
                }, 5000);

                console.log(`🎉 ${sanitizedNumber} successfully connected!`);
            }

            if (connection === 'close') {
                let reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`❌ Session closed: Logged Out.`);
                    cleanupBioInterval(number);
                }
            }
        });

        conn.ev.on('call', async (calls) => {
            try {
                const userConfig = await getUserConfigFromMongoDB(number);
                if (userConfig.ANTI_CALL !== 'true') return;
                for (const call of calls) {
                    if (call.status !== 'offer') continue;
                    await conn.rejectCall(call.id, call.from);
                    await conn.sendMessage(call.from, { text: userConfig.REJECT_MSG || 'Please do not call me! 😊' });
                }
            } catch (err) { console.error("Anti‑call error:", err); }
        });

        conn.ev.on('messages.update', async (updates) => {
            await handleAntidelete(conn, updates, store);
        });

        // ===============================================================
        // 📥 MESSAGE HANDLER (UPSERT) - supports auto‑reply
        // ===============================================================
        conn.ev.on('messages.upsert', async (msg) => {
            try {
                let mek = msg.messages[0];
                if (!mek.message) return;

                const userConfig = await getUserConfigFromMongoDB(number);
                mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;
                if (mek.message.viewOnceMessageV2) mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

                if (userConfig.READ_MESSAGE === 'true') await conn.readMessages([mek.key]);

                if (mek.key && mek.key.remoteJid === 'status@broadcast') return;

                // React to single channel (if CHANNEL_JID set)
                const channelJid = config.CHANNEL_JID;
                if (channelJid && mek.key && mek.key.remoteJid === channelJid) {
                    try {
                        if (mek.newsletterServerId) {
                            const emojis = config.NEWSLETTER_REACTION_EMOJIS || ["🔥", "❤️", "⚡", "👑"];
                            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                            await conn.newsletterReactMessage(mek.key.remoteJid, mek.newsletterServerId.toString(), emoji);
                            console.log(`🎭 Reacted to newsletter with ${emoji}`);
                        }
                    } catch (e) { console.log(`⚠️ Could not react to newsletter: ${e.message}`); }
                }

                const m = sms(conn, mek);
                const type = getContentType(mek.message);
                const from = mek.key.remoteJid;
                const quoted = type == 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null ? mek.message.extendedTextMessage.contextInfo.quotedMessage || [] : [];
                const body = (type === 'conversation') ? mek.message.conversation : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';

                const antilinkSettingsPath = path.join(__dirname, './database/antilink.json');
                if (fs.existsSync(antilinkSettingsPath)) {
                    const antilinkSettings = JSON.parse(fs.readFileSync(antilinkSettingsPath, 'utf8'));
                    if (antilinkSettings[from] === true) await handleAntilink(conn, mek, from, m);
                }

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

                let groupMetadata = null, groupName = null, participants = null, groupAdmins = null, isBotAdmins = null, isAdmins = null;
                if (isGroup) {
                    try {
                        groupMetadata = await conn.groupMetadata(from);
                        groupName = groupMetadata.subject;
                        participants = groupMetadata.participants;
                        groupAdmins = getGroupAdmins(participants);
                        isBotAdmins = groupAdmins.includes(botNumber2);
                        isAdmins = groupAdmins.includes(sender);
                    } catch(e) {}
                }

                if (userConfig.AUTO_TYPING === 'true') await conn.sendPresenceUpdate('composing', from);
                if (userConfig.AUTO_RECORDING === 'true') await conn.sendPresenceUpdate('recording', from);

                const fakevCard = {
                    key: { fromMe: false, participant: "0@s.whatsapp.net", remoteJid: "status@broadcast" },
                    message: {
                        contactMessage: {
                            displayName: "© JAMALI TECH TZ",
                            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:JAMALI MD BOT\nORG:JAMALI TECH TZ;\nTEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER || '255784062158'}:+${config.OWNER_NUMBER || '255784062158'}\nEND:VCARD`
                        }
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    status: 1
                };

                const reply = (text) => conn.sendMessage(from, { text: text }, { quoted: fakevCard });
                const l = reply;

                // Auto‑reply (if enabled)
                if (config.AUTO_REPLY_ENABLE === 'true' && config.AUTO_REPLIES) {
                    const lowerBody = body.toLowerCase().trim();
                    for (const [key, replyMsg] of Object.entries(config.AUTO_REPLIES)) {
                        if (lowerBody === key || lowerBody.includes(key)) {
                            await conn.sendMessage(from, { text: replyMsg }, { quoted: mek });
                            break;
                        }
                    }
                }

                // "send" command (status saver)
                const cmdNoPrefix = body.toLowerCase().trim();
                if (["send", "sendme", "sand"].includes(cmdNoPrefix)) {
                    if (!mek.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        await conn.sendMessage(from, { text: "*Reply to a status to send it! 😊*" }, { quoted: mek });
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

                // Execute silatech commands
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
                                reply, config, fakevCard
                            });
                        } catch (e) { console.error("[silatech ERROR] " + e); }
                    }
                }

                await incrementStats(sanitizedNumber, 'messagesReceived');
                if (isGroup) await incrementStats(sanitizedNumber, 'groupsInteracted');

                // Execute events
                events.commands.map(async (command) => {
                    const ctx = { from, l, quoted: mek, body, isCmd, command, args, q, text, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply, config, fakevCard };
                    if (body && command.on === "body") command.function(conn, mek, m, ctx);
                    else if (mek.q && command.on === "text") command.function(conn, mek, m, ctx);
                    else if ((command.on === "image" || command.on === "photo") && mek.type === "imageMessage") command.function(conn, mek, m, ctx);
                    else if (command.on === "sticker" && mek.type === "stickerMessage") command.function(conn, mek, m, ctx);
                });

            } catch (e) { console.error(e); }
        });

    } catch (err) {
        console.error(err);
        if (res && !res.headersSent) return res.json({ error: 'Internal Server Error', details: err.message });
    } finally {
        if (connectionLockKey) global[connectionLockKey] = false;
    }
}

// ==============================================================================
// 4. API ROUTES
// ==============================================================================

router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'dashboard.html'));
});
router.get('/config-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'config.html'));
});
router.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'admin-panel.html'));
});
router.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'settings.html'));
});

router.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    await startBot(number, res);
});

router.get('/status', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        const activeConnections = Array.from(activeSockets.keys()).map(num => {
            const status = getConnectionStatus(num);
            return { number: num, status: 'connected', connectionTime: status.connectionTime, uptime: `${status.uptime} seconds` };
        });
        return res.json({ totalActive: activeSockets.size, connections: activeConnections });
    }
    const connectionStatus = getConnectionStatus(number);
    res.json({
        number: number,
        isConnected: connectionStatus.isConnected,
        connectionTime: connectionStatus.connectionTime,
        uptime: `${connectionStatus.uptime} seconds`,
        message: connectionStatus.isConnected ? 'Number is actively connected' : 'Number is not connected'
    });
});

router.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number parameter is required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (!activeSockets.has(sanitizedNumber)) return res.status(404).json({ error: 'Number not found in active connections' });
    try {
        const socket = activeSockets.get(sanitizedNumber);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        await removeNumberFromMongoDB(sanitizedNumber);
        await deleteSessionFromMongoDB(sanitizedNumber);
        console.log(`✅ Manually disconnected ${sanitizedNumber}`);
        res.json({ status: 'success', message: 'Number disconnected successfully' });
    } catch (error) {
        console.error(`Error disconnecting ${sanitizedNumber}:`, error);
        res.status(500).json({ error: 'Failed to disconnect number' });
    }
});

router.get('/active', (req, res) => {
    res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

router.get('/ping', (req, res) => {
    res.json({ status: 'active', message: 'JAMALI MD is running', activeSessions: activeSockets.size, database: 'MongoDB Integrated' });
});

router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) return res.status(404).json({ error: 'No numbers found to connect' });
        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, json: () => {}, status: () => mockRes };
            await startBot(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
            await delay(1000);
        }
        res.json({ status: 'success', total: numbers.length, connections: results });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).json({ error: 'Failed to connect all bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) return res.status(400).json({ error: 'Number and config are required' });
    let newConfig;
    try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).json({ error: 'Invalid config format' }); }
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) return res.status(404).json({ error: 'No active session found for this number' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await saveOTPToMongoDB(sanitizedNumber, otp, newConfig);
    try {
        const userJid = jidNormalizedUser(socket.user.id);
        await socket.sendMessage(userJid, { text: `*🔐 CONFIGURATION UPDATE*\n\nYour OTP: *${otp}*\nValid for 5 minutes\n\nUse: .verify-otp ${otp}` });
        res.json({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        console.error('Failed to send OTP:', error);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) return res.status(400).json({ error: 'Number and OTP are required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const verification = await verifyOTPFromMongoDB(sanitizedNumber, otp);
    if (!verification.valid) return res.status(400).json({ error: verification.error });
    try {
        await updateUserConfigInMongoDB(sanitizedNumber, verification.config);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: `*✅ CONFIG UPDATED*\n\nYour configuration has been successfully updated!\n\nChanges saved in MongoDB.` });
        }
        res.json({ status: 'success', message: 'Config updated successfully in MongoDB' });
    } catch (error) {
        console.error('Failed to update config in MongoDB:', error);
        res.status(500).json({ error: 'Failed to update config' });
    }
});

router.get('/stats', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    try {
        const stats = await getStatsForNumber(number);
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const connectionStatus = getConnectionStatus(sanitizedNumber);
        res.json({ number: sanitizedNumber, connectionStatus: connectionStatus.isConnected ? 'Connected' : 'Disconnected', uptime: connectionStatus.uptime, stats: stats });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

router.get('/api/config/global', async (req, res) => { res.json(config); });
router.post('/api/config/global', async (req, res) => {
    try {
        const newConfig = req.body;
        Object.assign(config, newConfig);
        const envContent = Object.entries(newConfig).map(([key, value]) => `${key}=${value}`).join('\n');
        fs.writeFileSync('.env', envContent);
        res.json({ status: 'success', message: 'Config updated' });
    } catch(error) { res.status(500).json({ error: error.message }); }
});
router.get('/api/config', async (req, res) => {
    const { number } = req.query;
    if(!number) return res.status(400).json({ error: 'Number required' });
    const userConfig = await getUserConfigFromMongoDB(number);
    res.json(userConfig);
});
router.post('/api/config/update', async (req, res) => {
    const { number, config: newConfig } = req.body;
    if(!number) return res.status(400).json({ error: 'Number required' });
    await updateUserConfigInMongoDB(number, newConfig);
    res.json({ status: 'success' });
});

// ==============================================================================
// 5. AUTO RECONNECT AT STARTUP
// ==============================================================================
async function autoReconnectFromMongoDB() {
    try {
        console.log('🔁 Attempting auto-reconnect from MongoDB...');
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) { console.log('ℹ️ No numbers found in MongoDB for auto-reconnect'); return; }
        console.log(`📊 Found ${numbers.length} numbers in MongoDB`);
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                console.log(`🔁 Reconnecting: ${number}`);
                const mockRes = { headersSent: false, json: () => {}, status: () => mockRes };
                await startBot(number, mockRes);
                await delay(2000);
            } else { console.log(`✅ Already connected: ${number}`); }
        }
        console.log('✅ Auto-reconnect completed');
    } catch (error) { console.error('❌ autoReconnectFromMongoDB error:', error.message); }
}
setTimeout(() => { autoReconnectFromMongoDB(); }, 3000);
setTimeout(() => { startTelegramBot(); }, 5000);

// ==============================================================================
// 6. CLEANUP ON EXIT
// ==============================================================================
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        if(socket.ws) socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) fs.emptyDirSync(sessionDir);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    if (process.env.PM2_NAME) {
        const { exec } = require('child_process');
        exec(`pm2 restart ${process.env.PM2_NAME}`);
    }
});

module.exports = router;
