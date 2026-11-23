ARG GATEWAY_BASE
FROM ${GATEWAY_BASE}
WORKDIR /app
COPY main.py src/airfoilfoam/api/main.py
COPY historical_raw_restore.py src/airfoilfoam/historical_raw_restore.py
RUN rm -rf /app/build \
    && PYTHONPATH=src python -c "from pathlib import Path; from airfoilfoam.provenance import write_application_source_sha256; write_application_source_sha256(Path('/app'))" \
    && python -m pip install --no-cache-dir --no-index --no-deps --no-build-isolation --force-reinstall . \
    && python -m pip check
