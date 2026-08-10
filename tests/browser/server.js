// Validação em browser real: `node tests/browser/server.js` e abrir
// http://localhost:8787
//
// Os testes em Node provam a lógica, mas há uma coisa que só um browser
// responde: a CORRIDA. A lista de qualidades vem num <script> inline e o
// leitor num bundle externo carregado depois — o script tem de corrigir a
// lista na janela entre os dois. Esta página reproduz esse padrão com o
// hls.js verdadeiro e diz na cara se chegou a tempo.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const AQUI = __dirname;
const RAIZ = path.join(AQUI, "..", "..");
const HLS = path.join(AQUI, "..", ".cache", "hls-1.5.14.min.js");

if (!fs.existsSync(HLS)) {
	console.log("a obter o hls.js 1.5.14…");
	fs.mkdirSync(path.dirname(HLS), { recursive: true });
	execFileSync("curl", ["-sSL", "--max-time", "60", "-o", HLS,
		"https://cdn.jsdelivr.net/npm/hls.js@1.5.14/dist/hls.min.js"], { stdio: "inherit" });
}

const TIPOS = { ".html": "text/html", ".js": "application/javascript" };
const M3U8 = "application/vnd.apple.mpegurl";

// master com 3 variantes: dá ao corte do .m3u8 alguma coisa para fazer
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1000000,RESOLUTION=426x240
../v240/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000,RESOLUTION=854x480
../v480/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4000000,RESOLUTION=1920x1080
../v1080/index.m3u8
`;

// os segmentos não existem de propósito: o 404 é esperado e chega DEPOIS do
// MANIFEST_PARSED, que é o que interessa observar
const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
seg1.ts
#EXT-X-ENDLIST
`;

const ficheiros = {
	"/mvq.js": path.join(RAIZ, "max-video-quality.user.js"),
	"/hls.min.js": HLS,
	"/player.js": path.join(AQUI, "player.js"),
	"/": path.join(AQUI, "index.html")
};

http.createServer((req, res) => {
	const u = req.url.split("?")[0];
	if (/master\.m3u8$/.test(u)) { res.writeHead(200, { "content-type": M3U8 }); return res.end(MASTER); }
	if (/index\.m3u8$/.test(u)) { res.writeHead(200, { "content-type": M3U8 }); return res.end(MEDIA); }
	const f = ficheiros[u];
	if (!f) { res.writeHead(404); return res.end("nao encontrado"); }
	fs.readFile(f, (e, b) => {
		if (e) { res.writeHead(404); return res.end("nao encontrado"); }
		res.writeHead(200, { "content-type": TIPOS[path.extname(f)] || "text/plain" });
		res.end(b);
	});
}).listen(8787, () => console.log("abrir http://localhost:8787"));
