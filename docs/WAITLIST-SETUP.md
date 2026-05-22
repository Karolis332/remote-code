# Waitlist + Stripe Setup

This doc covers wiring the landing-page CTAs to real backends. Static page, no server. Two integrations:

1. **Waitlist form** → Supabase REST insert (ShortVitals project)
2. **Pricing tier CTAs** → Stripe Payment Links

---

## 1. Supabase — `remotecode_waitlist` table

The landing form already POSTs to:
```
https://kgtgyenjtugmdqgloxdq.supabase.co/rest/v1/remotecode_waitlist
```

That table needs to exist with anon-insert RLS. Paste this into **Supabase SQL Editor** for project `kgtgyenjtugmdqgloxdq`:

```sql
-- Idempotent: safe to run multiple times.
create table if not exists public.remotecode_waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text default 'gh-pages',
  user_agent  text,
  referrer    text,
  ip_country  text,
  created_at  timestamptz not null default now()
);

create unique index if not exists remotecode_waitlist_email_idx
  on public.remotecode_waitlist (lower(email));

alter table public.remotecode_waitlist enable row level security;

-- Allow anonymous inserts only — no select/update/delete from the anon role.
drop policy if exists "anon insert" on public.remotecode_waitlist;
create policy "anon insert"
  on public.remotecode_waitlist
  for insert
  to anon
  with check (
    email is not null
    and length(email) between 5 and 320
    and email like '%@%.%'
  );

-- Allow service-role (you) to read everything. (Already true by default;
-- this comment is here so future-you knows.)
```

After running:
- The landing form will work end-to-end.
- Read signups via Supabase Studio → Table editor → `remotecode_waitlist`.
- Or query via service-role key:
  ```bash
  curl "$SUPABASE_URL/rest/v1/remotecode_waitlist?select=*&order=created_at.desc" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  ```

**Why this is safe:** the anon key shipped in the static HTML is public-by-design in Supabase's threat model. RLS is the actual access control — only `INSERT` is allowed for `anon`, never `SELECT`. An attacker can spam inserts (rate-limit via Supabase project settings if needed) but cannot read other people's emails or modify them.

---

## 2. Stripe — Payment Links for 3 tiers

For a static site, **Stripe Payment Links** are simpler than Checkout Sessions (no backend required). Each link is a hosted URL that handles the full checkout flow.

### Step 1 — Create products in Stripe Dashboard (test mode)

Dashboard → Products → Add product. Create three:

| Name | Description | Pricing |
|---|---|---|
| RemoteCode Solo | One PC. One phone. One operator. | $19/month recurring |
| RemoteCode Team | Up to 5 PCs. Shared inbox. | $49/month recurring |
| RemoteCode Agency | Multi-tenant, white-label, SSO. | $199/month recurring |

For each: enable **"Customer can adjust quantity"** = NO. Set **trial period** = 7 days (optional). Set the **statement descriptor** to `REMOTECODE`.

### Step 2 — Generate a Payment Link per product

For each product → "Pricing" section → click the price → "Create payment link". On the link page:
- Toggle "Collect customer's email address" = ON
- Success URL: `https://karolis332.github.io/remote-code/?paid=<tier>` (replace `<tier>` per product)
- Toggle "Allow promotion codes" = ON
- Save.

Copy the resulting URL (looks like `https://buy.stripe.com/test_xxxxxxxxxxxx`).

### Step 3 — Tell me the 3 URLs

Reply with:
```
solo:  https://buy.stripe.com/test_...
team:  https://buy.stripe.com/test_...
agency: https://buy.stripe.com/test_...
```

I'll wire them into the pricing CTAs and push.

### Stays in test mode

Per the eCMR Capture policy (`memory/project_vercel_stripe.md`), Stripe stays in test mode until first paid call agreed by phone. Same here. Switch to live mode only after the first founding-member close.

### Optional: founding-member preorder

If you want to validate pricing aggressively, create a 4th product: **RemoteCode Founder · $99 one-time · Lifetime Solo plan**. Limit to first 50 customers via Stripe's "Inventory" feature. Add a prominent CTA above the regular pricing tiers. This is the strongest demand-validation signal you can get pre-product. Says you can stop the build if you don't get to 10 founders in a week.

---

## 3. After both are wired

The landing becomes:
- Free demo URL: https://karolis332.github.io/remote-code/
- Working email capture: emails land in your ShortVitals Supabase
- Working preorder buttons: payments land in your Stripe (test → live when ready)
- $0/month infrastructure cost

You can post to Show HN, IH, There's an AI for That with that URL.
