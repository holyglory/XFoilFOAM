import json
import sys

from airfoilfoam.api.predictions import ProgressivePolarRequest, calculate_progressive_polar

request = ProgressivePolarRequest.model_validate(json.load(sys.stdin))
json.dump(calculate_progressive_polar(request), sys.stdout, allow_nan=False)
