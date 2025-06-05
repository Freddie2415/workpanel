// login_and_stay.js — скрытый (headless) логин + видимый браузер
// ------------------------------------------------------------------
// Скрипт сначала выполняет «невидимый» headless‑логин, сохраняя куки в
// общий профиль, а затем запускает полноэкранный Chromium с тем же
// профилем. Пользователь видит уже авторизованную страницу /dispatch,
// не замечая процесса входа.
// ------------------------------------------------------------------
// 1. npm i puppeteer dotenv
// 2. .env:
//        SITE_EMAIL=you@example.com
//        SITE_PASS=super_secret
// 3. node login_and_stay.js
// ------------------------------------------------------------------

require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');

const SITE = process.env.REMOTE_BASE_URL;            // <-- ваш домен
const EMAIL = process.env.USERNAME_FIELD;
const PASS = process.env.PASSWORD_FIELD;
const PROFILE_DIR = path.resolve('user_data'); // общий профиль для headless+GUI

//--------------------------------------------------------------------
// 1. headlessLogin() — выполняется в «невидимом» Chromium, чтобы
//    обновить сессию. Пользователь этого не видит.
//--------------------------------------------------------------------
async function headlessLogin() {
    const browser = await puppeteer.launch({
        headless: 'new',                        // headless ≥118 (бесшумно)
        userDataDir: PROFILE_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Пытаемся открыть /dispatch — если редиректит на /login, логинимся
    await page.goto(`${SITE}/dispatch`, {waitUntil: 'networkidle2'});
    if (page.url().includes('/login')) {
        console.log('[headless] Требуется логин…');
        await page.type('input[data-cy="loginEmailField"]', EMAIL, {delay: 20});
        await page.type('input[data-cy="loginPasswordField"]', PASS, {delay: 20});
        await Promise.all([
            page.click('button[data-cy="signInBtn"]'),
            page.waitForNavigation({waitUntil: 'networkidle2'})
        ]);
        console.log('[headless] Авторизация успешна, куки сохранены');
    } else {
        console.log('[headless] Уже авторизованы, логин не нужен');
    }

    await browser.close();
}

//--------------------------------------------------------------------
// 2. launchVisible() — запускает полноэкранный Chromium с тем же
//    userDataDir, поэтому сессия уже активна. Пользователь видит
//    только готовую страницу /dispatch.
//--------------------------------------------------------------------
async function launchVisible() {
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: PROFILE_DIR,
        defaultViewport: null,                  // убираем фиксированный viewport
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-maximized'                  // окно на весь экран
        ]
    });

    const [page] = await browser.pages();
    await page.goto(`${SITE}/dispatch`, {waitUntil: 'networkidle2'});
    console.log('🚀 Видимый браузер готов. Закройте окно, чтобы завершить скрипт.');

    // Держим процесс живым, пока пользователь не закроет браузер
    await new Promise(() => {
    });
}

//--------------------------------------------------------------------
// 3. Главный поток: сначала headless‑логин, потом видимый браузер
//--------------------------------------------------------------------
(async () => {
    try {
        await headlessLogin();  // невидимый вход
        await launchVisible();  // рабочий GUI-браузер
    } catch (e) {
        console.error('❌ Ошибка:', e);
        process.exit(1);
    }
})();
