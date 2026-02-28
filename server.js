const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore 
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "Numéro requis" });

    phone = phone.replace(/[^0-9]/g, '');
    const sessionDir = `./sessions/${phone}_${Date.now()}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    try {
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            const code = await sock.requestPairingCode(phone);
            res.json({ code: code });
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await delay(5000);
                // Lecture du fichier creds.json
                const credsData = fs.readFileSync(`${sessionDir}/creds.json`, 'utf-8');
                const base64Session = Buffer.from(credsData).toString('base64');
                const sessionId = `NEBULA_BOT~${base64Session}`;

                // Envoyer l'ID au numéro de l'utilisateur sur WhatsApp
                await sock.sendMessage(sock.user.id, { 
                    text: `*CONNEXION RÉUSSIE !* 🎉\n\nVoici votre Session ID :\n\n\`\`\`${sessionId}\`\`\`\n\nCopiez ce code et utilisez-le dans vos variables d'environnement.` 
                });

                // Nettoyage local
                setTimeout(() => {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    process.exit(0); // Optionnel : redémarrage pour nettoyer la mémoire
                }, 10000);
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur prêt sur http://localhost:${PORT}`));
