import json
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

from airfoilfoam.api.main import _require_control_plane_bearer
from airfoilfoam.api.predictions import prediction_router


def main() -> None:
    app = FastAPI()
    app.include_router(prediction_router("isolated-prediction-fixture", _require_control_plane_bearer))
    with TestClient(app) as client:
        response = client.post("/predictions/neuralfoil", json=json.load(sys.stdin),
                               headers={"Authorization": "Bearer isolated-prediction-fixture"})
    if response.status_code != 200:
        raise RuntimeError(response.text)
    print(json.dumps(response.json(), allow_nan=False))


if __name__ == "__main__":
    main()
