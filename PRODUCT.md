# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: static HTML/CSS/JS, no build, installable as a PWA on Android. Hosted on GitHub Pages; a Python scraper (`scraper/update.py`) runs on GitHub Actions and writes `data/shows.json`. MyDramaList is the owner's list of record: the scraper reads it into `data/mdl.json`, and app changes are written back to MDL by a GitHub Actions job using the owner's MDL session token. App-only extras (own links, notes, hidden, subscriptions) live in `data/extras.json`, written through the GitHub API, so nothing depends on phone browser storage.

## Users

One person, the owner. Watches Asian GL (girls' love / lesbian romance) dramas, mostly Thai, also Japanese, Korean, Taiwanese, Chinese, Filipino. Uses it mainly on an Android phone, sometimes on PC. Not shared with anyone.

## Product Purpose

Answer "what GL episodes are out this week, what's coming soon, and where do I watch it" at a glance, and send a phone notification when an episode drops or a new GL show appears on MyDramaList.

## Operating Context

- Source of truth for shows is MyDramaList's "Lesbian Romance" tag (th=15265). No official API; pages are scraped politely a few times a day.
- Owner subscribes to WeTV, iQIYI and GagaOOLala. Some shows are free on YouTube or other sites.
- Notifications go through the ntfy Android app.

## Capabilities and Constraints

- Views: This week, Coming soon, My list, Browse (all tag shows).
- Per show: status (watching, plan, finished, dropped), episode progress, where to watch (MDL's list plus own links), hide.
- Episode dates come from MDL; missing ones are estimated from air days and must be marked as estimates.
- Air dates are in the origin country's date; air times are unknown.

## Product Principles

- Glanceable on a phone in one thumb: what's new first.
- Never lose the owner's list.
- Say when a date is a guess.
