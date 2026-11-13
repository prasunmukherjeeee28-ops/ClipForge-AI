from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


# COCO label indices used by common YOLOv5 ONNX exports.
COCO_LABELS = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
)
TRACKABLE_CLASSES = frozenset({0, 1, 2, 3, 5, 6, 7, 8})


class VisualAnalysisError(Exception):
    """Raised when video sampling or optional object detection cannot proceed."""


@dataclass(frozen=True)
class ObjectDetection:
    time_seconds: float
    class_id: int
    class_name: str
    confidence: float
    x: float
    y: float
    width: float
    height: float

    def __post_init__(self) -> None:
        values = (self.time_seconds, self.confidence, self.x, self.y, self.width, self.height)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("object detection values must be finite")
        if self.time_seconds < 0 or self.class_id < 0 or not self.class_name:
            raise ValueError("object detection identity is invalid")
        if not 0 <= self.confidence <= 1 or self.width <= 0 or self.height <= 0:
            raise ValueError("object detection confidence or size is invalid")
        if not (
            0 <= self.x <= 1 and 0 <= self.y <= 1
            and self.x + self.width <= 1.000001
            and self.y + self.height <= 1.000001
        ):
            raise ValueError("object detection box must be normalized to the frame")


@dataclass(frozen=True)
class TrackedObject:
    track_id: int
    detection: ObjectDetection


@dataclass(frozen=True)
class VisualEvidence:
    motion_salience: float
    scene_change_salience: float
    object_presence: float
    object_transition: float
    visual_salience: float
    detected_object_count: int
    object_classes: tuple[str, ...]
    focus_observations: tuple[ObjectDetection, ...] = ()


class ObjectDetector(Protocol):
    def detect(self, frame: object, time_seconds: float) -> list[ObjectDetection]:
        """Return normalized detections for the supplied video frame."""


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def _box_iou(left: ObjectDetection, right: ObjectDetection) -> float:
    x1 = max(left.x, right.x)
    y1 = max(left.y, right.y)
    x2 = min(left.x + left.width, right.x + right.width)
    y2 = min(left.y + left.height, right.y + right.height)
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = left.width * left.height + right.width * right.height - intersection
    return intersection / union if union > 0 else 0.0


def track_objects(
    detections: list[ObjectDetection],
    *,
    max_gap_seconds: float = 2.5,
    minimum_iou: float = 0.08,
    maximum_center_distance: float = 0.16,
) -> list[TrackedObject]:
    """Associate same-class detections over time using bounded greedy IoU matching."""
    if not (0.25 <= max_gap_seconds <= 10 and 0 < minimum_iou <= 1 and 0 < maximum_center_distance <= 1):
        raise ValueError("object tracking limits are invalid")
    if len(detections) > 20_000:
        raise ValueError("object detection count exceeds the tracking limit")
    ordered = sorted(detections, key=lambda item: (item.time_seconds, -item.confidence))
    active: dict[int, ObjectDetection] = {}
    next_track_id = 1
    output: list[TrackedObject] = []

    for detection in ordered:
        expired = [
            track_id for track_id, previous in active.items()
            if detection.time_seconds - previous.time_seconds > max_gap_seconds
        ]
        for track_id in expired:
            del active[track_id]

        best_id: int | None = None
        best_score = -1.0
        for track_id, previous in active.items():
            if previous.class_id != detection.class_id or previous.time_seconds >= detection.time_seconds:
                continue
            overlap = _box_iou(previous, detection)
            left_center = previous.x + previous.width / 2
            top_center = previous.y + previous.height / 2
            right_center = detection.x + detection.width / 2
            bottom_center = detection.y + detection.height / 2
            distance = math.hypot(left_center - right_center, top_center - bottom_center)
            if overlap < minimum_iou and distance > maximum_center_distance:
                continue
            score = max(overlap, 1.0 - distance / maximum_center_distance)
            if score > best_score:
                best_id, best_score = track_id, score

        if best_id is None:
            best_id = next_track_id
            next_track_id += 1
        active[best_id] = detection
        output.append(TrackedObject(best_id, detection))
    return output


class OpenCVDNNYoloV5Detector:
    """CPU-only detector for a locally supplied YOLOv5-compatible COCO ONNX model.

    The model is deliberately not downloaded automatically or stored in Git.
    Provide a model file through the processor's private configuration.
    """

    def __init__(
        self,
        model_path: Path,
        *,
        confidence_threshold: float = 0.35,
        nms_threshold: float = 0.45,
    ) -> None:
        try:
            import cv2
        except ImportError as exc:
            raise VisualAnalysisError("OpenCV object detection support is unavailable") from exc
        model_path = Path(model_path)
        if (
            model_path.is_symlink() or not model_path.is_file()
            or model_path.suffix.lower() != ".onnx"
            or model_path.stat().st_size < 1024
            or model_path.stat().st_size > 150_000_000
        ):
            raise VisualAnalysisError("object detection model file is missing or outside size limits")
        if not (0.1 <= confidence_threshold <= 0.95 and 0.1 <= nms_threshold <= 0.95):
            raise ValueError("object detector thresholds are invalid")
        try:
            network = cv2.dnn.readNetFromONNX(str(model_path))
            network.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            network.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
            self.model = cv2.dnn_DetectionModel(network)
            self.model.setInputParams(size=(640, 640), scale=1 / 255.0, swapRB=True)
        except cv2.error as exc:
            raise VisualAnalysisError("object detection ONNX model could not be loaded") from exc
        self.confidence_threshold = confidence_threshold
        self.nms_threshold = nms_threshold

    def detect(self, frame: object, time_seconds: float) -> list[ObjectDetection]:
        import cv2

        height, width = frame.shape[:2]
        try:
            class_ids, confidences, boxes = self.model.detect(
                frame,
                confThreshold=self.confidence_threshold,
                nmsThreshold=self.nms_threshold,
            )
        except cv2.error as exc:
            raise VisualAnalysisError("object detection inference failed") from exc
        if class_ids is None or confidences is None or boxes is None:
            return []
        output: list[ObjectDetection] = []
        for class_id, confidence, box in zip(class_ids, confidences, boxes, strict=False):
            index = int(class_id[0] if hasattr(class_id, "__len__") else class_id)
            if index not in TRACKABLE_CLASSES or index >= len(COCO_LABELS):
                continue
            score = float(confidence[0] if hasattr(confidence, "__len__") else confidence)
            x, y, box_width, box_height = (int(value) for value in box)
            left = max(0, min(width, x))
            top = max(0, min(height, y))
            right = max(left, min(width, x + box_width))
            bottom = max(top, min(height, y + box_height))
            if right <= left or bottom <= top or not math.isfinite(score):
                continue
            output.append(ObjectDetection(
                time_seconds=time_seconds,
                class_id=index,
                class_name=COCO_LABELS[index],
                confidence=_clamp(score),
                x=left / width,
                y=top / height,
                width=(right - left) / width,
                height=(bottom - top) / height,
            ))
        return output


def _focus_track(tracks: list[TrackedObject]) -> tuple[ObjectDetection, ...]:
    grouped: dict[int, list[ObjectDetection]] = {}
    for item in tracks:
        grouped.setdefault(item.track_id, []).append(item.detection)
    if not grouped:
        return ()
    class_weight = {"person": 1.2, "car": 1.0, "motorcycle": 1.0, "truck": 0.9, "bus": 0.9}
    ranked: list[tuple[float, list[ObjectDetection]]] = []
    for observations in grouped.values():
        average_area = sum(item.width * item.height for item in observations) / len(observations)
        average_confidence = sum(item.confidence for item in observations) / len(observations)
        weight = class_weight.get(observations[0].class_name, 0.8)
        score = len(observations) * average_confidence * math.sqrt(max(average_area, 0.0001)) * weight
        ranked.append((score, observations))
    return tuple(max(ranked, key=lambda item: item[0])[1])


def analyze_candidate_windows(
    video_path: Path,
    candidates: list[tuple[float, float, float]],
    *,
    model_path: str | None = None,
    max_windows: int = 16,
    max_samples: int = 320,
) -> dict[tuple[float, float], VisualEvidence]:
    """Sample only top audio/transcript candidates to bound video-analysis cost."""
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise VisualAnalysisError("OpenCV visual analysis dependency is unavailable") from exc
    if video_path.is_symlink() or not video_path.is_file():
        raise VisualAnalysisError("visual analysis source is unavailable")
    if not (1 <= max_windows <= 40 and 2 <= max_samples <= 1000):
        raise ValueError("visual sampling limits are invalid")

    detector: ObjectDetector | None = None
    if model_path:
        detector = OpenCVDNNYoloV5Detector(Path(model_path))

    ranked = sorted(
        (
            (float(start), float(end), float(score))
            for start, end, score in candidates
            if math.isfinite(float(start)) and math.isfinite(float(end))
            and math.isfinite(float(score)) and start >= 0 and end > start
        ),
        key=lambda item: (-item[2], item[0]),
    )[:max_windows]
    if not ranked:
        return {}
    samples_per_window = max(2, min(24, max_samples // len(ranked)))
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise VisualAnalysisError("visual analysis source could not be opened")
    output: dict[tuple[float, float], VisualEvidence] = {}
    try:
        for start, end, _score in ranked:
            previous_gray = None
            previous_histogram = None
            motion_scores: list[float] = []
            scene_scores: list[float] = []
            detections: list[ObjectDetection] = []
            object_counts: list[int] = []
            for index in range(samples_per_window):
                timestamp = start + (index + 0.5) * (end - start) / samples_per_window
                capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = capture.read()
                if not ok or frame is None:
                    continue
                height, width = frame.shape[:2]
                scale = min(1.0, 640.0 / max(width, height))
                if scale < 1:
                    frame = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))))
                small = cv2.resize(frame, (320, 180))
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                histogram = cv2.calcHist([small], [0, 1], None, [16, 16], [0, 180, 0, 256])
                cv2.normalize(histogram, histogram, 0, 1, cv2.NORM_MINMAX)
                if previous_gray is not None:
                    difference = float(np.mean(cv2.absdiff(previous_gray, gray))) / 255.0
                    motion_scores.append(_clamp(difference / 0.08))
                if previous_histogram is not None:
                    distance = float(cv2.compareHist(previous_histogram, histogram, cv2.HISTCMP_BHATTACHARYYA))
                    scene_scores.append(_clamp(distance / 0.6))
                previous_gray = gray
                previous_histogram = histogram
                if detector is not None:
                    detections.extend(detector.detect(frame, timestamp))
                    object_counts.append(sum(1 for item in detections if abs(item.time_seconds - timestamp) < 0.001))

            tracks = track_objects(detections)
            focus = _focus_track(tracks)
            motion = max(motion_scores, default=0.0) * 0.7 + (
                sum(motion_scores) / len(motion_scores) * 0.3 if motion_scores else 0.0
            )
            scene = max(scene_scores, default=0.0)
            object_presence = _clamp(len(tracks) / max(2.0, samples_per_window * 0.5))
            transitions = [
                abs(right - left) for left, right in zip(object_counts, object_counts[1:])
            ]
            object_transition = _clamp(
                (sum(transitions) / len(transitions) if transitions else 0.0) / 2.0
            )
            visual_score = (
                0.45 * motion + 0.25 * scene
                + 0.20 * object_presence + 0.10 * object_transition
            )
            output[(round(start, 3), round(end, 3))] = VisualEvidence(
                motion_salience=_clamp(motion),
                scene_change_salience=_clamp(scene),
                object_presence=_clamp(object_presence),
                object_transition=_clamp(object_transition),
                visual_salience=_clamp(visual_score),
                detected_object_count=len(tracks),
                object_classes=tuple(sorted({item.detection.class_name for item in tracks})),
                focus_observations=focus,
            )
    except (cv2.error, ValueError) as exc:
        raise VisualAnalysisError("video visual analysis failed") from exc
    finally:
        capture.release()
    return output
