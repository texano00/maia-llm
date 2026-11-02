# Desktop integration tests

Integration tests exercise real SQLite, local HTTP endpoints, and provider
adapters against local doubles such as MinIO. They must not rent GPUs or call
billable providers.
