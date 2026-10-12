"""Application factory — assembles the Flask app from config + blueprints.

Using a factory keeps construction testable and gives the future login
blueprint a clean place to register.
"""
from pathlib import Path

from flask import Flask

from .config import config
from .routes import api, static

ROOT = Path(__file__).resolve().parent.parent


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(ROOT), static_url_path="")
    app.config["SECRET_KEY"] = config.SECRET_KEY

    # No-store so the dev app always serves fresh assets.
    @app.after_request
    def no_store(resp):
        resp.headers["Cache-Control"] = "no-store"
        return resp

    app.register_blueprint(api)
    # AUTH SEAM: register your auth blueprint here, e.g.
    #   from .auth import auth
    #   app.register_blueprint(auth)
    app.register_blueprint(static)
    return app
