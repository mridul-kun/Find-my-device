(() => {
    const $ = (s) => document.querySelector(s);

    /* ---------- persistent device identity (this is what keeps the pairing) ---------- */
    function makeId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    const deviceId = localStorage.getItem('fmd_id') || (() => {
        const id = makeId();
        localStorage.setItem('fmd_id', id);
        return id;
    })();

    function defaultName() {
        const ua = navigator.userAgent;
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/iPad/.test(ua)) return 'iPad';
        if (/Android/.test(ua)) return 'Android phone';
        if (/Windows/.test(ua)) return 'Windows PC';
        if (/Mac/.test(ua)) return 'Mac';
        if (/Linux/.test(ua)) return 'Linux PC';
        return 'Device';
    }
    let myName = localStorage.getItem('fmd_name') || defaultName();

    /* ---------- elements ---------- */
    const el = {
        conn: $('#conn'), name: $('#deviceName'), myIp: $('#myIp'),
        viewPair: $('#viewPair'), viewHome: $('#viewHome'),
        btnCode: $('#btnCode'), codeOut: $('#codeOut'), codeText: $('#codeText'), codeTimer: $('#codeTimer'),
        codeIn: $('#codeIn'), btnJoin: $('#btnJoin'), pairErr: $('#pairErr'),
        partnerDot: $('#partnerDot'), partnerName: $('#partnerName'), partnerStatus: $('#partnerStatus'),
        bindMe: $('#bindMe'), bindThem: $('#bindThem'),
        ringWrap: document.querySelector('.ring-wrap'), btnRing: $('#btnRing'), ringLabel: $('#ringLabel'),
        ringStatus: $('#ringStatus'), btnSos: $('#btnSos'), smsLink: $('#smsLink'), btnUnpair: $('#btnUnpair'),
        lastCard: $('#lastCard'), lastTitle: $('#lastTitle'), lastText: $('#lastText'), lastTime: $('#lastTime'),
        lastFrame: $('#lastFrame'), lastOsm: $('#lastOsm'), lastGoogle: $('#lastGoogle'),
        emNumber: $('#emNumber'), btnShare: $('#btnShare'), btnPush: $('#btnPush'), secureNote: $('#secureNote'),
        overlay: $('#ringOverlay'), ringTitle: $('#ringTitle'), ringMsg: $('#ringMsg'), ringDetail: $('#ringDetail'),
        ringFrame: $('#ringFrame'), ringOsm: $('#ringOsm'), ringGoogle: $('#ringGoogle'),
        btnStop: $('#btnStop'), toast: $('#toast')
    };
    el.name.value = myName;
    el.emNumber.value = localStorage.getItem('fmd_em') || '';

    /* ---------- helpers ---------- */
    function ago(ts) {
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 45) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h} h ago`;
        return `${Math.round(h / 24)} d ago`;
    }
    function clock(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    function placeText(loc) {
        if (!loc) return 'a location we could not find';
        return loc.address || [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'an unknown place';
    }
    function precisionText(loc) {
        if (!loc) return '';
        return loc.source === 'gps'
            ? `GPS location, accurate to about ${loc.accuracy || '?'} m.`
            : 'Approximate location from the IP address, usually accurate to the city.';
    }

    /* ---------- maps: OpenStreetMap embed + links to OpenStreetMap and Google Maps ---------- */
    function mapUrls(loc) {
        if (!loc || loc.lat == null || loc.lon == null) return null;
        const { lat, lon } = loc;
        const d = loc.source === 'gps' ? 0.003 : 0.06;
        const bbox = [lon - d, lat - d, lon + d, lat + d].map((n) => n.toFixed(5)).join('%2C');
        return {
            embed: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`,
            osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${loc.source === 'gps' ? 17 : 11}/${lat}/${lon}`,
            google: `https://www.google.com/maps?q=${lat},${lon}`
        };
    }
    function fillMap(frame, osmLink, googleLink, loc) {
        const m = mapUrls(loc);
        if (!m) { frame.hidden = true; osmLink.hidden = true; googleLink.hidden = true; return; }
        if (frame.dataset.src !== m.embed) { frame.src = m.embed; frame.dataset.src = m.embed; }
        frame.hidden = false;
        osmLink.href = m.osm;
        googleLink.href = m.google;
        osmLink.hidden = false;
        googleLink.hidden = false;
    }

    /* ---------- offline queue (SOS waits here until the internet is back) ---------- */
    let queue = [];
    try { queue = JSON.parse(localStorage.getItem('fmd_queue') || '[]'); } catch { queue = []; }
    const saveQueue = () => localStorage.setItem('fmd_queue', JSON.stringify(queue));

    /* ---------- WebSocket with auto-reconnect ---------- */
    let ws, retry = 0, state = null, codeCountdown = null;

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}`);

        ws.onopen = () => {
            retry = 0;
            setConn(true);
            ws.send(JSON.stringify({ type: 'register', id: deviceId, name: myName }));
            // Send anything that was saved while offline
            while (queue.length) ws.send(JSON.stringify(queue.shift()));
            saveQueue();
            if (Notification.permission === 'granted') subscribePush().catch(() => { });
            if (localStorage.getItem('fmd_share') === '1') shareTick();
        };
        ws.onmessage = (e) => handle(JSON.parse(e.data));
        ws.onclose = () => {
            setConn(false);
            setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
        };
        ws.onerror = () => ws.close();
    }
    const isOpen = () => ws && ws.readyState === 1;
    const send = (obj) => { if (isOpen()) ws.send(JSON.stringify(obj)); };

    function setConn(on) {
        el.conn.dataset.state = on ? 'on' : 'off';
        el.conn.textContent = on ? 'Connected' : 'No connection. Retrying';
        if (!on) el.btnRing.disabled = true;
    }
    window.addEventListener('online', () => { if (!isOpen()) { try { ws.close(); } catch { } } });

    /* ---------- message handling ---------- */
    function handle(msg) {
        switch (msg.type) {
            case 'state': renderState(msg); break;
            case 'code': showCode(msg.code, msg.expiresIn); break;
            case 'error': showPairError(msg.message); break;
            case 'ring': startRinging(msg); break;
            case 'ring-stopped': toast(`${msg.by} stopped the ring.`); setStatus('', ''); break;
            case 'ring-result': ringResult(msg); break;
        }
    }

    function renderState(s) {
        state = s;
        el.myIp.textContent = s.me.ip || 'unknown';
        if (s.me.name && s.me.name !== el.name.value && document.activeElement !== el.name) el.name.value = s.me.name;

        if (!s.partner) {
            el.viewHome.hidden = true;
            el.viewPair.hidden = false;
            return;
        }
        el.viewPair.hidden = true;
        el.viewHome.hidden = false;
        clearCode();

        const p = s.partner;
        el.partnerName.textContent = p.name;
        el.partnerDot.classList.toggle('on', p.online);
        el.partnerStatus.textContent = p.online
            ? 'Online'
            : (p.lastSeen ? `Offline since ${clock(p.lastSeen)}. Alerts still reach them.` : 'Offline');
        el.bindMe.textContent = s.me.ip || '–';
        el.bindThem.textContent = p.ip || '–';
        el.ringLabel.textContent = 'Ring';
        // Ringing stays enabled even when they are offline: it goes out as a notification.
        el.btnRing.disabled = !isOpen();
        el.btnRing.setAttribute('aria-label', `Ring ${p.name}`);
        renderLast();
        refreshSms();
    }

    function renderLast() {
        const p = state && state.partner;
        if (!p || !p.last) { el.lastCard.hidden = true; return; }
        el.lastCard.hidden = false;
        el.lastTitle.textContent = `Last known location of ${p.name}`;
        el.lastText.textContent = placeText(p.last.loc);
        el.lastTime.textContent = `Updated ${ago(p.last.at)}. ${precisionText(p.last.loc)}`;
        fillMap(el.lastFrame, el.lastOsm, el.lastGoogle, p.last.loc);
    }
    setInterval(renderLast, 30000);

    /* ---------- naming ---------- */
    el.name.addEventListener('change', () => {
        const v = el.name.value.trim();
        if (!v) { el.name.value = myName; return; }
        myName = v;
        localStorage.setItem('fmd_name', v);
        send({ type: 'rename', name: v });
    });

    /* ---------- pairing ---------- */
    el.btnCode.addEventListener('click', () => { hidePairError(); send({ type: 'create-code' }); });

    function showCode(code, seconds) {
        el.codeText.textContent = code;
        el.codeOut.hidden = false;
        let left = seconds;
        clearInterval(codeCountdown);
        const tick = () => {
            if (left <= 0) { clearCode(); return; }
            const m = Math.floor(left / 60), s = String(left % 60).padStart(2, '0');
            el.codeTimer.textContent = `Expires in ${m}:${s}`;
            left--;
        };
        tick();
        codeCountdown = setInterval(tick, 1000);
    }
    function clearCode() { clearInterval(codeCountdown); el.codeOut.hidden = true; }

    el.btnJoin.addEventListener('click', joinNow);
    el.codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNow(); });
    function joinNow() {
        hidePairError();
        const code = el.codeIn.value.replace(/\D/g, '');
        if (code.length !== 6) return showPairError('Enter the 6-digit code shown on your other device.');
        send({ type: 'join', code });
    }
    function showPairError(m) { el.pairErr.textContent = m; el.pairErr.hidden = false; }
    function hidePairError() { el.pairErr.hidden = true; }

    el.btnUnpair.addEventListener('click', () => {
        if (confirm('Unpair these devices?')) send({ type: 'unpair' });
    });

    /* ---------- GPS ---------- */
    function cachedGps() {
        try { return JSON.parse(localStorage.getItem('fmd_lastgps')) || null; } catch { return null; }
    }
    // Resolves with a fresh fix, or the last saved fix, or null. GPS needs HTTPS (or localhost).
    function getPosition(timeout = 8000, onError) {
        return new Promise((resolve) => {
            if (!navigator.geolocation || !window.isSecureContext) return resolve(cachedGps());
            navigator.geolocation.getCurrentPosition(
                (p) => {
                    const g = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
                    localStorage.setItem('fmd_lastgps', JSON.stringify(g));
                    resolve(g);
                },
                (err) => { if (onError) onError(err); resolve(cachedGps()); },
                { enableHighAccuracy: true, timeout, maximumAge: 30000 }
            );
        });
    }

    let shareTimer = null;
    async function shareTick() {
        const g = await getPosition(10000);
        if (g) { send({ type: 'location', gps: g }); refreshSms(); }
    }
    function startSharing() {
        clearInterval(shareTimer);
        shareTick();
        shareTimer = setInterval(shareTick, 60000);
    }

    el.btnShare.addEventListener('click', () => {
        if (!window.isSecureContext) return toast('Exact location needs HTTPS. See the note below.');
        if (!navigator.geolocation) return toast('This browser has no location support.');
        navigator.geolocation.getCurrentPosition(
            () => {
                localStorage.setItem('fmd_share', '1');
                startSharing();
                toast('Sharing your exact location while the app is open.');
            },
            () => toast('Location is blocked. Allow it in the browser site settings.'),
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });
    if (localStorage.getItem('fmd_share') === '1') startSharing();

    /* ---------- emergency contact + SMS (works with no internet) ---------- */
    el.emNumber.addEventListener('input', () => {
        localStorage.setItem('fmd_em', el.emNumber.value.trim());
        refreshSms();
    });
    // SMS links only work on a phone or tablet with a SIM card, not on a laptop.
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        !!(navigator.userAgentData && navigator.userAgentData.mobile);

    function smsHref(gps) {
        const num = (el.emNumber.value || '').replace(/[^\d+]/g, '');
        if (!num) return '';
        const where = gps ? `https://www.google.com/maps?q=${gps.lat},${gps.lon}` : 'location unavailable';
        const body = encodeURIComponent(`SOS from ${myName}. I need help. My location: ${where}`);
        const sep = /iPhone|iPad/.test(navigator.userAgent) ? '&' : '?';
        return `sms:${num}${sep}body=${body}`;
    }
    function refreshSms(gps) {
        const href = smsHref(gps || cachedGps());
        el.smsLink.hidden = !isMobile || !href || !state || !state.partner;
        if (href) el.smsLink.href = href;
    }
    el.smsLink.addEventListener('click', () => { el.smsLink.href = smsHref(cachedGps()) || el.smsLink.href; });

    /* ---------- ring and SOS ---------- */
    el.btnRing.addEventListener('click', () => {
        unlockAudio();
        send({ type: 'ring', gps: cachedGpsFresh() });
        el.ringWrap.classList.remove('ping');
        void el.ringWrap.offsetWidth;
        el.ringWrap.classList.add('ping');
        setStatus('Ringing…', '');
    });
    // Use a GPS fix from the last 2 minutes if we have one; otherwise the server uses the IP.
    function cachedGpsFresh() {
        const g = cachedGps();
        return g && Date.now() - g.at < 120000 ? g : null;
    }

    let holdTimer = null;
    el.btnSos.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.btnSos.classList.add('holding');
        holdTimer = setTimeout(() => { el.btnSos.classList.remove('holding'); triggerSos(); }, 1000);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
        el.btnSos.addEventListener(ev, () => { clearTimeout(holdTimer); el.btnSos.classList.remove('holding'); })
    );
    el.btnSos.addEventListener('click', (e) => { if (e.detail === 0) triggerSos(); }); // keyboard users

    async function triggerSos() {
        unlockAudio();
        if (navigator.vibrate) navigator.vibrate(200);
        setStatus('Getting your location…', '');
        const gps = await getPosition(6000);
        const item = { type: 'sos', gps, queuedAt: Date.now() };
        if (isOpen()) {
            send(item);
            setStatus('Sending SOS…', '');
        } else {
            queue.push(item);
            saveQueue();
            setStatus('No internet. SOS is saved and sends the moment you are back online.', 'bad');
        }
        refreshSms(gps);
        if (!el.smsLink.hidden) toast('Tap "Send SOS by SMS" to alert your contact without internet.');
        else if (!isMobile) toast('SMS without internet only works on a phone with a SIM card.');
        else toast('Add an emergency number in Safety settings to enable SMS without internet.');
    }

    function ringResult(r) {
        const name = state && state.partner ? state.partner.name : 'The other device';
        const sos = r.kind === 'sos';
        if (!r.ok) {
            setStatus(r.reason === 'not-paired' ? 'Pair a device first.' : `${name} could not be reached.`, 'bad');
        } else if (r.live) {
            setStatus(sos ? `SOS sent. ${name} is ringing now.` : `${name} is ringing now.`, 'ok');
        } else if (r.pushed) {
            setStatus(`${name}'s app is closed. Alert sent as a notification.`, 'ok');
        } else if (r.pending) {
            setStatus(`${name} is offline. The ${sos ? 'SOS' : 'ring'} will appear as soon as they open the app.`, 'ok');
        }
    }
    function setStatus(text, cls) { el.ringStatus.textContent = text; el.ringStatus.className = 'status ' + cls; }

    /* ---------- receiving a ring / SOS ---------- */
    let ringTimer = null;

    function startRinging(msg) {
        const { from } = msg;
        const sos = msg.kind === 'sos';
        const loc = from.location;

        el.overlay.classList.toggle('sos', sos);
        el.ringTitle.textContent = sos ? `SOS: ${from.name} needs help` : `${from.name} is calling`;
        el.ringMsg.textContent = loc ? `Location: ${placeText(loc)}` : 'Location is not available.';
        const late = msg.delayed ? `Sent ${ago(msg.at)}. ` : '';
        const old = from.locationAt && Date.now() - from.locationAt > 120000
            ? `Last known location from ${ago(from.locationAt)}. ` : '';
        el.ringDetail.textContent = `${late}${old}${precisionText(loc)}`;
        fillMap(el.ringFrame, el.ringOsm, el.ringGoogle, loc);

        el.overlay.hidden = false;
        el.btnStop.focus();
        unlockAudio();
        clearInterval(ringTimer);
        ringBell(sos);
        ringTimer = setInterval(() => ringBell(sos), sos ? 900 : 1500);
        // Clear the notification that was shown while the app was closed
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration()
                .then((reg) => reg && reg.getNotifications().then((list) => list.forEach((n) => n.close())))
                .catch(() => { });
        }
        // Desktop app (Electron): bring the window to the front and show a native notification
        if (window.fmdDesktop) {
            window.fmdDesktop.ring({ sos, title: el.ringTitle.textContent, body: el.ringMsg.textContent });
        }
    }

    function ringBell(sos) {
        strike(sos ? 1 : 0.7);
        if (navigator.vibrate) navigator.vibrate(sos ? [500, 150, 500] : [300, 150, 300]);
    }

    el.btnStop.addEventListener('click', stopRinging);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.overlay.hidden) stopRinging(); });
    function stopRinging() {
        clearInterval(ringTimer);
        ringTimer = null;
        el.overlay.hidden = true;
        if (navigator.vibrate) navigator.vibrate(0);
        if (window.fmdDesktop) window.fmdDesktop.stop();
        send({ type: 'stop' });
    }

    /* ---------- bell sound (synthesised) ---------- */
    let audioCtx;
    function unlockAudio() {
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) audioCtx = new AC();
        }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    function strike(volume) {
        if (!audioCtx) return;
        const t = audioCtx.currentTime;
        const master = audioCtx.createGain();
        master.gain.setValueAtTime(0.0001, t);
        master.gain.exponentialRampToValueAtTime(volume, t + 0.01);
        master.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        master.connect(audioCtx.destination);
        [[880, 1], [1318, 0.55], [1760, 0.4], [2640, 0.25], [3520, 0.12]].forEach(([freq, gain]) => {
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.type = 'sine';
            o.frequency.value = freq * (1 + (Math.random() - 0.5) * 0.004);
            g.gain.value = gain;
            o.connect(g).connect(master);
            o.start(t);
            o.stop(t + 1.5);
        });
    }

    /* ---------- alerts when the app is closed (service worker + web push) ---------- */
    function b64ToU8(b64) {
        const pad = '='.repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    }
    async function subscribePush() {
        const reg = await navigator.serviceWorker.ready;
        const { key } = await (await fetch('/api/vapid')).json();
        let sub = await reg.pushManager.getSubscription();
        if (sub && localStorage.getItem('fmd_vapid') !== key) { await sub.unsubscribe(); sub = null; }
        if (!sub) {
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
            localStorage.setItem('fmd_vapid', key);
        }
        send({ type: 'push-sub', sub: sub.toJSON() });
    }

    el.btnPush.addEventListener('click', async () => {
        if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) {
            return toast('Alerts when closed need HTTPS. On iPhone, also add the app to the Home Screen.');
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return toast('Notifications are blocked. Allow them in the browser site settings.');
        try { await subscribePush(); toast('Alerts when the app is closed are on.'); }
        catch { toast('Could not turn on alerts. Check that the address uses HTTPS.'); }
    });

    if (window.fmdDesktop) {
        el.btnPush.hidden = true; // desktop app keeps running in the tray instead of using web push
    }
    if (window.isSecureContext && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => { });
    } else {
        el.secureNote.hidden = false;
        el.secureNote.textContent =
            'This address is not HTTPS, so exact GPS, alerts when closed and offline opening are off. ' +
            'Host the app on an HTTPS address to turn them on. Rings, SOS and IP location still work.';
    }

    /* ---------- toast ---------- */
    let toastTimer;
    function toast(text) {
        el.toast.textContent = text;
        el.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (el.toast.hidden = true), 4500);
    }

    connect();
})();