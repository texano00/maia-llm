# Contract — Session boot facts and serving endpoint

Additive changes to `packages/contracts/src/sessions.ts`. Existing consumers keep
working because every new field is optional or defaulted.

## 1. `sessionSchema` additions

```ts
const bootPhaseSchema = z.object({
  text: z.string().min(1).max(200),
  percent: z.number().int().min(0).max(100).nullable(),
  /** ISO 8601; the renderer refuses to show a phase older than 60 s as current. */
  observedAt: z.string(),
  source: z.enum(["container", "provider", "app"])
});

const releaseSchema = z.object({
  reason: releaseReasonSchema,
  /** Phase text at release, so history explains a cut-off boot. */
  phase: z.string().max(200).nullable(),
  elapsedMs: z.number().int().nonnegative()
});

// inside sessionSchema
boot: bootPhaseSchema.nullable().default(null),
/** Endpoint facts, present from the moment the host publishes a port. */
endpoint: z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  /** True only after the inference probe answered (FR-001). */
  serving: z.boolean()
}).nullable().default(null),
release: releaseSchema.nullable().default(null),
```

`readyAt` keeps its current meaning and stays the only readiness timestamp.

## 2. `session.endpoint` result

`SessionEndpoint` gains one field; nothing is removed.

```ts
export const sessionEndpointSchema = z.object({
  baseUrl: z.string().min(1),   // http://host:port/v1
  modelId: z.string().min(1),
  apiKey: z.string().min(1),
  /** Echo of the run's serving flag, so a caller cannot race a stale read. */
  serving: z.literal(true)
});
```

The channel returns `null` for a run that is not serving. The renderer never
constructs a base URL from `session.endpoint.*` fields: it renders what the
channel returned, which is what keeps FR-012 (no false endpoint) true.

## 3. `session.history` and `session.list`

Unchanged shape; they simply carry the new fields. A row written before this
feature returns `boot: null`, `endpoint: null`, `release: null` and renders
without the new blocks.

## 4. Backwards compatibility

- All new fields have defaults, so an older renderer ignores them.
- `errorCodeSchema` gains `BOOT_FINISHED` (the run stopped while the wait was in
  flight) so the UI can distinguish it from `NOT_FOUND`.

## 5. Test obligations

`apps/web/tests/contract/session-boot.test.ts`:

- a serving run serialises `endpoint.serving = true` and a parseable `baseUrl`;
- a provisioning run with a published port serialises `serving = false`;
- a legacy row (all three fields absent) still parses;
- `session.endpoint` returns `null` for `provisioning`, `ending`, `ended`,
  `cancelled`, `failed`;
- `release.reason` is present for every terminal state produced by the
  orchestrator.
