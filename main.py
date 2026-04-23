import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from database import (
    get_client,
    upsert_transaction,
    get_all_transactions,
    get_ticker_for_company,
    save_ticker_map,
    update_ticker_for_company,
    get_last_sync,
    set_last_sync,
    get_cached_prices,
    set_cached_prices,
    get_watchlist,
    ensure_watchlist,
    setup_tables,
    get_price_history_ticker,
    get_price_history_bulk,
    upsert_price_history,
    save_ml_run,
    get_latest_ml_run,
    save_screener_results,
    get_screener_results,
    get_screener_sectors,
)
from gmail_client import fetch_fintual_emails, test_connection
from datetime import datetime, timezone
from email_parser import parse_buy_email, parse_sell_email, parse_old_buy_email
from stock_service import search_ticker, get_prices_bulk
from watchlist_service import derive_watchlist_data, INITIAL_WATCHLIST

load_dotenv()

app = FastAPI(title="Fintual Portfolio Tracker")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def root():
    return FileResponse("static/index.html")


@app.get("/api/health")
def health():
    db_ok = False
    tables_ok = False
    email_ok = False
    last_sync = None
    try:
        client = get_client()
        client.table("transactions").select("id").limit(1).execute()
        db_ok = True
        tables_ok = True
        last_sync = get_last_sync(client)
    except Exception as e:
        msg = str(e)
        db_ok = "PGRST205" not in msg
        tables_ok = False
    try:
        email_ok = test_connection()
    except Exception:
        pass
    return {"db": db_ok, "tables": tables_ok, "email": email_ok, "last_sync": last_sync}


@app.post("/api/setup")
def run_setup():
    try:
        client = get_client()
        setup_tables(client)
        return {"ok": True, "message": "Tablas creadas correctamente"}
    except Exception as e:
        sql = open("schema.sql").read()
        raise HTTPException(
            status_code=500,
            detail={
                "message": "No se pudo crear las tablas automáticamente. Ejecuta este SQL en el editor de Supabase.",
                "sql": sql,
                "error": str(e),
            },
        )


@app.post("/api/sync/full")
def sync_emails_full():
    """Force a full re-sync ignoring last_sync date."""
    try:
        client = get_client()
        client.table("sync_state").delete().eq("key", "last_sync_at").execute()
    except Exception:
        pass
    return sync_emails()


@app.post("/api/sync")
def sync_emails():
    client = get_client()
    last_sync = get_last_sync(client)
    sync_started_at = datetime.now(timezone.utc).isoformat()

    try:
        buy_msgs, sell_msgs, old_buy_msgs = fetch_fintual_emails(since_date=last_sync)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al conectar con Gmail: {e}")

    added, skipped, errors = 0, 0, []

    for _type, msgs, parser in [
        ("buy", buy_msgs, parse_buy_email),
        ("sell", sell_msgs, parse_sell_email),
        ("buy_old", old_buy_msgs, parse_old_buy_email),
    ]:
        for msg in msgs:
            try:
                data = parser(msg)
                if not data.get("email_message_id"):
                    skipped += 1
                    continue

                company = data.get("company_name")
                if company:
                    ticker = get_ticker_for_company(client, company)
                    if not ticker:
                        ticker = search_ticker(company)
                        if ticker:
                            save_ticker_map(client, company, ticker, auto=True)
                    if ticker:
                        data["ticker"] = ticker
                    else:
                        data.pop("ticker", None)

                upsert_transaction(client, data)
                added += 1
            except Exception as e:
                errors.append(str(e))
                skipped += 1

    set_last_sync(client, sync_started_at)

    return {
        "added": added,
        "skipped": skipped,
        "errors": errors,
        "total_emails": len(buy_msgs) + len(sell_msgs),
        "last_sync": sync_started_at,
        "was_incremental": last_sync is not None,
    }


@app.get("/api/transactions")
def list_transactions():
    try:
        client = get_client()
        return get_all_transactions(client)
    except Exception:
        return []


@app.get("/api/portfolio")
def portfolio():
    try:
        client = get_client()
        transactions = get_all_transactions(client)
    except Exception:
        return []

    holdings = {}
    for t in transactions:
        ticker = t.get("ticker")
        company = t.get("company_name") or "Unknown"
        # Group by ticker when available, fallback to company_name
        key = ticker if ticker else company

        if key not in holdings:
            holdings[key] = {
                "company_name": company,
                "ticker": ticker,
                "bought_shares": 0.0,
                "sold_shares": 0.0,
                "total_buy_cost": 0.0,
            }

        h = holdings[key]
        if ticker:
            h["ticker"] = ticker

        shares = float(t.get("shares") or 0)
        if t["type"] == "buy":
            h["bought_shares"] += shares
            h["total_buy_cost"] += float(t.get("total_cost") or t.get("amount_usd") or 0)
        else:
            h["sold_shares"] += shares

    result = []
    for h in holdings.values():
        current_shares = round(h["bought_shares"] - h["sold_shares"], 9)
        if current_shares < 0.0001:
            continue
        avg_cost = h["total_buy_cost"] / h["bought_shares"] if h["bought_shares"] > 0 else 0
        result.append(
            {
                "company_name": h["company_name"],
                "ticker": h["ticker"],
                "total_shares": current_shares,
                "avg_cost": round(avg_cost, 6),
                "total_cost": round(avg_cost * current_shares, 4),
            }
        )

    result.sort(key=lambda x: x["total_cost"], reverse=True)
    return result


@app.get("/api/prices")
def current_prices():
    try:
        client       = get_client()
        transactions = get_all_transactions(client)
        tickers      = list({t["ticker"] for t in transactions if t.get("ticker")})
        if not tickers:
            return {}
        prices = get_prices_bulk(tickers)
        if prices:
            set_cached_prices(client, prices)  # persist so restarts have last known value
            return prices
        return get_cached_prices(client)       # fallback if yfinance unavailable
    except Exception:
        try:
            return get_cached_prices(get_client())
        except Exception:
            return {}


@app.post("/api/prices/refresh")
def refresh_prices():
    import traceback
    try:
        client = get_client()
        transactions = get_all_transactions(client)
        tickers = list({t["ticker"] for t in transactions if t.get("ticker")})
        if not tickers:
            return {"ok": True, "updated": 0, "prices": {}}
        prices = get_prices_bulk(tickers)
        set_cached_prices(client, prices)
        return {"ok": True, "updated": len(prices), "prices": prices}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _portfolio_shares(transactions: list) -> dict:
    shares = {}
    for t in transactions:
        ticker = t.get("ticker")
        if not ticker:
            continue
        s = float(t.get("shares") or 0)
        shares[ticker] = shares.get(ticker, 0) + (s if t["type"] == "buy" else -s)
    return shares


@app.get("/api/watchlist/cached")
def watchlist_cached(view: str = "watchlist", qual: bool = False):
    """
    Reads from Supabase and incrementally updates stale tickers from yfinance.
    qual=False (default) skips yfinance .info calls so the page loads instantly.
    Use /api/watchlist/qual to lazy-load qualitative fields separately.
    """
    try:
        client  = get_client()
        tickers = _get_tickers_for_view(view, client)
        if not tickers:
            return []

        # Get company names from the watchlist table (no yfinance needed)
        wl_all = get_watchlist(client)
        company_names = {w["ticker"]: w.get("company_name") or w["ticker"] for w in wl_all}

        # Incremental update: downloads only missing days for stale tickers
        closes_dict = _load_closes(client, tickers, force_update=True)

        return derive_watchlist_data(tickers, closes_dict, qual=qual, company_names=company_names)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/watchlist/qual")
def watchlist_qual_info(view: str = "watchlist"):
    """
    Returns qualitative fields (recommendation, sector, industry, market_cap, etc.)
    fetched from yfinance for all tickers in the view.
    Called lazily from the frontend only when the user clicks the qualitative toggle.
    """
    try:
        from watchlist_service import _qualitative_info
        client  = get_client()
        tickers = _get_tickers_for_view(view, client)
        result  = {}
        for ticker in tickers:
            result[ticker] = _qualitative_info(ticker)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/watchlist/prices")
def watchlist_prices(view: str = "watchlist"):
    try:
        client      = get_client()
        tickers     = _get_tickers_for_view(view, client)
        closes_dict = _load_closes(client, tickers, force_update=True)
        return derive_watchlist_data(tickers, closes_dict)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/watchlist/live")
def watchlist_live(view: str = "watchlist"):
    """Returns {ticker: live_price} using intraday 2-min bars — one bulk yfinance request."""
    import yfinance as yf
    import pandas as pd
    try:
        client  = get_client()
        tickers = _get_tickers_for_view(view, client)
        if not tickers:
            return {}
        hist = yf.download(tickers, period="1d", interval="2m", progress=False, auto_adjust=True)
        if hist.empty:
            return {}
        close_df = hist["Close"]
        if isinstance(close_df, pd.Series):
            close_df = close_df.to_frame(name=tickers[0])
        result = {}
        for ticker in tickers:
            if ticker in close_df.columns:
                last = close_df[ticker].dropna()
                if not last.empty:
                    result[ticker] = round(float(last.iloc[-1]), 2)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/watchlist/{ticker}")
def add_watchlist(ticker: str):
    import yfinance as yf
    ticker = ticker.upper().strip()
    try:
        info = yf.Ticker(ticker).info
        company_name = info.get("shortName") or info.get("longName") or ticker
    except Exception:
        company_name = ticker
    client = get_client()
    client.table("watchlist").upsert(
        {"ticker": ticker, "company_name": company_name},
        on_conflict="ticker",
    ).execute()
    return {"ok": True, "ticker": ticker, "company_name": company_name}


@app.delete("/api/watchlist/{ticker}")
def remove_watchlist(ticker: str):
    client = get_client()
    client.table("watchlist").delete().eq("ticker", ticker.upper()).execute()
    return {"ok": True}


def _get_tickers_for_view(view: str, client) -> list:
    ensure_watchlist(client, INITIAL_WATCHLIST)
    transactions = get_all_transactions(client)
    port_shares  = _portfolio_shares(transactions)
    if view == "portfolio":
        return [t for t, s in port_shares.items() if s > 0]
    wl = get_watchlist(client)
    return [w["ticker"] for w in wl if port_shares.get(w["ticker"], 0) <= 1.5]


def _load_closes(client, tickers: list, force_update: bool = False) -> dict:
    """
    Load closes from Supabase for each ticker.
    force_update=True  → always try incremental download (used by watchlist display).
    force_update=False → skip download if data is <7 days old (used by ML).
    Returns dict {ticker: pd.Series with DatetimeIndex}.
    """
    import yfinance as yf
    import pandas as pd
    from datetime import date, timedelta

    today = date.today()

    # 1. Read all cached data in one bulk query
    cached_map = get_price_history_bulk(client, tickers)

    closes_dict = {}
    need_full = []       # tickers with no history → full 2-year download
    need_incr = {}       # ticker → start date for incremental download

    for ticker in tickers:
        cached = cached_map[ticker]
        if len(cached) >= 100:
            latest   = cached.index[-1].date()
            days_old = (today - latest).days
            if days_old == 0 or (not force_update and days_old <= 7):
                closes_dict[ticker] = cached
            else:
                need_incr[ticker] = latest + timedelta(days=1)
        else:
            need_full.append(ticker)

    # 2. Bulk full download (all new tickers in one request)
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

    # 3. Bulk incremental download (all stale tickers in one request, from earliest start date)
    if need_incr:
        min_start = min(need_incr.values())
        hist = yf.download(list(need_incr.keys()), start=str(min_start), progress=False, auto_adjust=True)
        if not hist.empty:
            close_df = hist["Close"]
            if isinstance(close_df, pd.Series):
                close_df = close_df.to_frame(name=list(need_incr.keys())[0])
            for ticker, start in need_incr.items():
                cached = cached_map[ticker]
                if ticker not in close_df.columns:
                    closes_dict[ticker] = cached
                    continue
                new_c = close_df[ticker].loc[str(start):].dropna()
                if not new_c.empty:
                    upsert_price_history(client, ticker, new_c)
                    cached = pd.concat([cached, new_c]).sort_index()
                closes_dict[ticker] = cached

    return closes_dict


@app.post("/api/ml/entry-score")
def ml_entry_score(view: str = "watchlist"):
    try:
        from ml_service import run_entry_score
    except ImportError:
        raise HTTPException(status_code=500, detail="Ejecuta: pip install scikit-learn")
    try:
        client      = get_client()
        tickers     = _get_tickers_for_view(view, client)
        closes_dict = _load_closes(client, tickers, force_update=False)
        wl_data     = derive_watchlist_data(tickers, closes_dict)
        results, metrics = run_entry_score(wl_data, closes_dict)
        run_at      = save_ml_run(client, "entry_score", results, metrics)
        return {"results": results, "metrics": metrics, "run_at": run_at}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ml/signal")
def ml_signal(view: str = "watchlist"):
    try:
        from ml_service import run_signal
    except ImportError:
        raise HTTPException(status_code=500, detail="Ejecuta: pip install scikit-learn")
    try:
        client      = get_client()
        tickers     = _get_tickers_for_view(view, client)
        closes_dict = _load_closes(client, tickers, force_update=False)
        wl_data     = derive_watchlist_data(tickers, closes_dict)
        results, metrics = run_signal(wl_data, closes_dict)
        run_at      = save_ml_run(client, "signal", results, metrics)
        return {"results": results, "metrics": metrics, "run_at": run_at}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/ml/entry-score")
def ml_entry_score_cached():
    try:
        client = get_client()
        results, metrics, run_at = get_latest_ml_run(client, "entry_score")
        if not results:
            return {"results": [], "metrics": None, "run_at": None}
        # sort by score desc
        results.sort(key=lambda x: (x.get("score") or 0), reverse=True)
        return {"results": results, "metrics": metrics, "run_at": run_at}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/ml/signal")
def ml_signal_cached():
    try:
        client = get_client()
        results, metrics, run_at = get_latest_ml_run(client, "signal")
        if not results:
            return {"results": [], "metrics": None, "run_at": None}
        return {"results": results, "metrics": metrics, "run_at": run_at}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/screener/sectors")
def screener_sectors_list():
    try:
        from screener_service import get_sectors
        return get_sectors()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/screener/run")
def screener_run(sector: str):
    try:
        from screener_service import run_screener
        client  = get_client()
        results = run_screener(sector, client)
        run_at  = save_screener_results(client, sector, results)
        return {"results": results, "run_at": run_at, "sector": sector, "count": len(results)}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/screener/results")
def screener_results_get(sector: str):
    try:
        client = get_client()
        results, run_at = get_screener_results(client, sector)
        return {"results": results, "run_at": run_at, "sector": sector}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/screener/cached-sectors")
def screener_cached_sectors():
    try:
        client = get_client()
        return get_screener_sectors(client)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



class TickerUpdate(BaseModel):
    ticker: str


@app.put("/api/ticker/{company_name}")
def update_ticker(company_name: str, body: TickerUpdate):
    client = get_client()
    ticker = body.ticker.upper().strip()
    save_ticker_map(client, company_name, ticker, auto=False)
    update_ticker_for_company(client, company_name, ticker)
    return {"ok": True, "company_name": company_name, "ticker": ticker}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
