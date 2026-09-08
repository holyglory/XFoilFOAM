from __future__ import annotations

import json
import sys

from .api.predictions import NeuralFoilRequest, calculate_prediction_batch


def main() -> int:
    request = NeuralFoilRequest.model_validate(json.load(sys.stdin))
    json.dump(calculate_prediction_batch(request), sys.stdout, allow_nan=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
