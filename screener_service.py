import pandas as pd
import yfinance as yf
from datetime import date, timedelta

# ── Criteria ──────────────────────────────────────────────────────────────────
DIST_90D_MAX  = 0.15   # within 15% of 90-day low
DIST_60D_MAX  = 0.12   # within 12% of 60-day low
MOMENTUM_MIN  = -0.10  # not falling more than 10% in last 5 trading days

# ── S&P 500 cache ─────────────────────────────────────────────────────────────
_sp500 = None


def _load_sp500() -> pd.DataFrame:
    global _sp500
    if _sp500 is not None:
        return _sp500
    import requests, io
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
    html = requests.get(url, headers=headers, timeout=20).text
    tables = pd.read_html(io.StringIO(html))
    df = tables[0][["Symbol", "Security", "GICS Sector"]].copy()
    df.columns = ["ticker", "company_name", "sector"]
    df["ticker"] = df["ticker"].str.replace(".", "-", regex=False)
    _sp500 = df
    return _sp500


def get_sectors() -> list:
    return sorted(_load_sp500()["sector"].unique().tolist())


def _companies_for_sector(sector: str) -> list:
    df = _load_sp500()
    rows = df[df["sector"] == sector][["ticker", "company_name"]]
    return rows.to_dict("records")


# ── Price download helpers (mirrors _load_closes in main.py) ──────────────────

def _fetch_closes(client, tickers: list) -> dict:
    """
    Read from Supabase in one bulk query; download only missing or stale tickers.
    Returns {ticker: pd.Series}.
    """
    from database import get_price_history_bulk, upsert_price_history

    # Single query for all tickers — avoids HTTP/2 stream exhaustion
    cached_map = get_price_history_bulk(client, tickers)

    today      = date.today()
    closes_dict = {}
    need_full  = []
    need_incr  = {}

    for ticker in tickers:
        cached = cached_map[ticker]
        if len(cached) >= 100:
            latest   = cached.index[-1].date()
            days_old = (today - latest).days
            if days_old == 0:
                closes_dict[ticker] = cached
            else:
                need_incr[ticker] = latest + timedelta(days=1)
        else:
            need_full.append(ticker)

    # Full 2-year download for brand-new tickers
    if need_full:
        hist = yf.download(need_full, period="2y", progress=False, auto_adjust=True)
        if not hist.empty:
            close_df = hist["Close"]
            if isinstance(close_df, pd.Series):
                close_df = close_df.to_frame(name=need_full[0])
            for ticker in need_full:
                if ticker not in close_df.columns:
                    continue
                closes = close_df[ticker].dropna()
                if not closes.empty:
                    upsert_price_history(client, ticker, closes)
                    closes_dict[ticker] = closes

    # Incremental update for stale tickers
    if need_incr:
        min_start = min(need_incr.values())
        hist = yf.download(
            list(need_incr.keys()), start=str(min_start),
            progress=False, auto_adjust=True
        )
        if not hist.empty:
            close_df = hist["Close"]
            if isinstance(close_df, pd.Series):
                close_df = close_df.to_frame(name=list(need_incr.keys())[0])
            for ticker, start in need_incr.items():
                cached = cached_map[ticker]
                if ticker in close_df.columns:
                    new_c = close_df[ticker].loc[str(start):].dropna()
                    if not new_c.empty:
                        upsert_price_history(client, ticker, new_c)
                        cached = pd.concat([cached, new_c]).sort_index()
                closes_dict[ticker] = cached

    return closes_dict


# ── Screener ──────────────────────────────────────────────────────────────────

def run_screener(sector: str, client) -> list:
    """
    Download (or read from cache) prices for all S&P 500 companies in `sector`,
    apply opportunity criteria, and return matching rows sorted by dist_90d_low.
    """
    companies   = _companies_for_sector(sector)
    tickers     = [c["ticker"] for c in companies]
    company_map = {c["ticker"]: c["company_name"] for c in companies}

    closes_dict = _fetch_closes(client, tickers)

    results = []
    for ticker, closes in closes_dict.items():
        n = len(closes)
        if n < 90:
            continue
        try:
            price   = float(closes.iloc[-1])
            min_30d = float(closes.iloc[-30:].min())
            min_60d = float(closes.iloc[-60:].min())
            min_90d = float(closes.iloc[-90:].min())

            if min_30d <= 0 or min_60d <= 0 or min_90d <= 0:
                continue

            dist_30d = (price / min_30d) - 1
            dist_60d = (price / min_60d) - 1
            dist_90d = (price / min_90d) - 1
            momentum = (price / float(closes.iloc[-6])) - 1 if n >= 6 else None

            if momentum is None:
                continue

            # Apply criteria
            if dist_90d > DIST_90D_MAX:
                continue
            if dist_60d > DIST_60D_MAX:
                continue
            if momentum < MOMENTUM_MIN:
                continue

            results.append({
                "ticker":       ticker,
                "company_name": company_map.get(ticker, ticker),
                "sector":       sector,
                "price":        round(price, 2),
                "dist_30d_low": round(dist_30d * 100, 2),
                "dist_60d_low": round(dist_60d * 100, 2),
                "dist_90d_low": round(dist_90d * 100, 2),
                "momentum_5d":  round(momentum * 100, 2),
                "min_30d":      round(min_30d, 2),
                "min_60d":      round(min_60d, 2),
                "min_90d":      round(min_90d, 2),
            })
        except Exception as e:
            print(f"screener error {ticker}: {e}")

    # Sort: closest to 90d low first (best opportunity at top)
    results.sort(key=lambda x: x["dist_90d_low"])
    return results
