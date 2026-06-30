"""Cooperative cancellation shared by API, worker, and solver pipeline."""
from __future__ import annotations


class JobCancelled(RuntimeError):
    """Raised when a user/admin cancellation marker is observed."""

