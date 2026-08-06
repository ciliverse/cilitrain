import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def _disable_auth_for_unit_tests(monkeypatch):
    """Job-builder / harvest unit tests do not need HTTP auth."""
    monkeypatch.setattr(settings, "auth_disabled", True)
