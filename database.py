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


def setup_tables(client: Client):
    schema = open("schema.sql").read()
    # Supabase anon key can't run DDL directly — raise to let caller handle
    raise RuntimeError("DDL requires running schema.sql manually in Supabase SQL Editor")
