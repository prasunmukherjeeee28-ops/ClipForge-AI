from __future__ import annotations

import pytest

from clipforge_processor.visual_analysis import (
    ObjectDetection,
    _focus_track,
    track_objects,
)


def detection(
    second: float,
    *,
    class_id: int = 2,
    class_name: str = "car",
    x: float = 0.2,
    y: float = 0.3,
    width: float = 0.25,
    height: float = 0.2,
    confidence: float = 0.9,
) -> ObjectDetection:
    return ObjectDetection(
        time_seconds=second,
        class_id=class_id,
        class_name=class_name,
        confidence=confidence,
        x=x,
        y=y,
        width=width,
        height=height,
    )


def test_tracker_associates_same_object_across_nearby_frames() -> None:
    output = track_objects([
        detection(1.0, x=0.20),
        detection(1.0, class_id=0, class_name="person", x=0.65, width=0.1, height=0.2),
        detection(2.0, x=0.22),
        detection(2.0, class_id=0, class_name="person", x=0.64, width=0.1, height=0.2),
        detection(3.0, x=0.24),
    ])
    car_ids = {item.track_id for item in output if item.detection.class_name == "car"}
    person_ids = {item.track_id for item in output if item.detection.class_name == "person"}
    assert len(car_ids) == 1
    assert len(person_ids) == 1
    assert car_ids.isdisjoint(person_ids)


def test_tracker_expires_old_tracks_after_configured_gap() -> None:
    output = track_objects([
        detection(1.0),
        detection(8.0),
    ])
    assert output[0].track_id != output[1].track_id


def test_focus_track_prefers_persistent_confident_subject() -> None:
    tracks = track_objects([
        detection(1.0, x=0.2, width=0.12, height=0.12),
        detection(2.0, x=0.21, width=0.12, height=0.12),
        detection(3.0, x=0.22, width=0.12, height=0.12),
        detection(1.0, class_id=0, class_name="person", x=0.7, width=0.2, height=0.25),
    ])
    focus = _focus_track(tracks)
    assert len(focus) == 3
    assert all(item.class_name == "car" for item in focus)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"x": -0.1},
        {"y": 0.9, "height": 0.2},
        {"confidence": 1.2},
    ],
)
def test_object_detection_rejects_invalid_boxes(kwargs: dict[str, float]) -> None:
    with pytest.raises(ValueError):
        detection(1.0, **kwargs)


def test_candidate_visual_sampler_extracts_motion_and_source_dimensions(tmp_path) -> None:
    import cv2
    import numpy as np

    from clipforge_processor.visual_analysis import analyze_candidate_windows

    video = tmp_path / "moving-scene.avi"
    writer = cv2.VideoWriter(
        str(video), cv2.VideoWriter_fourcc(*"MJPG"), 4.0, (320, 180)
    )
    if not writer.isOpened():
        pytest.skip("OpenCV MJPG writer is unavailable in this environment")
    try:
        for index in range(24):
            frame = np.zeros((180, 320, 3), dtype=np.uint8)
            frame[:, :] = (20, 35, 55)
            left = 10 + (index * 9) % 250
            cv2.rectangle(frame, (left, 55), (left + 45, 115), (240, 220, 30), -1)
            writer.write(frame)
    finally:
        writer.release()

    evidence = analyze_candidate_windows(
        video, [(1.0, 5.5, 0.9)], model_path=None, max_windows=1, max_samples=16
    )[(1.0, 5.5)]

    assert evidence.frame_width == 320
    assert evidence.frame_height == 180
    assert evidence.motion_salience > 0
    assert evidence.visual_salience > 0
    assert evidence.object_classes == ()
