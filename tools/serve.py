# 開発用の簡易サーバー: UTF-8・キャッシュ無効で配信する
# POST /__shot?name=xxx で受け取った PNG（data URL）を .shots/ に保存する（ローカル確認用）
import http.server, sys, os, base64, re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SHOTS = os.environ.get('KANI_SHOTS', os.path.join(ROOT, '.shots'))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

    def do_POST(self):
        if not self.path.startswith('/__shot'):
            self.send_error(404)
            return
        m = re.search(r'name=([\w\-]+)', self.path)
        name = m.group(1) if m else 'shot'
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n).decode('ascii')
        data = base64.b64decode(body.split(',', 1)[1])
        os.makedirs(SHOTS, exist_ok=True)
        with open(os.path.join(SHOTS, name + '.png'), 'wb') as f:
            f.write(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')


port = int(os.environ.get('PORT') or (sys.argv[1] if len(sys.argv) > 1 else 8765))
print(f'http://localhost:{port}')
http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
