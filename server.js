const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs-extra");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/pair', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: "Numéro requis" });

    num = num.replace(/[^0-9]/g, '');
    const sessionPath = path.join(__dirname, 'auth_info'); // Dossier persistant
    
    // On utilise useMultiFileAuthState pour garder la session "vivante" sur Render
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    try {
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["Chrome (Linux)", "", ""]
        });

        // Demande du code de couplage
        if (!sock.authState.creds.registered) {
            await delay(1500);
            const pairingCode = await sock.requestPairingCode(num);
            res.json({ code: pairingCode });
        } else {
            res.json({ error: "Déjà connecté !" });
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                console.log("Cible connectée !");
                await delay(5000);

                // GÉNÉRATION DU SESSION ID
                const credsContent = fs.readFileSync(path.join(sessionPath, 'creds.json'));
                const sessionID = "NEBULA~" + Buffer.from(credsContent).toString('base64');

                // ENVOI DU MESSAGE À L'UTILISATEUR
                const welcomeMsg = `*🚀 NEBULA BOT CONNECTÉ !*\n\nVotre serveur de pairing est actif. Voici votre Session ID pour Pterodactyl :\n\n\`\`\`${sessionID}\`\`\`\n\n*Instructions :*\n1. Copiez ce code.\n2. Allez sur votre panel Pterodactyl.\n3. Collez-le dans votre fichier config.js ou variable SESSION_ID.\n4. Démarrez votre bot. ✅`;
                
                await sock.sendMessage(sock.user.id, { text: welcomeMsg });
                console.log("Session ID envoyé avec succès.");
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    // Si déconnecté accidentellement, on ne supprime rien pour pouvoir reconnecter
                    console.log("Connexion perdue, tentative de reconnexion...");
                }
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erreur lors du pairing" });
    }
});

app.listen(PORT, () => console.log(`Système de Pairing Nebula sur le port ${PORT}`));
