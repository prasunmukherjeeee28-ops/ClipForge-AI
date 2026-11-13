from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class TrackingError(Exception):
    """Raised when subject tracking cannot safely analyze the source."""


@dataclass(frozen=True)
class FaceObservation:
    time_seconds: float
    x: float
    y: float
    width: float
    height: float
    confidence: float = 1.0

    def __post_init__(self) -> None:
        values = (self.time_seconds, self.x, self.y, self.width, self.height, self.confidence)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("face observation values must be finite")
        if self.time_seconds < 0 or self.width <= 0 or self.height <= 0:
            raise ValueError("face observation bounds are invalid")
        if not (0 <= self.x <= 1 and 0 <= self.y <= 1 and self.x + self.width <= 1.000001 and self.y + self.height <= 1.000001):
            raise ValueError("face observation must be normalized to the frame")


@dataclass(frozen=True)
class CameraPoint:
    time_seconds: float
    center_x: float
    center_y: float


def smooth_camera_path(
    observations: list[FaceObservation],
    *,
    frame_width: int,
    frame_height: int,
    clip_start: float,
    clip_end: float,
    crop_width: int,
    crop_height: int,
    smoothing: float = 0.35,
) -> list[CameraPoint]:
    """Create a bounded, smoothed crop-center path from face observations.

    Observations are normalized frame coordinates. Missing samples are not
    invented: callers should use the static full-frame fallback when no faces
    were detected.
    """
    if frame_width < 1 or frame_height < 1 or crop_width < 1 or crop_height < 1:
        raise ValueError("frame and crop dimensions must be positive")
    if not math.isfinite(clip_start) or not math.isfinite(clip_end) or clip_start < 0 or clip_end <= clip_start:
        raise ValueError("clip time range is invalid")
    if not 0 < smoothing <= 1:
        raise ValueError("smoothing must be in (0, 1]")
    max_x = max(0.0, frame_width - crop_width)
    max_y = max(0.0, frame_height - crop_height)
    ordered = sorted(
        (item for item in observations if clip_start <= item.time_seconds <= clip_end),
        key=lambda item: item.time_seconds,
    )
    if not ordered:
        return []

    points: list[CameraPoint] = []
    current_x: float | None = None
    current_y: float | None = None
    for item in ordered:
        target_x = (item.x + item.width / 2) * frame_width - crop_width / 2
        target_y = (item.y + item.height / 2) * frame_height - crop_height / 2
        target_x = min(max(target_x, 0.0), max_x)
        target_y = min(max(target_y, 0.0), max_y)
        if current_x is None:
            current_x, current_y = target_x, target_y
        else:
            current_x += smoothing * (target_x - current_x)
            current_y += smoothing * (target_y - current_y)
        points.append(CameraPoint(
            time_seconds=item.time_seconds - clip_start,
            center_x=round(min(max(current_x, 0.0), max_x), 2),
            center_y=round(min(max(current_y, 0.0), max_y), 2),
        ))
    return points


def detect_faces(
    video_path: Path,
    *,
    start_seconds: float,
    end_seconds: float,
    sample_interval_seconds: float = 0.5,
    max_samples: int = 240,
    min_face_size: int = 36,
) -> tuple[int, int, list[FaceObservation]]:
    """Sample a clip with OpenCV's bundled Haar face detector.

    This intentionally lightweight first detector finds face regions only; it
    does not identify people or infer identity. No face detections means the
    renderer must retain its existing full-frame layout.
    """
    try:
        import cv2
    except ImportError as exc:
        raise TrackingError("OpenCV tracking dependency is unavailable") from exc

    if not video_path.is_file() or video_path.is_symlink():
        raise TrackingError("tracking source is unavailable")
    if not (math.isfinite(start_seconds) and math.isfinite(end_seconds) and 0 <= start_seconds < end_seconds):
        raise TrackingError("tracking time range is invalid")
    if not (0.25 <= sample_interval_seconds <= 5 and 1 <= max_samples <= 1000 and min_face_size >= 16):
        raise TrackingError("tracking resource limits are invalid")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise TrackingError("tracking source could not be opened")
    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if width < 1 or height < 1 or not math.isfinite(fps) or fps <= 0 or frame_count < 1:
            raise TrackingError("tracking source metadata is invalid")
        duration = frame_count / fps
        if end_seconds > duration + 0.25:
            raise TrackingError("tracking range exceeds source duration")

        cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        detector = cv2.CascadeClassifier(str(cascade_path))
        if detector.empty():
            raise TrackingError("bundled face detector could not be loaded")

        interval = max(sample_interval_seconds, (end_seconds - start_seconds) / max_samples)
        observations: list[FaceObservation] = []
        timestamp = start_seconds
        while timestamp < end_seconds and len(observations) < max_samples:
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
            ok, frame = capture.read()
            if not ok or frame is None:
                timestamp += interval
                continue
            scale = min(1.0, 640.0 / max(width, height))
            if scale < 1:
                frame = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))))
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            boxes = detector.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5,
                minSize=(max(16, round(min_face_size * scale)),) * 2,
            )
            if len(boxes):
                # Use the largest face in each sample as the initial speaker/facecam target.
                x, y, box_w, box_h = max(boxes, key=lambda box: int(box[2]) * int(box[3]))
                sample_w, sample_h = gray.shape[1], gray.shape[0]
                observations.append(FaceObservation(
                    time_seconds=timestamp,
                    x=float(x) / sample_w,
                    y=float(y) / sample_h,
                    width=float(box_w) / sample_w,
                    height=float(box_h) / sample_h,
                ))
            timestamp += interval
        return width, height, observations
    finally:
        capture.release()
