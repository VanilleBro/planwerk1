import express from 'express';
import { WebUntis } from 'webuntis';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';
import session from 'express-session';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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

// -------------------------------------------------------------
// Keys Management Helpers
// -------------------------------------------------------------
const KEYS_FILE = path.join(__dirname, 'keys.json');

function getKeysData() {
    if (!fs.existsSync(KEYS_FILE)) {
        const initial = {
            "DEMO-KEY-123": { usedBy: null, activatedAt: null },
            "PLANWERK-2026": { usedBy: null, activatedAt: null }
        };
        fs.writeFileSync(KEYS_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    try {
        return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveKeysData(data) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

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

app.post('/api/verify-key', (req, res) => {
    const { key, deviceId } = req.body;

    if (!key || !deviceId) {
        return res.status(400).json({ error: 'Ungültige Anfrage. Schlüssel und Geräte-ID erforderlich.' });
    }

    const trimmedKey = key.trim();
    const keysData = getKeysData();

    if (!keysData[trimmedKey]) {
        return res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
    }

    const keyInfo = keysData[trimmedKey];

    if (keyInfo.usedBy === null) {
        // First activation -> Bind key to this device
        keyInfo.usedBy = deviceId;
        keyInfo.activatedAt = new Date().toISOString();
        saveKeysData(keysData);

        req.session.authenticated = true;
        req.session.deviceId = deviceId;
        return res.json({ success: true, message: 'Schlüssel erfolgreich an dieses Gerät gebunden!' });
    } else if (keyInfo.usedBy === deviceId) {
        // Same device reconnecting -> Allow
        req.session.authenticated = true;
        req.session.deviceId = deviceId;
        return res.json({ success: true, message: 'Willkommen zurück!' });
    } else {
        // Already redeemed on another device -> Block
        return res.status(403).json({ 
            error: 'Dieser Schlüssel wurde bereits auf einem anderen Gerät eingelöst!' 
        });
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

