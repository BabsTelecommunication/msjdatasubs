# Babspay WhatsApp Bridge (Option 2)

This folder contains the Node.js application that bridges the gap between WhatsApp (using the connection on your server) and your PHP Shared Hosting.

## How it works
1.  **Node.js App (Here)**: Runs on a cloud provider (Render/Railway). It connects to WhatsApp 24/7.
2.  **Incoming Messages**: When a message comes to WhatsApp, this app sends a `POST` request to your shared hosting: `https://babspay.com.ng/bot/bridge_webhook.php`.
3.  **Outgoing Messages**: When your PHP script wants to reply, it sends a `POST` request to this app: `https://your-render-app-url.com/send-message`.

## Setup Instructions

### 1. Deploy this folder to Render (Free Tier)
1.  Create a GitHub repository and upload this `bot_bridge` folder content.
2.  Go to **Render.com** -> New **Web Service**.
3.  Connect your repo.
4.  **Runtime**: Node
5.  **Build Command**: `npm install`
6.  **Start Command**: `npm start`
7.  **Environment Variables**:
    *   `PHP_WEBHOOK_URL`: `https://babspay.com.ng/bot/bridge_webhook.php`
    *   `API_SECRET`: `my_secure_password_123` (Change this!)

### 2. Connect WhatsApp
1.  Once deployed, look at the **Logs** in Render.
2.  You will see a QR Code (text format).
3.  Scan it with your WhatsApp (Linked Devices).

### 3. Configure PHP
1.  Edit `bot/bridge_webhook.php`: Update `$API_SECRET` to match the one you set in Render.
2.  Update your PHP bot logic to send replies to the new Bridge URL instead of the Meta Graph API.
    *   **Url**: `https://your-app-name.onrender.com/send-message`
    *   **Body**: `{"secret": "...", "to": "...", "message": "..."}`

## Local Testing
1.  Install Node.js
2.  Run `npm install`
3.  Run `npm start`
4.  Scan QR code in terminal.
