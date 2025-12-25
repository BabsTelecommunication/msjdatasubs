const crypto = require('crypto');
global.crypto = crypto; // Polyfill for Baileys
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs');
const NodeCache = require('node-cache');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://msjdatasubs.com.ng/bot/route.php';
const API_SECRET = process.env.API_SECRET || 'changethis_secret_key';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PERSISTENCE CONFIGURATION
// Check if Render Persistent Disk is available at /var/lib/data
const DISK_PATH = '/var/lib/data';
const AUTH_DIR = fs.existsSync(DISK_PATH) ? `${DISK_PATH}/auth_info_baileys` : 'auth_info_baileys';
console.log(`Storage Path: ${AUTH_DIR}`);

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Global State
let pairingCode = null;
let connectionStatus = 'initializing';
let sock = null;
const msgRetryCounterCache = new NodeCache();

// Main Socket function
async function backend() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'warn' }),
        browser: ['Chrome (Linux)', 'Chrome', '124.0.6367.60'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        usePairingCode: true,
        msgRetryCounterCache
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        console.log('Connection Update:', update);

        if (connection === 'close') {
            const err = lastDisconnect?.error;
            const statusCode = (err && err.output && err.output.statusCode) ? err.output.statusCode : 500;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`);

            connectionStatus = 'disconnected';

            if (shouldReconnect) {
                setTimeout(() => backend(), 5000);
            } else {
                console.log('Logged out. Clearing auth and restarting...');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                backend();
            }
        } else if (connection === 'open') {
            console.log('Opened connection to WhatsApp!');
            connectionStatus = 'connected';
            pairingCode = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const remoteJid = msg.key.remoteJid;
                    const textMessage = msg.message.conversation ||
                        msg.message.extendedTextMessage?.text ||
                        msg.message.imageMessage?.caption || "";

                    console.log(`Msg from ${remoteJid}: ${textMessage}`);

                    try {
                        await axios.post(PHP_WEBHOOK_URL, {
                            secret: API_SECRET,
                            type: 'message',
                            data: {
                                from: remoteJid,
                                body: textMessage,
                                name: msg.pushName || 'User'
                            }
                        });
                    } catch (error) {
                        console.error("Forwarding Error:", error.message);
                    }
                }
            }
        }
    });
}

// --- WEB INTERFACE ---
app.get('/', (req, res) => {
    let content = '';

    if (connectionStatus === 'connected') {
        content = `<h1 style="color:green">Active & Connected!</h1><p>The bot is running successfully.</p>`;
    } else if (pairingCode) {
        content = `
            <h1>Link with Phone Number</h1>
            <h3>Pairing Code: <span style="background:#eee; padding:5px 10px; letter-spacing:3px;">${pairingCode}</span></h3>
            <p>1. Open WhatsApp on your phone</p>
            <p>2. Go to Settings > Linked Devices > Link a Device > <b>Link with phone number</b></p>
            <p>3. Enter the code above.</p>
            <p><a href="/">Refresh Code</a></p>
        `;
    } else {
        content = `
            <h1>WhatsApp Bridge Setup</h1>
            <p>Status: ${connectionStatus}</p>
            <p style="font-size:0.8em; color:gray;">(Status 405 is normal during initial startup loop, wait for 'connected')</p>
            <form action="/pair" method="POST">
                <label>Enter Bot Phone Number (e.g. 2348012345678):</label><br/>
                <input type="text" name="phone" required placeholder="23480..." style="padding:10px; margin:10px; width:200px;"><br/>
                <button type="submit" style="padding:10px 20px;">Get Pairing Code</button>
            </form>
             <br/><br/>
            <a href="/reset" style="color:red; font-size:0.8em;">[Panic Button] Reset Session</a>
        `;
    }

    res.send(`
        <html>
        <head>
            <title>WhatsApp Bridge</title>
            <style>body{font-family:sans-serif; text-align:center; padding-top:50px;}</style>
        </head>
        <body>${content}</body>
        </html>
    `);
});

app.post('/pair', async (req, res) => {
    const phone = req.body.phone;
    if (!phone) return res.send('Phone required');

    if (!sock) return res.send('Socket not ready. Wait a few seconds.');

    if (sock.authState.creds.registered) {
        return res.send('Error: Bot is ALREADY registered! Reset session if you want to re-pair.');
    }

    if (connectionStatus === 'connected') return res.send('Already Connected!');

    console.log("Requesting Pairing Code for:", phone);
    res.send('Requesting code... Please wait 5 seconds then <a href="/">Click Here to Refresh</a>.');

    setTimeout(async () => {
        try {
            if (!sock.authState.creds.registered) {
                const code = await sock.requestPairingCode(phone);
                pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log("Pairing Code generated:", pairingCode);
            }
        } catch (e) {
            console.error("Pairing Error:", e.message);
        }
    }, 1000);
});

app.post('/send-message', async (req, res) => {
    const { secret, to, message } = req.body;
    if (secret !== API_SECRET) return res.status(403).json({ error: 'Access Denied' });

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'success' });
    } catch (error) {
        res.status(500).json({ error: 'Failed', details: error.message });
    }
});

app.get('/reset', (req, res) => {
    try {
        if (sock) {
            try { sock.end(undefined); } catch { }
            sock = null;
        }
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        res.send('Reset. Restarting...');
        setTimeout(() => process.exit(0), 1000);
    } catch (e) {
        res.send("Reset failed: " + e.message);
    }
});

app.listen(PORT, () => {
    console.log(`Bridge listening on port ${PORT}`);
    backend();
});
