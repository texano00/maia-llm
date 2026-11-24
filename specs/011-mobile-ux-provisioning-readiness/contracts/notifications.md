# Contract — Readiness notification, claim-once and withdrawal

Additive changes to `packages/contracts/src/ipc.ts` and
`apps/web/src/main/services/notifications/center.ts`.

## 1. `notificationSchema`

```ts
export const notificationSchema = z.object({
  key: z.string().min(1),                       // run:ready:<sessionId> | run:failed:<sessionId>
  severity: z.enum(["success", "warning", "error"]),   // "success" is new
  message: z.string().min(1),                   // "DeepSeek-Qwen3-27B is ready."
  action: z.object({ label: z.string().min(1), route: z.string().min(1) }).optional(),
  /** NEW: the serving address, for the link and the copy action. */
  endpoint: z.object({
    baseUrl: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
    modelId: z.string().min(1)
  }).optional(),
  /** NEW: where the entry belongs in the product. */
  route: z.string().min(1).optional(),
  createdAt: z.string(),
  dismissible: z.boolean()
});
```

`NotificationSnapshot.indicator` keeps its three values; a snapshot holding only
`success` entries reports `indicator: "none"` (a quiet bell, not a warn), while
the entry is still listed until dismissed or withdrawn.

## 2. Lifecycle

| Event | Effect |
|---|---|
| Run becomes ready | `center.set({ key: "run:ready:<id>", severity: "success", endpoint, route: "/models?run=<id>" })` |
| Run stops serving (ends, fails after being ready, host drops the port) | `center.clear("run:ready:<id>")` — FR-017/FR-038 |
| Attempt exhausted / run fails | `center.set({ key: "run:failed:<id>", severity: "error", route: "/models?run=<id>", dismissible: true })` |
| Person dismisses | existing `notifications.dismiss` (bell only) |

`center.clear` already exists and also forgets the dismissal; it gains no new
behaviour, it is simply called from the new places.

## 3. New channel `notifications.claim`

```ts
// request
{ key: string }
// result
{ shown: boolean; snapshot: NotificationSnapshot }
```

- Adds `key` to `account_settings.announcedNotificationKeys` **once**; answers
  `shown: true` to the first caller only.
- `ToastStack` calls it for every snapshot entry with `severity === "success"`
  or a *new* `error` entry it has not rendered, then shows only the entries that
  came back `shown: true`.
- The claim is per account, so a second tab, a reload or another device sees
  `shown: false` and stays quiet — FR-015.

## 4. Toast behaviour (renderer)

| Rule | Value |
|---|---|
| Position | Desktop: top-right, under the header, 360 px wide. Phone (≤ 640 px): full-width sheet below the header, above the composer. |
| Stack | At most 3; older entries collapse into "+N more" opening the bell. |
| Auto-dismiss | `success` after 8 s, `warning` after 10 s, `error` never (dismiss or act). |
| Never covers | The composer, the primary action, the navigation (FR-018). |
| Motion | 150 ms slide/fade; none under `prefers-reduced-motion`. |
| Accessibility | `role="status"` + `aria-live="polite"` for success; `role="alert"` for error; focus is never moved. |
| Actions | "Open chat" (route), "Copy address" (clipboard with a confirmation), dismiss. |

## 5. Bell parity

`NotificationBell` consumes the same snapshot from the new
`NotificationProvider`, so a readiness entry appears in both surfaces from one
poll (5 s). The bell keeps the existing behaviour of deriving run *failures* from
the session list; the readiness entry is server-derived because it must survive a
closed tab.

## 6. Test obligations

`unit/notification-toast.test.ts` (pure model): stack cap, auto-dismiss timers,
claim gating, ordering (error before success), withdrawal.
`contract/notifications-health.test.ts` (extend): schema accepts `success` with
and without `endpoint`; snapshot `indicator` for success-only entries;
`notifications.claim` is idempotent and answers `shown: false` the second time;
`clear` on run end removes the entry from the snapshot.
