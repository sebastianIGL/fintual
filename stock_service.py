import re
import time
import httpx
import yfinance as yf
from typing import Optional

_price_cache: dict = {}
_cache_ts: float = 0.0
_CACHE_TTL = 900  # 15 minutes

_CLEAN_PATTERNS = [
    r"\bClass [A-Z] Common Stock\b",
    r"\bCommon Stock\b",
    r"\bInc\.?\b",
    r"\bCorp\.?\b",
    r"\bLtd\.?\b",
    r"\bLLC\b",
    r"\bPlc\.?\b",
    r"\bS\.A\.?\b",
]


def clean_company_name(name: str) -> str:
    for pattern in _CLEAN_PATTERNS:
        name = re.sub(pattern, "", name, flags=re.IGNORECASE)
    return name.strip().strip(",").strip()


def search_ticker(company_name: str) -> Optional[str]:
    clean = clean_company_name(company_name)
    try:
        r = httpx.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": clean, "quotesCount": 5, "newsCount": 0, "listsCount": 0},
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            timeout=8,
        )
        if r.status_code == 200:
            quotes = r.json().get("quotes", [])
            for q in quotes:
                if q.get("quoteType") == "EQUITY":
                    return q.get("symbol")
            if quotes:
                return quotes[0].get("symbol")
    except Exception:
        pass
    return None


def get_prices_bulk(tickers: list) -> dict:
    """Single yf.download() call for all tickers — no per-ticker loops."""
    global _price_cache, _cache_ts
    now = time.time()

    if not tickers:
        return {}

    # Return memory cache if still fresh
    if now - _cache_ts < _CACHE_TTL and all(t in _price_cache for t in tickers):
        return {t: _price_cache[t] for t in tickers if t in _price_cache}

    prices = {}
    try:
        raw = yf.download(
            " ".join(tickers),
            period="5d",
            progress=False,
            auto_adjust=True,
        )
        if not raw.empty:
            close = raw["Close"]
            if len(tickers) == 1:
                # Single ticker: Close is a plain Series
                val = close.dropna().iloc[-1] if not close.dropna().empty else None
                if val is not None:
                    prices[tickers[0]] = float(val)
            else:
                # Multiple tickers: Close is a DataFrame with ticker columns
                last = close.dropna(how="all").iloc[-1]
                for ticker in tickers:
                    if ticker in last and last[ticker] is not None:
                        import math
                        v = float(last[ticker])
                        if not math.isnan(v):
                            prices[ticker] = v
    except Exception as e:
        print(f"Price fetch failed: {e}")

    _price_cache.update(prices)
    _cache_ts = now
    return prices
