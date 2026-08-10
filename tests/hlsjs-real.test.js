// Teste diferencial contra o hls.js verdadeiro: o mesmo carregamento com e sem
// o script. Tudo o que um site consegue observar tem de ficar igual — versão,
// Events, isSupported, instanceof, construção. A única diferença aceitável é a
// flag que o script quer mesmo mudar.
//
// A biblioteca é descarregada para tests/.cache na primeira vez. Sem rede, o
// teste diz que saltou em vez de falhar.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { funcao, bloco, montar, grupo, ok } = require("./harness");

const VERSAO = "1.5.14";
const CACHE = path.join(__dirname, ".cache");
const ALVO = path.join(CACHE, "hls-" + VERSAO + ".min.js");
const URL = "https://cdn.jsdelivr.net/npm/hls.js@" + VERSAO + "/dist/hls.min.js";

function biblioteca() {
	if (fs.existsSync(ALVO)) { return fs.readFileSync(ALVO, "utf8"); }
	try {
		fs.mkdirSync(CACHE, { recursive: true });
		execFileSync("curl", ["-sSL", "--max-time", "60", "-o", ALVO, URL], { stdio: "ignore" });
		const t = fs.readFileSync(ALVO, "utf8");
		if (t.length < 100000) { throw new Error("descarga incompleta"); }
		return t;
	} catch (e) {
		try { fs.unlinkSync(ALVO); } catch (e2) {}
		return null;
	}
}

const HLS = biblioteca();

grupo("Diferencial contra o hls.js " + VERSAO + " real");

if (!HLS) {
	console.log("    -- saltado: não foi possível obter o hls.js (sem rede?)");
} else {
	const CODIGO = bloco("\tconst globalSubs", "\tfunction onGlobal(") + funcao("hlsHook");

	function palco() {
		const regs = [];
		const el = { addEventListener() {}, removeEventListener() {}, style: {} };
		const doc = {
			createElement: () => Object.assign({}, el),
			addEventListener(t, fn) { regs.push({ t, fn }); },
			removeEventListener(t, fn) {
				const i = regs.findIndex((r) => r.t === t && r.fn === fn);
				if (i >= 0) { regs.splice(i, 1); }
			},
			_scriptCarregou() { regs.filter((r) => r.t === "load").forEach((r) => r.fn({})); },
			documentElement: el, readyState: "complete",
			querySelectorAll: () => [], querySelector: () => null
		};
		class MediaSourceStub { static isTypeSupported() { return true; } addEventListener() {} }
		const g = {
			document: doc, navigator: { userAgent: "Mozilla/5.0 Chrome/126" },
			MediaSource: MediaSourceStub, performance: { now: () => 0 },
			XMLHttpRequest: function () { this.open = () => {}; this.send = () => {}; },
			fetch: () => Promise.resolve(),
			URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
			Worker: function () { this.postMessage = () => {}; this.addEventListener = () => {}; },
			Blob: function () {}, console
		};
		g.self = g; g.window = g; g.globalThis = g;
		return g;
	}

	function carregar(g) {
		// o UMD do hls.js acaba em `globalThis.Hls = factory()`; passando o nosso
		// globalThis como parâmetro, a atribuição cai no palco em vez do Node real
		const f = new Function("globalThis", "self", "window", "document", "navigator",
			"MediaSource", "XMLHttpRequest", "fetch", "URL", "Worker", "Blob", "performance",
			"console", HLS + "\nreturn globalThis.Hls;");
		return f(g, g, g, g.document, g.navigator, g.MediaSource, g.XMLHttpRequest,
			g.fetch, g.URL, g.Worker, g.Blob, g.performance, console);
	}

	function correr(comScript) {
		const g = palco();
		const out = {};
		if (comScript) {
			montar(CODIGO, {
				W: g, document: g.document,
				settings: { hlsjs: true }, debugLog: () => {}, hlsPickBest: () => 0,
				setInterval: () => 0, clearInterval: () => {}
			}, "{ hlsHook }").hlsHook();
			out.fantasma = "Hls" in g;
		}
		const Real = carregar(g);
		g.document._scriptCarregou();
		const Visto = g.Hls; // o que o site vê

		const tenta = (f, etiqueta) => { try { out[etiqueta] = f(); } catch (e) { out[etiqueta] = "ERRO: " + e.message; } };
		tenta(() => typeof Visto, "tipo");
		tenta(() => Visto.version, "versao");
		tenta(() => !!(Visto.Events && Visto.Events.MANIFEST_PARSED), "events");
		tenta(() => Visto.isSupported(), "isSupported");
		tenta(() => typeof Visto.DefaultConfig === "object", "defaultConfig");
		try {
			const inst = new Visto({ debug: false, enableWorker: true, capLevelToPlayerSize: true, maxBufferLength: 30 });
			out.construiu = true;
			out.instanceOf = inst instanceof Real;
			out.temOn = typeof inst.on === "function";
			out.cap = inst.config && inst.config.capLevelToPlayerSize;
			out.maxBuffer = inst.config && inst.config.maxBufferLength;
		} catch (e) {
			out.construiu = false;
			out.erro = e.constructor.name + ": " + e.message;
		}
		return out;
	}

	const sem = correr(false);
	const com = correr(true);

	ok(com.fantasma === false, 'não cria "Hls" in window antes de a biblioteca chegar');

	const esperadas = new Set(["cap", "fantasma"]);
	const chaves = new Set([...Object.keys(sem), ...Object.keys(com)]);
	const divergem = [];
	for (const k of chaves) {
		if (esperadas.has(k)) { continue; }
		if (JSON.stringify(sem[k]) !== JSON.stringify(com[k])) {
			divergem.push(k + " (sem=" + JSON.stringify(sem[k]) + " com=" + JSON.stringify(com[k]) + ")");
		}
	}
	ok(divergem.length === 0, "nada do que o site observa muda" + (divergem.length ? ": " + divergem.join(", ") : ""));
	ok(com.construiu === true, "new Hls(config) continua a construir");
	ok(com.instanceOf === true, "instanceof continua certo");
	ok(sem.cap === true && com.cap === false, "só o capLevelToPlayerSize muda, que é o objetivo");
	ok(com.maxBuffer === 30, "a configuração do site é preservada");
}
