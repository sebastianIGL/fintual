import os
from typing import Optional
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()


def get_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


def upsert_transaction(client: Client, data: dict) -> list:
    result = (
        client.table("transactions")
        .upsert(data, on_conflict="email_message_id")
        .execute()
    )
    return result.data


def get_all_transactions(client: Client) -> list:
    result = (
        client.table("transactions").select("*").order("date", desc=True).execute()
    )
    return result.data


def get_ticker_for_company(client: Client, company_name: str) -> Optional[str]:
    result = (
        client.table("ticker_map")
        .select("ticker")
        .eq("company_name", company_name)
        .execute()
    )
    if result.data:
        return result.data[0]["ticker"]
    return None


def save_ticker_map(client: Client, company_name: str, ticker: str, auto: bool = False):
    client.table("ticker_map").upsert(
        {"company_name": company_name, "ticker": ticker, "auto_resolved": auto},
        on_conflict="company_name",
    ).execute()


def update_ticker_for_company(client: Client, company_name: str, ticker: str):
    client.table("transactions").update({"ticker": ticker}).eq(
        "company_name", company_name
    ).execute()


def get_last_sync(client: Client) -> Optional[str]:
    """Returns ISO datetime string of last successful sync, or None."""
    try:
        result = (
            client.table("sync_state")
            .select("value")
            .eq("key", "last_sync_at")
            .execute()
        )
        if result.data:
            return result.data[0]["value"]
    except Exception:
        pass
    return None


def get_cached_prices(client: Client) -> dict:
    try:
        result = (
            client.table("sync_state")
            .select("value")
            .eq("key", "price_cache")
            .execute()
        )
        if result.data:
            import json
            return json.loads(result.data[0]["value"])
    except Exception:
        pass
    return {}


def set_cached_prices(client: Client, prices: dict):
    import json
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    client.table("sync_state").upsert(
        {"key": "price_cache", "value": json.dumps(prices), "updated_at": now},
        on_conflict="key",
    ).execute()


def set_last_sync(client: Client, iso_datetime: str):
    try:
        client.table("sync_state").upsert(
            {"key": "last_sync_at", "value": iso_datetime, "updated_at": iso_datetime},
            on_conflict="key",
        ).execute()
    except Exception:
        pass


def get_watchlist(client: Client) -> list:
    result = client.table("watchlist").select("*").order("added_at").execute()
    return result.data


def ensure_watchlist(client: Client, initial_tickers: list):
    existing = client.table("watchlist").select("ticker").execute()
    if not existing.data:
        client.table("watchlist").insert(
            [{"ticker": t} for t in initial_tickers]
        ).execute()


def setup_tables(client: Client):
    schema = open("schema.sql").read()
    # Supabase anon key can't run DDL directly — raise to let caller handle
    raise RuntimeError("DDL requires running schema.sql manually in Supabase SQL Editor")


# ── ML: price_history ─────────────────────────────────────────────────────────

def get_price_history_ticker(client: Client, ticker: str):
    """Returns pd.Series with DatetimeIndex of daily closes, or empty Series."""
    import pandas as pd
    res = (
        client.table("price_history")
        .select("date,close")
        .eq("ticker", ticker)
        .order("date")
        .execute()
    )
    if not res.data:
        return pd.Series(dtype=float)
    idx  = pd.to_datetime([r["date"] for r in res.data])
    vals = [float(r["close"]) for r in res.data]
    return pd.Series(vals, index=idx)


def upsert_price_history(client: Client, ticker: str, closes):
    """Upsert daily closes for a ticker (closes is pd.Series with DatetimeIndex)."""
    rows = [
        {"ticker": ticker, "date": str(idx.date()), "close": float(c)}
        for idx, c in closes.items()
    ]
    if rows:
        client.table("price_history").upsert(rows, on_conflict="ticker,date").execute()


# ── ML: ml_results + ml_metrics ──────────────────────────────────────────────

def save_ml_run(client: Client, model: str, results: list, metrics: dict) -> str:
    """Insert results and metrics for a model run. Returns run_at ISO string."""
    from datetime import datetime, timezone
    run_at = datetime.now(timezone.utc).isoformat()

    rows = []
    for r in results:
        row = {"run_at": run_at, "model": model, "ticker": r["ticker"], "why": r.get("why")}
        if model == "entry_score":
            row["score"] = r.get("score")
        else:
            row["signal"]     = r.get("signal")
            row["signal_key"] = r.get("signal_key")
            row["confidence"] = r.get("confidence")
            row["probs"]      = r.get("probs")
        rows.append(row)
    if rows:
        client.table("ml_results").insert(rows).execute()

    if metrics:
        client.table("ml_metrics").insert({"run_at": run_at, "model": model, **metrics}).execute()

    return run_at


def get_latest_ml_run(client: Client, model: str) -> tuple:
    """Returns (results_list, metrics_dict, run_at_str) for the latest run, or ([], None, None)."""
    res = (
        client.table("ml_results")
        .select("*")
        .eq("model", model)
        .order("run_at", desc=True)
        .limit(200)
        .execute()
    )
    if not res.data:
        return [], None, None

    latest_at = res.data[0]["run_at"]
    results   = [r for r in res.data if r["run_at"] == latest_at]

    metrics_res = (
        client.table("ml_metrics")
        .select("*")
        .eq("model", model)
        .order("run_at", desc=True)
        .limit(1)
        .execute()
    )
    metrics = metrics_res.data[0] if metrics_res.data else None
    return results, metrics, latest_at
