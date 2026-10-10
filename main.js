/**
 * Find My Device — Windows desktop app (Electron)
 *
 * Loads your hosted Find My Device server in a window and keeps running in the
 * system tray, so a ring or SOS from the other device can still reach this PC
 * after you close the window. When a ring arrives the window pops to the front.
 */
const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, session, nativeImage, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

app.setAppUserModelId('com.player.findmydevice'); // must match "appId" in package.json
// Let the bell play even when the window is hidden in the tray (no click needed).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let trayTipShown = false;
let showingOffline = false;
let lastError = '';
let retryTimer = null;
let serverUrl = '';
let serverOrigin = '';

/* ---------- config: FMD_URL env > userData/config.json > bundled config.json ---------- */
function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function getServerUrl() {
    const user = readJson(path.join(app.getPath('userData'), 'config.json'));
    const bundled = readJson(path.join(__dirname, 'config.json'));
    const url = process.env.FMD_URL || (user && user.serverUrl) || (bundled && bundled.serverUrl) || '';
    return String(url).trim().replace(/\/+$/, '');
}

/* ---------- small settings file (remembers the first-run auto-start choice) ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { return readJson(settingsFile()) || {}; }
function saveSettings(s) { try { fs.writeFileSync(settingsFile(), JSON.stringify(s)); } catch { } }

function originOk(u) {
    try { return new URL(u).origin === serverOrigin; } catch { return false; }
}

/* ---------- window ---------- */
function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function createWindow() {
    win = new BrowserWindow({
        width: 480,
        height: 840,
        minWidth: 380,
        minHeight: 600,
        show: false,
        title: 'Find My Device',
        icon: ICON_PATH,
        backgroundColor: '#0b0b0c',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false // keep the connection and the bell alive while hidden
        }
    });
    Menu.setApplicationMenu(null);

    win.once('ready-to-show', () => { if (!startHidden) win.show(); });

    // Close button hides to the tray; the app keeps listening for rings.
    win.on('close', (e) => {
        if (quitting) return;
        e.preventDefault();
        win.hide();
        if (!trayTipShown && Notification.isSupported()) {
            trayTipShown = true;
            new Notification({
                title: 'Find My Device is still running',
                body: 'It stays in the system tray so rings can reach you. Right-click the tray icon to quit.'
            }).show();
        }
    });

    // Links such as OpenStreetMap and Google Maps open in your normal browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith('file:') || originOk(url)) return;
        e.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
    });

    // No internet or server unreachable: show a friendly page and retry by itself.
    win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
        if (!isMainFrame || code === -3) return; // -3 = navigation was cancelled
        goOffline(`${desc} (${code})`);
    });
    win.webContents.on('did-finish-load', () => {
        if (originOk(win.webContents.getURL())) {
            showingOffline = false;
            clearTimeout(retryTimer);
        }
    });

    win.loadURL(serverUrl).catch(() => { });
}

/* ---------- offline handling ---------- */
function goOffline(reason) {
    if (!win) return;
    if (reason) lastError = reason;
    if (!showingOffline) {
        showingOffline = true;
        // The offline page shows which address failed and why, so problems are easy to diagnose.
        win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: serverUrl, err: lastError } }).catch(() => { });
    }
    scheduleRetry(5000);
}
function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
        try {
            await net.fetch(serverUrl, { method: 'HEAD' }); // any HTTP answer means the server is reachable
            if (win) win.loadURL(serverUrl).catch(() => { });
        } catch {
            scheduleRetry(5000);
        }
    }, ms);
}

/* ---------- tray ---------- */
function rebuildTrayMenu() {
    const startup = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Find My Device', click: showWindow },
        {
            label: 'Start with Windows',
            type: 'checkbox',
            checked: startup,
            enabled: app.isPackaged,
            click: (item) => {
                app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
                rebuildTrayMenu();
            }
        },
        { type: 'separator' },
        { label: 'Quit (you will stop receiving rings)', click: () => { quitting = true; app.quit(); } }
    ]));
}
function createTray() {
    tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
    tray.setToolTip('Find My Device');
    tray.on('click', showWindow);
    rebuildTrayMenu();
}

/* ---------- messages from the web app ---------- */
function trusted(e) {
    try { return originOk(e.senderFrame.url); } catch { return false; }
}

ipcMain.on('fmd:ring', (e, info) => {
    if (!win || !trusted(e)) return;
    const sos = !!(info && info.sos);
    showWindow();
    win.flashFrame(true);
    if (sos) win.setAlwaysOnTop(true, 'screen-saver'); // an SOS stays on top of other windows until answered
    if (Notification.isSupported()) {
        const n = new Notification({
            title: String((info && info.title) || 'Find My Device').slice(0, 100),
            body: String((info && info.body) || '').slice(0, 250),
            icon: ICON_PATH
        });
        n.on('click', showWindow);
        n.show();
    }
});

ipcMain.on('fmd:stop', (e) => {
    if (!win || !trusted(e)) return;
    win.flashFrame(false);
    win.setAlwaysOnTop(false);
});

ipcMain.on('fmd:retry', () => {
    if (showingOffline) scheduleRetry(0);
});

/* ---------- start ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit(); // already running: the first copy will be brought to the front instead
} else {
    app.on('second-instance', showWindow);
    app.on('before-quit', () => { quitting = true; });
    app.on('window-all-closed', () => { /* keep running in the tray */ });

    app.whenReady().then(() => {
        serverUrl = getServerUrl();
        if (!/^https?:\/\//i.test(serverUrl) || serverUrl.includes('your-app.onrender.com')) {
            dialog.showErrorBox(
                'Find My Device',
                'The server address is not set.\n\nOpen desktop/config.json, set "serverUrl" to your hosted address ' +
                '(for example https://my-find-device.onrender.com), then start the app again.'
            );
            app.quit();
            return;
        }
        // The Render dashboard is a login page for you, not the app. Refuse it with a clear message.
        let host = '';
        try { host = new URL(serverUrl).hostname.toLowerCase(); } catch { }
        if (host === 'render.com' || host.endsWith('.render.com')) {
            dialog.showErrorBox(
                'Find My Device',
                'config.json contains a Render dashboard link, which is a login page and not your app.\n\n' +
                'Use your public address instead. It ends with .onrender.com ' +
                '(for example https://my-find-device.onrender.com) and is shown at the top of your service page in Render.'
            );
            app.quit();
            return;
        }
        serverOrigin = new URL(serverUrl).origin;

        // Only your own server may use location and notifications.
        const allowed = ['geolocation', 'notifications'];
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
            callback(allowed.includes(permission) && originOk(details.requestingUrl));
        });
        session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
            return allowed.includes(permission) && originOk(origin);
        });

        // First run of the installed app: start with Windows so rings can arrive after a restart.
        const settings = loadSettings();
        if (app.isPackaged && !settings.autoStartSet) {
            app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
            settings.autoStartSet = true;
            saveSettings(settings);
        }

        createTray();
        createWindow();
    });
}