"""Fetch GL shows from MyDramaList into data/shows.json and send ntfy alerts.

Run: python scraper/update.py            (NTFY_TOPIC env var enables notifications)
     python scraper/update.py --selftest
"""
import json, os, re, sys, time, urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOWS = ROOT / "data" / "shows.json"
MYLIST = ROOT / "data" / "mdl.json"  # my MDL list, read-only copy
MDL_USER = os.environ.get("MDL_USER", "15187640")
BASE = "https://mydramalist.com"
TAG = BASE + "/search?adv=titles&th=15265"  # Lesbian Romance tag
# st=1 airing, st=2 upcoming (only lists with so=popular), st=3 completed. Older titles stay in shows.json from earlier runs.
TAG_URLS = [TAG + "&st=1&so=newest", TAG + "&st=2&so=popular", TAG + "&st=2&so=popular&page=2",
            TAG + "&st=3&so=newest", TAG + "&st=3&so=newest&page=2"]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def parse_date(s):
    s = s.strip()
    for fmt in ("%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None  # "2026", "Nov 2026" or "?" stay unknown


def parse_search(html):
    from bs4 import BeautifulSoup
    out = []
    for box in BeautifulSoup(html, "html.parser").select("div.box[id^=mdl-]"):
        a = box.select_one("h6.title a")
        meta = box.select_one("span.text-muted")
        img = box.select_one("img")
        if not a:
            continue
        out.append({
            "id": box["id"][4:],
            "slug": a["href"].strip("/"),
            "title": a.get_text(strip=True),
            "meta": meta.get_text(strip=True) if meta else "",  # "Thai Drama - 2026, 8 episodes"
            "poster": img.get("data-src") if img else None,
        })
    return out


def parse_show(html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    info = {}
    for li in soup.select("ul.list li.list-item"):
        b = li.find("b")
        if b:
            key = b.get_text(strip=True).rstrip(":")
            info.setdefault(key, li.get_text(" ", strip=True)[len(b.get_text(strip=True)):].strip())
    aired = info.get("Aired") or info.get("Airs") or info.get("Release Date", "")  # Airs = upcoming, Release Date = movies
    start, _, end = aired.partition(" - ")
    watch = []
    for block in soup.select(".box-body.wts .col-lg-4"):
        name = block.select_one("b")
        link = block.select_one("a[href]")
        kind = block.select_one(".p-l > div:nth-of-type(2)")
        if name and link:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(link["href"]).query).get("q", [link["href"]])[0]
            watch.append({"name": name.get_text(strip=True), "url": q,
                          "kind": kind.get_text(strip=True) if kind else ""})
    eps = info.get("Episodes", "")
    syn = soup.select_one(".show-synopsis p, .show-synopsis")
    native = info.get("Native Title")
    return {
        "native": native,
        "country": info.get("Country"),
        "type": info.get("Type"),
        "episodes": int(eps) if eps.isdigit() else None,
        "start": parse_date(start) if start else None,
        "end": parse_date(end) if end else None,
        "airText": aired or None,
        "airDays": [d for d in DAYS if d in (info.get("Aired On") or info.get("Airs On") or "")],
        "network": info.get("Original Network"),
        "score": info.get("Score", "").split(" ")[0] or None,
        "synopsis": syn.get_text(" ", strip=True)[:600] if syn else None,
        "watch": watch,
    }


def parse_episodes(html):
    from bs4 import BeautifulSoup
    out = []
    for ep in BeautifulSoup(html, "html.parser").select("div.episode"):
        a = ep.select_one("h2.title a")
        d = ep.select_one(".air-date")
        m = re.search(r"/episode/(\d+)", a["href"]) if a else None
        if m:
            out.append({"n": int(m.group(1)), "date": parse_date(d.get_text()) if d else None})
    return sorted(out, key=lambda e: e["n"])


STATUS = {"Watching": 1, "Completed": 2, "Plan to Watch": 3, "On-Hold": 4, "Dropped": 5, "Not Interested": 6}


def parse_mylist(html):
    """Rows of the public /dramalist/<user> table -> {id: {...}}."""
    from bs4 import BeautifulSoup
    out = {}
    for tr in BeautifulSoup(html, "html.parser").select("tr[id^=ml]"):
        a = tr.select_one("a.title")
        st = tr.select_one(".msv2-i-status")
        seen, total = tr.select_one(".num-seen"), tr.select_one(".num-total")
        img = tr.select_one("img")
        if not a:
            continue
        out[tr["id"][2:]] = {
            "slug": a["href"].strip("/"), "title": a.get_text(strip=True),
            "status": STATUS.get(st.get_text(strip=True), 0) if st else 0,
            "seen": int(seen.get_text()) if seen and seen.get_text().isdigit() else 0,
            "total": int(total.get_text()) if total and total.get_text().isdigit() else None,
            "poster": img.get("data-src") if img else None,
        }
    return out


def fetch_mylist(session, user):
    rows, page = {}, 1
    while True:
        time.sleep(1.5)
        r = session.post(f"{BASE}/dramalist/{user}", json={"page": page, "sort_by": "title", "sort_order": "asc"},
                         headers={"x-requested-with": "XMLHttpRequest"}, timeout=30)
        r.raise_for_status()
        new = parse_mylist(r.text)
        if not new.keys() - rows.keys():
            return rows
        rows.update(new)
        page += 1


def fill_dates(show):
    """Estimate missing episode dates from the start date and air days, one episode per air day."""
    n = show.get("episodes") or len(show["eps"])
    known = {e["n"]: e["date"] for e in show["eps"] if e["date"]}
    if not n or not show.get("start") or not show.get("airDays"):
        show["eps"] = [{"n": i, "date": known.get(i), "est": False} for i in range(1, n + 1)] if n else show["eps"]
        return show
    # shortcut: assumes one episode per air day, a double-episode day makes later estimates early; MDL dates win when present.
    days = {DAYS.index(d) for d in show["airDays"]}
    d, i, eps = date.fromisoformat(show["start"]), 1, []
    while i <= n:
        if d.weekday() in days or i == 1:
            eps.append({"n": i, "date": known.get(i, d.isoformat()), "est": i not in known})
            if i in known:
                d = date.fromisoformat(known[i])
            i += 1
        d += timedelta(days=1)
    show["eps"] = eps
    return show


def needs_refresh(show, today):
    """Skip shows that finished airing over 3 weeks ago and were already fetched."""
    if "fetched" not in show:
        return True
    last = max((e["date"] for e in show.get("eps", []) if e.get("date")), default=None) or show.get("end") or show.get("start")
    return not last or date.fromisoformat(last) > today - timedelta(days=21)


def notify(topic, title, msg, url=None):
    if not topic:
        print("[notify]", title, "|", msg)
        return
    import requests
    headers = {"Title": title.encode("utf-8"), "Tags": "rainbow"}
    if url:
        headers["Click"] = url
    requests.post(f"https://ntfy.sh/{topic}", data=msg.encode("utf-8"), headers=headers, timeout=20)


def main():
    from curl_cffi import requests as cr
    session = cr.Session(impersonate="chrome")

    def get(url):
        time.sleep(1.5)  # be polite to MDL
        r = session.get(url, timeout=30)
        r.raise_for_status()
        return r.text

    old = json.loads(SHOWS.read_text("utf-8")) if SHOWS.exists() else {"shows": {}, "notified": []}
    shows, notified = old["shows"], set(old.get("notified", []))
    first_run = not shows
    today = date.today()
    topic = os.environ.get("NTFY_TOPIC")

    found = list({i["id"]: i for url in TAG_URLS for i in parse_search(get(url))}.values())
    if not found:
        sys.exit("No shows parsed from MDL search page, layout changed or blocked.")

    for item in found:
        if item["id"] not in shows:
            shows[item["id"]] = {**item, "gl": True, "firstSeen": today.isoformat()}
            if not first_run:
                notify(topic, "New GL show on MDL", f'{item["title"]} ({item["meta"]})', f'{BASE}/{item["slug"]}')
        else:
            shows[item["id"]].update(item, gl=True)

    mylist = fetch_mylist(session, MDL_USER)
    MYLIST.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "list": mylist},
                                 ensure_ascii=False, indent=1), "utf-8")
    tracked = {sid for sid, e in mylist.items() if e["status"] in (1, 3)}  # watching, plan to watch
    for sid in tracked - shows.keys():
        e = mylist[sid]
        shows[sid] = {"id": sid, "slug": e["slug"], "title": e["title"], "poster": e["poster"], "firstSeen": today.isoformat()}

    for sid in [s for s in shows if needs_refresh(shows[s], today)]:
        s = shows[sid]
        try:
            s.update(parse_show(get(f'{BASE}/{s["slug"]}')))
            if s.get("type") != "Movie":
                s["eps"] = parse_episodes(get(f'{BASE}/{s["slug"]}/episodes'))
                fill_dates(s)
            s["fetched"] = today.isoformat()
        except Exception as e:  # one broken show must not stop the run
            print("failed", s["slug"], e)

    # Episode and premiere alerts, once each, only for shows on my list.
    tomorrow = (today + timedelta(days=1)).isoformat()
    for sid in tracked & shows.keys():
        s = shows[sid]
        for e in s.get("eps", []):
            key = f'{sid}:{e["n"]}'
            if e["date"] and e["date"] <= today.isoformat() and key not in notified:
                notified.add(key)
                if not first_run and e["date"] >= (today - timedelta(days=2)).isoformat():
                    notify(topic, s["title"], f'Episode {e["n"]} is out', f'{BASE}/{s["slug"]}')
        if s.get("start") == tomorrow and f"{sid}:premiere" not in notified:
            notified.add(f"{sid}:premiere")
            notify(topic, s["title"], "Premieres tomorrow", f'{BASE}/{s["slug"]}')

    SHOWS.parent.mkdir(exist_ok=True)
    SHOWS.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
                                 "shows": shows, "notified": sorted(notified)},
                                ensure_ascii=False, indent=1), "utf-8")
    print(f"{len(shows)} shows saved, {len(found)} on tag pages")


def selftest():
    assert parse_date("Sep 11, 2026") == "2026-09-11" and parse_date("2026") is None
    s = fill_dates({"episodes": 4, "start": "2026-09-11", "airDays": ["Friday"],
                    "eps": [{"n": 1, "date": "2026-09-11"}, {"n": 2, "date": "2026-09-18"}]})
    assert [e["date"] for e in s["eps"]] == ["2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02"], s
    assert [e["est"] for e in s["eps"]] == [False, False, True, True]
    s = fill_dates({"episodes": 3, "start": "2026-11-09", "airDays": ["Monday", "Tuesday"], "eps": []})
    assert [e["date"] for e in s["eps"]] == ["2026-11-09", "2026-11-10", "2026-11-16"], s
    print("selftest ok")


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
