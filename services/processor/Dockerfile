FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PROCESSOR_SCRATCH_DIR=/var/lib/clipforge/scratch \
    PROCESSOR_STT_MODEL_CACHE_DIR=/var/cache/clipforge/models

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/clipforge
COPY services/processor/pyproject.toml ./pyproject.toml
COPY services/processor/src ./src
RUN python -m pip install --no-cache-dir . \
    && mkdir -p /var/lib/clipforge/scratch /var/cache/clipforge/models \
    && chown -R 10001:10001 /opt/clipforge /var/lib/clipforge /var/cache/clipforge

USER 10001:10001

ENTRYPOINT ["python", "-m", "clipforge_processor.worker"]
