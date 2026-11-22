"""
ApexNotes – Lokální server pro PWA aplikaci (PC + iPhone 13 přes Wi-Fi)
Spustí HTTP server se složkou pwa/ a vypíše přesnou adresu pro otevření na PC i na iPhonu 13.
"""

import os
import socket
import http.server
import socketserver

PORT = 8080
PWA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pwa")


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PWA_DIR, **kwargs)


if __name__ == "__main__":
    local_ip = get_local_ip()
    print("=" * 68)
    print("🏁 APEXNOTES PWA SERVER BĚŽÍ!")
    print("=" * 68)
    print(f"👉 Na tomto PC otevři v prohlížeči:   http://localhost:{PORT}")
    print(f"📱 Na iPhonu 13 (na stejné Wi-Fi):    http://{local_ip}:{PORT}")
    print("   (V Safari na iPhonu klikni na Sdílet -> Přidat na plochu)")
    print("=" * 68)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        httpd.serve_forever()
