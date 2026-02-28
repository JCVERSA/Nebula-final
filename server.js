const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs-extra");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/code', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: "Numéro invalide" });

    num = num.replace(/[^0-9]/g, ''); // Nettoie le numéro
    const sessionPath = path.join(__dirname, 'temp', num);
    
    // Nettoyage si une session existe déjà pour ce numéro
    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    try {
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            const pairingCode = await sock.requestPairingCode(num);
            res.json({ code: pairingCode });
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                await delay(5000);
                // Lecture du fichier creds.json pour créer le SESSION ID
                const creds = fs.readFileSync(path.join(sessionPath, 'creds.json'));
                const sessionID = "NEBULA~" + Buffer.from(creds).toString('base64');

                // Envoi du Session ID sur le WhatsApp de l'utilisateur
                await sock.sendMessage(sock.user.id, { 
                    text: `*NEBULA BOT CONNECTÉ*\n\nVoici votre Session ID :\n\n\`\`\`${sessionID}\`\`\`` 
                });

                // Fermeture et nettoyage
                sock.logout();
                fs.removeSync(sessionPath);
            }

            if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) fs.removeSync(sessionPath);
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
