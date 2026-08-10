// O corte da master playlist HLS só pode agir quando há mesmo escolha a fazer.
// Um manifesto de variante única, ou uma playlist de media, têm de passar
// intactos byte a byte — se o script os alterasse, partia leitores em sites
// onde não tinha nada a ganhar.

const { funcao, montar, grupo, ok } = require("./harness");

const settings = { m3u8Rewrite: true, debug: true };
const ditos = [];

const api = montar(
	funcao("stripM3u8") + funcao("installTextResponseFilter"),
	{ W: {}, settings, debugLog: (m) => ditos.push(m), acao: (m) => ditos.push(m) },
	"{ stripM3u8, installTextResponseFilter }"
);

// Um master por qualidade, com uma única variante lá dentro: é o formato que
// muitos portais de vídeo usam, e é onde o corte não tem nada que fazer.
const MASTER_UMA = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4000000,RESOLUTION=1920x1080
index-v1-a1.m3u8?validfrom=1786394530&validto=1786398130&hash=abc%3D
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
seg-1-v1-a1.ts
#EXT-X-ENDLIST
`;

const MASTER_VARIAS = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="pt",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=426x240
240.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=854x480
480.m3u8
`;

grupo("Não tocar em manifestos onde não há escolha");
ok(api.stripM3u8(MASTER_UMA) === null, "master com uma só variante passa intacto");
ok(api.stripM3u8(MEDIA) === null, "playlist de media passa intacta");
ok(api.stripM3u8("nada disto é um manifesto") === null, "texto que não é manifesto é ignorado");
ok(api.stripM3u8("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n") === null,
	"manifesto truncado (variante sem URI) não é cortado");

grupo("Cortar quando há mesmo várias variantes");
{
	ditos.length = 0;
	const out = api.stripM3u8(MASTER_VARIAS);
	ok(typeof out === "string", "reconheceu o master");
	ok(out.indexOf("1080.m3u8") !== -1, "ficou com a variante de 1080p");
	ok(out.indexOf("240.m3u8") === -1 && out.indexOf("480.m3u8") === -1, "as outras saíram");
	ok(out.indexOf("#EXT-X-MEDIA:") !== -1, "as faixas de áudio ficaram intactas");
	ok(/1080p \(de 3 variantes\)/.test(ditos[0] || ""), "diz o que fez: " + (ditos[0] || "(nada)"));
}

grupo("Filtro de respostas: devolver o original quando não há nada a mudar");
{
	class FakeXHR {
		constructor() { this.readyState = 0; this.responseType = ""; this._body = ""; }
		open() { this.readyState = 1; }
		send() { this.readyState = 4; }
		get responseText() { return this._body; }
		get response() { return this._body; }
	}
	const W = { XMLHttpRequest: FakeXHR, fetch: null };
	const filtro = montar(
		funcao("stripM3u8") + funcao("installTextResponseFilter"),
		{ W, settings, debugLog: () => {} },
		"{ stripM3u8, installTextResponseFilter }"
	);
	const isM3u8 = (url) => /\.m3u8(\?|#|$)/i.test(url);
	filtro.installTextResponseFilter(isM3u8, (t) => filtro.stripM3u8(t));

	ok(isM3u8("https://cdn/x/1080P.mp4/master.m3u8?"), "URL terminada em .m3u8? é reconhecida");
	ok(!isM3u8("https://site/video/get_media?s=abc"), "URL sem .m3u8 é ignorada");

	const x = new W.XMLHttpRequest();
	x.open("GET", "https://cdn/x/1080P.mp4/master.m3u8?");
	x._body = MASTER_UMA;
	x.responseType = "text";
	x.send();
	ok(x.responseText === MASTER_UMA, "responseText devolve o manifesto original");
	ok(x.response === MASTER_UMA, "response devolve o manifesto original");
}
