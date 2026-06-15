"""Celery application factory."""
from __future__ import annotations

from celery import Celery

from .config import get_settings


def make_celery() -> Celery:
    settings = get_settings()
    app = Celery("airfoilfoam", broker=settings.broker_url, backend=settings.result_backend)
    app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        task_track_started=True,
        worker_prefetch_multiplier=1,
        task_acks_late=True,
    )
    app.autodiscover_tasks(["airfoilfoam"])
    return app


celery_app = make_celery()

# Ensure tasks are registered when the worker imports this module.
from . import tasks  # noqa: E402,F401
