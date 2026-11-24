# Contract — Provisioning release summary (product → backoffice)

Two hops, both read-only and both already authenticated the same way as their
neighbours.

## 1. Product internal route

`GET /internal/provisioning/summary?days=<1..365>` (default 30) in
`apps/web/src/web/internal.ts`, behind the existing `INTERNAL_TOKEN_HEADER` guard.
Same 404-when-unconfigured behaviour as the other internal routes.

```ts
export const provisioningSummarySchema = z.object({
  windowDays: z.number().int().positive(),
  generatedAt: z.string(),
  total: z.number().int().nonnegative(),
  days: z.array(z.object({
    day: z.string(),                       // YYYY-MM-DD
    total: z.number().int().nonnegative(),
    reasons: z.array(z.object({
      reason: releaseReasonSchema,
      count: z.number().int().nonnegative()
    }))
  }))
});

export type ProvisioningSummary = z.infer<typeof provisioningSummarySchema>;
```

Rules:

- Counts only. No account id, session id, machine id, model id, host, port, key
  or conversation text appears anywhere in the payload (FR-036, Principle I).
- `ceiling_reached` is excluded: it is a report, not a release.
- A day with no releases is omitted rather than sent as zeros.
- The query is bounded (`days ≤ 365`) and uses the existing `released_at` /
  `release_reason` columns, so it needs no new table.

Failure modes: `401` without the token, `404` when the internal API is not
configured, `400` for a malformed `days`, `503` when storage is unavailable.

## 2. Backoffice route

`GET /admin-api/provisioning?days=<1..365>` in `apps/portal/src/admin-routes.ts`,
behind the existing `requireAdmin` guard, proxying the product route through
`apps/portal/src/services/internal-client.ts` (`provisioningSummary(days)`). The
portal does not store the result; it validates it with
`provisioningSummarySchema` and passes it on.

Errors mirror the accounts routes: `502` with the product's message when the
internal API is unreachable, `401` when the admin session is gone.

## 3. Backoffice view

A new **Provisioning** tab in `apps/portal/ui/src/App.jsx`:

- window selector (7 / 30 / 90 days), matching the accounts view's control;
- one row per day: date, total releases, and the reason breakdown as labelled
  chips with counts (never a bare colour — FR-026);
- every cell carries `data-label` so the existing phone-tier table rules stack it
  (feature 008 contract);
- an empty state that says the window has no releases, rather than a blank table.

## 4. Test obligations

`contract/internal-api.test.ts` (extend):

- the route requires the token;
- the projection contains only the schema's fields (assert no keys beyond them);
- `ceiling_reached` never appears;
- `days` is clamped to `1..365` and defaults to 30;
- the portal route is `401` without an admin session and forwards a validated
  payload.
