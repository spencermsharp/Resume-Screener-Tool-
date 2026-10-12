"""Central configuration — the single source of truth for server settings.

All environment-driven config is read HERE and nowhere else, so there is exactly
one place to look when wiring up dev vs. production.

Secrets (like the Anthropic API key) are read from the environment:
  - Development: a git-ignored .env file at the project root (loaded below).
  - Production:  real environment variables set in your host's dashboard
                 (Vercel/Render/Fly/AWS/etc.). No code change required.

The key is NEVER hardcoded and NEVER sent to the browser.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Project root = one level up from this server/ package.
ROOT = Path(__file__).resolve().parent.parent

# Load .env for local development. In production the platform injects real env
# vars, and load_dotenv is a harmless no-op when no .env file is present.
load_dotenv(ROOT / ".env")


class Config:
    """Typed accessors for everything the server needs from the environment."""

    # ── Anthropic ────────────────────────────────────────────────────────────
    ANTHROPIC_API_KEY: Optional[str] = os.environ.get("ANTHROPIC_API_KEY")
    ANTHROPIC_MODEL: str = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")
    ANTHROPIC_URL: str = "https://api.anthropic.com/v1/messages"
    ANTHROPIC_VERSION: str = "2023-06-01"

    # ── Server ───────────────────────────────────────────────────────────────
    PORT: int = int(os.environ.get("PORT", "3200"))
    # Session secret for the future login. Dev default is fine locally; MUST be
    # set to a real random value in production.
    SECRET_KEY: str = os.environ.get("SECRET_KEY", "dev-only-insecure-secret")

    # ── Guards ───────────────────────────────────────────────────────────────
    MAX_RESUME_CHARS: int = 60000

    @classmethod
    def ai_ready(cls) -> bool:
        """True when a key is present, i.e. AI screening can run."""
        return bool(cls.ANTHROPIC_API_KEY)


config = Config()
