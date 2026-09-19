# CLIProxy client-key attribution

CLIProxy's usage queue supplies the inbound client credential in `api_key`.
The compatibility transformer hashes it with SHA-256 at ingestion and retains
only `client_key_id`. Normalized history persists this as `clientKeyId`.
This is distinct from `accountId`, which identifies the upstream OAuth account.
Request merging includes the client fingerprint so otherwise identical requests
from separate keys are not collapsed.

The fingerprint supports grouping request counts, token counts, and estimated
costs from persisted history. Operators can map the SHA-256 digest of their own
high-entropy client keys to owner labels privately; raw keys must never be put
in analytics, screenshots, issues, or log output. Fingerprints are pseudonymous,
not anonymous, and hashing does not protect weak keys against guessing.

Old records without a client fingerprint remain unattributed. Key rotation
produces a new fingerprint; this patch does not infer a shared owner. It also
does not add a dashboard grouping control, change token/cost semantics, or
change the existing treatment of failed requests with no reported usage.

This change does not solve collector durability: `/usage-queue` consumes records,
the upstream queue has bounded retention, and competing consumers can split the
stream. Do not deploy an additional queue consumer to generate reports beside
CCS. The `/api-key-usage` management endpoint concerns upstream provider API-key
auths and is not a substitute for inbound client attribution.
