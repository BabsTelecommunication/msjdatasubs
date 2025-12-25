/**
 * BABSPAY WHATSAPP BRIDGE
 * Stable Baileys Implementation
 */

const crypto = require('crypto');
global.crypto = crypto;

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const express = require('express');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs');
const NodeCache = require('node-cache');

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://msjdatasubs.com.ng/bot/route.php';
const API_SECRET = process.env.API_SECRET || 'changethis_secret_key';

// Persistent storage (Render / VPS safe)
const DISK_PATH = '/var/lib/data';
const AUTH_DIR = fs.existsSync(DISK_PATH)
    ? `${DISK_PATH}/auth_info_baileys`
    : 'auth_info_baileys';

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

console.log('Auth Storage:', AUTH_DIR);

// ================= GLOBAL STATE =================
let sock = null;
let pairingCode = null;
let connectionStatus = 'starting';
const msgRetryCounterCache = new NodeCache();

// ================= WHATSAPP BACKEND =================
async function startWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        console.log('WhatsApp Protocol Version:', version);

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            keepAliveIntervalMs: 20000,
            msgRetryCounterCache
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            console.log('Connection Update:', update);

            if (connection === 'open') {
                connectionStatus = 'connected';
                pairingCode = null;
                console.log('✅ WhatsApp Connected');
            }

            if (connection === 'close') {
                connectionStatus = 'disconnected';

                const statusCode =
                    lastDisconnect?.error?.output?.statusCode || 500;

                const shouldReconnect =
                    statusCode !== DisconnectReason.loggedOut;

                console.log(`❌ Connection Closed (${statusCode})`);

                if (shouldReconnect) {
                    console.log('🔁 Reconnecting in 30 seconds...');
                    setTimeout(startWhatsApp, 30000);
                } else {
                    console.log('🚨 Logged out. Clearing session...');
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    setTimeout(startWhatsApp, 5000);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.fromMe) continue;

                const text =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    '';

                const from = msg.key.remoteJid;

                console.log(`📩 ${from}: ${text}`);

                try {
                    await axios.post(PHP_WEBHOOK_URL, {
                        secret: API_SECRET,
                        type: 'message',
                        data: {
                            from,
                            body: text,
                            name: msg.pushName || 'User'
                        }
                    });
                } catch (err) {
                    console.error('Webhook Error:', err.message);
                }
            }
        });

    } catch (err) {
        console.error('Startup Error:', err);
        setTimeout(startWhatsApp, 30000);
    }
}

// ================= EXPRESS SERVER =================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    let html = '';

    if (connectionStatus === 'connected') {
        html = `<h2 style="color:green">✅ WhatsApp Connected</h2>`;
    } else if (pairingCode) {
        html = `
        <h2>Link WhatsApp</h2>
        <h3>Pairing Code</h3>
        <div style="font-size:24px;letter-spacing:3px">${pairingCode}</div>
        <p>WhatsApp → Settings → Linked Devices → Link with phone number</p>
        <a href="/">Refresh</a>
        `;
    } else {
        html = `
        <h2>WhatsApp Bridge</h2>
        <p>Status: ${connectionStatus}</p>
        <form method="POST" action="/pair">
            <input name="phone" placeholder="2348012345678" required />
            <br/><br/>
            <button>Get Pairing Code</button>
        </form>
        <br/>
        <a href="/reset" style="color:red">Reset Session</a>
        `;
    }

    res.send(`<html><body style="text-align:center;font-family:sans-serif">${html}</body></html>`);
});

app.post('/pair', async (req, res) => {
    const phone = req.body.phone;

    if (!sock) return res.send('Socket not ready. Wait.');

    if (sock.authState.creds.registered)
        return res.send('Already paired.');

    if (connectionStatus === 'connected')
        return res.send('Already connected.');

    res.send('Requesting pairing code... Refresh page in 5 seconds.');

    setTimeout(async () => {
        try {
            const code = await sock.requestPairingCode(phone);
            pairingCode = code?.match(/.{1,4}/g)?.join('-');
            console.log('🔐 Pairing Code:', pairingCode);
        } catch (err) {
            console.error('Pairing Error:', err.message);
        }
    }, 3000);
});

app.post('/send-message', async (req, res) => {
    const { secret, to, message } = req.body;

    if (secret !== API_SECRET)
        return res.status(403).json({ error: 'Forbidden' });

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reset', (req, res) => {
    try {
        if (sock) sock.end();
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        res.send('Session reset. Restarting...');
        setTimeout(() => process.exit(0), 1000);
    } catch (e) {
        res.send('Reset failed');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startWhatsApp();
});
