#!/usr/bin/env python3
"""Entry point for the Vimenture Resume Screener dev server.

    python3 serve.py

Reads configuration (including the Anthropic API key) from the environment via
server/config.py. In development that comes from a git-ignored .env file; in
production your host injects the same variables — no code change needed.
"""
import threading
import time
import webbrowser

from server.app import create_app
from server.config import config

app = create_app()


def _open_browser():
    time.sleep(0.6)
    webbrowser.open(f"http://localhost:{config.PORT}")


if __name__ == "__main__":
    ai_state = "ON" if config.ai_ready() else "OFF (set ANTHROPIC_API_KEY in .env to enable)"
    print(f"\U0001F4C4 Vimenture Resume Screener running at http://localhost:{config.PORT}")
    print(f"   AI: {ai_state}  |  model: {config.ANTHROPIC_MODEL}")
    print("   Press Ctrl+C to stop.\n")
    threading.Thread(target=_open_browser, daemon=True).start()
    # debug=False so the browser opener and port stay predictable.
    app.run(host="0.0.0.0", port=config.PORT, debug=False)
