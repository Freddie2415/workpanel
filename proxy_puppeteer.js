// proxy_puppeteer.js
// --------------------------------------------------------------------
// Прокси‑сервер на Express + Puppeteer для ces.gtnetwork.com, который
// • Логинится через headless‑Chrome, вводя email/пароль по data‑cy селекторам.
// • Забирает **cookies** и **JWT bearer‑token** (из localStorage или JSON
//   ответа) и сохраняет их в express‑session.
// • Проксирует все запросы через `/proxy/**`, автоматически подставляя:
//     – Cookie: <name>=<value>;
//     – Authorization: Bearer <token>
//
// Запуск:
//   npm i express express-session puppeteer http-proxy-middleware body-parser
//   export SESSION_SECRET="mysecret"
//   node proxy_puppeteer.js
// --------------------------------------------------------------------

const express = require('express');
const session = require('express-session');
const puppeteer = require('puppeteer');
const { createProxyMiddleware } = require('http-proxy-middleware');
const bodyParser = require('body-parser');

// ------------------------- Константы ---------------------------------
const REMOTE_BASE = process.env.REMOTE_BASE || 'https://ces.gtnetwork.com';
const LOGIN_PAGE  = process.env.LOGIN_PAGE  || REMOTE_BASE + '/login';
const PORT        = process.env.PORT        || 8080;

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
}));

// ---------------------- Логирование helper ---------------------------
function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

// ---------------------- Puppeteer login ------------------------------
async function performLogin(email, password) {
    log('Launching headless Chrome…');
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();

    log('Go to', LOGIN_PAGE);
    await page.goto(LOGIN_PAGE, { waitUntil: 'networkidle2' });

    const emailSelector    = 'input[data-cy="loginEmailField"]';
    const passwordSelector = 'input[data-cy="loginPasswordField"]';
    const submitSelector   = 'button[data-cy="signInBtn"]';

    await page.waitForSelector(emailSelector, { visible: true });
    await page.type(emailSelector, email, { delay: 30 });

    await page.waitForSelector(passwordSelector, { visible: true });
    await page.type(passwordSelector, password, { delay: 30 });

    // Немедленно слушаем POST /login, чтобы вытащить JSON‑ответ, если LT хранится там
    const loginResponsePromise = page.waitForResponse(
        r => r.request().method() === 'POST' && r.url().includes('/login')
    ).catch(() => null);

    log('Click Login button');
    await Promise.all([
        page.click(submitSelector),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    // 1️⃣  Пробуем взять токен из localStorage
    let bearerToken = await page.evaluate(() =>
        localStorage.getItem('token') ||
        localStorage.getItem('accessToken') ||
        localStorage.getItem('jwt') || null
    );

    // 2️⃣  Если не нашли — берём из JSON‑ответа /login
    if (!bearerToken) {
        const resp = await loginResponsePromise;
        if (resp) {
            try {
                const data = await resp.json();
                bearerToken = data.token || null;
            } catch (_) { /* ignore */ }
        }
    }

    if (!bearerToken) {
        log('⚠️  Bearer token not found — API calls may fail.');
    } else {
        log('Bearer token captured');
    }

    const cookies = await page.cookies();
    await browser.close();
    return { cookies, bearerToken };
}

// ----------------------- Routes --------------------------------------
app.get('/', (req, res) => {
    res.send(`
    <h2>Login to CES GTNetwork</h2>
    <form method="post" action="/login">
      <input name="email" type="email" placeholder="E-mail" required><br>
      <input name="password" type="password" placeholder="Password" required><br>
      <button type="submit">Login</button>
    </form>
  `);
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { cookies, bearerToken } = await performLogin(email, password);
        req.session.authCookies = cookies;
        req.session.bearerToken = bearerToken || null;

        // После логина переходим на /boot, чтобы положить токен в localStorage
        return res.redirect('/boot');
    } catch (err) {
        log('Login failed:', err.message);
        return res.status(500).send('Login failed: ' + err.message);
    }
});

});

// ----------------------- Boot route -----------------------------------
app.get('/boot', (req, res) => {
    const token = req.session.bearerToken;
    if (!token) {
        // Если токена нет — сразу к proxy
        return res.redirect('/proxy/');
    }
    res.send(`
    <script>
      // Записываем JWT в localStorage, чтобы фронтенд смог взять его сам.
      localStorage.setItem('token', ${JSON.stringify(token)});
      localStorage.setItem('accessToken', ${JSON.stringify(token)});
      // После установки — переходим к приложению
      location.replace('/proxy/');
    </script>
  `);
});

// ----------------------- Proxy middleware --------------------------- ---------------------------
app.use('/proxy', createProxyMiddleware({
    target: REMOTE_BASE,
    changeOrigin: true,
    secure: true,
    pathRewrite: { '^/proxy': '' },
    cookieDomainRewrite: '', // оригинальный домен
    logLevel: 'debug',
    onProxyReq: (proxyReq, req) => {
        // Подставляем cookies авторизации
        if (req.session.authCookies) {
            const cookieHeader = req.session.authCookies.map(c => `${c.name}=${c.value}`).join('; ');
            proxyReq.setHeader('cookie', cookieHeader);
        }
        // Подставляем Authorization: Bearer … для API вызовов
        if (req.session.bearerToken) {
            proxyReq.setHeader('Authorization', 'Bearer ' + req.session.bearerToken);
        }
    },
}));

// Если пользователь пытается открыть /proxy без авторизации
app.use('/proxy', (_req, res) => res.redirect('/'));

// --------------------------- Start -----------------------------------
app.listen(PORT, () => {
    log(`Proxy server listening on http://localhost:${PORT} → ${REMOTE_BASE}`);
});
