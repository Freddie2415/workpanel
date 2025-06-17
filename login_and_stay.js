require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');

//--------------------------------------------------
// Logging util
//--------------------------------------------------
function log(scope, ...args) {
    console.log(`${new Date().toISOString()} [${scope}]`, ...args);
}

//--------------------------------------------------
// 0. Decrypt service-account JSON (AES-256-GCM)
//--------------------------------------------------
function decryptServiceAccount() {
    log('decrypt', 'Starting decryption of service account');
    const encPath = process.env.SA_ENC_PATH || path.join(__dirname, 'serviceAccount.enc');
    const key = Buffer.from(process.env.SA_KEY || '942a1be56119228d8df0c2769059d4e6b9022882983def29ee38dbe34e37652b', 'hex');
    const iv = Buffer.from(process.env.SA_IV || '1e6631d01807299ebf5e0d26', 'hex');
    const tag = Buffer.from(process.env.SA_TAG || '28910d5c928822bcf0ccfb592460095a', 'hex');
    log('decrypt', 'Paths and crypto vars prepared', {encPath});
    if (!fs.existsSync(encPath) || key.length !== 32 || iv.length !== 12 || tag.length !== 16) {
        log('decrypt', 'Encrypted service-account or crypto vars missing / invalid');
        throw new Error('Encrypted service-account or crypto vars missing / invalid');
    }
    const cipherText = fs.readFileSync(encPath);
    log('decrypt', 'Encrypted file loaded', {size: cipherText.length});
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    log('decrypt', 'Decryption complete');
    return JSON.parse(decrypted.toString('utf8'));
}

//--------------------------------------------------
// 1. Firebase init
//--------------------------------------------------
log('firebase', 'Initializing Firebase');
admin.initializeApp({credential: admin.credential.cert(decryptServiceAccount())});
const db = admin.firestore();
log('firebase', 'Firestore instantiated');

//--------------------------------------------------
// 2. Global state & helpers
//--------------------------------------------------
const PROFILE_DIR = path.resolve('user_data');
const CONFIG_REF = db.collection('appConfig').doc('kioskAuth');
const INTERNAL_COLL = db.collection('internalUsers');

let CURRENT_CFG = null;         // appConfig/kioskAuth snapshot
let CURRENT_INTERNAL = null;    // array of {user,pass}
let STARTED = false;            // main() launched?
let BROWSERS = [];              // all launched Puppeteer instances

const arraysEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => JSON.stringify(v) === JSON.stringify(b[i]));

async function gracefulExit(code = 0, wipeProfile = false) {
    log('exit', 'Graceful exit requested', {code, wipeProfile});
    for (const br of BROWSERS) {
        try {
            await br.close();
            log('exit', 'Browser closed');
        } catch (e) {
            log('exit', 'Error closing browser', e.message);
        }
    }
    if (wipeProfile) {
        try {
            fs.rmSync(PROFILE_DIR, {recursive: true, force: true});
            log('cache', 'user_data wiped');
        } catch (e) {
            log('cache', 'wipe failed', e.message);
        }
    }
    process.exit(code);
}

//--------------------------------------------------
// 3. Browser building blocks (unchanged logic but added logs)
//--------------------------------------------------
async function headlessLogin(cfg) {
    log('headless', 'Launching headless browser for pre-login');
    const {remoteBaseUrl: SITE, externalEmail: EMAIL, externalPass: PASS} = cfg;
    const browser = await puppeteer.launch({
        headless: 'new', userDataDir: PROFILE_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    BROWSERS.push(browser);
    try {
        const page = await browser.newPage();
        log('headless', 'Navigating to dispatch', SITE + '/dispatch');
        await page.goto(`${SITE}/dispatch`, {waitUntil: 'networkidle2'});
        if (page.url().includes('/login')) {
            log('headless', 'Login page detected, performing login');
            await page.type('input[data-cy="loginEmailField"]', EMAIL);
            await page.type('input[data-cy="loginPasswordField"]', PASS);
            await Promise.all([
                page.click('button[data-cy="signInBtn"]'),
                page.waitForNavigation({waitUntil: 'networkidle2'})
            ]);
            log('headless', 'Logged in successfully');
        } else {
            log('headless', 'Dispatch open without login');
        }
    } catch (e) {
        log('headless', 'Error during headlessLogin', e);
        throw e;
    } finally {
        await browser.close();
        BROWSERS.splice(BROWSERS.indexOf(browser), 1);
        log('headless', 'Headless browser closed');
    }
}

function makeLoginHTML() {
    log('kiosk', 'Generating kiosk login HTML');
    return `<!DOCTYPE html><html><head><meta charset=utf-8><title>Internal Login</title></head>
 <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff;font-family:sans-serif;gap:12px;">
  <h2 style="margin:0">Internal Login</h2>
  <input id=user placeholder=Username style="font-size:18px;padding:8px;width:240px;border-radius:4px;border:none;">
  <input id=pass type=password placeholder=Password style="font-size:18px;padding:8px;width:240px;border-radius:4px;border:none;">
  <button id=go style="font-size:18px;padding:8px 16px;border:none;border-radius:4px;background:#3ba768;color:#fff;cursor:pointer;">Enter</button>
  <p id=msg style="height:18px;color:#ff6b6b;margin:0"></p>
  <script>
   const loginURL=location.href;
   window.addEventListener('keydown',e=>{if(e.ctrlKey&&(e.key==='n'||e.key==='t'))e.preventDefault();});
   setInterval(()=>{if(location.href!==loginURL)location.href=loginURL;},300);
   async function attempt(){console.log('[login] attempt', user.value); const ok=await window.verifyLogin(user.value,pass.value); if(ok){await window.signalAuth();} else msg.textContent='Invalid credentials';}
   go.onclick=attempt; document.addEventListener('keyup',e=>{if(e.key==='Enter')attempt();});
  </script>
 </body></html>`;
}

async function kioskLogin() {
    log('kiosk', 'Launching kiosk login window');
    const kiosk = await puppeteer.launch({
        headless: false, userDataDir: PROFILE_DIR, defaultViewport: null,
        args: ['--kiosk', '--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars']
    });
    BROWSERS.push(kiosk);
    kiosk.on('targetcreated', async () => {
        const pages = await kiosk.pages();
        if (pages.length > 1) {
            log('kiosk', 'Extra page detected, closing');
            await pages.pop().close();
        }
    });
    const [page] = await kiosk.pages();
    let resolveAuth;
    const authP = new Promise(r => resolveAuth = r);
    await page.exposeFunction('verifyLogin', (u, p) => {
        log('kiosk', `Login attempt from ${u}`);
        return (CURRENT_INTERNAL || []).some(r => r.user === u && r.pass === p);
    });
    await page.exposeFunction('signalAuth', () => {
        log('kiosk', 'User authenticated');
        resolveAuth(true);
    });
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(makeLoginHTML()));
    await authP;
    log('kiosk', 'Closing kiosk window after auth');
    await kiosk.close();
    BROWSERS.splice(BROWSERS.indexOf(kiosk), 1);
    log('kiosk', 'Kiosk browser closed');
}

async function launchFull(cfg) {
    log('full', 'Launching main browser');
    const blacklist = cfg.blacklist && cfg.blacklist.length ? cfg.blacklist : ['/profile'];
    const isBlocked = url => blacklist.some(b => url.includes(b));
    const browser = await puppeteer.launch({
        headless: false, userDataDir: PROFILE_DIR, defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });
    BROWSERS.push(browser);
    const attachBlocker = async page => {
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (isBlocked(req.url())) {
                log('blk', 'abort', req.url());
                req.abort();
            } else req.continue();
        });
        page.on('framenavigated', frame => {
            const u = frame.url();
            if (isBlocked(u)) {
                log('blk', 'nav', u);
                page.close();
            }
        });
    };
    for (const p of await browser.pages()) await attachBlocker(p);
    browser.on('targetcreated', async t => {
        if (t.type() === 'page') {
            const p = await t.page();
            await attachBlocker(p);
            if (isBlocked(p.url())) {
                log('blk', 'close new', p.url());
                await p.close();
            }
        }
    });
    const exitIfEmpty = async () => {
        if ((await browser.pages()).length === 0) {
            log('full', 'No pages left, closing browser');
            await browser.close();
            BROWSERS.splice(BROWSERS.indexOf(browser), 1);
            process.exit(0);
        }
    };
    browser.on('targetdestroyed', exitIfEmpty);
    browser.on('disconnected', () => {
        log('full', 'Browser disconnected, exiting');
        process.exit(0);
    });
    const p = await browser.newPage();
    await p.goto(`${cfg.remoteBaseUrl}/dispatch`, {waitUntil: 'networkidle2'});
    log('full', 'Main browser ready');
    await new Promise(() => {
    });
}

async function main(cfg) {
    log('main', 'Starting main flow');
    await headlessLogin(cfg);
    await kioskLogin();
    await launchFull(cfg);
}

//--------------------------------------------------
// 4. Firestore listeners (+wipeProfile)
//--------------------------------------------------
function watch() {
    log('watch', 'Setting up Firestore listeners');
    CONFIG_REF.onSnapshot(async snap => {
        const data = snap.data();
        log('cfg', 'kioskAuth snapshot', data);
        if (!data) {
            log('cfg', 'kioskAuth missing → exit');
            await gracefulExit(1, true);
        }
        if (CURRENT_CFG) { // compare sensitive fields
            if (data.remoteBaseUrl !== CURRENT_CFG.remoteBaseUrl ||
                data.externalEmail !== CURRENT_CFG.externalEmail ||
                data.externalPass !== CURRENT_CFG.externalPass ||
                data.blacklist !== CURRENT_CFG.blacklist) {
                log('cfg', 'Sensitive config changed → restart & wipe');
                await gracefulExit(0, true);
            }
        }
        CURRENT_CFG = data;
        maybeStart();
    });

    INTERNAL_COLL.onSnapshot(async snap => {
        const users = snap.docs.map(d => ({user: d.get('user') || '', pass: d.get('pass') || ''}));
        log('cfg', 'internalUsers snapshot', users);
        if (CURRENT_INTERNAL && !arraysEqual(users, CURRENT_INTERNAL)) {
            log('cfg', 'internalUsers changed → restart & wipe');
            await gracefulExit(0, true);
        }
        CURRENT_INTERNAL = users;
        maybeStart();
    });
}

function maybeStart() {
    if (!STARTED && CURRENT_CFG && CURRENT_INTERNAL) {
        STARTED = true;
        log('main', 'All configs loaded, starting');
        main(CURRENT_CFG).catch(async e => {
            log('main', 'Unhandled error', e);
            await gracefulExit(1, true);
        });
    }
}

//--------------------------------------------------
// 5. Entry point + signals (no wipe on manual SIGINT)
//--------------------------------------------------
watch();
process.on('SIGINT', () => {
    log('signal', 'SIGINT received');
    gracefulExit(0, false);
});
process.on('SIGTERM', () => {
    log('signal', 'SIGTERM received');
    gracefulExit(0, false);
});
