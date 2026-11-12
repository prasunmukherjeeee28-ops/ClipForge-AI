# ClipForge Python Processor

Initial connectivity scaffold for the D1-backed polling architecture. This is not yet a video processor.

## What it does now
- Signs machine requests with HMAC-SHA256.
- Checks the public Worker health endpoint.
- Authenticates against the internal processor ping endpoint.
- Claims one queued D1 job and receives a short-lived lease.
- Sends a heartbeat and a test progress update.
- Releases the job back to queued (or acknowledges cancellation) without fetching the source URL.

It intentionally does not download source media, run FFmpeg, transcribe audio, call an AI provider, or upload clips.

## Requirements
- Python 3.11+
- A deployed Worker with migration `0002_processor_leases.sql` applied.
- Cloudflare Access configured for the two intended users.
- Worker secret `PROCESSOR_SHARED_SECRET` set to a random value of at least 32 characters.
- The same secret supplied to this process through its environment. Never put it in Git.

## Local setup
From this directory:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

Set `CLIPFORGE_API_BASE_URL` and `PROCESSOR_SHARED_SECRET` in your shell environment (or load them from a local, untracked .env file). The code does not automatically read .env files.

Run the authenticated health check:

```bash
python -m clipforge_processor.health_check
```

Run one safe mock claim/heartbeat/release cycle:

```bash
python -m clipforge_processor.worker
```

The mock worker releases the claimed job so it remains queued. Do not run multiple copies of this smoke-test worker simultaneously.

Run unit tests:

```bash
pytest
```

## Request signing
The client signs the exact bytes sent in the HTTP body. The canonical message is:

```text
unix_timestamp + newline
HTTP_METHOD + newline
URL_PATHNAME + newline
exact_raw_body
```

The Worker checks the timestamp (±300 seconds) and verifies the HMAC. Each claim also returns a per-job lease token. Only its SHA-256 hash is stored in D1. Never log or persist the raw lease token.

## Next implementation steps
1. Turn the smoke-test into a supervised single-job worker loop with periodic heartbeats and graceful shutdown.
2. Add a real pipeline behind an authorized-source adapter; repeat URL, redirect, DNS and IP validation before network access.
3. Add bounded scratch storage, ffprobe, audio extraction and CPU-gated transcription.
4. Add candidate generation, provider-independent AI scoring and deterministic clip IDs.
5. Add FFmpeg rendering, private R2 upload and idempotent clip registration.
6. Add integration tests for lease races, expired lease recovery, cancellation, and per-user isolation.

Do not deploy paid infrastructure or add platform download behavior without confirming source permissions and applicable platform rules.
