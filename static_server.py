#!/usr/bin/env python3
"""Dead-simple static file server for production (Railway).

The app is a static site (browser talks to Supabase directly), so we just need
to serve files. Binds to the PORT Railway provides. No Flask, no gunicorn.
"""
import http.server
import os
import socketserver

PORT = int(os.environ.get("PORT", "8080"))
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always serve fresh assets — never let a browser/proxy cache the app.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        # Serve index.html at the root.
        if self.path == "/" or self.path == "":
            self.path = "/index.html"
        return super().do_GET()


if __name__ == "__main__":
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving static site on 0.0.0.0:{PORT}")
        httpd.serve_forever()
