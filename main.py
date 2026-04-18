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
    setup_tables,
)
from gmail_client import fetch_fintual_emails, test_connection
from datetime import datetime, timezone
from email_parser import parse_buy_email, parse_sell_email, parse_old_buy_email
from stock_service import search_ticker, get_prices_bulk

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
        client = get_client()
        return get_cached_prices(client)
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
