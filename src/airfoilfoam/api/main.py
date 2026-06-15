"""FastAPI application exposing airfoil polar CFD jobs."""
from __future__ import annotations

import io
import uuid

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from .. import __version__, physics
from ..airfoil import load_airfoil
from ..config import get_settings
from ..meshing.base import list_meshers
from ..models import (
    AirfoilInput,
    JobResult,
    JobState,
    JobStatus,
    PolarRequest,
    TurbulenceModel,
)
from ..storage import JobStore


def create_app() -> FastAPI:
    app = FastAPI(
        title="XFoilFOAM",
        version=__version__,
        description="Compute airfoil angle-of-attack polars with 2D RANS CFD in OpenFOAM.",
    )
    settings = get_settings()
    store = JobStore(settings)

    # ------------------------------------------------------------------ #
    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "version": __version__}

    @app.get("/capabilities")
    def capabilities() -> dict:
        return {
            "meshers": list_meshers(),
            "turbulence_models": [m.value for m in TurbulenceModel],
            "openfoam_image": settings.openfoam_image,
            "runner": settings.openfoam_runner,
        }

    @app.post("/airfoils/parse")
    def parse_airfoil(airfoil: AirfoilInput) -> dict:
        try:
            af = load_airfoil(airfoil.name, airfoil.coordinates, airfoil.points, airfoil.format)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not parse airfoil: {exc}")
        upper, lower = af.split_surfaces()
        thickness = float(np.max(np.interp(lower[:, 0], upper[:, 0], upper[:, 1]) - lower[:, 1])) \
            if len(upper) and len(lower) else None
        return {
            "name": af.name,
            "n_points": int(af.contour.shape[0]),
            "leading_edge_index": af.le_index,
            "trailing_edge_gap_original": af.te_gap_original,
            "max_thickness_fraction": thickness,
        }

    @app.post("/polars", response_model=JobStatus, status_code=202)
    def submit_polar(request: PolarRequest) -> JobStatus:
        # validate airfoil up-front so bad geometry fails fast with 422
        try:
            load_airfoil(
                request.airfoil.name, request.airfoil.coordinates,
                request.airfoil.points, request.airfoil.format,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Invalid airfoil: {exc}")

        job_id = uuid.uuid4().hex
        store.create(job_id, request)
        # import here so the API can start even if the broker is unavailable at import time
        from ..tasks import run_polar

        run_polar.delay(job_id, request.model_dump_json())
        status = store.read_status(job_id)
        assert status is not None
        return status

    @app.get("/jobs/{job_id}", response_model=JobStatus)
    def job_status(job_id: str) -> JobStatus:
        status = store.read_status(job_id)
        if status is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return status

    @app.get("/jobs/{job_id}/result", response_model=JobResult)
    def job_result(job_id: str) -> JobResult:
        if not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        result = store.read_result(job_id)
        if result is None:
            status = store.read_status(job_id)
            state = status.state if status else JobState.pending
            raise HTTPException(status_code=409, detail=f"Result not ready (state={state.value})")
        return result

    @app.get("/jobs/{job_id}/polar.csv")
    def job_polar_csv(job_id: str) -> PlainTextResponse:
        result = store.read_result(job_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Result not found")
        buf = io.StringIO()
        buf.write("chord,speed,reynolds,aoa_deg,cl,cd,cm,cl_cd,converged,y_plus_avg,error\n")
        for pol in result.polars:
            for p in pol.points:
                buf.write(
                    f"{pol.chord},{pol.speed},{pol.reynolds:.6g},{p.aoa_deg},"
                    f"{_csv(p.cl)},{_csv(p.cd)},{_csv(p.cm)},{_csv(p.cl_cd)},"
                    f"{p.converged},{_csv(p.y_plus_avg)},{p.error or ''}\n"
                )
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")

    @app.get("/jobs/{job_id}/files/{path:path}")
    def job_file(job_id: str, path: str) -> FileResponse:
        if not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            target = store.file_path(job_id, path)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid path")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(target)

    return app


def _csv(v) -> str:
    return "" if v is None else f"{v:.6g}"


app = create_app()
