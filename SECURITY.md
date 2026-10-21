# Security

## Scope

This project is a static bundle of HTML, CSS and JavaScript. There is no server, no
database and no account system of its own — the only network peers are the Party Quiz
matchmaker (`wss://partyquiz.club:3012`) and, for the 3D preview, a pinned Three.js build
on jsDelivr.

Things that count as security issues here:

- a way to execute injected content through this client (for example a translation or an
  avatar name escaping into `innerHTML`);
- a way to leak another player's data beyond what the official client already exposes;
- a supply-chain change in the pinned CDN dependency;
- a service-worker bug that serves stale or attacker-controlled content.

Things that do not: someone cheating by editing their own browser, or the game's own
server-side rules.

## Reporting

Open a private report through **Security → Report a vulnerability** on GitHub rather than a
public issue, and include the browser, the URL, and the steps. You will get an answer as
soon as a human sees it — this is a hobby project, not a product with an SLA.

## Hardening notes for this fork

- No `eval`, no `new Function`, no `innerHTML` with translated strings.
- The 3D module imports Three.js `0.160.0` from jsDelivr by exact version; there is no
  `latest` tag anywhere.
- The service worker only handles same-origin `GET` requests and never caches `/pqlog`.
- `?server=` accepts only the hosts in `ALLOWED_SERVERS` inside `main.js`.
