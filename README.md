# GL Tracker

Personal tracker for Asian GL dramas. Shows what's airing this week, what's coming, and your MyDramaList list, with phone notifications. Changes you make in the app sync back to MDL.

## How it works

- `scraper/update.py` runs on GitHub Actions every 3 hours (`.github/workflows/update.yml`). It reads MDL's Lesbian Romance tag (airing, upcoming, recently finished), your public MDL list, and episode dates, writes `data/shows.json` and `data/mdl.json`, and sends ntfy notifications.
- The app (`index.html`, `app.js`, `style.css`) is a static page on GitHub Pages, installable on Android.
- Tapping +1 or changing a status starts `.github/workflows/sync.yml`, which runs `scraper/mdl_write.py` to save the change on MDL with your MDL login token. The app shows the change straight away; the next update run pulls MDL's real values.
- Your own links, notes, hidden shows and subscriptions live in `data/extras.json`, written by the app through the GitHub API.

Notifications: new episode of a show you're Watching or Plan to Watch (once per episode), premiere tomorrow, a new show appearing on the GL tag, and MDL login expired.

## Setup (once)

1. **Repo.** Create a new repository on GitHub named `gl-tracker`. It has to be **public** for free GitHub Pages; your MDL list is public anyway, but your notes in the app would be too. Push this folder to it.
2. **Pages.** Repo Settings, Pages, Source: "Deploy from a branch", branch `main`, folder `/ (root)`. The app ends up at `https://<you>.github.io/gl-tracker/`.
3. **ntfy.** Install ntfy from the Play Store, tap +, subscribe to a topic name nobody would guess (e.g. `gl-` plus random letters).
4. **MDL token.** On a PC, open mydramalist.com while logged in, press F12, Application tab, Cookies, `https://mydramalist.com`, copy the value of `jl_sess`.
5. **Secrets.** Repo Settings, Secrets and variables, Actions, New repository secret:
   - `MDL_TOKEN` = the `jl_sess` value
   - `NTFY_TOPIC` = your ntfy topic name
6. **App token.** GitHub Settings, Developer settings, Fine-grained tokens, Generate: only this repository, permissions **Contents: Read and write** and **Actions: Read and write**. Copy it.
7. **Phone.** Open the app URL in Chrome, tap the settings button on the Week screen, enter `<you>/gl-tracker` and the token. Then Chrome menu, "Add to Home screen".
8. Run the `update` workflow once by hand (Actions tab, update, Run workflow) to fill the data.

When MDL logs you out, you get a "MDL login expired" notification: repeat step 4 and update the `MDL_TOKEN` secret.

## Local run

```
pip install curl_cffi beautifulsoup4 requests
python scraper/update.py --selftest
python scraper/update.py
python -m http.server 8765   # then open http://127.0.0.1:8765
```
