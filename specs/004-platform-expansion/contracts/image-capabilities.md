# Contract: Image and multimodal capabilities

**Feature**: `004-platform-expansion` | **Version**: 1.0

## Capability enum

`capability` extends the session contract with `text-to-image`, `image-to-text` and `image-to-image`; `text` remains the default so existing records and callers keep working.

## Catalogue

| Property | Contract |
|---|---|
| Exposure | The capability is exposed on catalogue entries next to the existing text capability data and is rendered wherever capabilities are rendered today. |
| Filtering | The existing "only models I can run" logic treats image capabilities like text: a model is runnable only if a supported engine can serve it. |
| Gating | Gated model handling is unchanged. |

## Pre-flight refusal

| Case | Result |
|---|---|
| Model cannot serve the requested capability | The run request is refused **before** any offer is booked, with `CAPABILITY_UNSUPPORTED` and a message naming the model and the requested capability. |
| Model serves the capability but the chosen runtime lacks support | Refused at the same gate with the same code; the message names the runtime. |
| Model is an embedding/reranking model | Existing refusal path unchanged. |

## Chat contract

### Input attachments (`chat.send`)

```ts
interface ImageAttachmentRef {
  imageId: string;   // id in conversation_images
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;     // > 0
  height: number;    // > 0
}
```

| Property | Contract |
|---|---|
| Request | `chat.send` accepts `attachments?: ImageAttachmentRef[]` (max 4). |
| Response/stream | Unchanged chunk schema; image output arrives as a completed message with `attachments` referencing stored images. |
| Validation | Unknown mime types, non-positive dimensions and unknown ids are rejected with `VALIDATION_FAILED` before the model is called. |
| Capability check | Text-only models reject attachments with `CAPABILITY_UNSUPPORTED`; image-to-text/image-to-image require at least one attachment. |

## Storage

| Property | Contract |
|---|---|
| Location | `userData/images/<conversationId>/<imageId>.<ext>`; only the relative path is stored in `conversation_images`. |
| Rendering | Renderer resolves images through a dedicated bridge URL scheme; absolute paths never reach the renderer as text. |
| Growth | Attachments are capped at 4 per message and 20 MB per image. |
| Deletion | Deleting a conversation deletes its directory. |
| Export | Existing conversation export includes image references and copies the files; no new export format is introduced unless the plan's export step requires it. |

## Cost and lifecycle

- Image runs use the existing estimate, confirmation, live cost meter and teardown flow unchanged.
- The same readiness, idle timeout and failure classifier apply; `session_metrics` records the outcome for both text and image runs.
- Only `active` runs accept new chat messages, for every capability.

## Telemetry

When usage reporting is enabled, an image run contributes a sample with the same allowlisted fields as a text run. No image bytes, prompt text, dimensions or file paths are included; `capability` records the image mode.

## Privacy

- Images never leave the device unless the user explicitly exports them.
- The renderer never receives provider URLs or credentials for image generation.
- Conversation content that includes images is covered by the existing local-first guarantees.
