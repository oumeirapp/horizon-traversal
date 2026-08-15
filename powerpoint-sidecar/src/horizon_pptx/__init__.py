"""Manifest-driven, template-safe PowerPoint generation for Horizon Traversal."""

from .builder import build_presentation
from .manifest import load_manifest

__all__ = ["build_presentation", "load_manifest"]
__version__ = "0.1.0"

