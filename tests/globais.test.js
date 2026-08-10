// O script NUNCA pode criar variáveis globais que não existiam.
//
// Definir `window.Hls` antes de a biblioteca existir faz `"Hls" in window`
// passar a verdadeiro. Há sites que decidem por aí se ainda precisam de
// descarregar o leitor — e, convencidos de que já lá está, abortam o download.
// O vídeo fica a carregar para sempre, sem erro nenhum. Foi o bug do v2.5.1.

const { funcao, bloco, montar, grupo, ok, ambiente } = require("./harness");

const CODIGO = bloco("\tconst globalSubs", "\tfunction onGlobal(") +
	funcao("hlsHook") + funcao("dashForceMax") + funcao("dashHook") + funcao("shakaHook");

function arrancar(env) {
	return montar(CODIGO, {
		W: env.W,
		document: env.document,
		settings: { hlsjs: true, dashjs: true, shaka: true, debug: false },
		debugLog: () => {},
		hlsPickBest: () => 0,
		setInterval: () => 0,   // o teste controla o tempo pelo evento de load
		clearInterval: () => {}
	}, "{ hlsHook, dashHook, shakaHook }");
}

function biblioteca() {
	class FakeHls {
		constructor(cfg) { this.config = Object.assign({ capLevelToPlayerSize: true }, cfg); }
		on() {} attachMedia() {} destroy() {}
		static isSupported() { return true; }
	}
	FakeHls.version = "1.5.14";
	FakeHls.Events = { MANIFEST_PARSED: "hlsManifestParsed" };
	return FakeHls;
}

grupo("Nenhum global fantasma antes de a biblioteca existir");
{
	const env = ambiente();
	const api = arrancar(env);
	api.hlsHook(); api.dashHook(); api.shakaHook();
	ok(!("Hls" in env.W), '"Hls" in window === false');
	ok(!("dashjs" in env.W), '"dashjs" in window === false');
	ok(!("shaka" in env.W), '"shaka" in window === false');
}

grupo("Carregador que deteta por `in window` continua a descarregar a biblioteca");
{
	// forma real encontrada num player de produção:
	//   check: () => "Hls" in window
	//   if (check() && !loadComplete) { "Loading aborted."; loadComplete = true; success = true }
	//   loadComplete || isLoading || attemptToLoadLibrary()
	const env = ambiente();
	const api = arrancar(env);
	api.hlsHook();

	const lib = {
		loadComplete: false, isLoading: false, success: false,
		check: () => "Hls" in env.W,
		checkVersion: () => (env.W.Hls && env.W.Hls.version) === "1.5.14"
	};
	let descarregou = false;
	if (lib.check() && !lib.loadComplete) { lib.loadComplete = true; lib.success = true; }
	if (!lib.loadComplete && !lib.isLoading) {
		descarregou = true;
		env.W.Hls = biblioteca();
		env.document._scriptCarregou();
	}

	ok(descarregou, "o site chegou a descarregar a biblioteca");
	ok(lib.check(), 'depois de carregada, "Hls" in window === true');
	ok(!!(env.W.Hls && env.W.Hls.isSupported()), "window.Hls.isSupported() responde (o leitor arranca)");
	ok(lib.checkVersion(), "a versão continua a bater certo");
}

grupo("A forçagem de qualidade continua a aplicar-se");
{
	const env = ambiente();
	arrancar(env).hlsHook();
	env.W.Hls = biblioteca();
	env.document._scriptCarregou();
	const inst = new env.W.Hls({ capLevelToPlayerSize: true, maxBufferLength: 30 });
	ok(inst.config.capLevelToPlayerSize === false, "capLevelToPlayerSize forçado a false");
	ok(inst.config.maxBufferLength === 30, "restante configuração do site preservada");
}

grupo("Biblioteca já presente em document-start");
{
	const env = ambiente();
	env.W.Hls = biblioteca();
	arrancar(env).hlsHook();
	const inst = new env.W.Hls({ capLevelToPlayerSize: true });
	ok(inst.config.capLevelToPlayerSize === false, "embrulhada de imediato, sem esperar por eventos");
}

grupo("Nada fica pendurado depois de resolver");
{
	const env = ambiente();
	arrancar(env).hlsHook();
	env.W.Hls = biblioteca();
	env.document._scriptCarregou();
	ok(env.document._nListeners() === 0, "o listener de load é removido quando já não faz falta");
}
