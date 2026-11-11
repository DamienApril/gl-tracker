"""Apply one change to my MDL list.

Run: MDL_TOKEN=... python scraper/mdl_write.py <title id> [--status N] [--seen N]
Status: 1 watching, 2 completed, 3 plan to watch, 4 on-hold, 5 dropped.
"""
import argparse, os, sys
from curl_cffi import requests as cr

p = argparse.ArgumentParser()
p.add_argument("id", type=int)
p.add_argument("--status", type=int, choices=range(1, 7))
p.add_argument("--seen", type=int)
a = p.parse_args()

body = {}
if a.seen is not None:
    body.update(episode_seen=max(0, a.seen), quick_action="true")
if a.status:
    body["watch_status"] = a.status
if not body:
    sys.exit("nothing to change")

token = os.environ.get("MDL_TOKEN")
if not token:
    sys.exit("MDL_TOKEN secret is missing")

url = f"https://mydramalist.com/v1/users/watchaction/{a.id}"
headers = {"authorization": "Bearer " + token}
s = cr.Session(impersonate="chrome")
r = s.patch(url, data=body, headers=headers, timeout=30)
if r.status_code in (401, 403):
    topic = os.environ.get("NTFY_TOPIC")
    if topic:
        s.post(f"https://ntfy.sh/{topic}", data=b"Paste a fresh jl_sess cookie into the MDL_TOKEN secret.",
               headers={"Title": "MDL login expired", "Tags": "warning"})
    sys.exit(f"MDL rejected the token ({r.status_code}), it probably expired")
r.raise_for_status()
d = r.json()
# MDL answers 200 with the old values when it ignores a field, so check the result.
if (a.seen is not None and d.get("episode_seen") != max(0, a.seen)) or (a.status and d.get("watch_status") != a.status):
    sys.exit(f"MDL did not apply the change: {d}")
print("ok", a.id, "status", d["watch_status"], "seen", d["episode_seen"])
