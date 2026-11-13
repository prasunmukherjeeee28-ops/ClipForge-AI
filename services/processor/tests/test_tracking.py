from __future__ import annotations

import pytest

from clipforge_processor.tracking import FaceObservation, smooth_camera_path


def test_camera_path_smooths_face_motion_and_stays_inside_crop() -> None:
    observations = [
        FaceObservation(1.0, 0.10, 0.25, 0.10, 0.20),
        FaceObservation(2.0, 0.80, 0.25, 0.10, 0.20),
    ]
    path = smooth_camera_path(
        observations,
        frame_width=1920,
        frame_height=1080,
        clip_start=1.0,
        clip_end=3.0,
        crop_width=608,
        crop_height=1080,
        smoothing=0.25,
    )
    assert len(path) == 2
    assert path[0].time_seconds == 0
    assert 0 <= path[0].center_x <= 1312
    assert 0 <= path[1].center_x <= 1312
    # EMA smoothing prevents the camera from jumping directly to the second face.
    assert path[1].center_x - path[0].center_x < 500


def test_camera_path_ignores_observations_outside_clip() -> None:
    observations = [
        FaceObservation(0.5, 0.2, 0.2, 0.1, 0.1),
        FaceObservation(5.0, 0.3, 0.2, 0.1, 0.1),
    ]
    path = smooth_camera_path(
        observations,
        frame_width=1280,
        frame_height=720,
        clip_start=1,
        clip_end=4,
        crop_width=405,
        crop_height=720,
    )
    assert path == []


@pytest.mark.parametrize(
    "values",
    [
        (float("nan"), 0.1, 0.1, 0.1, 0.1),
        (1.0, -0.1, 0.1, 0.1, 0.1),
        (1.0, 0.9, 0.1, 0.2, 0.1),
    ],
)
def test_face_observation_rejects_invalid_normalized_boxes(values: tuple[float, ...]) -> None:
    with pytest.raises(ValueError):
        FaceObservation(*values)
