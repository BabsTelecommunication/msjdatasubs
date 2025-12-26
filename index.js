/**
 * BABSPAY WHATSAPP BRIDGE
 * SAFE & STABLE BAILEYS SETUP (v5+)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const NodeCache = require('node-cache');
const QRCode = require('qrcode');
const crypto = require('crypto');
global.crypto = crypto;

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'change_this_secret';
const PHP_WEBHOOK_URL =
    process.env.PHP_WEBHOOK_URL || 'https://msjdatasubs.com.ng/bot/route.php';

const DATA_DIR = '/var/lib/data';
const AUTH_DIR = fs.existsSync(DATA_DIR)
    ? path.join(DATA_DIR, 'auth_info_baileys')
    : path.join(__dirname, 'auth_info_baileys');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

console.log('🔐 Auth Path:', AUTH_DIR);

/* ================= GLOBAL STATE ================= */

let sock;
let qrCode = null;
let qrImage = null;
let connectionStatus = 'starting';

const msgRetryCounterCache = new NodeCache();

/* ================= WHATSAPP ================= */

async function startWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'), // ✔ correct fingerprint
            printQRInTerminal: true,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            keepAliveIntervalMs: 25000,
            msgRetryCounterCache
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                qrImage = await QRCode.toDataURL(qr);
                connectionStatus = 'scan_qr';
            }

            console.log('📡 Connection:', connection);

            if (connection === 'open') {
                qrCode = null;
                qrImage = null;
                connectionStatus = 'connected';
                console.log('✅ WhatsApp Connected');
            }

            if (connection === 'close') {
                connectionStatus = 'disconnected';

                const statusCode =
                    lastDisconnect?.error?.output?.statusCode || 500;

                console.log('❌ Connection Closed:', statusCode);

                // Clean auth on handshake / protocol failure
                if ([401, 403, 405, 428, 500].includes(statusCode)) {
                    console.log('🧹 Clearing auth state...');
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }

                // Logged out completely
                if (
                    lastDisconnect?.error?.output?.statusCode ===
                    DisconnectReason.loggedOut
                ) {
                    console.log('🚨 Logged out, resetting session...');
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }

                console.log('🔁 Reconnecting in 2 minutes...');
                setTimeout(startWhatsApp, 120000);
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
                        from,
                        message: text,
                        name: msg.pushName || 'User'
                    });
                } catch (err) {
                    console.error('❌ Webhook error:', err.message);
                }
            }
        });

    } catch (err) {
        console.error('🚨 Startup error:', err);
        setTimeout(startWhatsApp, 120000);
    }
}

/* ================= EXPRESS ================= */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    let html = '';

    if (connectionStatus === 'connected') {
        html = `<h2 style="color:green">✅ WhatsApp Connected</h2>`;
    } else if (qrImage) {
        html = `
            <h2>📲 Scan QR Code</h2>
            <img src="${qrImage}" />
            <p>WhatsApp → Linked Devices → Link a device</p>
            <small>Refresh if QR expires</small>
        `;
    } else {
        html = `<h3>Status: ${connectionStatus}</h3>`;
    }

    res.send(`<html><body style="text-align:center;font-family:sans-serif">${html}</body></html>`);
});

app.post('/send-message', async (req, res) => {
    const { secret, to, message } = req.body;

    if (secret !== API_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reset', (req, res) => {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.send('Session reset. Restart server.');
    setTimeout(() => process.exit(0), 1000);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startWhatsApp();
});
