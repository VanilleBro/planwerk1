import 'dotenv/config';
import express from 'express';
import { WebUntis } from 'webuntis';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';
import session from 'express-session';
import { Redis } from '@upstash/redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Sichere Redis-Initialisierung
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
} else {
    console.error('⚠️ WARNUNG: UPSTASH_REDIS_REST_URL oder TOKEN fehlt in den Umgebungsvariablen!');
}

// Middleware
app.use(express.json());

// CORS Header für API-Anfragen
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-License-Key, X-Device-Id, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Route für Web-App Manifest
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
        name: "Planwerk | Mein Stundenplan",
        short_name: "Planwerk",
        start_url: "/",
        display: "standalone",
        background_color: "#07111f",
        theme_color: "#07111f",
        orientation: "portrait"
    });
});

// Admin-Seiten
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Statische Dateien
app.use(express.static(__dirname));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'planwerk-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true
    }
}));

// WebUntis Configuration
const UNTIS_CONFIG = {
    school: process.env.UNTIS_SCHOOL || 'anno-gym-siegburg',
    username: process.env.UNTIS_USER || 'EF',
    password: process.env.UNTIS_PASSWORD || '580292Qa',
    server: process.env.UNTIS_SERVER || 'anno-gym-siegburg.webuntis.com'
};

// VAPID Web Push Setup
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails('mailto:admin@planwerk.app', vapidKeys.publicKey, vapidKeys.privateKey);
let pushSubscriptions = [];

// -------------------------------------------------------------
// Striktes Auth Middleware: Gerätebindung für jeden Schlüssel
// -------------------------------------------------------------
async function requireAuth(req, res, next) {
    // 1. Geräte-ID & Lizenzschlüssel aus Request extrahieren
    const authHeader = req.headers['authorization'] || '';
    const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    const providedKey = (
        req.headers['x-license-key'] ||
        bearerKey ||
        req.query?.key ||
        req.query?.license ||
        ''
    ).toString().trim();

    const clientDeviceId = (
        req.headers['x-device-id'] ||
        req.query?.deviceId ||
        req.session?.deviceId ||
        ''
    ).toString().trim();

    if (!providedKey) {
        return res.status(401).json({ error: 'Zugriff verweigert. Bitte Lizenzschlüssel eingeben.' });
    }

    if (!clientDeviceId) {
        return res.status(400).json({ error: 'Zugriff verweigert. Keine Geräte-ID übermittelt.' });
    }

    // Globaler Admin-Key aus Umgebungsvariablen (Bypass für den Admin/Testen)
    const envAdminKey = (process.env.LICENSE_KEY || process.env.KEY || '').trim();
    if (envAdminKey && providedKey === envAdminKey) {
        return next();
    }

    // 2. Prüfung in Redis
    if (redis) {
        try {
            let keyInfo = await redis.get(`key:${providedKey}`);

            // Automatische Erstellung von Standard-Demo-Keys
            if (!keyInfo && (providedKey === 'DEMO-KEY-123' || providedKey === 'PLANWERK-2026')) {
                keyInfo = { usedBy: null, activatedAt: null };
            }

            if (!keyInfo) {
                return res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
            }

            // Fall A: Schlüssel ist noch UNBENUTZT -> Jetzt an dieses Gerät binden
            if (keyInfo.usedBy === null) {
                keyInfo.usedBy = clientDeviceId;
                keyInfo.activatedAt = new Date().toISOString();
                await redis.set(`key:${providedKey}`, keyInfo);
                return next();
            }

            // Fall B: Schlüssel ist bereits GEBUNDEN -> Gerät überprüfen
            if (keyInfo.usedBy === clientDeviceId) {
                return next(); // Gerät stimmt überein!
            } else {
                return res.status(403).json({ 
                    error: 'Dieser Lizenzschlüssel ist bereits an ein anderes Gerät gebunden!' 
                });
            }
        } catch (err) {
            console.error('Redis Auth Check Error:', err);
            return res.status(500).json({ error: 'Fehler bei der Datenbankprüfung.' });
        }
    } else {
        return res.status(500).json({ error: 'Datenbank (Redis) ist nicht konfiguriert.' });
    }
}

// -------------------------------------------------------------
// Authentication Endpoints
// -------------------------------------------------------------
app.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post('/api/verify-key', async (req, res) => {
    try {
        if (!redis) return res.status(500).json({ error: 'Datenbank nicht konfiguriert.' });

        const { key, deviceId } = req.body;
        if (!key || !deviceId) return res.status(400).json({ error: 'Schlüssel und Geräte-ID erforderlich.' });

        const trimmedKey = key.trim();
        let keyInfo = await redis.get(`key:${trimmedKey}`);

        if (!keyInfo) {
            const envKey = (process.env.LICENSE_KEY || process.env.KEY || '').trim();
            if (trimmedKey === 'DEMO-KEY-123' || trimmedKey === 'PLANWERK-2026' || trimmedKey === envKey) {
                keyInfo = { usedBy: null, activatedAt: null };
            } else {
                return res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
            }
        }

        if (keyInfo.usedBy === null) {
            keyInfo.usedBy = deviceId;
            keyInfo.activatedAt = new Date().toISOString();
            await redis.set(`key:${trimmedKey}`, keyInfo);
            req.session.authenticated = true;
            req.session.deviceId = deviceId;
            return res.json({ success: true, message: 'Schlüssel erfolgreich an dieses Gerät gebunden!' });
        } else if (keyInfo.usedBy === deviceId) {
            req.session.authenticated = true;
            req.session.deviceId = deviceId;
            return res.json({ success: true, message: 'Willkommen zurück!' });
        } else {
            return res.status(403).json({ error: 'Dieser Schlüssel wurde bereits auf einem anderen Gerät eingelöst!' });
        }
    } catch (err) {
        return res.status(500).json({ error: 'Fehler bei der Verbindung zur Datenbank.' });
    }
});

// Admin Endpoint: Neue Schlüssel erstellen
app.post('/api/admin/create-key', async (req, res) => {
    try {
        if (!redis) return res.status(500).json({ error: 'Datenbank nicht konfiguriert.' });

        const { adminSecret, newKey } = req.body;
        if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ error: 'Nicht autorisiert. Falsches Admin-Passwort.' });
        }

        if (!newKey || !newKey.trim()) return res.status(400).json({ error: 'Schlüssel darf nicht leer sein.' });

        const trimmedKey = newKey.trim();
        await redis.set(`key:${trimmedKey}`, { usedBy: null, activatedAt: null });

        return res.json({ success: true, message: `Schlüssel '${trimmedKey}' erfolgreich erstellt!` });
    } catch (err) {
        return res.status(500).json({ error: 'Fehler beim Erstellen des Schlüssels.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// -------------------------------------------------------------
// Timetable Endpoint
// -------------------------------------------------------------
app.get('/api/timetable', requireAuth, async (req, res) => {
    const untis = new WebUntis(
        UNTIS_CONFIG.school,
        UNTIS_CONFIG.username,
        UNTIS_CONFIG.password,
        UNTIS_CONFIG.server
    );

    try {
        await untis.login();
        const today = new Date();
        const timetable = await untis.getOwnTimetableFor(today);
        return res.json({ success: true, timetable });
    } catch (error) {
        console.error('WebUntis Fehler:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Fehler beim Laden des Stundenplans von WebUntis.', 
            details: error.message || error 
        });
    } finally {
        try { await untis.logout(); } catch (e) {}
    }
});

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: vapidKeys.publicKey }));

app.post('/api/subscribe', requireAuth, (req, res) => {
    pushSubscriptions.push(req.body);
    res.status(201).json({ success: true });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Planwerk Server läuft auf Port ${PORT}`));
}

export default app;

