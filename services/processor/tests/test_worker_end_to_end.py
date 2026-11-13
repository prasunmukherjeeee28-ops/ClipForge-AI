from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import clipforge_processor.worker as worker_module


def test_run_once_completes_claimed_vod_through_private_clip_registration(monkeypatch, tmp_path: Path) -> None:
    user_id, job_id, asset_id = (str(uuid4()) for _ in range(3))
    transcript_path = tmp_path / "transcript.json"
    transcript_path.write_text(json.dumps({
        "segments": [{"start": 10.0, "end": 18.0, "text": "That was an incredible escape!"}]
    }), encoding="utf-8")

    settings = SimpleNamespace(
        api_base_url="https://clipforge.test", shared_secret="x" * 40,
        worker_id="test-worker", http_timeout_seconds=5, scratch_dir=str(tmp_path / "scratch"),
        youtube_data_api_key=None, twitch_client_id=None, twitch_client_secret=None,
        ffprobe_binary="ffprobe", ffmpeg_binary="ffmpeg", ffprobe_timeout_seconds=5,
        ffmpeg_timeout_seconds=30, max_video_duration_seconds=43200,
        max_audio_bytes=1_500_000_000, ffmpeg_threads=1, semantic_api_key=None,
        semantic_model="test-model", semantic_timeout_seconds=5,
    )

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.events: list[str] = []

        async def ping(self):
            self.events.append("ping")
            return {"status": "ok"}

        async def claim(self, worker_id):
            self.events.append("claim")
            return {
                "job": {
                    "id": job_id, "userId": user_id, "sourceAssetId": asset_id,
                    "sourceUrl": "https://youtu.be/abcdefghijk",
                },
                "lease": {"leaseId": "lease-1", "leaseToken": "token-1"},
            }

        async def report_source_metadata(self, *args, **kwargs):
            self.events.append("source_metadata")

        async def report_progress(self, *args, **kwargs):
            self.events.append("progress")

        async def download_source_asset(self, job, lease, token, path, max_bytes):
            self.events.append("source_download")
            Path(path).write_bytes(b"authorized-source")
            return len(b"authorized-source")

        async def report_transcription_ready(self, *args, **kwargs):
            self.events.append("transcription_ready")
            assert kwargs["candidates"]

        async def begin_clip_upload(self, *args, **kwargs):
            self.events.append("clip_upload_begin")
            return {
                "clipUploadId": "clip-upload-1", "partSizeBytes": 5 * 1024 * 1024,
                "partCount": 1, "stored": True,
            }

        async def report_clips_ready(self, job, lease, token, clip_ids):
            self.events.append("clips_ready")
            assert clip_ids == ["clip-upload-1"]
            return {"status": "completed", "clipCount": 1}

        async def close(self):
            self.events.append("close")

    client_holder = {}

    def make_client(*args, **kwargs):
        client_holder["client"] = FakeClient(*args, **kwargs)
        return client_holder["client"]

    async def fake_inspect(*args, **kwargs):
        return SimpleNamespace(
            source_id="abcdefghijk", platform="youtube", source_type="video",
            title="Authorized VOD", duration_seconds=60, published_at=None,
        )

    async def fake_extract(source, output, **kwargs):
        Path(output).write_bytes(b"normalized-audio")
        return len(b"normalized-audio")

    async def fake_transcribe(*args, **kwargs):
        return {
            "path": str(transcript_path), "model": "base", "language": "en",
            "segment_count": 1, "size_bytes": transcript_path.stat().st_size,
            "sha256": "a" * 64,
        }

    def fake_detect(*args, **kwargs):
        return [SimpleNamespace(as_dict=lambda: {
            "startSeconds": 10.0, "endSeconds": 25.0, "score": 0.9,
            "signals": {
                "acousticSalience": 0.8, "transcriptVelocity": 0.7,
                "narrativeArc": 0.6, "novelty": 0.5,
            },
            "wordCount": 6, "markerCount": 1, "rationale": "test reaction",
        })]

    def fake_render(source, transcript, output, **kwargs):
        Path(output).write_bytes(b"rendered-mp4")
        return SimpleNamespace(size_bytes=len(b"rendered-mp4"))

    monkeypatch.setattr(worker_module.Settings, "from_env", lambda: settings)
    monkeypatch.setattr(worker_module, "ProcessorClient", make_client)
    monkeypatch.setattr(worker_module, "inspect_video_url", fake_inspect)
    async def fake_probe(*args, **kwargs):
        return SimpleNamespace(
            container="mov,mp4", video_codec="h264", audio_codec="aac",
            width=1920, height=1080, duration_seconds=60.0,
            source_sample_rate=48000, source_channels=2,
        )

    monkeypatch.setattr(worker_module, "probe_media", fake_probe)
    monkeypatch.setattr(worker_module, "extract_audio", fake_extract)
    monkeypatch.setattr(worker_module, "run_transcription_process", fake_transcribe)
    monkeypatch.setattr(worker_module, "detect_moments", fake_detect)
    monkeypatch.setattr(worker_module, "render_vertical_clip", fake_render)
    monkeypatch.setattr(worker_module, "LocalHeuristicAdapter", lambda: SimpleNamespace(score=lambda evidence: []))

    result = asyncio.run(worker_module.run_once())

    assert result == 0
    events = client_holder["client"].events
    assert events.index("ping") < events.index("claim") < events.index("source_metadata")
    assert events.index("source_download") < events.index("transcription_ready")
    assert events.index("transcription_ready") < events.index("clip_upload_begin") < events.index("clips_ready")
    assert events[-1] == "close"
    assert not (tmp_path / "scratch" / "users" / user_id / job_id).exists()
