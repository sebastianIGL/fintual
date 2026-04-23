import yfinance as yf

INITIAL_WATCHLIST = [
    "BIDU", "MU", "NVDA", "NBIS", "BABA", "MCHP", "DRS",
    "ACIW", "NKE", "SOUN", "VERI", "CSCO", "QBTS", "IONQ",
    "RGTI", "CRWV", "IREN", "APLD",
]

RECOMMENDATION_LABELS = {
    "strong_buy":  "Compra Fuerte",
    "buy":         "Compra",
    "hold":        "Mantener",
    "sell":        "Vender",
    "strong_sell": "Venta Fuerte",
}


def _qualitative_info(ticker: str) -> dict:
    """Fetch qualitative data from yfinance for a single ticker."""
    try:
        info           = yf.Ticker(ticker).info
        company_name   = info.get("shortName") or info.get("longName") or ticker
        rec_key        = info.get("recommendationKey", "")
        recommendation = RECOMMENDATION_LABELS.get(rec_key, rec_key or "—")
        sector         = info.get("sector")   or "—"
        industry       = info.get("industry") or "—"
        country        = info.get("country")  or "—"
        market_cap     = info.get("marketCap")
        payout_ratio   = info.get("payoutRatio")
        div_yield      = info.get("trailingAnnualDividendYield") or info.get("dividendYield")
        if div_yield is not None:
            if div_yield > 1:
                div_yield = div_yield / 100
            if div_yield > 0.25:
                div_yield = None
        has_dividend = div_yield is not None and div_yield > 0
    except Exception:
        company_name   = ticker
        recommendation = "—"
        sector = industry = country = "—"
        market_cap = div_yield = payout_ratio = None
        has_dividend = False

    return {
        "company_name":   company_name,
        "recommendation": recommendation,
        "sector":         sector,
        "industry":       industry,
        "country":        country,
        "market_cap":     market_cap,
        "div_yield":      div_yield,
        "payout_ratio":   payout_ratio,
        "has_dividend":   has_dividend,
    }


def derive_watchlist_data(tickers: list, closes_dict: dict, qual: bool = True, company_names: dict = None) -> list:
    """
    Build the watchlist display rows from pre-loaded closes (Supabase)
    + qualitative info (yfinance per-ticker).
    closes_dict: {ticker: pd.Series with DatetimeIndex}
    qual: if False, skip yfinance .info calls (fast path — call /api/watchlist/qual later)
    company_names: {ticker: name} used when qual=False to avoid showing raw tickers
    """
    if not tickers:
        return []

    results = []
    for ticker in tickers:
        closes = closes_dict.get(ticker)
        if closes is None or len(closes) < 2:
            continue
        try:
            n         = len(closes)
            current   = float(closes.iloc[-1])
            last_date = closes.index[-1].date().isoformat()

            prev = [float(closes.iloc[-i]) if n >= i else None for i in range(2, 7)]

            min_30 = float(closes.iloc[-30:].min()) if n >= 2  else None
            min_60 = float(closes.iloc[-60:].min()) if n >= 2  else None
            min_90 = float(closes.iloc[-90:].min()) if n >= 90 else float(closes.min())

            if qual:
                q = _qualitative_info(ticker)
            else:
                name = (company_names or {}).get(ticker) or ticker
                q = {
                    "company_name":   name,
                    "recommendation": "—",
                    "sector":         "—",
                    "industry":       "—",
                    "country":        "—",
                    "market_cap":     None,
                    "div_yield":      None,
                    "payout_ratio":   None,
                    "has_dividend":   False,
                }

            results.append({
                "ticker":    ticker,
                "date":      last_date,
                "price":     current,
                "close_1d":  prev[0],
                "close_2d":  prev[1],
                "close_3d":  prev[2],
                "close_4d":  prev[3],
                "close_5d":  prev[4],
                "min_30d":   min_30,
                "min_60d":   min_60,
                "min_90d":   min_90,
                **q,
            })
        except Exception as e:
            print(f"watchlist_service: error deriving {ticker}: {e}")

    return results
