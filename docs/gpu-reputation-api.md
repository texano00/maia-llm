# GPU reputation API

A small shared service that remembers which GPU machines actually work. Every
Maia LLM workspace reads it before renting and reports back after each attempt, so
a host that cannot start a container costs one failure **in total**, not one per
workspace and not a full boot window.

It runs beside the telemetry API (same Fastify app), so one process serves both.
Verdicts and the underlying attempt history are stored in a local SQLite
database; see [data-storage.md](data-storage.md) for the schema, the retention
rules and how to move the service to PostgreSQL or MySQL later.

```bash
npm run -w @maia/telemetry-api dev       # http://localhost:8787
```

| Variable                  | Default             | Purpose                                                      |
| ------------------------- | ------------------- | ------------------------------------------------------------ |
| `MAIA_DATABASE_FILE`      | `./var/maia.sqlite` | Database holding verdicts and telemetry                      |
| `MAIA_UNSTABLE_TTL_HOURS` | `6`                 | How long a failure keeps a machine out of circulation        |
| `MAIA_REPUTATION_FILE`    | unset               | Legacy JSON file: imported once on first boot, then archived |

## Why machine ids, not offer ids

A vast.ai offer is a short-lived ask: about three quarters of offer ids change
within seconds, and none survive a day. `machine_id` identifies the physical host,
which is what actually fails or succeeds. Verdicts are stored per machine.

## Endpoints

All responses are JSON. Times are ISO-8601 strings.

### `GET /v1/gpus`

```json
{
  "gpus": [
    {
      "machineId": 154662,
      "gpuName": "RTX 3090",
      "status": "unstable",
      "successes": 0,
      "failures": 1,
      "lastSuccessAt": null,
      "lastFailureAt": "2026-11-04T17:37:21.000Z",
      "lastError": "failed to inject CDI devices: unresolvable CDI devices D.759…/gpu=1",
      "updatedAt": "2026-11-04T17:37:21.000Z"
    }
  ],
  "serverTime": "2026-11-04T17:47:27.907Z"
}
```

Query: `?status=good|unstable|unknown`, `?limit=1..1000` (default 200).

`status` is computed on read:

| Value      | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| `good`     | Started and served a model at least once             |
| `unstable` | Failed to start, and the verdict is still fresh      |
| `unknown`  | No history, **or** the failure is older than the TTL |

Only `unstable` removes a machine from circulation, so a host that was fixed by its
owner is retried automatically once the verdict lapses. History is kept.

### `GET /v1/gpus/:machineId`

The record, or `404` when nothing is known about that machine.

### `POST /v1/gpus/:machineId/reports`

Records the outcome of one provisioning attempt.

```json
{
  "outcome": "failure",
  "gpuName": "RTX 3090",
  "offerId": 59138348,
  "error": "failed to inject CDI devices…"
}
```

- `success` → `status: "good"`, `failures` reset to 0, `lastSuccessAt` set.
- `failure` → `status: "unstable"`, `failures + 1`, `lastError` stored.

Returns `202` with the stored record. Every attempt is also appended to a
history table, so the raw evidence survives a counter reset.

### `GET /v1/gpus/:machineId/reports`

Provisioning attempts seen for one machine, newest first (`?limit=1..1000`,
default 50). Useful when deciding whether a host deserves a second chance, and as
the raw material for tuning the unstable-verdict policy.

```json
{
  "machineId": 154662,
  "reports": [
    {
      "id": 12,
      "machineId": 154662,
      "outcome": "failure",
      "gpuName": "RTX 3090",
      "offerId": 59138348,
      "error": "failed to inject CDI devices: unresolvable CDI devices",
      "reportedAt": "2026-11-04T17:37:21.000Z"
    }
  ],
  "serverTime": "2026-11-04T17:47:27.907Z"
}
```

### `PUT /v1/gpus/:machineId`

Manual override, for example to clear a machine flagged by mistake.

```json
{ "gpuName": "L40S", "status": "good", "note": "verified by hand" }
```

### `DELETE /v1/gpus/:machineId`

Forgets a machine, including its attempt history. `204` when removed, `404` when
it was unknown.

```bash
# flag a host by hand
curl -X PUT http://localhost:8787/v1/gpus/154662 \
  -H 'content-type: application/json' \
  -d '{"gpuName":"RTX 3090","status":"unstable","note":"owner is fixing the driver"}'

# clear it
curl -X DELETE http://localhost:8787/v1/gpus/154662
```

## How the app uses it

1. `findOffer` fetches a snapshot (cached 60 s) and ranks candidates:
   known-good machines first, then unknown ones, then price. Machines marked
   `unstable` are skipped entirely.
2. Provisioning outcome is reported: `success` once vLLM serves `/v1/models`, or
   `failure` when vast.ai reports a container that cannot start (for example
   `failed to inject CDI devices`, `OCI runtime create failed`).
3. On such a failure the session immediately releases that machine, marks it
   unstable, books the next best GPU and continues booting — at most three
   machines per session.

The client is fail-open: if the service is unreachable, renting proceeds with no
history and the report is logged and dropped. Nothing about booking depends on it.

## Error patterns treated as "this machine is broken"

Detected in vast.ai's `status_msg` before the readiness timeout would fire:

```
failed to start containers
failed to create task / shim
OCI runtime create failed
unresolvable CDI devices
Error response from daemon
```

These are host-level faults: retrying the same machine cannot help, but another
machine usually works.
