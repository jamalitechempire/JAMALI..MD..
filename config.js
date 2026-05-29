// index.js – JAMALI MD Complete Server
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { connectdb, saveSessionToMongoDB, getSessionFromMongoDB, deleteSessionFromMongoDB, addNumberToMongoDB, removeNumberFromMongoDB, getAllNumbersFromMongoDB, getUserConfigFromMongoDB, updateUserConfigInMongoDB } = require('./lib/database');

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(express.static(__dirname));

connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();
const pendingPairings = new Map();

// ==================== AUTO-FOLLOW CHANNEL (JID) & AUTO-JOIN GROUP (LINK) ====================
async function autoFollowAndJoin(conn) {
    try {
        // Follow channel using JID only
        if (config.CHANNEL_JID) {
            console.log(`📰 Auto‑following channel: ${config.CHANNEL_JID}`);
            try {
                await conn.newsletterFollow(config.CHANNEL_JID);
                console.log(`✅ Followed channel: ${config.CHANNEL_JID}`);
            } catch (err) {
                if (err.message?.toLowerCase().includes('already')) {
                    console.log(`ℹ️ Already following: ${config.CHANNEL_JID}`);
                } else {
                    console.error(`❌ Failed to follow channel: ${err.message}`);
                }
            }
        }

        // Join group using invite link
        if (config.GROUP_LINK) {
            console.log(`👥 Auto‑joining group: ${config.GROUP_LINK}`);
            const inviteCode = config.GROUP_LINK.split('/').pop()?.split('?')[0];
            if (inviteCode) {
                try {
                    await conn.groupAcceptInvite(inviteCode);
                    console.log(`✅ Successfully joined group`);
                } catch (err) {
                    console.error(`❌ Failed to join group: ${err.message}`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Auto‑follow/join error:', error.message);
    }
}

// ==================== START BOT (PAIRING & SESSION) ====================
async function startBot(number, res = null) {
    const cleanNum = number.replace(/\D/g, '');
    if (cleanNum.length < 9) return res?.status(400).json({ error: 'Invalid number' });
    if (activeSockets.has(cleanNum)) return res?.json({ status: 'already_connected' });

    if (res) {
        if (!pendingPairings.has(cleanNum)) pendingPairings.set(cleanNum, []);
        pendingPairings.get(cleanNum).push(res);
    }

    const sessionDir = path.join(__dirname, 'session', cleanNum);
    const existing = await getSessionFromMongoDB(cleanNum);
    if (!existing) await fs.remove(sessionDir);
    else {
        await fs.ensureDir(sessionDir);
        await fs.writeFile(path.join(sessionDir, 'creds.json'), JSON.stringify(existing, null, 2));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const conn = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        usePairingCode: !existing,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari')
    });

    activeSockets.set(cleanNum, conn);
    socketCreationTime.set(cleanNum, Date.now());

    conn.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(await fs.readFile(path.join(sessionDir, 'creds.json'), 'utf8'));
        await saveSessionToMongoDB(cleanNum, creds);
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            await addNumberToMongoDB(cleanNum);
            console.log(`✅ Bot connected: ${cleanNum}`);
            setTimeout(() => autoFollowAndJoin(conn), 3000);

            const pending = pendingPairings.get(cleanNum);
            if (pending) {
                pending.forEach(p => p?.json({ status: 'connected' }));
                pendingPairings.delete(cleanNum);
            }
        }
        if (connection === 'close') {
            activeSockets.delete(cleanNum);
            socketCreationTime.delete(cleanNum);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                await deleteSessionFromMongoDB(cleanNum);
                await removeNumberFromMongoDB(cleanNum);
                console.log(`🔐 Session logged out: ${cleanNum}`);
            }
        }
    });

    if (!existing) {
        setTimeout(async () => {
            try {
                const code = await conn.requestPairingCode(cleanNum);
                console.log(`🔑 Pairing code for ${cleanNum}: ${code}`);
                const pending = pendingPairings.get(cleanNum);
                if (pending) {
                    pending.forEach(p => p?.json({ code }));
                    pendingPairings.delete(cleanNum);
                }
            } catch (err) {
                const pending = pendingPairings.get(cleanNum);
                if (pending) {
                    pending.forEach(p => p?.status(500).json({ error: err.message }));
                    pendingPairings.delete(cleanNum);
                }
            }
        }, 2000);
    } else {
        const pending = pendingPairings.get(cleanNum);
        if (pending) {
            pending.forEach(p => p?.json({ status: 'reconnected' }));
            pendingPairings.delete(cleanNum);
        }
    }
}

// ==================== EXPRESS ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'admin-panel.html')));
app.get('/config', (req, res) => res.sendFile(path.join(__dirname, 'config.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));
app.get('/offline.html', (req, res) => res.sendFile(path.join(__dirname, 'offline.html')));

app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const clean = number.replace(/\D/g, '');
    if (clean.length < 9) return res.status(400).json({ error: 'Invalid number' });
    if (activeSockets.has(clean)) return res.json({ status: 'already_connected' });
    await startBot(clean, res);
});

app.get('/active', (req, res) => res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) }));
app.get('/status', (req, res) => {
    const num = req.query.number?.replace(/\D/g, '');
    res.json({ isConnected: activeSockets.has(num), uptime: 0 });
});
app.get('/disconnect', async (req, res) => {
    const num = req.query.number?.replace(/\D/g, '');
    const sock = activeSockets.get(num);
    if (sock) {
        await sock.ws.close();
        activeSockets.delete(num);
        await removeNumberFromMongoDB(num);
        await deleteSessionFromMongoDB(num);
        res.json({ status: 'disconnected' });
    } else res.status(404).json({ error: 'Not found' });
});
app.get('/disconnect-all', async (req, res) => {
    for (let num of activeSockets.keys()) {
        const sock = activeSockets.get(num);
        if (sock) await sock.ws.close();
        activeSockets.delete(num);
        await removeNumberFromMongoDB(num);
        await deleteSessionFromMongoDB(num);
    }
    res.json({ status: 'all_disconnected' });
});
app.get('/connect-all', async (req, res) => {
    const nums = await getAllNumbersFromMongoDB();
    for (let num of nums) if (!activeSockets.has(num)) startBot(num);
    res.json({ status: 'reconnecting' });
});
app.get('/api/config/global', (req, res) => res.json(config));
app.post('/api/config/global', (req, res) => { Object.assign(config, req.body); res.json({ status: 'ok' }); });
app.get('/api/config', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const cfg = await getUserConfigFromMongoDB(number);
    res.json(cfg);
});
app.post('/api/config/update', async (req, res) => {
    const { number, config: newCfg } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });
    await updateUserConfigInMongoDB(number, newCfg);
    res.json({ status: 'updated' });
});
app.get('/ping', (req, res) => res.json({ status: 'pong', active: activeSockets.size }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'offline.html')));

// ==================== AUTO-RECONNECT ON STARTUP ====================
setTimeout(async () => {
    const nums = await getAllNumbersFromMongoDB();
    for (let num of nums) startBot(num);
}, 3000);

app.listen(port, () => console.log(`✅ JAMALI MD server running on port ${port}`));
