const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const LOG_FILE = path.join(DATA_DIR, 'activity.log');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// --- Email notification config ---
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
const SMTP_SECURE = (process.env.SMTP_SECURE || '').trim() === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const SMTP_FROM = (process.env.SMTP_FROM || 'tenant-logger@localhost').trim();
const NOTIFY_EMAILS_ENV = (process.env.NOTIFY_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const NOTIFY_CRON = process.env.NOTIFY_CRON || '30 3 * * *';

// Get notification recipients: db.json appSettings takes priority, env var is fallback/seed
function getNotifyEmails() {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (data.appSettings && Array.isArray(data.appSettings.notifyEmails)) {
            return data.appSettings.notifyEmails; // respect explicit empty list
        }
    } catch {}
    return NOTIFY_EMAILS_ENV;
}

// Parse PINs: supports "name1:pin1,name2:pin2" or a single "pin"
const PIN_RAW = process.env.PIN;
if (!PIN_RAW) {
    console.error('ERROR: PIN environment variable is required.');
    console.error('  Single user:  PIN=12345');
    console.error('  Multi user:   PIN=Dad:12345,Mom:67890');
    process.exit(1);
}

const USERS = {};
PIN_RAW.split(',').forEach(entry => {
    const trimmed = entry.trim();
    if (trimmed.includes(':')) {
        const [name, pin] = trimmed.split(':').map(s => s.trim());
        USERS[pin] = name;
    } else {
        USERS[trimmed] = 'User';
    }
});
console.log(`Configured ${Object.keys(USERS).length} user(s): ${Object.values(USERS).join(', ')}`);

// Ensure directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Initialize db.json if it doesn't exist
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
        properties: [],
        tenants: [],
        leases: [],
        workLog: [],
        payments: [],
        propertyDocs: [],
        appSettings: {},
        notificationsSent: []
    }, null, 2));
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(SESSION_SECRET));

// --- Activity logging ---
function logActivity(user, action, details) {
    const entry = `${new Date().toISOString()} | ${user} | ${action} | ${details}\n`;
    try { fs.appendFileSync(LOG_FILE, entry); } catch {}
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
    const session = req.signedCookies.session;
    if (session && USERS[session]) {
        req.userName = USERS[session];
        req.userPin = session;
        return next();
    }
    // Backward compat: accept 'valid' from old sessions
    if (session === 'valid') {
        req.userName = 'User';
        req.userPin = '';
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// --- Auth routes ---
app.post('/api/login', (req, res) => {
    const { pin } = req.body;
    const userName = USERS[String(pin)];
    if (!pin || !userName) {
        return res.status(401).json({ error: 'Incorrect PIN' });
    }
    res.cookie('session', String(pin), {
        signed: true,
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    });
    logActivity(userName, 'login', 'Logged in');
    res.json({ success: true, user: userName });
});

app.get('/api/auth-check', requireAuth, (req, res) => {
    res.json({ authenticated: true, user: req.userName });
});

app.post('/api/logout', (req, res) => {
    const session = req.signedCookies.session;
    const userName = (session && USERS[session]) || 'User';
    logActivity(userName, 'logout', 'Logged out');
    res.clearCookie('session');
    res.json({ success: true });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// --- Data routes ---
app.get('/api/data', requireAuth, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read data' });
    }
});

app.put('/api/data', requireAuth, (req, res) => {
    try {
        const action = req.headers['x-action'] || 'update';
        const detail = req.headers['x-detail'] || 'Data saved';
        logActivity(req.userName, action, detail);
        // Preserve server-managed fields that the frontend does not send
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
        const toSave = { ...req.body };
        if (!toSave.notificationsSent && existing.notificationsSent) {
            toSave.notificationsSent = existing.notificationsSent;
        }
        if (!toSave.appSettings && existing.appSettings) {
            toSave.appSettings = existing.appSettings;
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(toSave, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save data' });
    }
});

app.get('/api/backup', requireAuth, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const backup = { ...data, _backup: { date: new Date().toISOString(), version: '1.0.0' } };
        const filename = `tenant_logger_backup_${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        logActivity(req.userName, 'backup', 'Downloaded backup');
        res.json(backup);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create backup' });
    }
});

app.post('/api/restore', requireAuth, (req, res) => {
    try {
        const data = req.body;
        if (!data.properties || !Array.isArray(data.properties)) {
            return res.status(400).json({ error: 'Invalid backup format' });
        }
        delete data._backup;
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        logActivity(req.userName, 'restore', 'Restored from backup');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to restore backup' });
    }
});

// --- Activity log endpoint ---
app.get('/api/activity', requireAuth, (req, res) => {
    try {
        if (!fs.existsSync(LOG_FILE)) return res.json([]);
        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
        // Return last 100 entries, newest first
        const entries = lines.slice(-100).reverse().map(line => {
            const parts = line.split(' | ');
            return { timestamp: parts[0], user: parts[1], action: parts[2], detail: parts[3] || '' };
        });
        res.json(entries);
    } catch {
        res.json([]);
    }
});

// --- File upload helpers ---
function makeUploadHandler(prefix) {
    const storage = multer.diskStorage({
        destination: UPLOADS_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
            cb(null, `${prefix}-${req.params.id}${ext}`);
        }
    });
    return multer({
        storage,
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
            if (!allowed.includes(file.mimetype)) {
                return cb(new Error('Only images and PDFs are allowed'));
            }
            cb(null, true);
        }
    });
}

const uploadLease = makeUploadHandler('lease');
const uploadReceipt = makeUploadHandler('receipt');

function findFile(prefix, id) {
    try {
        const files = fs.readdirSync(UPLOADS_DIR);
        return files.find(f => f.startsWith(`${prefix}-${id}.`));
    } catch { return null; }
}

function deleteFiles(prefix, id) {
    try {
        const files = fs.readdirSync(UPLOADS_DIR);
        files.forEach(f => {
            if (f.startsWith(`${prefix}-${id}.`)) {
                fs.unlinkSync(path.join(UPLOADS_DIR, f));
            }
        });
    } catch {}
}

// --- Upload routes: lease documents ---
app.post('/api/upload/lease/:id', requireAuth, (req, res) => {
    uploadLease.single('document')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        // Clean up old files with different extensions
        const files = fs.readdirSync(UPLOADS_DIR);
        files.forEach(f => {
            if (f.startsWith(`lease-${req.params.id}.`) && f !== req.file.filename) {
                fs.unlinkSync(path.join(UPLOADS_DIR, f));
            }
        });
        res.json({ success: true, filename: req.file.filename });
    });
});

app.get('/api/upload/lease/:id', requireAuth, (req, res) => {
    const file = findFile('lease', req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(UPLOADS_DIR, file));
});

app.delete('/api/upload/lease/:id', requireAuth, (req, res) => {
    deleteFiles('lease', req.params.id);
    res.json({ success: true });
});

// --- Upload routes: work receipts ---
app.post('/api/upload/receipt/:id', requireAuth, (req, res) => {
    uploadReceipt.single('document')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const files = fs.readdirSync(UPLOADS_DIR);
        files.forEach(f => {
            if (f.startsWith(`receipt-${req.params.id}.`) && f !== req.file.filename) {
                fs.unlinkSync(path.join(UPLOADS_DIR, f));
            }
        });
        res.json({ success: true, filename: req.file.filename });
    });
});

app.get('/api/upload/receipt/:id', requireAuth, (req, res) => {
    const file = findFile('receipt', req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(UPLOADS_DIR, file));
});

app.delete('/api/upload/receipt/:id', requireAuth, (req, res) => {
    deleteFiles('receipt', req.params.id);
    res.json({ success: true });
});

// --- Upload routes: property documents (multiple per property) ---
const uploadPropDoc = multer({
    storage: multer.diskStorage({
        destination: UPLOADS_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
            const docId = req.params.docId || Date.now();
            cb(null, `propdoc-${docId}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (!allowed.includes(file.mimetype)) {
            return cb(new Error('Only images and PDFs are allowed'));
        }
        cb(null, true);
    }
});

app.post('/api/upload/propdoc/:docId', requireAuth, (req, res) => {
    uploadPropDoc.single('document')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        // Clean up old files with different extensions for same docId
        const files = fs.readdirSync(UPLOADS_DIR);
        files.forEach(f => {
            if (f.startsWith(`propdoc-${req.params.docId}.`) && f !== req.file.filename) {
                fs.unlinkSync(path.join(UPLOADS_DIR, f));
            }
        });
        res.json({ success: true, filename: req.file.filename });
    });
});

app.get('/api/upload/propdoc/:docId', requireAuth, (req, res) => {
    const file = findFile('propdoc', req.params.docId);
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(UPLOADS_DIR, file));
});

app.delete('/api/upload/propdoc/:docId', requireAuth, (req, res) => {
    deleteFiles('propdoc', req.params.docId);
    res.json({ success: true });
});

// --- List all uploads ---
app.get('/api/uploads', requireAuth, (req, res) => {
    try {
        const files = fs.readdirSync(UPLOADS_DIR);
        const uploads = {};
        files.forEach(f => {
            const match = f.match(/^(lease|receipt|propdoc)-(\d+)\./);
            if (match) {
                uploads[`${match[1]}-${match[2]}`] = f;
            }
        });
        res.json(uploads);
    } catch {
        res.json({});
    }
});

// --- Email notification system ---

function createMailTransporter() {
    if (!SMTP_HOST) return null;
    const opts = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, tls: { rejectUnauthorized: false } };
    if (SMTP_USER) opts.auth = { user: SMTP_USER, pass: SMTP_PASS };
    return nodemailer.createTransport(opts);
}

const mailTransporter = createMailTransporter();

async function sendEmail(subject, htmlBody) {
    const recipients = getNotifyEmails();
    if (!mailTransporter || recipients.length === 0) {
        console.log('Email skipped: SMTP not configured or no recipients');
        return false;
    }
    try {
        await mailTransporter.sendMail({
            from: SMTP_FROM,
            to: recipients.join(', '),
            subject,
            html: htmlBody,
        });
        console.log(`Email sent: ${subject}`);
        return true;
    } catch (err) {
        console.error('Email send error:', err.message);
        return false;
    }
}

function formatDateForEmail(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function buildLeaseEmailHtml(tenantName, propertyName, startDate, endDate, daysLeft, rentAmount) {
    const monthsLeft = Math.max(0, Math.ceil(daysLeft / 30.44));
    const status = daysLeft < 0
        ? `expired ${Math.ceil(Math.abs(daysLeft) / 30.44)} month${Math.ceil(Math.abs(daysLeft) / 30.44) !== 1 ? 's' : ''} ago`
        : `${monthsLeft} month${monthsLeft !== 1 ? 's' : ''} remaining`;
    const urgency = daysLeft < 0 ? 'EXPIRED' : daysLeft <= 7 ? 'URGENT' : 'REMINDER';
    const color = daysLeft < 0 ? '#dc2626' : daysLeft <= 30 ? '#f59e0b' : '#3b82f6';
    // Calculate lease term in months
    const s = new Date(startDate + 'T00:00:00'), e = new Date(endDate + 'T00:00:00');
    const totalMonths = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
    const termLabel = totalMonths > 0 ? `${totalMonths} month${totalMonths !== 1 ? 's' : ''}` : '';
    return `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
            <div style="background:${color};color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
                <h2 style="margin:0;font-size:18px;">${urgency}: Lease ${status}</h2>
            </div>
            <div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
                <p style="font-size:16px;margin:0 0 12px;"><strong>Tenant:</strong> ${tenantName}</p>
                <p style="font-size:16px;margin:0 0 12px;"><strong>Property:</strong> ${propertyName}</p>
                ${rentAmount ? `<p style="font-size:16px;margin:0 0 12px;"><strong>Monthly Rent:</strong> ₹${Number(rentAmount).toLocaleString('en-IN')}</p>` : ''}
                <p style="font-size:16px;margin:0 0 12px;"><strong>Lease Period:</strong> ${formatDateForEmail(startDate)} — ${formatDateForEmail(endDate)}${termLabel ? ` (${termLabel})` : ''}</p>
                <p style="font-size:16px;margin:0;"><strong>Status:</strong> Lease ${status}</p>
            </div>
            <p style="color:#6b7280;font-size:12px;margin-top:12px;">Sent by Tenant Logger</p>
        </div>`;
}

function buildRentOverdueEmailHtml(tenantName, propertyName, month, rentAmount, leaseEndDate) {
    const [y, m] = month.split('-');
    const monthLabel = new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    let leaseInfo = '';
    if (leaseEndDate) {
        const end = new Date(leaseEndDate + 'T00:00:00');
        const now = new Date();
        const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
        const monthsLeft = Math.max(0, Math.ceil(daysLeft / 30.44));
        const leaseStatus = daysLeft < 0
            ? `expired ${Math.ceil(Math.abs(daysLeft) / 30.44)} month${Math.ceil(Math.abs(daysLeft) / 30.44) !== 1 ? 's' : ''} ago`
            : `${monthsLeft} month${monthsLeft !== 1 ? 's' : ''} remaining`;
        leaseInfo = `<p style="font-size:16px;margin:0 0 12px;"><strong>Lease:</strong> Ends ${formatDateForEmail(leaseEndDate)} (${leaseStatus})</p>`;
    }
    return `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
            <div style="background:#f59e0b;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
                <h2 style="margin:0;font-size:18px;">REMINDER: ${monthLabel} Rent Not Received</h2>
            </div>
            <div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
                <p style="font-size:16px;margin:0 0 12px;"><strong>Tenant:</strong> ${tenantName}</p>
                <p style="font-size:16px;margin:0 0 12px;"><strong>Property:</strong> ${propertyName}</p>
                <p style="font-size:16px;margin:0 0 12px;"><strong>Month:</strong> ${monthLabel}</p>
                ${rentAmount ? `<p style="font-size:16px;margin:0 0 12px;"><strong>Expected Rent:</strong> ₹${Number(rentAmount).toLocaleString('en-IN')}</p>` : ''}
                ${leaseInfo}
            </div>
            <p style="color:#6b7280;font-size:12px;margin-top:12px;">Sent by Tenant Logger</p>
        </div>`;
}

function buildMissingLeaseEmailHtml(tenantName, propertyName, moveInDate) {
    return `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
            <div style="background:#dc2626;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
                <h2 style="margin:0;font-size:18px;">ACTION NEEDED: No Active Lease</h2>
            </div>
            <div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
                <p style="font-size:16px;margin:0 0 12px;"><strong>Tenant:</strong> ${tenantName}</p>
                <p style="font-size:16px;margin:0 0 12px;"><strong>Property:</strong> ${propertyName}</p>
                ${moveInDate ? `<p style="font-size:16px;margin:0 0 12px;"><strong>Move-in Date:</strong> ${formatDateForEmail(moveInDate)}</p>` : ''}
                <p style="font-size:16px;margin:0;color:#dc2626;">This tenant does not have an active lease. Please open Tenant Logger and add a lease so rent tracking and reminders can work properly.</p>
            </div>
            <p style="color:#6b7280;font-size:12px;margin-top:12px;">Sent by Tenant Logger</p>
        </div>`;
}

async function checkAndSendNotifications() {
    console.log('Running notification check at', new Date().toISOString());
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const now = new Date();
        const currentMonth = now.toISOString().slice(0, 7);
        const today = now.toISOString().slice(0, 10);

        if (!data.notificationsSent) data.notificationsSent = [];
        const sent = data.notificationsSent;
        const newNotifications = [];
        const THRESHOLDS = [90, 30, 7, 0];

        // --- Lease expiry checks ---
        (data.leases || []).filter(l => l.active).forEach(lease => {
            const end = new Date(lease.endDate + 'T00:00:00');
            const days = Math.ceil((end - now) / (1000 * 60 * 60 * 24));

            let matchedThreshold = null;
            if (days < 0) {
                matchedThreshold = 0;
            } else {
                for (const t of THRESHOLDS) {
                    if (days <= t) matchedThreshold = t;
                }
            }
            if (matchedThreshold === null) return;

            const alreadySent = sent.some(s => s.type === 'lease-expiry' && s.leaseId === lease.id && s.threshold === matchedThreshold);
            if (alreadySent) return;

            const tenant = (data.tenants || []).find(t => t.id === lease.tenantId);
            const property = (data.properties || []).find(p => p.id === lease.propertyId);
            const tenantName = tenant ? tenant.name : 'Unknown';
            const propertyName = property ? property.name : 'Unknown';

            const monthsLeft = Math.max(0, Math.ceil(days / 30.44));
            const subject = days < 0
                ? `EXPIRED: Lease for ${tenantName} (${propertyName})`
                : `Lease Reminder: ${tenantName} — ${monthsLeft} month${monthsLeft !== 1 ? 's' : ''} left`;

            newNotifications.push({
                subject,
                html: buildLeaseEmailHtml(tenantName, propertyName, lease.startDate, lease.endDate, days, lease.rentAmount),
                record: { type: 'lease-expiry', leaseId: lease.id, threshold: matchedThreshold, sentAt: today }
            });
        });

        // --- Overdue rent checks (1st reminder + 2nd on the 10th) ---
        const dayOfMonth = now.getDate();
        const RENT_REMINDERS = [1, 10]; // send on 1st and 10th of month
        const activeReminder = RENT_REMINDERS.filter(d => dayOfMonth >= d).pop();

        // --- Missing lease checks (once per month per tenant) ---
        (data.tenants || []).filter(t => t.active).forEach(tenant => {
            const activeLease = (data.leases || []).find(l => l.tenantId === tenant.id && l.active);
            if (activeLease) return; // has a lease, skip

            const alreadySent = sent.some(s => s.type === 'missing-lease' && s.tenantId === tenant.id && s.month === currentMonth);
            if (alreadySent) return;

            const property = (data.properties || []).find(p => p.id === tenant.propertyId);
            const propertyName = property ? property.name : 'Unknown';

            newNotifications.push({
                subject: `Action Needed: No Lease for ${tenant.name} (${propertyName})`,
                html: buildMissingLeaseEmailHtml(tenant.name, propertyName, tenant.moveInDate),
                record: { type: 'missing-lease', tenantId: tenant.id, month: currentMonth, sentAt: today }
            });
        });

        // --- Overdue rent checks (only for tenants WITH an active lease) ---
        if (activeReminder) {
            (data.tenants || []).filter(t => t.active).forEach(tenant => {
                const activeLease = (data.leases || []).find(l => l.tenantId === tenant.id && l.active);
                if (!activeLease) return; // no lease — handled by missing-lease check above

                const paid = (data.payments || []).some(p => p.tenantId === tenant.id && p.month === currentMonth);
                if (paid) return;

                const alreadySent = sent.some(s => s.type === 'rent-overdue' && s.tenantId === tenant.id && s.month === currentMonth && s.reminder === activeReminder);
                if (alreadySent) return;

                const property = (data.properties || []).find(p => p.id === tenant.propertyId);
                const propertyName = property ? property.name : 'Unknown';

                const isFollowUp = activeReminder > 1;
                const subject = isFollowUp
                    ? `2nd REMINDER: Rent Not Received — ${tenant.name} (${propertyName})`
                    : `Rent Not Received: ${tenant.name} (${propertyName}) — ${currentMonth}`;

                newNotifications.push({
                    subject,
                    html: buildRentOverdueEmailHtml(tenant.name, propertyName, currentMonth, activeLease.rentAmount, activeLease.endDate),
                    record: { type: 'rent-overdue', tenantId: tenant.id, month: currentMonth, reminder: activeReminder, sentAt: today }
                });
            });
        }

        // --- Send emails and record ---
        for (const notif of newNotifications) {
            const success = await sendEmail(notif.subject, notif.html);
            if (success) {
                data.notificationsSent.push(notif.record);
                logActivity('System', 'notification', `Sent: ${notif.subject}`);
            }
        }

        // Prune records older than 180 days
        const cutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        data.notificationsSent = data.notificationsSent.filter(n => n.sentAt >= cutoff);

        if (newNotifications.length > 0 || data.notificationsSent.length !== sent.length) {
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        }

        console.log(`Notification check complete. Sent ${newNotifications.length} email(s).`);
        return newNotifications.length;
    } catch (err) {
        console.error('Notification check error:', err.message);
        return 0;
    }
}

// --- Notification API endpoints ---
app.post('/api/test-email', requireAuth, async (req, res) => {
    if (!SMTP_HOST) return res.status(400).json({ error: 'SMTP not configured. Set SMTP_HOST environment variable.' });
    const recipients = getNotifyEmails();
    if (recipients.length === 0) return res.status(400).json({ error: 'No recipients configured. Add emails in Settings or set NOTIFY_EMAILS env var.' });
    const testHtml = `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
            <div style="background:#059669;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
                <h2 style="margin:0;font-size:18px;">Test Email — Tenant Logger</h2>
            </div>
            <div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
                <p style="font-size:16px;">This is a test email from Tenant Logger.</p>
                <p style="font-size:16px;">If you received this, email notifications are working correctly.</p>
                <p style="font-size:14px;color:#6b7280;">Sent to: ${recipients.join(', ')}</p>
                <p style="font-size:14px;color:#6b7280;">SMTP: ${SMTP_HOST}:${SMTP_PORT}</p>
            </div>
        </div>`;
    const success = await sendEmail('Test Email — Tenant Logger', testHtml);
    if (success) {
        logActivity(req.userName, 'test-email', `Test email sent to ${recipients.join(', ')}`);
        res.json({ success: true, message: `Test email sent to ${recipients.join(', ')}` });
    } else {
        res.status(500).json({ error: 'Failed to send email. Check server logs.' });
    }
});

app.get('/api/notifications', requireAuth, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const notifications = (data.notificationsSent || []).slice(-50).reverse();
        const enriched = notifications.map(n => {
            const detail = { ...n };
            if (n.type === 'lease-expiry') {
                const lease = (data.leases || []).find(l => l.id === n.leaseId);
                const tenant = lease ? (data.tenants || []).find(t => t.id === lease.tenantId) : null;
                const property = lease ? (data.properties || []).find(p => p.id === lease.propertyId) : null;
                detail.tenantName = tenant ? tenant.name : 'Unknown';
                detail.propertyName = property ? property.name : 'Unknown';
                detail.description = `Lease expiry (${n.threshold} day${n.threshold !== 1 ? 's' : ''}) — ${detail.tenantName}`;
            } else if (n.type === 'rent-overdue') {
                const tenant = (data.tenants || []).find(t => t.id === n.tenantId);
                const property = tenant ? (data.properties || []).find(p => p.id === tenant.propertyId) : null;
                detail.tenantName = tenant ? tenant.name : 'Unknown';
                detail.propertyName = property ? property.name : 'Unknown';
                detail.description = `Rent overdue (${n.month}) — ${detail.tenantName}`;
            } else if (n.type === 'missing-lease') {
                const tenant = (data.tenants || []).find(t => t.id === n.tenantId);
                const property = tenant ? (data.properties || []).find(p => p.id === tenant.propertyId) : null;
                detail.tenantName = tenant ? tenant.name : 'Unknown';
                detail.propertyName = property ? property.name : 'Unknown';
                detail.description = `No active lease — ${detail.tenantName}`;
            }
            return detail;
        });
        res.json(enriched);
    } catch { res.json([]); }
});

app.post('/api/notifications/check', requireAuth, async (req, res) => {
    const emailsSent = await checkAndSendNotifications();
    res.json({ success: true, emailsSent, message: `Notification check completed. ${emailsSent} email(s) sent.` });
});

app.get('/api/notifications/status', requireAuth, (req, res) => {
    res.json({
        smtpConfigured: !!SMTP_HOST,
        smtpHost: SMTP_HOST ? `${SMTP_HOST}:${SMTP_PORT}` : 'Not configured',
        recipients: getNotifyEmails(),
        cronSchedule: NOTIFY_CRON,
        fromAddress: SMTP_FROM
    });
});

// --- Email recipient management ---
app.get('/api/notify-emails', requireAuth, (req, res) => {
    res.json({ emails: getNotifyEmails() });
});

app.put('/api/notify-emails', requireAuth, (req, res) => {
    try {
        const { emails } = req.body;
        if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
        const cleaned = emails.map(e => String(e).trim().toLowerCase()).filter(e => e && e.includes('@'));
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!data.appSettings) data.appSettings = {};
        data.appSettings.notifyEmails = cleaned;
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        logActivity(req.userName, 'settings', `Updated notification emails: ${cleaned.join(', ')}`);
        res.json({ success: true, emails: cleaned });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update emails' });
    }
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start cron job for notifications ---
if (SMTP_HOST) {
    if (cron.validate(NOTIFY_CRON)) {
        cron.schedule(NOTIFY_CRON, () => { checkAndSendNotifications(); });
        const emails = getNotifyEmails();
        console.log(`Notification cron scheduled: "${NOTIFY_CRON}" -> ${emails.length > 0 ? emails.join(', ') : '(no recipients yet)'}`);
    } else {
        console.error(`Invalid NOTIFY_CRON expression: "${NOTIFY_CRON}"`);
    }
} else {
    console.log('Email notifications disabled (SMTP_HOST not set)');
}

app.listen(PORT, () => {
    console.log(`Tenant Logger running on port ${PORT}`);
});
