import imaplib
import email
import os
from datetime import datetime, timezone, timedelta
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

IMAP_HOST = "imap.gmail.com"


def _connect() -> imaplib.IMAP4_SSL:
    mail = imaplib.IMAP4_SSL(IMAP_HOST)
    mail.login(os.getenv("EMAIL"), os.getenv("EMAIL_PASSWORD"))
    return mail


def _imap_date(iso_str: str) -> str:
    """Convert ISO datetime string to IMAP SINCE format: '17-Apr-2025'."""
    dt = datetime.fromisoformat(iso_str)
    # Subtract 1 day as overlap buffer to avoid missing emails at boundary
    dt = dt - timedelta(days=1)
    return dt.strftime("%d-%b-%Y")


def _build_query(base: str, since_date: Optional[str]) -> str:
    if since_date:
        imap_date = _imap_date(since_date)
        return f'({base} SINCE "{imap_date}")'
    return f"({base})"


def _fetch_messages(mail: imaplib.IMAP4_SSL, search_query: str) -> list:
    mail.select("INBOX")
    _, data = mail.search(None, search_query)
    ids = data[0].split()
    if not ids:
        return []

    messages = []
    for uid in reversed(ids):  # newest first
        try:
            _, msg_data = mail.fetch(uid, "(RFC822)")
            raw = msg_data[0][1]
            messages.append(email.message_from_bytes(raw))
        except Exception:
            continue
    return messages


def fetch_fintual_emails(since_date: Optional[str] = None) -> tuple:
    mail = _connect()
    try:
        buy_base      = 'FROM "hola@fintual.com" SUBJECT "invertiste"'
        sell_base     = 'FROM "hola@fintual.com" SUBJECT "vendiste"'
        old_buy_base  = 'FROM "hola@fintual.com" SUBJECT "Invertimos"'
        buys     = _fetch_messages(mail, _build_query(buy_base,     since_date))
        sells    = _fetch_messages(mail, _build_query(sell_base,    since_date))
        old_buys = _fetch_messages(mail, _build_query(old_buy_base, since_date))
    finally:
        try:
            mail.logout()
        except Exception:
            pass
    return buys, sells, old_buys


def test_connection() -> bool:
    try:
        mail = _connect()
        mail.logout()
        return True
    except Exception:
        return False
