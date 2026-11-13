# Provider fixtures

Recorded Hugging Face, vast.ai, S3, and inference responses live here. Contract
tests load them through `loadFixture` and must never call live providers.
