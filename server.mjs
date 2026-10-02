import express from 'express';
import { WebUntis } from 'webuntis';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';
import session from 'express-session';

const __filename = fileURLToPath(import.meta.url); //[span_0](start_span)[span_0](end_span)
const __dirname = path.dirname(__filename); //[span_1](start_span)[span_1](end_span)

const app = express(); //[span_2](start_span)[span_2](end_span)
const PORT = process.env.PORT || 3000; //[span_3](start_span)[span_3](end_span)

app.use(express.static(__dirname)); //[span_4](start_span)[span_4](end_span)
app.use(express.json()); //[span_5](start_span)[span_5](end_span)

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'planwerk-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // Session valid for 30 days
        httpOnly: true
    }
}));

// Authorization Middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    return res.status(401).json({ error: 'Zugriff verweigert. Bitte Lizenzschlüssel eingeben.' });
}

// -------------------------------------------------------------
// Auth Endpoints
// -------------------------------------------------------------
app.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post('/api/verify-key', (req, res) => {
    const { key } = req.body;

    // Allowed access keys (configured via env variable or default list)
    const validKeys = (process.env.ACCESS_KEYS || 'DEMO-KEY-123,PLANWERK-2026').split(',').map(k => k.trim());

    if (key && validKeys.includes(key.trim())) {
        req.session.authenticated = true;
        return res.json({ success: true });
    }

    res.status(401).json({ error: 'Ungültiger Lizenzschlüssel!' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// -------------------------------------------------------------
// VAPID Keys & Push Notification Configuration
// -------------------------------------------------------------
const vapidKeys = webpush.generateVAPIDKeys(); //[span_6](start_span)[span_6](end_span)
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || vapidKeys.publicKey; //[span_7](start_span)[span_7](end_span)
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || vapidKeys.privateKey; //[span_8](start_span)[span_8](end_span)

webpush.setVapidDetails( //[span_9](start_span)[span_9](end_span)
    'mailto:admin@planwerk.app', //[span_10](start_span)[span_10](end_span)
    publicVapidKey, //[span_11](start_span)[span_11](end_span)
    privateVapidKey //[span_12](start_span)[span_12](end_span)
); //[span_13](start_span)[span_13](end_span)

let pushSubscriptions = []; //[span_14](start_span)[span_14](end_span)
let knownLessonKeys = new Set(); //[span_15](start_span)[span_15](end_span)
let isFirstPoll = true; //[span_16](start_span)[span_16](end_span)

const UNTIS_CONFIG = { //[span_17](start_span)[span_17](end_span)
    school: process.env.UNTIS_SCHOOL || "anno-gym-siegburg", //[span_18](start_span)[span_18](end_span)
    username: process.env.UNTIS_USER || "EF", //[span_19](start_span)[span_19](end_span)
    password: process.env.UNTIS_PASSWORD || "580292Qa", //[span_20](start_span)[span_20](end_span)
    server: process.env.UNTIS_SERVER || "anno-gym-siegburg.webuntis.com" //[span_21](start_span)[span_21](end_span)
}; //[span_22](start_span)[span_22](end_span)

function parseElements(list) { //[span_23](start_span)[span_23](end_span)
    if (!Array.isArray(list)) return []; //[span_24](start_span)[span_24](end_span)
    return list.map(item => ({ //[span_25](start_span)[span_25](end_span)
        id: item.id || 0, //[span_26](start_span)[span_26](end_span)
        name: item.name || item.element?.name || "", //[span_27](start_span)[span_27](end_span)
        longname: item.longname || item.longName || item.element?.longName || item.name || "" //[span_28](start_span)[span_28](end_span)
    })); //[span_29](start_span)[span_29](end_span)
} //[span_30](start_span)[span_30](end_span)

function formatDate(v) { //[span_31](start_span)[span_31](end_span)
    const t = String(v || ''); //[span_32](start_span)[span_32](end_span)
    return t.length === 8 ? `${t.slice(6)}.${t.slice(4, 6)}.${t.slice(0, 4)}` : ''; //[span_33](start_span)[span_33](end_span)
} //[span_34](start_span)[span_34](end_span)

function formatTime(v) { //[span_35](start_span)[span_35](end_span)
    const t = String(v || '').padStart(4, '0'); //[span_36](start_span)[span_36](end_span)
    return t.slice(0, 2) + ':' + t.slice(2); //[span_37](start_span)[span_37](end_span)
} //[span_38](start_span)[span_38](end_span)

async function fetchTimetableFromUntis() { //[span_39](start_span)[span_39](end_span)
    const untis = new WebUntis( //[span_40](start_span)[span_40](end_span)
        UNTIS_CONFIG.school, //[span_41](start_span)[span_41](end_span)
        UNTIS_CONFIG.username, //[span_42](start_span)[span_42](end_span)
        UNTIS_CONFIG.password, //[span_43](start_span)[span_43](end_span)
        UNTIS_CONFIG.server //[span_44](start_span)[span_44](end_span)
    ); //[span_45](start_span)[span_45](end_span)

    try { //[span_46](start_span)[span_46](end_span)
        await untis.login(); //[span_47](start_span)[span_47](end_span)
        const today = new Date(); //[span_48](start_span)[span_48](end_span)
        const nextDays = new Date(); //[span_49](start_span)[span_49](end_span)
        nextDays.setDate(today.getDate() + 7); //[span_50](start_span)[span_50](end_span)

        const timetable = await untis.getOwnTimetableForRange(today, nextDays); //[span_51](start_span)[span_51](end_span)
        await untis.logout(); //[span_52](start_span)[span_52](end_span)

        return timetable.map(lesson => ({ //[span_53](start_span)[span_53](end_span)
            id: lesson.id, //[span_54](start_span)[span_54](end_span)
            date: lesson.date, //[span_55](start_span)[span_55](end_span)
            startTime: lesson.startTime, //[span_56](start_span)[span_56](end_span)
            endTime: lesson.endTime, //[span_57](start_span)[span_57](end_span)
            sg: lesson.sg || lesson.studentGroup || "", //[span_58](start_span)[span_58](end_span)
            substText: lesson.substText || "", //[span_59](start_span)[span_59](end_span)
            activityType: lesson.activityType || lesson.lessonText || "Unterricht", //[span_60](start_span)[span_60](end_span)
            code: lesson.code || "", //[span_61](start_span)[span_61](end_span)
            te: parseElements(lesson.te || lesson.teachers), //[span_62](start_span)[span_62](end_span)
            su: parseElements(lesson.su || lesson.subjects), //[span_63](start_span)[span_63](end_span)
            ro: parseElements(lesson.ro || lesson.rooms) //[span_64](start_span)[span_64](end_span)
        })); //[span_65](start_span)[span_65](end_span)
    } catch (error) { //[span_66](start_span)[span_66](end_span)
        try { await untis.logout(); } catch (e) {} //[span_67](start_span)[span_67](end_span)
        throw error; //[span_68](start_span)[span_68](end_span)
    } //[span_69](start_span)[span_69](end_span)
} //[span_70](start_span)[span_70](end_span)

function sendPushNotification(title, body) { //[span_71](start_span)[span_71](end_span)
    const payload = JSON.stringify({ title, body }); //[span_72](start_span)[span_72](end_span)
    pushSubscriptions.forEach((sub, index) => { //[span_73](start_span)[span_73](end_span)
        webpush.sendNotification(sub, payload).catch(err => { //[span_74](start_span)[span_74](end_span)
            if (err.statusCode === 410 || err.statusCode === 404) { //[span_75](start_span)[span_75](end_span)
                pushSubscriptions.splice(index, 1); //[span_76](start_span)[span_76](end_span)
            } //[span_77](start_span)[span_77](end_span)
        }); //[span_78](start_span)[span_78](end_span)
    }); //[span_79](start_span)[span_79](end_span)
} //[span_80](start_span)[span_80](end_span)

async function pollAndCheckChanges() { //[span_81](start_span)[span_81](end_span)
    try { //[span_82](start_span)[span_82](end_span)
        const lessons = await fetchTimetableFromUntis(); //[span_83](start_span)[span_83](end_span)
        const currentSpecialLessons = []; //[span_84](start_span)[span_84](end_span)

        lessons.forEach(lesson => { //[span_85](start_span)[span_85](end_span)
            const txt = `${lesson.substText || ''} ${lesson.activityType || ''}`.toLowerCase(); //[span_86](start_span)[span_86](end_span)
            const teacher = lesson.te?.[0]?.name || ''; //[span_87](start_span)[span_87](end_span)
            
            const isEigenarbeit = teacher === '---' || teacher === '' || teacher === '-' || txt.includes('eigenarbeit') || txt.includes('eva'); //[span_88](start_span)[span_88](end_span)
            const isEntfall = txt.includes('entfall') || lesson.code === 'cancelled'; //[span_89](start_span)[span_89](end_span)

            if (isEigenarbeit || isEntfall) { //[span_90](start_span)[span_90](end_span)
                const typeStr = isEntfall ? 'Entfall' : 'Eigenarbeit'; //[span_91](start_span)[span_91](end_span)
                const subject = lesson.su?.[0]?.longname || lesson.su?.[0]?.name || 'Unterricht'; //[span_92](start_span)[span_92](end_span)
                const dateStr = formatDate(lesson.date); //[span_93](start_span)[span_93](end_span)
                const timeStr = formatTime(lesson.startTime); //[span_94](start_span)[span_94](end_span)
                
                const uniqueKey = `${lesson.date}_${lesson.startTime}_${subject}_${typeStr}`; //[span_95](start_span)[span_95](end_span)

                currentSpecialLessons.push({ //[span_96](start_span)[span_96](end_span)
                    key: uniqueKey, //[span_97](start_span)[span_97](end_span)
                    title: `Planänderung: ${typeStr}`, //[span_98](start_span)[span_98](end_span)
                    body: `${subject} am ${dateStr} um ${timeStr} Uhr (${typeStr})` //[span_99](start_span)[span_99](end_span)
                }); //[span_100](start_span)[span_100](end_span)
            } //[span_101](start_span)[span_101](end_span)
        }); //[span_102](start_span)[span_102](end_span)

        if (isFirstPoll) { //[span_103](start_span)[span_103](end_span)
            currentSpecialLessons.forEach(item => knownLessonKeys.add(item.key)); //[span_104](start_span)[span_104](end_span)
            isFirstPoll = false; //[span_105](start_span)[span_105](end_span)
            return; //[span_106](start_span)[span_106](end_span)
        } //[span_107](start_span)[span_107](end_span)

        currentSpecialLessons.forEach(item => { //[span_108](start_span)[span_108](end_span)
            if (!knownLessonKeys.has(item.key)) { //[span_109](start_span)[span_109](end_span)
                knownLessonKeys.add(item.key); //[span_110](start_span)[span_110](end_span)
                sendPushNotification(item.title, item.body); //[span_111](start_span)[span_111](end_span)
            } //[span_112](start_span)[span_112](end_span)
        }); //[span_113](start_span)[span_113](end_span)

    } catch (err) { //[span_114](start_span)[span_114](end_span)
        console.error("Polling-Fehler:", err.message); //[span_115](start_span)[span_115](end_span)
    } //[span_116](start_span)[span_116](end_span)
} //[span_117](start_span)[span_117](end_span)

setInterval(pollAndCheckChanges, 30000); //[span_118](start_span)[span_118](end_span)

// Public endpoints
app.get('/api/vapid-key', (req, res) => { //[span_119](start_span)[span_119](end_span)
    res.json({ publicKey: publicVapidKey }); //[span_120](start_span)[span_120](end_span)
}); //[span_121](start_span)[span_121](end_span)

// Protected endpoints
app.post('/api/subscribe', requireAuth, (req, res) => { //[span_122](start_span)[span_122](end_span)
    const subscription = req.body; //[span_123](start_span)[span_123](end_span)
    if (!pushSubscriptions.some(s => s.endpoint === subscription.endpoint)) { //[span_124](start_span)[span_124](end_span)
        pushSubscriptions.push(subscription); //[span_125](start_span)[span_125](end_span)
    } //[span_126](start_span)[span_126](end_span)
    res.status(201).json({ success: true }); //[span_127](start_span)[span_127](end_span)
}); //[span_128](start_span)[span_128](end_span)

app.get('/api/timetable', requireAuth, async (req, res) => { //[span_129](start_span)[span_129](end_span)
    try { //[span_130](start_span)[span_130](end_span)
        const data = await fetchTimetableFromUntis(); //[span_131](start_span)[span_131](end_span)
        res.json(data); //[span_132](start_span)[span_132](end_span)
    } catch (error) { //[span_133](start_span)[span_133](end_span)
        res.status(500).json({ error: "Stundenplan-Fehler", details: error.message }); //[span_134](start_span)[span_134](end_span)
    } //[span_135](start_span)[span_135](end_span)
}); //[span_136](start_span)[span_136](end_span)

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`)); //[span_137](start_span)[span_137](end_span)

export default app; //[span_138](start_span)[span_138](end_span)

