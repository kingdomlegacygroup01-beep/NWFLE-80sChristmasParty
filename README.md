# NWFL Encounters 80s Christmas Party — RSVP site

Node/Express app. Guests submit name, email, headcount, and what they're bringing.
Organizers view RSVPs at `/admin` (username: anything, password: `ADMIN_PASSWORD`), with totals and CSV export.

## Deploy on Railway
1. New Project → Deploy from GitHub repo (this repo).
2. In the project, add a **PostgreSQL** database. In the app service → Variables, add
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}` and `ADMIN_PASSWORD = <your choice>`.
   Optional: `QUESTIONS_EMAIL` (defaults to info.nwfle@gmail.com).
3. App service → Settings → Networking → Generate Domain.

Run locally: `npm install && npm start` (stores data in `data/rsvps.json` when no DATABASE_URL).
