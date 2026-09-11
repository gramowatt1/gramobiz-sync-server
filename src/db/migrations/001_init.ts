// The self-hosted counterpart to Gramobiz's own backend's catalog/staff sync tables — but
// genuinely multi-tenant-free (no `subscriber_id` anywhere): one deployment of this server
// serves exactly one business, which may still register several of its own physical stores
// against it — the self-hosted equivalent of Gramobiz's own Multi-Store tier, at whatever store
// count the customer wants, with no separate purchase needed since they're running the server
// themselves.
//
// Deliberately a *per-store mapping table* (`catalog_product_stores`/`staff_stores`) rather than
// a single `local_id` column directly on `catalog_products`/`staff`, the way Gramobiz's own
// hosted backend does it today. A bare column only works when exactly one store ever syncs to a
// given subscriber — two independent tills both have their own "local product #1", and those are
// two different products, not the same one; a single shared `local_id` column can't represent
// "store A calls this row 7, store B calls the very same row 3" at all. This deployment is meant
// to support genuine multi-store sharing from day one (arguably the main reason to self-host at
// all), so it gets the correct design here — Gramobiz's own hosted backend has the same
// underlying limitation today, not yet hit only because there's currently one real production
// till on it; worth fixing there too, deliberately, later, not silently left inconsistent.
//
// No `subscribers`, `licenses`, or anything Paystack-shaped exists in this schema at all — this
// package has nothing to do with licensing the till app, only with syncing its catalog and
// staff roster across whichever of the customer's own tills register against it.
export const sql = `
CREATE TABLE stores (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  api_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE catalog_products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  base_unit TEXT NOT NULL,
  cost_price NUMERIC NOT NULL DEFAULT 0,
  barcode TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE catalog_sale_units (
  id BIGSERIAL PRIMARY KEY,
  catalog_product_id BIGINT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  factor NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  barcode TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalog_sale_units_product ON catalog_sale_units(catalog_product_id);

-- One row per (store, local product) — a store's own till assigns local_id; this maps it to
-- the one shared catalog_products row every store sees on pull. A product only ever gets
-- created fresh (no mapping found for that store+local_id) the first time any store pushes it;
-- from then on every other store links to that same central row via its own local_id once it
-- pulls the product down and creates its own local copy (electron/services/catalogSync.ts's
-- claim step).
CREATE TABLE catalog_product_stores (
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id INTEGER NOT NULL,
  catalog_product_id BIGINT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, local_id)
);

CREATE UNIQUE INDEX idx_catalog_product_stores_product ON catalog_product_stores(store_id, catalog_product_id);

-- Same shape as Gramobiz's central staff table, minus subscriber_id — one shared roster across
-- every store this deployment serves, same per-store mapping reasoning as products above.
-- password_hash is required here (not nullable, unlike Gramobiz's hosted staff table) — every
-- row either arrived from a till push (which always carries a real hash) or was never meant to
-- exist without a working login in the first place, there being no separate till to fall back on.
CREATE TABLE staff (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  active BOOLEAN NOT NULL DEFAULT true,
  password_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_stores (
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id INTEGER NOT NULL,
  staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, local_id)
);

CREATE UNIQUE INDEX idx_staff_stores_staff ON staff_stores(store_id, staff_id);
`
