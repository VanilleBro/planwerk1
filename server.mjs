import 'dotenv/config'; // <-- ADD THIS LINE AT THE TOP
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

// Initialize Upstash Redis Database
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Middleware
app.use(express.static(__dirname));
app.use(express.json());

// Explicit Routes for Admin Page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

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

// Auth Middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
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
        const { key, deviceId } = req.body;

        if (!key || !deviceId) {
            return res.status(400).json({ error: 'Ungültige Anfrage. Schlüssel und Geräte-ID erforderlich.' });
        }

        const trimmedKey = key.trim();

        // Key aus der Redis-Datenbank abrufen
        let keyInfo = await redis.get(`key:${trimmedKey}`);

        // Standard-Demokey automatisch anlegen, falls noch nicht in DB
        if (!keyInfo) {
            if (trimmedKey === 'DEMO-KEY-123' || trimmedKey === 'PLANWERK-2026') {
                keyInfo = { usedBy: null, activatedAt: null };
                await redis.set(`key:${trimmedKey}`, keyInfo);
            } else {
                return res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
            }
        }

        if (keyInfo.usedBy === null) {
            // Erste Aktivierung -> Key an diese deviceId binden
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

app.listen(PORT, () => {
    console.log(`Planwerk Server läuft auf Port ${PORT}`);
});

