// auth_gate_kiosk_then_full.js — глобальный чёрный список "/profile"
// ------------------------------------------------------------------
// Схема работы
// 1) Headless‑логин на внешний сайт.
// 2) Kiosk‑окно с Internal Login (адресная строка скрыта, одна вкладка).
//    URL‑сторож не даёт уйти с data:‑страницы.
// 3) После успешного internalAuth kiosk закрывается.
// 4) Запускается обычный Chrome‑окно (UI). На ВСЕХ его вкладках
//    строгий блокер закрывает вкладку *и* абортирует network‑запрос,
//    если URL содержит "/profile".
// ------------------------------------------------------------------
// .env параметры: REMOTE_BASE_URL, USERNAME_FIELD, PASSWORD_FIELD,
// INTERNAL_USERS=login:pass,login2:pass2
// ------------------------------------------------------------------

require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');

const SITE  = process.env.REMOTE_BASE_URL;
const EMAIL = process.env.USERNAME_FIELD;
const PASS  = process.env.PASSWORD_FIELD;
const PROFILE_DIR = path.resolve('user_data');

const INTERNAL_USERS = (process.env.INTERNAL_USERS || 'operator:1234')
    .split(',')
    .map(p=>p.split(':'))
    .map(([u,p])=>({user:u.trim(),pass:p.trim()}));
const checkInternal = (u,p)=>INTERNAL_USERS.some(r=>r.user===u&&r.pass===p);

//------------------------------------------------------------------
// 1. Headless‑login
//------------------------------------------------------------------
async function headlessLogin(){
    const browser=await puppeteer.launch({headless:'new',userDataDir:PROFILE_DIR,args:['--no-sandbox','--disable-setuid-sandbox']});
    const page=await browser.newPage();
    await page.goto(`${SITE}/dispatch`,{waitUntil:'networkidle2'});
    if(page.url().includes('/login')){
        await page.type('input[data-cy="loginEmailField"]',EMAIL);
        await page.type('input[data-cy="loginPasswordField"]',PASS);
        await Promise.all([
            page.click('button[data-cy="signInBtn"]'),
            page.waitForNavigation({waitUntil:'networkidle2'})
        ]);
    }
    await browser.close();
}

//------------------------------------------------------------------
// 2. Kiosk‑HTML (data URL)
//------------------------------------------------------------------
function makeLoginHTML(){
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
      async function attempt(){const ok=await window.verifyLogin(user.value,pass.value); if(ok){await window.signalAuth();} else msg.textContent='Invalid credentials';}
      go.onclick=attempt; document.addEventListener('keyup',e=>{if(e.key==='Enter')attempt();});
    </script>
  </body></html>`;
}

//------------------------------------------------------------------
// 3. Kiosk‑browser
//------------------------------------------------------------------
async function kioskLogin(){
    const kiosk=await puppeteer.launch({headless:false,userDataDir:PROFILE_DIR,defaultViewport:null,
        args:['--kiosk','--no-sandbox','--disable-setuid-sandbox','--disable-infobars']});
    kiosk.on('targetcreated',async()=>{const pages=await kiosk.pages();if(pages.length>1){await pages.pop().close();}});
    const [page]=await kiosk.pages();
    let resolveAuth;const authP=new Promise(res=>resolveAuth=res);
    await page.exposeFunction('verifyLogin',(u,p)=>checkInternal(u,p));
    await page.exposeFunction('signalAuth',()=>resolveAuth(true));
    await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(makeLoginHTML()));
    await authP;
    await kiosk.close();
}

//------------------------------------------------------------------
// 4. Полный Chrome + глобальный blacklist /profile
//------------------------------------------------------------------
async function launchFull(){
    const BLACKLIST=['/profile'];
    const isBlocked=url=>BLACKLIST.some(b=>url.includes(b));
    const browser=await puppeteer.launch({headless:false,userDataDir:PROFILE_DIR,defaultViewport:null,
        args:['--start-maximized','--no-sandbox','--disable-setuid-sandbox']});

    // Функция‑сторож: запросы + навигации
    const attachBlocker=async page=>{
        await page.setRequestInterception(true);
        page.on('request',req=>{if(isBlocked(req.url())){console.log('[blk] abort',req.url());req.abort();}else req.continue();});
        page.on('framenavigated',frame=>{const u=frame.url();if(isBlocked(u)){console.log('[blk] nav',u);page.close();}});
    };

    // Существующие страницы (обычно одна)
    for(const p of await browser.pages()) await attachBlocker(p);

    // Новые страницы
    browser.on('targetcreated',async t=>{if(t.type()==='page'){const p=await t.page();await attachBlocker(p);if(isBlocked(p.url())){console.log('[blk] close new',p.url());await p.close();}}});

    // Автовыход
    const exit=async()=>{if((await browser.pages()).length===0){await browser.close();process.exit(0);}};
    browser.on('targetdestroyed',exit);browser.on('disconnected',()=>process.exit(0));

    const p=await browser.newPage();
    await p.goto(`${SITE}/dispatch`,{waitUntil:'networkidle2'});
    await new Promise(()=>{});
}

//------------------------------------------------------------------
// 5. Main
//------------------------------------------------------------------
(async()=>{
    try{
        await headlessLogin();
        await kioskLogin();
        await launchFull();
    }catch(e){console.error(e);process.exit(1);}
})();
