"""Anthropic client — the ONE place that knows how to call the Messages API.

Nothing else in the codebase talks to Anthropic directly. Routes call
`screen()`, which returns the model's raw text (strict JSON per our prompt
contract) or raises AnthropicError with a readable message.

Uses urllib from the stdlib so there is no extra dependency to deploy.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from .config import config


class AnthropicError(RuntimeError):
    """Raised when we cannot get a usable answer from Anthropic."""


def screen(system_prompt: str, user_prompt: str, model: str | None = None) -> str:
    """Call Anthropic and return the assistant's text content.

    Raises AnthropicError on any failure (missing key, HTTP error, network
    error, empty response) so the caller can fall back to the rule engine.
    """
    api_key = config.ANTHROPIC_API_KEY
    if not api_key:
        raise AnthropicError("ANTHROPIC_API_KEY is not set on the server.")

    model = model or config.ANTHROPIC_MODEL
    payload = json.dumps({
        "model": model,
        "max_tokens": 1500,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode("utf-8")

    request = urllib.request.Request(
        config.ANTHROPIC_URL,
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": config.ANTHROPIC_VERSION,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise AnthropicError(f"Anthropic API error {e.code}: {detail[:500]}")
    except urllib.error.URLError as e:
        raise AnthropicError(f"Could not reach Anthropic API: {e.reason}")

    parts = [b.get("text", "") for b in body.get("content", []) if b.get("type") == "text"]
    text = "".join(parts).strip()
    if not text:
        raise AnthropicError("Anthropic returned an empty response.")
    return text
