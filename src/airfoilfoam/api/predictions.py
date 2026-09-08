from __future__ import annotations

import hashlib
import json
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from ..neuralfoil_solver import BaselineCondition, BaselineRecipe, solve_baseline
from ..postprocess.polar_history import HistoryReductionPolicy, PolarHistory, history_observations
from ..postprocess.progressive_polar import PolarModelPolicy, PolarObservation, PolarPrior, fit_progressive_polar


class NeuralFoilRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    epoch_id: UUID
    lease_token: UUID
    coordinates: list[tuple[float, float]] = Field(min_length=8, max_length=4096)
    geometry_provenance: dict
    conditions: list[BaselineCondition] = Field(min_length=1, max_length=64)
    recipe: BaselineRecipe


class ProgressivePolarRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    epoch_id: UUID
    lease_token: UUID
    prior: PolarPrior
    observations: list[PolarObservation] = Field(default_factory=list, max_length=512)
    histories: list[PolarHistory] = Field(default_factory=list, max_length=64)
    history_policy: HistoryReductionPolicy | None = None
    policy: PolarModelPolicy


def calculate_progressive_polar(request: ProgressivePolarRequest) -> dict:
    if max(len(request.prior.alpha), len(request.prior.coefficients), len(request.prior.standard_deviation)) > 1024:
        raise ValueError("Progressive polar exceeds the bounded prediction grid")
    if sum(max(len(history.coordinate), len(history.coefficients)) for history in request.histories) > 32768:
        raise ValueError("Progressive polar exceeds the bounded history sample budget")
    if request.histories and request.history_policy is None:
        raise ValueError("Joint histories require an explicit reduction policy")
    observations = list(request.observations)
    if sum(observation.eligible for observation in observations) > 128:
        raise ValueError("Progressive polar exceeds the bounded observation budget")
    for history in request.histories:
        observations.extend(history_observations(history, request.history_policy))
        if sum(observation.eligible for observation in observations) > 128 or len(observations) > 640:
            raise ValueError("Joint history reduction exceeds the bounded observation budget")
    estimate = fit_progressive_polar(request.prior, observations, request.policy)
    payload = request.model_dump(mode="json", exclude={"epoch_id", "lease_token"})
    signature = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(),
    ).hexdigest()
    return {"epoch_id": str(request.epoch_id), "lease_token": str(request.lease_token),
            "request_signature": signature, "estimate": estimate}


def calculate_prediction_batch(request: NeuralFoilRequest) -> dict:
    if sum(len(condition.alpha) for condition in request.conditions) > 32768:
        raise ValueError("Prediction batch exceeds the bounded angle budget")
    predictions = solve_baseline(
        request.coordinates, request.geometry_provenance, request.conditions, request.recipe,
    )
    return {"epoch_id": str(request.epoch_id), "lease_token": str(request.lease_token),
            "predictions": predictions}


def prediction_router(control_plane_token: str | None, require_bearer) -> APIRouter:
    router = APIRouter()

    @router.post("/predictions/neuralfoil")
    def neuralfoil(request: NeuralFoilRequest, authorization: str | None = Header(default=None)) -> dict:
        require_bearer(control_plane_token, authorization)
        try:
            return calculate_prediction_batch(request)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/predictions/progressive-polar")
    def progressive_polar(request: ProgressivePolarRequest, authorization: str | None = Header(default=None)) -> dict:
        require_bearer(control_plane_token, authorization)
        try:
            return calculate_progressive_polar(request)
        except (ValueError, FloatingPointError, OverflowError, np.linalg.LinAlgError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    return router
