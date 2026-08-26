"""web_search -- live search via the Tavily API (https://tavily.com), the
only skill here that sends a query to a third party other than the
configured LLM/embedding endpoint. Tavily advertises zero-day retention on
search terms (see README.md's privacy section); that's the tradeoff
accepted when this skill is used at all.

Unlike the other tools, this one needs its own API key (Settings page,
encrypted at rest the same way as the LLM provider key -- see
settings_store.py) since Tavily is a fixed third-party service, not
something pointed at whatever OpenAI-compatible endpoint the user has."""
import httpx

from ..config import settings

MAX_RESULTS = 5
_API_URL = "https://api.tavily.com/search"


async def run(args: dict, api_key: str) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "No query given."}
    if not api_key:
        return {"error": "No Tavily API key configured on the Settings page -- can't search the web."}
    body = {"query": query, "max_results": MAX_RESULTS, "search_depth": "basic"}
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=settings.tavily_timeout_seconds) as client:
            resp = await client.post(_API_URL, json=body, headers=headers)
    except httpx.RequestError as e:
        return {"error": f"Could not reach Tavily: {e}"}
    if resp.status_code != 200:
        return {"error": f"Tavily returned HTTP {resp.status_code}: {resp.text[:500]}"}
    data = resp.json()
    results = [
        {"title": r.get("title", ""), "url": r.get("url", ""), "content": r.get("content", "")}
        for r in data.get("results", [])
    ]
    if not results:
        return {"results": [], "note": "No results found."}
    return {"results": results}
