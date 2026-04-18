import re
import email.utils
from email.header import decode_header as _decode_header
from typing import Optional
from bs4 import BeautifulSoup
from datetime import datetime, timezone


def _decode_str(raw) -> str:
    parts = []
    for fragment, charset in _decode_header(raw):
        if isinstance(fragment, bytes):
            parts.append(fragment.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(fragment)
    return "".join(parts)


def _get_html_body(msg) -> str:
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            charset = part.get_content_charset() or "utf-8"
            return part.get_payload(decode=True).decode(charset, errors="replace")
    return ""


def _parse_number(text: str) -> Optional[float]:
    if not text:
        return None
    # Remove "US $" prefix and whitespace
    text = re.sub(r"US\s*\$\s*", "", text).strip()
    # European format: dots = thousands separator, comma = decimal separator
    text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def _extract_table(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    data = {}
    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) >= 2:
            key = cells[0].get_text(strip=True)
            value = cells[-1].get_text(strip=True)
            if key:
                data[key] = value
    return data


def _extract_company(subject: str) -> Optional[str]:
    match = re.search(r"acciones de (.+)$", subject, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return None


def _parse_date(msg) -> str:
    date_str = msg.get("Date", "")
    try:
        dt = email.utils.parsedate_to_datetime(date_str)
        return dt.isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def parse_old_buy_email(msg) -> dict:
    """Parse 2022 format: 'Invertimos tu depósito en Company' with inline body text."""
    subject = _decode_str(msg.get("Subject", ""))
    html = _get_html_body(msg)
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)

    # Company from subject: "Invertimos tu depósito en Intel Corp"
    company_match = re.search(r"Invertimos tu dep[oó]sito en (.+)$", subject, re.IGNORECASE)
    company = company_match.group(1).strip() if company_match else None

    # "Convertimos los $ 29.000 en US $ 30,80 a una tasa de ..."
    amount_match = re.search(r"en\s+US\s*\$\s*([\d\.,]+)\s+a una tasa", text, re.IGNORECASE)
    # "a un precio de US $ 29,82 por acción"
    price_match = re.search(r"a un precio de US\s*\$\s*([\d\.,]+)\s*por acci[oó]n", text, re.IGNORECASE)

    amount_usd = _parse_number(amount_match.group(1)) if amount_match else None
    price = _parse_number(price_match.group(1)) if price_match else None
    shares = round(amount_usd / price, 9) if amount_usd and price else None

    return {
        "email_message_id": msg.get("Message-ID", ""),
        "type": "buy",
        "company_name": company,
        "date": _parse_date(msg),
        "amount_usd": amount_usd,
        "price_per_share": price,
        "shares": shares,
        "commission": 0,
        "total_cost": amount_usd,
        "ticker": None,
    }


def _parse_buy_inline(html: str, subject: str = "") -> Optional[dict]:
    """Fallback: extract buy data from subject + body inline text."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)

    # Format 2023+: subject "Invertiste 0,29 dólares en 0,0060 acciones de Cisco Systems Inc"
    # Body: "La compra fue a US $ 48,07 la acción, equivalente a 0,0060 acciones."
    sm = re.search(
        r"Invertiste\s+([\d\.,]+)\s+d[oó]lares\s+en\s+([\d\.,]+)\s+acciones\s+de\s+(.+)",
        subject, re.IGNORECASE
    )
    if sm:
        amount  = _parse_number(sm.group(1))
        shares  = _parse_number(sm.group(2))
        company = sm.group(3).strip()
        pm = re.search(r"La compra fue a US\s*\$\s*([\d\.,]+)\s+la acci[oó]n", text, re.IGNORECASE)
        price = _parse_number(pm.group(1)) if pm else (
            round(amount / shares, 6) if amount and shares else None
        )
        return {"shares": shares, "amount_usd": amount, "price_per_share": price, "company_name": company}

    # Older inline: "Invertiste X acciones de Company a un precio de US $ Y por acción"
    m = re.search(
        r"Invertiste\s+([\d\.,]+)\s+acciones\s+de\s+(.+?)\s+"
        r"a un precio de\s+US\s*\$\s*([\d\.,]+)\s*por acci[oó]n",
        text, re.IGNORECASE
    )
    if m:
        shares  = _parse_number(m.group(1))
        price   = _parse_number(m.group(3))
        amount  = round(shares * price, 4) if shares and price else None
        return {"shares": shares, "price_per_share": price, "amount_usd": amount,
                "company_name": m.group(2).strip()}

    return None


def parse_buy_email(msg) -> dict:
    subject = _decode_str(msg.get("Subject", ""))
    html = _get_html_body(msg)
    table = _extract_table(html)

    amount    = _parse_number(table.get("Monto invertido", ""))
    price     = _parse_number(table.get("Precio de la acción", ""))
    shares    = _parse_number(table.get("Acciones compradas", ""))
    commission = _parse_number(table.get("Comisión", "")) or 0
    total_cost = _parse_number(table.get("Costo total", ""))
    company   = _extract_company(subject)

    # Fallback: try inline text if table didn't yield data
    if shares is None or amount is None:
        inline = _parse_buy_inline(html, subject)
        if inline:
            shares     = shares    or inline["shares"]
            price      = price     or inline["price_per_share"]
            amount     = amount    or inline["amount_usd"]
            total_cost = total_cost or inline["amount_usd"]
            company    = company   or inline["company_name"]

    return {
        "email_message_id": msg.get("Message-ID", ""),
        "type": "buy",
        "company_name": company,
        "date": _parse_date(msg),
        "amount_usd": amount,
        "price_per_share": price,
        "shares": shares,
        "commission": commission,
        "total_cost": total_cost or amount,
        "ticker": None,
    }


def _parse_sell_inline(html: str) -> Optional[dict]:
    """Parse 'Vendiste X,XX acciones de Company por un total de US $ Y,YY' format."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)
    pattern = (
        r"Vendiste\s+([\d\.,]+)\s+acciones\s+de\s+(.+?)\s+por un total de\s+US\s*\$\s*([\d\.,]+)"
    )
    m = re.search(pattern, text, re.IGNORECASE)
    if not m:
        return None
    shares = _parse_number(m.group(1))
    company = m.group(2).strip()
    amount = _parse_number(m.group(3))
    price = round(amount / shares, 6) if shares and amount else None
    return {"shares": shares, "company_name": company, "amount_usd": amount, "price_per_share": price}


def parse_sell_email(msg) -> dict:
    subject = _decode_str(msg.get("Subject", ""))
    html = _get_html_body(msg)
    table = _extract_table(html)

    shares = _parse_number(table.get("Cantidad de acciones", ""))
    price  = _parse_number(table.get("Precio por acción", ""))
    amount = _parse_number(table.get("Recibiste", ""))

    # Fallback for "Vendiste todas tus acciones" inline format
    if shares is None or amount is None:
        inline = _parse_sell_inline(html)
        if inline:
            shares  = inline["shares"]
            amount  = inline["amount_usd"]
            price   = inline["price_per_share"]
            # Prefer subject company name (cleaner), use inline as fallback
            company = _extract_company(subject) or inline["company_name"]
        else:
            company = _extract_company(subject)
    else:
        company = _extract_company(subject)

    return {
        "email_message_id": msg.get("Message-ID", ""),
        "type": "sell",
        "company_name": company,
        "date": _parse_date(msg),
        "shares": shares,
        "price_per_share": price,
        "amount_usd": amount,
        "commission": 0,
        "total_cost": amount,
        "ticker": None,
    }
