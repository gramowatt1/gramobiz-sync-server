# Gramobiz Sync Server (self-hosted)

The same catalog/staff sync protocol Gramobiz's own hosted "Cloud Sync & Web Access" uses —
packaged small enough to run entirely on infrastructure **you** own, instead of Gramobiz's. This
is for a business that wants several of its own tills sharing one product catalog and one staff
roster, without paying for or depending on Gramobiz's own servers to do it.

## What this is not

There's no licensing, billing, or Paystack anywhere in this package — it has nothing to do with
activating the till app itself (that always goes through Gramobiz; license activation is a
one-time thing and stays that way regardless of where you sync). This is *only* the sync server:
catalog and staff data, shared across whichever of your own tills you register against it. There's
also no web dashboard here (yet) — you keep managing products and staff from the till app itself,
exactly as today; this just lets more than one till see the same data.

## Two ways to run this — pick whichever fits

**Don't want to touch a server at all?** Click the button below. It deploys this exact software
onto your *own* Render account — your data, your bill (Render's free tier is enough for a small
shop's sync traffic, though it has real limits — see the note below), nothing for you to
maintain beyond occasionally checking it's still running.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gramowatt1/gramobiz-sync-server)

**Run your own server already, or want full control?** Use Docker Compose — works on a spare shop
PC, an office server, a VPS you already pay for, anything with Docker installed. See "Running with
Docker" below.

Both options run the *exact same software* — pick based on how much you want to manage yourself,
not because one is more "real" than the other.

## Option A: Deploy to Render (one click)

1. Click the button above and sign in to (or create) a Render account.
2. Render provisions a small Postgres database and this server together, automatically.
3. Once it's live, open the `gramobiz-sync-server` service → **Environment** tab, and copy the
   value Render generated for `SETUP_KEY` — you'll need it in a moment.
4. Register your first till (see "Registering your first till" below), using your Render
   service's URL (shown at the top of its dashboard page) and that `SETUP_KEY`.

**Render's free tier, honestly:** the free web service goes to sleep after 15 minutes of no
traffic and takes a few seconds to wake back up on the next request (your till's sync just waits
a moment longer that one time — nothing breaks), and the free Postgres database expires after 30
days unless you attach a card or upgrade. Fine for trying this out; for daily real use, Render's
cheapest paid tier (a few dollars/month) removes both limits.

## Option B: Running with Docker

Needs [Docker](https://docs.docker.com/get-docker/) installed on whatever machine will run this.

```sh
cp .env.example .env        # then set SETUP_KEY to something long and random
docker compose up -d
```

That's it — `docker compose up -d` starts both Postgres and the sync server, applies the database
schema automatically, and keeps both running (`restart: unless-stopped`) across a reboot. Check
it's up with `docker compose logs -f sync-server`.

## Registering your first till

Once the server is running somewhere reachable (from Option A or B above):

```sh
curl -X POST https://your-server-url/v1/stores/register \
  -H "content-type: application/json" -H "x-setup-key: <your SETUP_KEY>" \
  -d '{"name":"Main Branch"}'
```

Returns `{ storeId, name, apiToken, createdAt }` — paste the URL and `apiToken` into the till's
**Settings → Self-Hosted Sync Server**. Repeat for each additional till/store — they'll all share
the same catalog and staff roster from then on.

## Running locally, for development

Needs a real Postgres to talk to.

```sh
cp .env.example .env        # then fill in DATABASE_URL and a SETUP_KEY you make up
npm install
npm run migrate             # applies src/db/migrations against DATABASE_URL
npm run dev                 # starts the server with reload-on-change
```

## What's here

- `src/db/` — Postgres schema and migration runner. Genuinely single-business (no
  `subscriber_id`/multi-tenant concept anywhere) — one deployment serves one business, which may
  register several of its own physical stores against it, each with its own independent mapping
  of local product/staff ids to the one shared catalog (see the schema's own comments for why a
  bare `local_id` column — Gramobiz's own hosted backend's simpler approach — doesn't work once
  more than one store is involved).
- `src/routes/setup.ts` — `POST /v1/stores/register` (header `x-setup-key`, matching your own
  `SETUP_KEY`) — the one thing you do once per till to connect it here.
- `src/routes/catalog.ts` / `src/routes/staffSync.ts` — the actual sync endpoints (`/sync`,
  `/pull`, `/claim`) — identical wire protocol to Gramobiz's own hosted backend, so the till's
  sync code doesn't know or care which one it's talking to.
