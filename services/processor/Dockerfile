FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PROCESSOR_SCRATCH_DIR=/var/lib/clipforge/scratch \
    PROCESSOR_STT_MODEL_CACHE_DIR=/var/cache/clipforge/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system clipforge \
    && useradd --system --gid clipforge --home-dir /home/clipforge --create-home clipforge \
    && install -d -o clipforge -g clipforge -m 0700 /var/lib/clipforge/scratch /var/cache/clipforge/models

WORKDIR /opt/clipforge/processor

COPY pyproject.toml ./
COPY src ./src

RUN python -m pip install --upgrade pip \
    && python -m pip install .

USER clipforge:clipforge

VOLUME ["/var/lib/clipforge/scratch", "/var/cache/clipforge/models"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["python", "-m", "clipforge_processor.worker"]
