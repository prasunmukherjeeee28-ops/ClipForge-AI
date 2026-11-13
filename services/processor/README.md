# ClipForge Python Processor

D1-backed single-job processor for private, creator-authorized VOD files. It verifies official YouTube/Twitch metadata, streams the attached private R2 source through a lease-scoped endpoint, validates media, extracts normalized audio, transcribes locally, scores candidate moments, renders up to three 9:16 clips, and stores verified exports in private R2 before completing the job.

## Current capabilities

- Signs processor requests with HMAC-SHA256 and one-time nonces.
- Claims one queued job only when a ready source asset owned by the same account is attached.
- Inspects YouTube and Twitch VOD metadata through official APIs. It does not fetch submitted platform pages or extract playback URLs.
- Streams the attached R2 object only when the job ID, lease ID, lease-token hash, cancellation state, expiry and asset ownership all match.
- Runs FFprobe against the downloaded local file and requires both video and audio streams.
- Enforces a 12-hour duration limit and maximum dimensions of 7680 × 4320.
- Uses FFmpeg to extract mono 16 kHz signed 16-bit PCM WAV audio.
- Stores `audio.wav` and a `media.json` manifest in a private per-user/per-job scratch directory.
- Runs CPU INT8 faster-whisper locally in bounded five-minute chunks, with voice-activity detection, word timestamps, and resumable per-chunk checkpoints.
- Stores `transcript.json` and a verification summary in the same private per-user/per-job scratch directory. Transcript contents are not sent to Cloudflare or a third-party transcription API for transcription.
- Computes one-second RMS loudness and zero-crossing features from the normalized WAV without loading the full audio into memory.
- Scans multi-scale 15–90 second windows using transcript word density, reaction phrases, speech coverage, acoustic changes and within-VOD phrase rarity; overlapping candidates are deduplicated with temporal IoU non-maximum suppression.
- Uses a provider-neutral Pydantic scoring contract. Deterministic local audio/transcript heuristics always run first. When `GEMINI_API_KEY` is explicitly configured, Gemini receives only the top 40 candidate-local transcript excerpts (maximum 1,600 characters each) and numeric features; source video/audio are never uploaded. It classifies likely funny/action/fail/glitch/banter moments, refines ranking, and can suggest a concise clip title. The final score blends 65% semantic score with 35% deterministic score; malformed output, quota errors and provider timeouts fall back to local scoring.
- Persists media, transcript verification metadata and candidate rows in D1 while retaining the active lease for rendering.
- Selects up to three high-scoring, non-overlapping candidates, renders 1080×1920 H.264/AAC clips with timestamped burned-in subtitles, and derives conservative titles from transcript excerpts.
- Uploads each clip to private R2 through lease-scoped multipart endpoints, verifies the stored object size, and registers clip metadata in D1 before marking the job completed.
- Serves clips only through authenticated, owner-scoped API download responses; bucket objects remain private.
- Renews the 90-second lease every 25 seconds and stops work when cancellation or lease loss is detected, including terminating an active FFmpeg render.

The user must upload an original/export or another provider-approved file they have permission to process. A public YouTube or Twitch URL and official metadata do not prove permission to process a media file. The worker does not scrape platform pages, bypass access controls or download video bytes from YouTube/Twitch.

## Requirements

- Python 3.11+
- FFmpeg and FFprobe installed on the processor host and available on PATH, or configured using `FFMPEG_BINARY` and `FFPROBE_BINARY`.
- A deployed Worker with migrations `0001_initial.sql` through `0009_private_clip_storage.sql` applied.
- Cloudflare Access configured for the two intended users.
- Worker secret `PROCESSOR_SHARED_SECRET` set to a random value of at least 32 characters and supplied to the processor environment. Never commit it.
- Persistent, access-restricted volumes mounted at `PROCESSOR_SCRATCH_DIR` and `PROCESSOR_STT_MODEL_CACHE_DIR`. Audio and transcript artifacts remain on the trusted processor host; the model cache avoids downloading weights for every job. The model is downloaded from its model registry on first use, so allow outbound HTTPS during initial setup or pre-populate the cache before running jobs.

## Configuration

Copy `.env.example` into a local, untracked environment file or export the variables in the processor service environment. The code does not automatically read `.env` files.

Required:
- `CLIPFORGE_API_BASE_URL`
- `PROCESSOR_SHARED_SECRET`

Metadata credentials:
- `YOUTUBE_DATA_API_KEY`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

Media-processing options:
- `PROCESSOR_SCRATCH_DIR` (default `/var/lib/clipforge/scratch`)
- `FFPROBE_BINARY` and `FFMPEG_BINARY` (default `ffprobe` and `ffmpeg`)
- `PROCESSOR_FFPROBE_TIMEOUT_SECONDS` (default 30; allowed 1–300)
- `PROCESSOR_FFMPEG_TIMEOUT_SECONDS` (default 3600; allowed 10–14400)
- `PROCESSOR_MAX_VIDEO_DURATION_SECONDS` (default 43200; maximum 43200)
- `PROCESSOR_MAX_AUDIO_BYTES` (default 1500000000; maximum 1500000000)
- `PROCESSOR_FFMPEG_THREADS` (default 2; allowed 1–4)
- `PROCESSOR_STT_MODEL` (default `base`; supports `tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo`, and `distil-large-v3`)
- `PROCESSOR_STT_MODEL_CACHE_DIR` (default `/var/cache/clipforge/models`; keep private and persistent)
- `PROCESSOR_STT_CPU_THREADS` (default 2; allowed 1–8)
- `PROCESSOR_STT_CHUNK_SECONDS` (default 300; allowed 60–900)
- `PROCESSOR_STT_BEAM_SIZE` (default 1; allowed 1–5)
- `PROCESSOR_STT_LANGUAGE` (optional language code; empty means automatic detection)
- `PROCESSOR_STT_CHUNK_TIMEOUT_SECONDS` (default 1800; allowed 60–3600)

The source upload API caps input files at 2 GiB and source storage at 8 GiB per account. The processor caps normalized WAV output at 1.5 GB. Moment analysis currently caps transcript JSON at 100 MB and emits at most 100 shortlisted candidates. FFmpeg is invoked with argument arrays, never through a shell, with a bounded timeout and thread count.

## Local setup

From this directory:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

Run the authenticated health check:

```bash
python -m clipforge_processor.health_check
```

Inspect one supported URL without claiming a job:

```bash
YOUTUBE_DATA_API_KEY=... python -m clipforge_processor.source_probe 'https://youtu.be/VIDEO_ID'
```

For Twitch metadata, set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.

Run one processor cycle:

```bash
python -m clipforge_processor.worker
```

Do not run multiple copies of this one-job worker simultaneously. The worker handles one queued source at a time.

## Source upload and processing flow

1. The user creates a job with one supported YouTube/Twitch URL. It waits in `review` / `awaiting_source_asset`.
2. The user uploads an original/export file they are authorized to process. The Worker creates an owner-scoped private R2 multipart upload with 8 MiB parts.
3. The API verifies every uploaded part and finalizes the R2 object.
4. The user attaches the ready asset to their own job. A source asset can be attached to only one job.
5. The Python processor claims the job under a short-lived D1 lease and verifies official platform metadata.
6. The processor requests the attached source from the signed internal endpoint. The Worker validates the current lease and owner match, then streams the private R2 body directly without buffering the full file in Worker memory.
7. FFprobe validates the actual local file. FFmpeg extracts the first audio stream into mono 16 kHz PCM WAV.
8. The processor writes `audio.wav` and `media.json` under `<scratch>/users/<user-uuid>/<job-uuid>/`, retaining the downloaded source until clip rendering and private R2 upload finish. It then runs local speech recognition in an isolated child process. Five-minute chunks are checkpointed atomically so an expired lease or process restart can resume completed chunks.
9. The processor writes `transcript.json` with absolute segment and word timestamps, language metadata, and a SHA-256 digest. Only transcript verification metadata and scored candidate metadata are sent to D1; audio and transcript text remain on private processor storage. The same active lease continues into rendering and private clip upload; the job is completed only after stored clips are registered.
10. The local moment-analysis module reads the WAV and transcript, calculates lightweight one-second audio features, scores overlapping multi-scale candidate windows, and applies IoU-based NMS. The Worker persists candidate metadata while keeping the same processor lease active.
11. The processor chooses up to three non-overlapping candidates, renders vertical MP4s with synchronized SRT captions, uploads them in 8 MiB multipart chunks to owner-scoped private R2 keys, and verifies each completed object.
12. A final lease-checked callback atomically registers the stored clips in D1 and completes the job. The authenticated `/api/clips` list is owner-scoped; `/api/clips/:clipId/download` streams only the current user's private object.

The source video is deleted from processor scratch only after successful clip registration. Audio and transcript artifacts remain on the private persistent processor volume for now; configure encryption-at-rest, backup and retention at the host/storage layer. Automated intermediate-artifact cleanup and artifact lifecycle management remain follow-up work.

## Request signing

The client signs the exact request body bytes. The canonical message is:

```text
unix_timestamp + newline
lowercase_32_character_nonce + newline
HTTP_METHOD + newline
URL_PATHNAME + newline
exact_raw_body
```

Each request uses a fresh random nonce. The Worker stores only its SHA-256 hash and rejects replayed nonces. Each job claim returns a lease token; only its SHA-256 hash is stored in D1. Never log or persist the raw lease token.

## Next implementation steps

1. Connect the existing dashboard, clip library, job-progress and editor screens to the new owner-scoped clip APIs; add in-app preview and explicit delete/retention controls.
2. Finish connecting the editor to the generated clip media and add non-destructive trim controls that do not imply server-side re-rendering until that API exists.
3. Benchmark the optional Gemini semantic adapter on an annotated GTA VI dataset; compare its classifications and ranking against human labels before relying on it for production.
4. Add render QA (duration, codec, audio presence, subtitle timing and output decode checks) plus retry-safe cleanup for orphaned R2 multipart uploads.
5. Benchmark candidate precision, recall, boundary accuracy and processor throughput on an annotated GTA VI VOD set before tuning scoring weights or adding acoustic models.
6. Move intermediate audio/transcript artifacts to lifecycle-managed private storage and add automated retention/cleanup.
7. Add live-stream processing only after the VOD pipeline is stable.

The code and tests do not prove that a live Cloudflare account, R2 bucket or production processor host is configured correctly. No Cloudflare resources are created or deployed by these changes.


## Vertical clip rendering

The `clipforge_processor.render.render_vertical_clip` function renders an authorized local source segment into a 1080×1920 H.264/AAC MP4. The worker now invokes it under the active job lease and uploads the result to private R2. Landscape footage is contained in the vertical canvas over a blurred background, preserving the full gameplay frame and HUD instead of center-cropping the action. Timestamped transcript segments are clipped to the selected interval and emitted as an SRT subtitle track burned into the output.

Rendering uses an FFmpeg argument array (no shell), private temporary files, a bounded duration, timeout, thread count and output-size limit. The renderer is currently a tested processing primitive; orchestration, R2 upload/registration, and the app's clip review/download workflow are separate integration steps.
