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

// Initialize Upstash Redis Client
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Serve static files and parse JSON bodies
app.use(express.static(__dirname));
app.use(express.json());

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'planwerk-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true
    }
}));

// WebUntis Credentials Configuration
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
// Authentication Endpoints (Database-backed)
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

        // Retrieve key info from Redis database
        let keyInfo = await redis.get(`key:${trimmedKey}`);

        // Auto-seed demo keys if requested for the first time
        if (!keyInfo) {
            if (trimmedKey === 'DEMO-KEY-123' || trimmedKey === 'PLANWERK-2026') {
                keyInfo = { usedBy: null, activatedAt: null };
                await redis.set(`key:${trimmedKey}`, keyInfo);
            } else {
                return res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
            }
        }

        if (keyInfo.usedBy === null) {
            // First activation -> Bind key to deviceId in database
            keyInfo.usedBy = deviceId;
            keyInfo.activatedAt = new Date().toISOString();
            await redis.set(`key:${trimmedKey}`, keyInfo);

            req.session.authenticated = true;
            req.session.deviceId = deviceId;
            return res.json({ success: true, message: 'Schlüssel erfolgreich an dieses Gerät gebunden!' });
        } else if (keyInfo.usedBy === deviceId) {
            // Same device returning -> Allow access
            req.session.authenticated = true;
            req.session.deviceId = deviceId;
            return res.json({ success: true, message: 'Willkommen zurück!' });
        } else {
            // Key already bound to a different device -> Reject
            return res.status(403).json({ 
                error: 'Dieser Schlüssel wurde bereits auf einem anderen Gerät eingelöst!' 
            });
        }
    } catch (err) {
        console.error('Database Connection Error:', err);
        return res.status(500).json({ error: 'Fehler bei der Datenbankverbindung.' });
    }
});

// Admin Endpoint: Add new customer keys to database
app.post('/api/admin/create-key', async (req, res) => {
    const { adminSecret, newKey } = req.body;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Nicht autorisiert.' });
    }
    if (!newKey) {
        return res.status(400).json({ error: 'Schlüssel erforderlich.' });
    }

    const trimmedKey = newKey.trim();
    await redis.set(`key:${trimmedKey}`, { usedBy: null, activatedAt: null });
    return res.json({ success: true, message: `Schlüssel '${trimmedKey}' in Datenbank gespeichert.` });
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

