#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proxy_app.py — прокси‑обёртка для ces.gtnetwork.com **с подробным логированием**.

● Логи пишутся в файл *proxy.log* (рядом с скриптом) + выводятся в stdout.
  Формат: «2025‑06‑05 14:33:12 INFO GET https://ces.gtnetwork.com/... -> 200  (0.243 s)»
● Логируются:
    – успешные и неуспешные попытки логина (status‑code, время).
    – все проксируемые запросы (метод, URL, код ответа, время).
    – ошибки сети/исключения.

Настройки окружения остались прежними (REMOTE_BASE_URL, LOGIN_ENDPOINT и т.д.).
"""
import json
import logging
import os
import time

# --- Совместимость urllib для Py2/Py3 ---------------------------------------
try:
    from urllib.parse import urljoin, urlparse
except ImportError:  # pragma: no cover
    from urlparse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from flask import Flask, Response, redirect, request, session, url_for

# ---------------------------------------------------------------------------
#                              Л О Г И Р О В А Н И Е
# ---------------------------------------------------------------------------
LOG_FILE = os.getenv("LOG_FILE", "proxy.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler()
    ],
)
log = logging.getLogger("proxy")

# ---------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-me")

REMOTE_BASE_URL = os.getenv("REMOTE_BASE_URL", "https://ces.gtnetwork.com")
LOGIN_ENDPOINT  = os.getenv("LOGIN_ENDPOINT",  "/api/auth/login")
EMAIL_FIELD     = os.getenv("EMAIL_FIELD",     "email")
PASSWORD_FIELD  = os.getenv("PASSWORD_FIELD",  "password")
JSON_LOGIN      = os.getenv("JSON_LOGIN", "1") == "1"

# ---------------------------------------------------------------------------
#                       Внутренние утилиты/сессия
# ---------------------------------------------------------------------------

def _new_backend_session():
    s = requests.Session()
    if "proxy_cookies" in session:
        s.cookies.update(session["proxy_cookies"])
    return s

def _save_backend_cookies(s):
    session["proxy_cookies"] = s.cookies.get_dict()

# ---------------------------------------------------------------------------
#                             РОУТ:  /
# ---------------------------------------------------------------------------
@app.route("/", methods=["GET", "POST"])
def login_page():
    if request.method == "POST":
        email    = request.form["email"]
        password = request.form["password"]

        s = _new_backend_session()
        login_url = urljoin(REMOTE_BASE_URL, LOGIN_ENDPOINT)

        payload = {EMAIL_FIELD: email, PASSWORD_FIELD: password}
        headers = {"Content-Type": "application/json"} if JSON_LOGIN else None

        start = time.time()
        try:
            if JSON_LOGIN:
                resp = s.post(login_url, json=payload, allow_redirects=True)
            else:
                resp = s.post(login_url, data=payload, allow_redirects=True)
        except requests.RequestException as exc:
            log.error("LOGIN ERROR %s — %s", login_url, exc)
            return Response("Ошибка сети при авторизации", 502)
        dur = time.time() - start
        log.info("POST %s -> %s (%.3f s)", login_url, resp.status_code, dur)

        if resp.ok and (resp.cookies or resp.headers.get("set-cookie")):
            _save_backend_cookies(s)
            return redirect(url_for("proxy_root"))
        return Response("Авторизация не удалась", 401)

    # GET → форма входа
    return """
    <h2>GTNetwork CES — вход</h2>
    <form method="post">
      <input name="email"    placeholder="E-mail"   type="email" required><br>
      <input name="password" placeholder="Пароль"   type="password" required><br>
      <button type="submit">Войти</button>
    </form>
    """

# ---------------------------------------------------------------------------
#                       РОУТЫ: /proxy/…
# ---------------------------------------------------------------------------
@app.route("/proxy/")
def proxy_root():
    return proxy("")

@app.route("/proxy/<path:path>")
def proxy(path):
    if "proxy_cookies" not in session:
        return redirect(url_for("login_page"))

    s = _new_backend_session()
    target_url = urljoin(REMOTE_BASE_URL + "/", path)

    start = time.time()
    try:
        resp = s.get(target_url, stream=True)
    except requests.RequestException as exc:
        log.error("GET ERROR %s — %s", target_url, exc)
        return Response("Ошибка сети при запросе", 502)
    dur = time.time() - start
    log.info("GET %s -> %s (%.3f s)", target_url, resp.status_code, dur)

    ctype = resp.headers.get("Content-Type", "application/octet-stream")
    if "text/html" not in ctype:
        return Response(resp.content, resp.status_code, {"Content-Type": ctype})

    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup.find_all(src=True):
        tag["src"] = _rewrite_url(tag["src"])
    for tag in soup.find_all(href=True):
        tag["href"] = _rewrite_url(tag["href"])

    return Response(str(soup), resp.status_code, {"Content-Type": "text/html"})

# ---------------------------------------------------------------------------
#                       URL‑переписка для HTML
# ---------------------------------------------------------------------------

def _rewrite_url(link):
    if link.startswith(("http://", "https://")):
        if urlparse(link).netloc != urlparse(REMOTE_BASE_URL).netloc:
            return link
        link = urlparse(link)._replace(scheme="", netloc="").geturl()
    return urljoin("/proxy/", link.lstrip("/"))

# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    log.info("Starting proxy on http://0.0.0.0:%s → %s", port, REMOTE_BASE_URL)
    app.run(debug=True, host="0.0.0.0", port=port)
