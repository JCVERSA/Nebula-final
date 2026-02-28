'use strict';
/**
 * Nebula Bot — Pairing Server
 * by Dark Neon
 *
 * Flux :
 * 1. L'utilisateur entre son numéro sur le site
 * 2. Le serveur génère un Pair Code via Baileys
 * 3. L'utilisateur entre le code dans WhatsApp
 * 4. Une fois connecté, le serveur lit creds.json
 * 5. Encode en base64 → envoie le SESSION ID par WhatsApp
 * 6. L'utilisateur colle le SESSION ID dans config.js de Nebula Bot
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');
const QRCode  = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  delay,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

// ─── Setup ───────────────────────────────────────────────────────────────────
const app    = express();
const PORT   = process.env.PORT || 3000;
const logger = pino({ level: 'silent' });

// Dossier temporaire pour les sessions de pairing
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Stock des sessions QR actives
const qrSessions = new Map();

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function cleanNumber(number) {
  return number.replace(/[^0-9]/g, '');
}

function makeTempDir() {
  const id = 'nebula_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(TEMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('[Cleanup] Error:', e.message);
  }
}

// ─── Envoyer le SESSION ID par WhatsApp ──────────────────────────────────────
async function sendSession(sock, targetJid, sessionDir) {
  try {
    await delay(3000);

    const credsPath = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      console.error('[Session] creds.json not found');
      return;
    }

    const credsData   = fs.readFileSync(credsPath, 'utf-8');
    const base64Creds = Buffer.from(credsData).toString('base64');

    // Message 1 : SESSION ID en texte
    await sock.sendMessage(targetJid, {
      text:
        '*🌌 Nebula Bot — Session ID*\n\n' +
        base64Creds + '\n\n' +
        '> ⚠️ Ne partage jamais ce code avec personne !\n' +
        '> _Nebula Bot by Dark Neon_',
    });

    await delay(1000);

    // Message 2 : creds.json en fichier (backup)
    await sock.sendMessage(targetJid, {
      document: Buffer.from(credsData),
      mimetype: 'application/json',
      fileName: 'creds.json',
      caption:  'Nebula Bot — Fichier de session (backup)',
    });

    console.log('[Session] ✅ SESSION ID envoyé à', targetJid);
  } catch (e) {
    console.error('[Session] Erreur envoi:', e.message);
  }
}

// ─── ROUTE : Pair Code ────────────────────────────────────────────────────────
app.get('/pair', async (req, res) => {
  const raw = req.query.number;
  if (!raw) return res.status(400).json({ error: 'Numéro requis' });

  const number = cleanNumber(raw);
  if (number.length < 7 || number.length > 15) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  const { id, dir } = makeTempDir();
  let sock = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
    });

    // Générer le pair code
    if (!sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(number);
      const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

      console.log('[Pair] Code généré:', formattedCode, 'pour', number);

      // Écouter la connexion en arrière-plan
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (update) => {
        const { connection } = update;

        if (connection === 'open') {
          console.log('[Pair] ✅ WhatsApp connecté !');
          const targetJid = number + '@s.whatsapp.net';
          await sendSession(sock, targetJid, dir);
          await delay(2000);
          try { sock.end(); } catch (e) {}
          cleanupDir(dir);
        }

        if (connection === 'close') {
          cleanupDir(dir);
        }
      });

      // Répondre immédiatement avec le code
      return res.json({ code: formattedCode });
    }

    // Déjà enregistré
    cleanupDir(dir);
    return res.status(400).json({ error: 'Session déjà active — réessaie dans quelques secondes' });

  } catch (err) {
    console.error('[Pair] Erreur:', err.message);
    cleanupDir(dir);
    if (sock) { try { sock.end(); } catch (e) {} }
    return res.status(500).json({ error: 'Impossible de générer le pair code. Réessaie.' });
  }
});

// ─── ROUTE : QR Code ─────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  const { id, dir } = makeTempDir();
  let sock = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
    });

    // Attendre le premier QR (max 30s)
    let qrResolve;
    const qrPromise = new Promise((resolve) => { qrResolve = resolve; });
    const timeout   = setTimeout(() => qrResolve({ error: 'Timeout' }), 30000);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          qrSessions.set(id, { qr: qrDataUrl, status: 'pending' });
          clearTimeout(timeout);
          qrResolve({ qr: qrDataUrl, sessionId: id });
        } catch (e) {
          qrResolve({ error: 'Erreur génération QR' });
        }
      }

      if (connection === 'open') {
        console.log('[QR] ✅ WhatsApp connecté !');
        qrSessions.set(id, { status: 'connected' });

        const userJid = sock.user?.id;
        if (userJid) {
          const cleanJid = userJid.split(':')[0] + '@s.whatsapp.net';
          await sendSession(sock, cleanJid, dir);
        }

        await delay(2000);
        try { sock.end(); } catch (e) {}
        cleanupDir(dir);
        setTimeout(() => qrSessions.delete(id), 30000);
      }

      if (connection === 'close') {
        qrSessions.set(id, { status: 'closed' });
        cleanupDir(dir);
        setTimeout(() => qrSessions.delete(id), 30000);
      }
    });

    const result = await qrPromise;
    return res.json(result);

  } catch (err) {
    console.error('[QR] Erreur:', err.message);
    cleanupDir(dir);
    if (sock) { try { sock.end(); } catch (e) {} }
    return res.status(500).json({ error: 'Impossible de générer le QR. Réessaie.' });
  }
});

// ─── ROUTE : QR Status (polling) ─────────────────────────────────────────────
app.get('/qr-status/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'expired' });
  return res.json(session);
});

// ─── ROUTE : Status serveur ───────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ status: 'online', bot: 'Nebula Bot', author: 'Dark Neon' });
});

// ─── Servir le site HTML ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🌌 ================================');
  console.log('   Nebula Bot — Pairing Server');
  console.log('   by Dark Neon');
  console.log('================================');
  console.log('🚀 Port    :', PORT);
  console.log('🌐 URL     : http://localhost:' + PORT);
  console.log('================================\n');
});
