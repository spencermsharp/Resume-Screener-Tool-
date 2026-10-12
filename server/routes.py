"""HTTP routes — thin handlers that delegate to the service layer.

Keep these lean: validate input, call a service, shape the response. Business
logic lives in anthropic_client.py; config lives in config.py.

AUTH SEAM
---------
When you add login, protect the API routes by applying `@login_required` (a
decorator you'll add alongside your auth blueprint). The marked spots below are
where that guard goes — one line each, no handler rewrites needed.
"""
import re
import uuid
from functools import wraps
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from .anthropic_client import AnthropicError, screen
from .config import config

api = Blueprint("api", __name__)

UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"


# ── AUTH SEAM ────────────────────────────────────────────────────────────────
# Placeholder guard. Today it allows everything (localhost, single user). When
# you build login, replace the body with a real session/token check and keep the
# same decorator name so the routes below don't change.
def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        # TODO (login): if not session.get("user"): return jsonify(error="Unauthorized"), 401
        return view(*args, **kwargs)
    return wrapped


# ── API ──────────────────────────────────────────────────────────────────────
@api.get("/api/status")
@login_required
def status():
    """Report whether AI is ready, without ever exposing the key itself."""
    return jsonify(aiReady=config.ai_ready(), model=config.ANTHROPIC_MODEL)


@api.post("/api/screen")
@login_required
def screen_route():
    """Proxy a screening request to Anthropic.

    Body: { system: str, user: str, model?: str }
    200:  { text: str, model: str }
    4xx/5xx: { error: str }  -> client falls back to the rule engine.
    """
    data = request.get_json(silent=True) or {}
    system_prompt = data.get("system", "")
    user_prompt = data.get("user", "")
    model = data.get("model") or config.ANTHROPIC_MODEL

    if not user_prompt:
        return jsonify(error="Missing 'user' prompt."), 400
    if len(user_prompt) > config.MAX_RESUME_CHARS:
        user_prompt = user_prompt[: config.MAX_RESUME_CHARS]

    try:
        text = screen(system_prompt, user_prompt, model)
    except AnthropicError as e:
        return jsonify(error=str(e)), 502

    return jsonify(text=text, model=model)


# A stored file id is just a uuid + .pdf — validate strictly before serving.
_ID_RE = re.compile(r"^[0-9a-f]{32}\.pdf$")


@api.post("/api/upload")
@login_required
def upload_route():
    """Persist an uploaded resume file and return an id to retrieve it later.

    Stored under uploads/ so the PDF survives page reloads and is viewable from
    the candidate detail page. Returns { id, url }.
    """
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify(error="No file provided."), 400

    original = secure_filename(f.filename)
    if not original.lower().endswith(".pdf"):
        return jsonify(error="Only PDF files can be stored for preview."), 400

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    stored = f"{uuid.uuid4().hex}.pdf"
    f.save(UPLOADS_DIR / stored)
    return jsonify(id=stored, url=f"/uploads/{stored}")


@api.get("/uploads/<path:name>")
@login_required
def serve_upload(name):
    """Serve a stored PDF inline so it previews in an <iframe>."""
    if not _ID_RE.match(name):
        return jsonify(error="Not found"), 404
    return send_from_directory(UPLOADS_DIR, name, mimetype="application/pdf")


@api.post("/api/uploads/clear")
@login_required
def clear_uploads():
    """Delete all stored resume PDFs. Used by the app's 'Clear data' action."""
    removed = 0
    if UPLOADS_DIR.exists():
        for p in UPLOADS_DIR.glob("*.pdf"):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return jsonify(removed=removed)


# ── STATIC APP ─────────────────────────────────────────────────────────────--
# Only the index route lives here; all other static assets (src/, public/,
# index.html) are served by Flask's built-in static handler (configured with
# static_url_path="" in the app factory), so /api/* routes take precedence.
static = Blueprint("static_app", __name__)


@static.get("/")
def index():
    return send_from_directory(current_app.static_folder, "index.html")
