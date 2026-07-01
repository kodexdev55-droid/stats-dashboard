# Deligatr — LinkedIn Outreach Dashboard

Client-facing outreach metrics embedded in GoHighLevel via Custom Menu Link.

---

## Setup

### 1. Supabase — run SQL

Open **Supabase → SQL Editor → New query**, paste the contents of `sql/setup.sql`, and run it.

This creates the `client_public` view, enables RLS on both tables, and locks down `subaccounts` from any browser access.

### 2. Environment variables

Copy `.env.local.example` to `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

Find both values in **Supabase → Settings → API**.

### 3. Deploy on Vercel

```bash
cd deligator
npm install
npx vercel
```

When prompted, add the two env vars above in the Vercel project settings
(**Project → Settings → Environment Variables**), or pass them during the CLI flow.

### 4. GoHighLevel Custom Menu Link

In GHL: **Sub-account → Settings → Custom Menu Links → Add**

| Field | Value |
|-------|-------|
| Name | Outreach Report |
| URL | `https://<your-app>.vercel.app/dash?client={{location.id}}` |
| Open in | iFrame |

GHL automatically replaces `{{location.id}}` with the sub-account's location ID.

---

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000/dash?client=YOUR_TEST_LOCATION_ID](http://localhost:3000/dash?client=YOUR_TEST_LOCATION_ID)

Test the empty state with an unknown id: `?client=nonexistent`  
Test the no-param state: `/dash` (no query string)

---

## Architecture notes

- The page reads from `client_stats` (metrics) and `client_public` (display name only).
- It never reads `subaccounts` directly — that table holds live API keys used by n8n.
- The `client_public` view exposes only `location_id` and `subaccount_name`.
- RLS + revoked grants mean the `anon` key cannot reach `subaccounts` even if someone tries.
- The anon key is safe to ship in the browser. Never add the service-role key to this project.
# stats-dashboard
