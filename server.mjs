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

// Sichere Redis-Initialisierung (verhindert Totalabsturz auf Vercel, falls Env-Variablen fehlen)
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-License-Key, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Route für Web-App Manifest (verhindert 404 Fehler)
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

// Explizite Routen für Admin-Seite
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Statische Dateien ausliefern
app.use(express.static(__dirname));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'planwerk-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 Tage
        httpOnly: true
    }
}));

// WebUntis Configuration
const UNTIS_CONFIG = {
    school: process.env.UNTIS_SCHOOL || 'demo-school',
    username: process.env.UNTIS_USER || 'demo-user',
    password: process.env.UNTIS_PASSWORD || '580292Qa',
    server: process.env.UNTIS_SERVER || 'untis.webuntis.com'
};

// VAPID Web Push Setup
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails(
    'mailto:admin@planwerk.app',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

let pushSubscriptions = [];

// Auth Middleware (Erweitert: Akzeptiert Session ODER direkten Lizenzschlüssel per Header/Query)
async function requireAuth(req, res, next) {
    // 1. Authentifizierung über aktive Session
    if (req.session && req.session.authenticated) {
        return next();
    }

    // 2. Authentifizierung über mitgeschickten Lizenzschlüssel (Header / Query / Bearer)
    const authHeader = req.headers['authorization'] || '';
    const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    const providedKey = (
        req.headers['x-license-key'] ||
        bearerKey ||
        req.query?.key ||
        req.query?.license ||
        ''
    ).toString().trim();

    if (providedKey) {
        const envKey = (process.env.LICENSE_KEY || process.env.KEY || 'TEST99911').trim();
        
        // Prüfe gegen Env-Variablen oder Standard-Keys
        if (providedKey === envKey || providedKey === 'DEMO-KEY-123' || providedKey === 'PLANWERK-2026') {
            return next();
        }

        // Prüfe gegen Redis-Datenbank
        if (redis) {
            try {
                const keyInfo = await redis.get(`key:${providedKey}`);
                if (keyInfo) {
                    return next();
                }
            } catch (err) {
                console.error('Redis Auth Check Error:', err);
            }
        }
    }

    return res.status(401).json({ error: 'Zugriff verweigert. Bitte Lizenzschlüssel eingeben.' });
}

// -------------------------------------------------------------
// Authentication Endpoints
// -------------------------------------------------------------
app.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post('/api/verify-key', async (req, res) => {
    try {
        if (!redis) {
            return res.status(500).json({ error: 'Datenbank nicht konfiguriert. Bitte Umgebungsvariablen in Vercel prüfen.' });
        }

        const { key, deviceId } = req.body;

        if (!key || !deviceId) {
            return res.status(400).json({ error: 'Ungültige Anfrage. Schlüssel und Geräte-ID erforderlich.' });
        }

        const trimmedKey = key.trim();

        // Key aus der Redis-Datenbank abrufen
        let keyInfo = await redis.get(`key:${trimmedKey}`);

        // Standard-Demokey automatisch anlegen
        if (!keyInfo) {
            const envKey = (process.env.LICENSE_KEY || process.env.KEY || 'TEST99911').trim();
            if (trimmedKey === 'DEMO-KEY-123' || trimmedKey === 'PLANWERK-2026' || trimmedKey === envKey) {
                keyInfo = { usedBy: null, activatedAt: null };
                await redis.set(`key:${trimmedKey}`, keyInfo);
            } else {
                return res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
            }
        }

        if (keyInfo.usedBy === null) {
            // Erste Aktivierung -> Key an dieses Gerät binden
            keyInfo.usedBy = deviceId;
            keyInfo.activatedAt = new Date().toISOString();
            await redis.set(`key:${trimmedKey}`, keyInfo);

            req.session.authenticated = true;
            req.session.deviceId = deviceId;
            return res.json({ success: true, message: 'Schlüssel erfolgreich an dieses Gerät gebunden!' });
        } else if (keyInfo.usedBy === deviceId) {
            // Selbes Gerät -> Zugang gewähren
            req.session.authenticated = true;
            req.session.deviceId = deviceId;
            return res.json({ success: true, message: 'Willkommen zurück!' });
        } else {
            // Bereits auf anderem Gerät aktiviert -> Sperren
            return res.status(403).json({ 
                error: 'Dieser Schlüssel wurde bereits auf einem anderen Gerät eingelöst!' 
            });
        }
    } catch (err) {
        console.error('Datenbank-Fehler:', err);
        return res.status(500).json({ error: 'Fehler bei der Verbindung zur Datenbank.' });
    }
});

// Admin Endpoint: Neue Kunden-Keys erstellen
app.post('/api/admin/create-key', async (req, res) => {
    try {
        if (!redis) {
            return res.status(500).json({ error: 'Datenbank nicht konfiguriert. Bitte Umgebungsvariablen prüfen.' });
        }

        const { adminSecret, newKey } = req.body;

        if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ error: 'Nicht autorisiert. Falsches Admin-Passwort.' });
        }

        if (!newKey || !newKey.trim()) {
            return res.status(400).json({ error: 'Schlüssel darf nicht leer sein.' });
        }

        const trimmedKey = newKey.trim();
        await redis.set(`key:${trimmedKey}`, { usedBy: null, activatedAt: null });

        return res.json({ success: true, message: `Schlüssel '${trimmedKey}' erfolgreich gespeichert!` });
    } catch (err) {
        console.error('Admin Key Creation Error:', err);
        return res.status(500).json({ error: 'Fehler beim Erstellen des Schlüssels.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Fehler beim Abmelden.' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// -------------------------------------------------------------
// Timetable & WebPush Endpoints
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
        await untis.logout();
        res.json({ success: true, timetable });
    } catch (error) {
        res.status(500).json({ 
            error: 'Fehler beim Laden des Stundenplans.', 
            details: error.message 
        });
    }
});

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', requireAuth, (req, res) => {
    const subscription = req.body;
    pushSubscriptions.push(subscription);
    res.status(201).json({ success: true });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Planwerk Server läuft auf Port ${PORT}`);
    });
}

export default app;

