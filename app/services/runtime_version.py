"""Snapshot backend source identity at process startup, not at health-request time."""
import hashlib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def source_version():
    digest = hashlib.sha256()
    for path in sorted((PROJECT_ROOT / 'app').rglob('*.py')):
        digest.update(path.relative_to(PROJECT_ROOT).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


RUNTIME_VERSION = source_version()
