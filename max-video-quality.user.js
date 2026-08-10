// ==UserScript==
// @name          Max Video Quality
// @namespace     https://github.com/fabioganga1
// @version       2.8.0
// @icon          data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%96%B6%EF%B8%8F%3C/text%3E%3C/svg%3E
// @description   Força automaticamente a melhor qualidade disponível em vídeos na web
// @author        fabioganga1
// @homepageURL   https://github.com/fabioganga1/max-video-quality
// @downloadURL   https://raw.githubusercontent.com/fabioganga1/max-video-quality/main/max-video-quality.user.js
// @updateURL     https://raw.githubusercontent.com/fabioganga1/max-video-quality/main/max-video-quality.user.js
// @match         *://*/*
// @run-at        document-start
// @sandbox       raw
// @grant         unsafeWindow
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_registerMenuCommand
// @grant         GM.getValue
// @grant         GM.setValue
// ==/UserScript==

// Corre em todos os sites e frames (necessário para apanhar players em iframes).
// Em páginas sem vídeo fica praticamente inerte: os hooks pesados só são instalados
// nos sites onde fazem sentido, e o scan só arranca quando aparece um vídeo.
// Excluir um site: Painel -> nome do script -> Definições -> Exclusões do utilizador.

(function () {
	"use strict";

	// unsafeWindow = window real da página (Tampermonkey @sandbox raw)
	const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

	// --- DEFINIÇÕES ------------------------------------------------------

	const settings = {
		youtube: true,
		youtubeTargetRes: "highest", // "highest" | "hd2160" | "hd1440" | "hd1080" | ...
		twitch: true,
		twitchSpoofVisibility: false, // evita descida de qualidade em separador de fundo
		vimeo: true,
		jwplayer: true,
		videojs: true,
		hlsjs: true,
		hlsGeneric: true, // hls.js empacotado no site (sem window.Hls)
		dashjs: true,
		shaka: true,
		mpdRewrite: true, // players DASH fechados (ex.: Facebook)
		m3u8Rewrite: true, // master playlists HLS: deixa só a melhor variante
		qualityList: true, // sites que escolhem a qualidade antes de o leitor existir
		autoDisable: true, // desliga-se sozinho num site onde tenha prendido o vídeo
		debug: false,
		overwriteStoredSettings: false
	};

	// Carregamento SÍNCRONO: os hooks de document-start precisam das definições
	// antes de agir (com a API assíncrona agiam sempre com os valores por defeito).
	function loadSettingsSync() {
		try {
			if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function") { return false; }
			if (settings.overwriteStoredSettings || !GM_getValue("SettingsSaved", false)) {
				for (const [k, v] of Object.entries(settings)) { GM_setValue(k, v); }
				GM_setValue("SettingsSaved", true);
				return true;
			}
			for (const k of Object.keys(settings)) {
				if (k === "overwriteStoredSettings") { continue; }
				const v = GM_getValue(k, undefined);
				if (v !== undefined) { settings[k] = v; }
				else { GM_setValue(k, settings[k]); } // opções novas passam a aparecer no separador Armazenamento
			}
			return true;
		} catch (e) { return false; }
	}

	// Fallback para gestores sem a API síncrona (aplica-se tarde, mas é melhor que nada)
	async function loadSettingsAsync() {
		try {
			if (typeof GM === "undefined" || !GM.getValue || !GM.setValue) { return; }
			if (settings.overwriteStoredSettings || !(await GM.getValue("SettingsSaved"))) {
				await Promise.all(Object.entries(settings).map(([k, v]) => GM.setValue(k, v)));
				await GM.setValue("SettingsSaved", true);
				return;
			}
			const entries = await Promise.all(
				Object.keys(settings).map(async (k) => [k, await GM.getValue(k)])
			);
			for (const [k, v] of entries) {
				if (k === "overwriteStoredSettings") { continue; }
				if (v !== undefined) { settings[k] = v; } else { GM.setValue(k, settings[k]); }
			}
		} catch (e) {}
	}

	const debugLog = (msg) => { if (settings.debug) { console.log(`MAXQ | ${msg}`); } };
	const hostMatches = (re) => re.test(location.hostname);

	// Regista que o script mexeu MESMO em alguma coisa nesta página. É o que
	// autoriza a rede de segurança a desligar-se sozinha: se não tocámos em
	// nada, um vídeo encravado é problema do site e não nosso.
	let houveAcao = false;
	const acao = (msg) => { houveAcao = true; debugLog(msg); };

	// --- INTERRUPTOR POR SITE --------------------------------------------
	// Um domínio nesta lista faz o script não instalar absolutamente nada:
	// nenhum hook, nenhuma interceção, nenhum risco. É a saída de emergência,
	// e é para onde a rede de segurança empurra um site que tenhamos estragado.

	const SITES_OFF = "sitesDesativados";

	function sitesDesativados() {
		try {
			if (typeof GM_getValue !== "function") { return []; }
			const v = GM_getValue(SITES_OFF, []);
			return Array.isArray(v) ? v : [];
		} catch (e) { return []; }
	}

	function estaDesativado() {
		try { return sitesDesativados().indexOf(location.hostname) !== -1; } catch (e) { return false; }
	}

	function guardarSites(lista) {
		try {
			if (typeof GM_setValue !== "function") { return false; }
			GM_setValue(SITES_OFF, lista);
			return true;
		} catch (e) { return false; }
	}

	function desativarSite(porque) {
		const host = location.hostname;
		const lista = sitesDesativados();
		if (lista.indexOf(host) === -1) { lista.push(host); }
		if (!guardarSites(lista)) { return false; }
		// este aviso sai sempre, mesmo sem debug: o utilizador tem de poder
		// perceber porque é que o script deixou de atuar aqui
		console.log("MAXQ | desativado em " + host + " — " + porque);
		return true;
	}

	function reativarSite() {
		const host = location.hostname;
		return guardarSites(sitesDesativados().filter((h) => h !== host));
	}

	// --- OBSERVADOR DE DOM PARTILHADO ------------------------------------
	// Um único MutationObserver por frame, em vez de um por adaptador.

	const domSubs = [];
	let domStarted = false;

	function onDomChange(fn) {
		domSubs.push(fn);
		if (domStarted) { return; }
		domStarted = true;
		const start = () => {
			try {
				new MutationObserver((muts) => {
					for (const sub of domSubs) { try { sub(muts); } catch (e) {} }
				}).observe(document.documentElement || document, { childList: true, subtree: true });
			} catch (e) {}
		};
		if (document.documentElement) { start(); }
		else { document.addEventListener("readystatechange", start, { once: true }); }
	}

	function onReady(fn) {
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", fn, { once: true });
		} else { fn(); }
	}

	// --- VÍDEOS, INCLUINDO OS QUE ESTÃO DENTRO DE SHADOW DOM --------------
	// querySelectorAll não atravessa shadow roots, por isso um <video> dentro
	// de um web component ficava invisível a tudo o que o script faz. Só se
	// entra em roots ABERTOS: os fechados devolvem null e não se força nada.
	//
	// A procura só acontece quando não há um único <video> à vista — que é
	// exatamente o caso em que se suspeita de um leitor feito em componente.
	// Nas páginas normais o custo é zero.

	let srCache = [], srQuando = 0;

	function shadowRootsAbertos() {
		const agora = Date.now();
		if (agora - srQuando < 2000) { return srCache; }
		srQuando = agora;
		const achados = [];
		let orcamento = 4000;
		const anda = (raiz) => {
			let it;
			try { it = document.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT); } catch (e) { return; }
			while (orcamento-- > 0) {
				let no;
				try { no = it.nextNode(); } catch (e) { return; }
				if (!no) { return; }
				let sr;
				try { sr = no.shadowRoot; } catch (e) { continue; }
				if (sr) { achados.push(sr); anda(sr); } // um root pode ter outro dentro
			}
		};
		try { if (document.documentElement) { anda(document.documentElement); } } catch (e) {}
		srCache = achados;
		return srCache;
	}

	function todosOsVideos() {
		let diretos = [];
		try { diretos = Array.prototype.slice.call(document.querySelectorAll("video")); } catch (e) {}
		if (diretos.length) { return diretos; } // caminho normal
		const out = [];
		for (const sr of shadowRootsAbertos()) {
			try { Array.prototype.push.apply(out, sr.querySelectorAll("video")); } catch (e) {}
		}
		return out;
	}

	// --- VIGIA DE GLOBAIS (sem criar propriedades fantasma) --------------
	// Definir um getter/setter para um global que ainda NÃO existe faz
	// `"Nome" in window` passar a true. Muitos sites decidem por aí se ainda
	// precisam de carregar a biblioteca; convencidos de que já lá está,
	// abortam o download e o leitor fica a rodar para sempre, sem erro
	// nenhum. (Pornhub: `check: () => "Hls" in window` -> nunca descarregava
	// o hls.js.) Por isso nada é definido à cabeça: só se embrulha o que
	// realmente aparecer.

	const globalSubs = [];
	let globalTimer = null, globalTicks = 0;

	function globalStop() {
		try { document.removeEventListener("load", globalSweep, true); } catch (e) {}
		if (globalTimer) { clearInterval(globalTimer); globalTimer = null; }
	}

	// Devolve true quando já não falta nenhum global
	function globalSweep() {
		for (let i = globalSubs.length - 1; i >= 0; i--) {
			const sub = globalSubs[i];
			let atual;
			try {
				if (!Object.prototype.hasOwnProperty.call(W, sub.nome)) { continue; }
				atual = W[sub.nome];
			} catch (e) { continue; }
			if (atual === null || atual === undefined) { continue; }
			globalSubs.splice(i, 1);
			try {
				const novo = sub.embrulhar(atual);
				// os hooks que alteram no sítio devolvem o mesmo objeto: nada a escrever
				if (novo && novo !== atual) { W[sub.nome] = novo; }
			} catch (e) {}
		}
		if (!globalSubs.length) { globalStop(); return true; }
		return false;
	}

	function onGlobal(nome, embrulhar) {
		globalSubs.push({ nome: nome, embrulhar: embrulhar });
		if (globalSweep()) { return; }
		if (globalTimer) { return; }
		// O "load" de um <script> passa pela fase de captura no document ANTES
		// do onload do próprio site: é aí que se apanha a biblioteca acabada de
		// ser definida, ainda antes de o site lhe tocar.
		try { document.addEventListener("load", globalSweep, true); } catch (e) {}
		globalTicks = 0;
		globalTimer = setInterval(() => {
			if (globalSweep()) { return; }
			if (++globalTicks > 150) { globalStop(); } // ~15 s e desiste
		}, 100);
	}

	// --- ADAPTADOR: YouTube ----------------------------------------------

	const YT_NUM = { highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };
	const ytIsWatchPage = () => /\/watch|\/embed\//.test(location.pathname);

	function ytWriteStoredQuality(level) {
		// Formato atual do YouTube: {"data":"{\"quality\":2160,...}", ...}
		const num = YT_NUM[level] || 0;
		if (!num) { return; }
		try {
			const now = Date.now();
			localStorage.setItem("yt-player-quality", JSON.stringify({
				data: JSON.stringify({ quality: num, previousQuality: num }),
				expiration: now + 2592000000, creation: now
			}));
		} catch (e) {}
	}

	function ytStorageBoot() {
		if (!settings.youtube || !hostMatches(/(^|\.)youtube(-nocookie)?\.com$/)) { return; }
		ytWriteStoredQuality(settings.youtubeTargetRes === "highest" ? "hd2160" : settings.youtubeTargetRes);
	}

	function ytAdapter() {
		if (!settings.youtube || !hostMatches(/(^|\.)youtube(-nocookie)?\.com$/)) { return; }

		let currentVideo = "";
		let attempts = 0; // limite por vídeo: força a qualidade sem lutar para sempre

		const mainPlayer = () => {
			const p = document.getElementById("movie_player");
			if (p) { return p; }
			// Sem #movie_player só usamos o fallback em páginas de vídeo — na página
			// inicial isso apanharia os pré-visualizadores e estragava a preferência.
			return ytIsWatchPage() ? document.querySelector(".html5-video-player") : null;
		};

		const videoIdOf = (p) => {
			try {
				const m = /[?&]v=([\w-]+)/.exec((p.getVideoUrl && p.getVideoUrl()) || "");
				return m ? m[1] : location.href;
			} catch (e) { return location.href; }
		};

		// Devolve true quando não há mais nada a fazer neste vídeo (conseguido ou desistido)
		const apply = () => {
			const p = mainPlayer();
			if (!p || typeof p.getPlaybackQuality !== "function") { return false; }
			const current = p.getPlaybackQuality();
			if (current === "unknown") { return false; }

			const levels = ((typeof p.getAvailableQualityLevels === "function" && p.getAvailableQualityLevels()) || [])
				.filter((l) => l !== "auto");
			if (!levels.length) { return false; }

			let target = (settings.youtubeTargetRes === "highest") ? levels[0] : settings.youtubeTargetRes;
			if (!levels.includes(target)) { target = levels[0]; }

			const id = videoIdOf(p);
			if (id !== currentVideo) { currentVideo = id; attempts = 0; }

			if (current === target) { return true; }  // já no alvo: nada a fazer
			if (attempts >= 3) { return true; }       // não insistir: pode ser escolha do utilizador
			attempts++;

			if (typeof p.setPlaybackQualityRange === "function") { p.setPlaybackQualityRange(target, target); }
			p.setPlaybackQuality(target);
			if (ytIsWatchPage()) { ytWriteStoredQuality(target); }
			acao("YouTube -> " + target + " (tentativa " + attempts + ")");
			return false;
		};

		// Vigia só até conseguir. Depois PÁRA — só volta a ligar-se em vídeo novo.
		let timer = null, ticks = 0;
		const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
		const arm = () => {
			ticks = 0;
			if (timer) { return; }
			timer = setInterval(() => {
				let done = false;
				try { done = apply(); } catch (e) {}
				if (done || ++ticks >= 20) { stop(); debugLog("YouTube: vigilância parada"); }
			}, 1000);
		};

		window.addEventListener("loadstart", (e) => {
			if (e.target instanceof HTMLMediaElement) { currentVideo = ""; arm(); }
		}, true);
		window.addEventListener("yt-navigate-finish", () => { currentVideo = ""; arm(); }, true);
		arm();
	}

	// --- ADAPTADOR: Twitch ------------------------------------------------

	function twitchStorageBoot() {
		if (!settings.twitch || !hostMatches(/(^|\.)twitch\.tv$/)) { return; }
		try { localStorage.setItem("video-quality", JSON.stringify({ default: "chunked" })); } catch (e) {}
	}

	function twitchAdapter() {
		if (!settings.twitch || !hostMatches(/(^|\.)twitch\.tv$/)) { return; }

		function findPlayer(video) {
			let el = video;
			while (el) {
				const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
				if (key) {
					let fiber = el[key], n = 0;
					while (fiber && n < 60) {
						const mp = fiber.memoizedProps && fiber.memoizedProps.mediaPlayerInstance;
						if (mp && typeof mp.getQualities === "function") { return mp; }
						if (fiber.stateNode && typeof fiber.stateNode.getQualities === "function") { return fiber.stateNode; }
						fiber = fiber.return; n++;
					}
				}
				el = el.parentElement;
			}
			return null;
		}

		let channel = "";
		let attempts = 0;

		// Devolve true quando não há mais nada a fazer (conseguido ou desistido)
		const apply = () => {
			if (location.pathname !== channel) { channel = location.pathname; attempts = 0; }
			if (attempts >= 3) { return true; } // não reescrever a escolha do utilizador

			const player = findPlayer(document.querySelector("video"));
			if (!player) { return false; }
			const qs = (player.getQualities && player.getQualities()) || [];
			if (qs.length < 2) { return false; }

			const best = qs.slice().sort((a, b) =>
				((b.height || 0) - (a.height || 0)) || ((b.framerate || 0) - (a.framerate || 0)))[0];
			if (!best) { return false; }
			const cur = player.getQuality && player.getQuality();
			if (cur && (cur.group === best.group || cur.name === best.name)) { return true; } // já no topo

			attempts++;
			player.setAutoQualityMode && player.setAutoQualityMode(false);
			player.abrManager && player.abrManager.disable && player.abrManager.disable();
			player.setQuality(best);
			acao("Twitch -> " + (best.name || best.height) + " (tentativa " + attempts + ")");
			return false;
		};

		if (settings.twitchSpoofVisibility) {
			try {
				Object.defineProperty(Document.prototype, "hidden",
					{ get: () => false, configurable: true, enumerable: true });
				Object.defineProperty(document, "visibilityState",
					{ get: () => "visible", configurable: true, enumerable: true });
				Object.defineProperty(document, "hasFocus",
					{ value: () => true, configurable: true, writable: true });
				// Filtrar pelo alvo: um listener de "blur" em captura no document apanharia
				// o blur de TODOS os elementos da página (menus, campos, etc.) e nem sequer
				// veria o blur de janela, cujo alvo é o window.
				document.addEventListener("visibilitychange", (e) => {
					if (e.target === document) { e.stopImmediatePropagation(); }
				}, true);
				window.addEventListener("blur", (e) => {
					if (e.target === window) { e.stopImmediatePropagation(); }
				}, true);
			} catch (e) {}
		}

		// Vigia só até conseguir; depois PÁRA. Reativa em stream/canal novo.
		let timer = null, ticks = 0;
		const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
		const arm = () => {
			ticks = 0;
			if (timer) { return; }
			timer = setInterval(() => {
				let done = false;
				try { done = apply(); } catch (e) {}
				if (done || ++ticks >= 15) { stop(); debugLog("Twitch: vigilância parada"); }
			}, 2000);
		};

		onReady(() => {
			for (const ev of ["loadedmetadata", "playing", "canplay"]) {
				document.addEventListener(ev, () => arm(), true);
			}
			arm();
		});
	}

	// --- ADAPTADOR: Vimeo (vídeos embebidos) ------------------------------

	function vimeoAdapter() {
		if (!settings.vimeo) { return; }
		if (location.hostname === "player.vimeo.com") { return; } // dentro do embed nada a fazer

		const rank = (id) => {
			const s = String(id).toLowerCase();
			if (s === "4k") { return 2160; }
			if (s === "2k") { return 1440; }
			return parseInt(s, 10) || 0;
		};

		// UM único listener global (um por iframe retinha iframes destacados para sempre)
		let listening = false;
		const ensureListener = () => {
			if (listening) { return; }
			listening = true;
			window.addEventListener("message", (e) => {
				if (e.origin !== "https://player.vimeo.com" || !e.source) { return; }
				let d;
				try { d = (typeof e.data === "string") ? JSON.parse(e.data) : e.data; } catch (err) { return; }
				if (!d || typeof d !== "object") { return; }
				const post = (o) => {
					try { e.source.postMessage(JSON.stringify(o), "https://player.vimeo.com"); } catch (err) {}
				};
				if (d.event === "ready" || d.method === "ping") { post({ method: "getQualities" }); }
				if (d.method === "getQualities" && Array.isArray(d.value)) {
					const best = d.value.map((q) => q.id).filter((id) => id !== "auto")
						.sort((a, b) => rank(b) - rank(a))[0];
					if (best) { post({ method: "setQuality", value: best }); acao("Vimeo -> " + best); }
				}
			});
		};

		const pinged = new WeakSet();
		const hook = (iframe) => {
			if (pinged.has(iframe)) { return; }
			pinged.add(iframe);
			ensureListener();
			const ping = () => {
				try { iframe.contentWindow.postMessage(JSON.stringify({ method: "ping" }), "https://player.vimeo.com"); } catch (e) {}
			};
			ping();
			iframe.addEventListener("load", ping); // src atribuído depois da inserção
		};

		const scanRoot = (root) => {
			try {
				if (root.matches && root.matches('iframe[src*="player.vimeo.com/video"]')) { hook(root); }
				if (root.querySelectorAll) {
					root.querySelectorAll('iframe[src*="player.vimeo.com/video"]').forEach(hook);
				}
			} catch (e) {}
		};

		onReady(() => scanRoot(document));
		// Só percorre os nós inseridos, não o documento inteiro a cada mutação
		onDomChange((muts) => {
			for (const m of muts) {
				for (const n of m.addedNodes) { if (n.nodeType === 1) { scanRoot(n); } }
			}
		});
	}

	// --- ADAPTADOR: JW Player ---------------------------------------------

	const jwDone = new WeakSet();

	function jwApply() {
		if (!settings.jwplayer || typeof W.jwplayer !== "function") { return; }

		const forceMax = (p) => {
			if (!p || typeof p.getQualityLevels !== "function" || jwDone.has(p)) { return; }
			jwDone.add(p);
			const apply = () => {
				try {
					const levels = p.getQualityLevels() || [];
					if (levels.length < 2) { return; }
					// índice 0 é sempre "Auto" em streams adaptativos; a ordem não é garantida
					let best = -1, bestScore = -1;
					levels.forEach((l, i) => {
						if (/auto/i.test(l.label || "")) { return; }
						const score = (l.height || 0) * 1e6 + (l.bitrate || 0);
						if (score > bestScore) { bestScore = score; best = i; }
					});
					// Chamar sempre: é isto que desliga o ABR, mesmo que o índice já coincida
					if (best >= 0) { p.setCurrentQuality(best); acao("JW Player -> nível " + best); }
				} catch (e) {}
			};
			try { p.on("levels", apply); } catch (e) {}
			apply();
		};

		try {
			document.querySelectorAll("div.jwplayer[id], .jw-player[id]").forEach((el) => {
				try { forceMax(W.jwplayer(el.id)); } catch (e) {}
			});
			forceMax(W.jwplayer());
		} catch (e) {}
	}

	// --- ADAPTADOR: Video.js ----------------------------------------------

	const vjsDone = new WeakSet();

	function vjsForceMax(player) {
		try {
			if (!player || vjsDone.has(player)) { return; }
			vjsDone.add(player);

			let ql = null;
			try { ql = (typeof player.qualityLevels === "function") ? player.qualityLevels() : null; } catch (e) {}

			if (ql && typeof ql.length === "number") {
				const apply = () => {
					try {
						if (ql.length < 2) { return; }
						let best = -1, bestScore = -1;
						for (let i = 0; i < ql.length; i++) {
							const s = (ql[i].height || 0) * 1e6 + (ql[i].bitrate || 0);
							if (s > bestScore) { bestScore = s; best = i; }
						}
						for (let i = 0; i < ql.length; i++) { ql[i].enabled = (i === best); }
						acao("Video.js -> nível " + best);
					} catch (e) {}
				};
				// Só depois de a lista estabilizar, para não alternar enabled a cada nível novo
				let t = null;
				ql.on("addqualitylevel", () => { clearTimeout(t); t = setTimeout(apply, 300); });
				apply();
			} else {
				const applyVhs = () => {
					try {
						const tech = player.tech(true);
						const vhs = tech && tech.vhs; // ".hls" foi removido no video.js 8
						// O VHS limita por defeito a qualidade ao tamanho do leitor: num
						// player pequeno nunca escolheria 1080p/4K.
						try {
							if (vhs && vhs.options_) {
								vhs.options_.limitRenditionByPlayerDimensions = false;
								vhs.options_.useDevicePixelRatio = false;
							}
						} catch (e) {}
						const reps = (vhs && vhs.representations) ? vhs.representations() : [];
						if (reps.length < 2) { return; }
						const best = reps.reduce((a, b) =>
							(((b.height || 0) * 1e6 + (b.bandwidth || 0)) > ((a.height || 0) * 1e6 + (a.bandwidth || 0))) ? b : a);
						reps.forEach((r) => r.enabled(r.id === best.id));
						acao("Video.js (VHS) -> " + (best.height || best.bandwidth));
					} catch (e) {}
				};
				player.on("loadedmetadata", applyVhs);
				applyVhs();
			}
		} catch (e) {}
	}

	function vjsApply() {
		if (!settings.videojs) { return; }

		// Via 1: registo global (só existe quando o site carrega o video.js por <script>)
		const vjs = W.videojs;
		if (typeof vjs === "function") {
			try {
				const players = (typeof vjs.getAllPlayers === "function") ? vjs.getAllPlayers()
					: Object.values((vjs.getPlayers && vjs.getPlayers()) || vjs.players || {});
				players.filter(Boolean).forEach(vjsForceMax);

				if (!vjsApply.hooked && typeof vjs.hook === "function") {
					vjsApply.hooked = true;
					// try/catch obrigatório: isto corre dentro do construtor do player do site
					vjs.hook("setup", (p) => { try { vjsForceMax(p); } catch (e) {} });
				}
			} catch (e) {}
		}

		// Via 2: o video.js guarda a instância no próprio elemento. Funciona mesmo quando
		// a biblioteca vem empacotada no site e não existe window.videojs — é o caso da
		// maioria das webapps modernas (Odysee, PeerTube, Internet Archive, …).
		try {
			document.querySelectorAll(".video-js, video-js").forEach((el) => {
				const p = el.player;
				if (p && (typeof p.qualityLevels === "function" || typeof p.tech === "function")) {
					vjsForceMax(p);
				}
			});
		} catch (e) {}
	}

	// --- HLS: melhor nível (partilhado pelos dois hooks de hls.js) ---------

	const hlsPickBest = (levels) => levels.reduce((bi, l, i, a) => {
		const b = a[bi];
		if ((l.height || 0) !== (b.height || 0)) { return ((l.height || 0) > (b.height || 0)) ? i : bi; }
		return ((l.bitrate || 0) > (b.bitrate || 0)) ? i : bi;
	}, 0);

	// --- HOOK: hls.js ------------------------------------------------------

	function hlsHook() {
		if (!settings.hlsjs) { return; }

		const pickBest = hlsPickBest;

		const hookInstance = (hls, HlsClass) => {
			try {
				hls.on(HlsClass.Events.MANIFEST_PARSED, (_evt, data) => {
					try {
						if (!settings.hlsjs || !data || !data.levels || data.levels.length < 2) { return; }
						const best = pickBest(data.levels);
						hls.autoLevelCapping = -1;
						hls.startLevel = best; // evita arrancar em qualidade baixa
						hls.loadLevel = best;  // sem flush do buffer
						acao("hls.js -> nível " + best);
					} catch (e) {}
				});
			} catch (e) {}
		};

		const wrap = (v) => {
			if (typeof v !== "function") { return v; }
			return new Proxy(v, {
				construct(target, args, newTarget) {
					try {
						const cfg = args[0];
						if (cfg && typeof cfg === "object") {
							// clone preservando o protótipo (uma cópia "crua" perdia métodos)
							const copy = Object.assign(Object.create(Object.getPrototypeOf(cfg) || null), cfg);
							copy.capLevelToPlayerSize = false;
							args[0] = copy;
						}
					} catch (e) {}
					const inst = Reflect.construct(target, args, newTarget);
					try { hookInstance(inst, target); } catch (e) {}
					return inst;
				}
			});
		};

		onGlobal("Hls", wrap);
	}

	// --- ADAPTADOR: hls.js empacotado (sem window.Hls) ---------------------
	// A maioria das webapps modernas traz o hls.js dentro do próprio bundle,
	// por isso o hook do construtor acima nunca chega a disparar. Aqui vamos
	// à procura da instância já criada, pendurada no <video> ou num componente
	// (Vue/React) acima dele — é o que apanha os players "à medida".

	const hlsTries = new WeakMap();   // instância -> nº de aplicações
	const hlsVideoDone = new WeakSet(); // <video> já resolvido: não voltar a varrer

	const looksLikeHls = (o) => {
		try {
			return !!o && typeof o === "object"
				&& typeof o.attachMedia === "function"
				&& typeof o.destroy === "function"
				&& Array.isArray(o.levels);
		} catch (e) { return false; }
	};

	// Devolve true quando não há mais nada a fazer (conseguido ou desistido)
	function hlsForceMax(hls) {
		try {
			const n = hlsTries.get(hls) || 0;
			if (n >= 3) { return true; } // não lutar contra a escolha do utilizador
			const levels = hls.levels || [];
			if (levels.length < 2) { return false; } // manifesto ainda não chegou
			const best = hlsPickBest(levels);
			// o site pode ter ligado o limite pelo tamanho do leitor
			try { if (hls.config) { hls.config.capLevelToPlayerSize = false; } } catch (e) {}
			hls.autoLevelCapping = -1;
			if (hls.loadLevel === best && hls.nextLevel === best) { return true; }
			hlsTries.set(hls, n + 1);
			hls.nextLevel = best; // troca de nível sem esvaziar o buffer
			hls.loadLevel = best;
			acao("hls.js (bundle) -> nível " + best + " ("
				+ ((levels[best] && levels[best].height) || "?") + "p, tentativa " + (n + 1) + ")");
			return false;
		} catch (e) { return true; }
	}

	// Procura limitada: só propriedades próprias (os expandos que o site pendura,
	// como __vue__ / __reactFiber$ / hls) e com orçamento de nós, para nunca
	// transformar isto num varrimento caro do grafo da página.
	const HLS_PREF = /^_{0,2}(hls|player|media|video|core)/i;

	function findHlsNear(video) {
		let budget = 400;
		const seen = new Set();
		const scan = (obj, depth) => {
			if (budget-- <= 0 || depth > 4 || !obj || typeof obj !== "object" || seen.has(obj)) { return null; }
			seen.add(obj);
			if (looksLikeHls(obj)) { return obj; }
			let keys;
			try { keys = Object.keys(obj); } catch (e) { return null; }
			if (keys.length > 60) { keys = keys.slice(0, 60); }
			// nomes prováveis primeiro: aumenta a hipótese de acertar antes do orçamento acabar
			keys.sort((a, b) => (HLS_PREF.test(b) ? 1 : 0) - (HLS_PREF.test(a) ? 1 : 0));
			for (const k of keys) {
				let v;
				try { v = obj[k]; } catch (e) { continue; } // getters do site podem rebentar
				if (!v || typeof v !== "object") { continue; }
				const hit = scan(v, depth + 1);
				if (hit) { return hit; }
			}
			return null;
		};
		let el = video, hops = 0;
		while (el && hops < 8) {
			const hit = scan(el, 0);
			if (hit) { return hit; }
			el = el.parentElement; hops++;
		}
		return null;
	}

	function hlsGenericApply() {
		if (!settings.hlsGeneric) { return; }
		try {
			todosOsVideos().forEach((v) => {
				if (hlsVideoDone.has(v)) { return; }
				const hls = findHlsNear(v);
				if (!hls) { return; }
				if (!hlsTries.has(hls)) {
					hlsTries.set(hls, 0);
					// A lista de níveis costuma chegar depois de encontrarmos a instância.
					// Cada manifesto novo = vídeo novo: orçamento de tentativas a zero,
					// senão o 2.º vídeo da sessão ficava sem forçagem nenhuma.
					try {
						hls.on("hlsManifestParsed", () => {
							try { hlsTries.set(hls, 0); hlsVideoDone.delete(v); hlsForceMax(hls); } catch (e) {}
						});
					} catch (e) {}
				}
				if (hlsForceMax(hls)) { hlsVideoDone.add(v); }
			});
		} catch (e) {}
	}

	// --- HOOK: dash.js -----------------------------------------------------

	function dashForceMax(player, dashjsRef) {
		try {
			player.updateSettings({ streaming: { abr: {
				autoSwitchBitrate: { video: false, audio: false },
				// não limitar a qualidade ao tamanho do leitor / densidade do ecrã
				limitBitrateByPortal: false,
				usePixelRatioInLimitBitrateByPortal: false
			} } });
		} catch (e) {}
		const apply = () => {
			try {
				if (typeof player.getRepresentationsByType === "function") {
					// dash.js v5: setQualityFor foi removido
					const reps = player.getRepresentationsByType("video");
					if (!reps || reps.length < 2) { return; }
					const best = reps.reduce((a, b) =>
						(((b.bitrateInKbit || b.bandwidth || 0) > (a.bitrateInKbit || a.bandwidth || 0)) ? b : a));
					player.setRepresentationForTypeById("video", best.id);
					acao("dash.js v5 -> " + best.id);
				} else if (typeof player.setQualityFor === "function") {
					const list = player.getBitrateInfoListFor("video");
					if (!list || list.length < 2) { return; }
					const top = list.reduce((a, b) => (b.bitrate > a.bitrate ? b : a));
					player.setQualityFor("video", top.qualityIndex, true);
					acao("dash.js v4 -> " + top.qualityIndex);
				}
			} catch (e) {}
		};
		try {
			const events = (dashjsRef && dashjsRef.MediaPlayer && dashjsRef.MediaPlayer.events) || {};
			player.on(events.STREAM_INITIALIZED || "streamInitialized", apply);
		} catch (e) {}
	}

	function dashHook() {
		if (!settings.dashjs) { return; }
		const hooked = new WeakSet(); // registo nosso: nunca escrever marcadores em objetos do site

		const install = (v) => {
			// try/catch obrigatório: corre dentro do setter de window.dashjs
			try {
				if (v && typeof v.MediaPlayer === "function" && !hooked.has(v)) {
					hooked.add(v);
					const RealMP = v.MediaPlayer;
					const WrapMP = function (...a) {
						const factory = RealMP.apply(this, a);
						try {
							const realCreate = factory.create;
							factory.create = function (...c) {
								const player = realCreate.apply(this, c);
								try { if (settings.dashjs) { dashForceMax(player, v); } } catch (e) {}
								return player;
							};
						} catch (e) {}
						return factory;
					};
					Object.assign(WrapMP, RealMP); // preserva dashjs.MediaPlayer.events
					v.MediaPlayer = WrapMP;
				}
			} catch (e) {}
			return v;
		};

		// install() altera o objeto no sítio e devolve-o: nada é reescrito
		onGlobal("dashjs", install);
	}

	// --- HOOK: Shaka Player ------------------------------------------------

	function shakaHook() {
		if (!settings.shaka) { return; }
		const hooked = new WeakSet();

		const hookPlayer = (player) => {
			try {
				const applyMax = () => {
					try {
						if (!settings.shaka) { return; }
						// abr desligado + sem limitar a qualidade ao tamanho do leitor/ecrã
						player.configure({ abr: { enabled: false, restrictToElementSize: false, restrictToScreenSize: false } });
						const tracks = (typeof player.getVariantTracks === "function" && player.getVariantTracks()) || [];
						if (tracks.length < 2) { return; }
						const best = tracks.reduce((a, b) =>
							(((b.height || 0) * 1e6 + (b.bandwidth || 0)) > ((a.height || 0) * 1e6 + (a.bandwidth || 0))) ? b : a);
						if (best && typeof player.selectVariantTrack === "function") {
							player.selectVariantTrack(best, true);
							acao("shaka -> " + (best.height || best.bandwidth));
						}
					} catch (e) {}
				};
				if (typeof player.addEventListener === "function") {
					player.addEventListener("trackschanged", applyMax);
				}
				applyMax();
			} catch (e) {}
		};

		const install = (v) => {
			try {
				if (v && typeof v.Player === "function" && !hooked.has(v)) {
					hooked.add(v);
					v.Player = new Proxy(v.Player, {
						construct(target, args, newTarget) {
							const inst = Reflect.construct(target, args, newTarget);
							try { hookPlayer(inst); } catch (e) {}
							return inst;
						}
					});
				}
			} catch (e) {}
			return v;
		};

		onGlobal("shaka", install);
	}

	// --- HOOK: manifests DASH (Facebook e outros players fechados) ---------

	let realParseFromString = null;

	function stripMpdDoc(doc) {
		let mudou = false;
		const sets = doc.getElementsByTagName("AdaptationSet");
		for (let i = 0; i < sets.length; i++) {
			const reps = [].slice.call(sets[i].getElementsByTagName("Representation"))
				.filter((r) => r.getAttribute("height"));
			if (reps.length < 2) { continue; } // áudio ou qualidade única: não tocar
			const best = reps.reduce((a, b) =>
				(((+b.getAttribute("height") || 0) > (+a.getAttribute("height") || 0)) ? b : a));
			reps.forEach((r) => { if (r !== best && r.parentNode) { r.parentNode.removeChild(r); mudou = true; } });
			if (mudou) { acao("MPD -> " + best.getAttribute("height") + "p (de " + reps.length + ")"); }
		}
		return mudou;
	}

	function mpdRewriteHook() {
		if (!settings.mpdRewrite) { return; }

		// Via 1: o player lê o MPD com DOMParser
		try {
			realParseFromString = DOMParser.prototype.parseFromString;
			DOMParser.prototype.parseFromString = function (str, type) {
				const doc = realParseFromString.apply(this, arguments);
				try {
					if (settings.mpdRewrite && typeof str === "string" && str.indexOf("<MPD") !== -1) {
						stripMpdDoc(doc);
					}
				} catch (e) {}
				return doc;
			};
		} catch (e) {}

		// Via 2: manifest embutido num <script type="application/json"> do HTML inicial
		const MPD_KEY = "dash_manifest_xml_string";

		const rewriteInlineJson = (node) => {
			try {
				if (!settings.mpdRewrite) { return; }
				if (node.getAttribute("type") !== "application/json") { return; }
				if (node.hasAttribute("data-processed")) { return; } // já lido pelo site
				const txt = node.textContent;
				if (!txt || txt.length > 4e6 || txt.indexOf(MPD_KEY) === -1) { return; }
				const re = new RegExp('"' + MPD_KEY + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "g");
				const novo = txt.replace(re, (m, esc) => {
					try {
						const xml = JSON.parse('"' + esc + '"');
						const parse = realParseFromString || DOMParser.prototype.parseFromString;
						const doc = parse.call(new DOMParser(), xml, "text/xml");
						if (!stripMpdDoc(doc)) { return m; }
						return '"' + MPD_KEY + '":' + JSON.stringify(new XMLSerializer().serializeToString(doc));
					} catch (e) { return m; }
				});
				if (novo !== txt) { node.textContent = novo; acao("MPD inline reescrito"); }
			} catch (e) {}
		};

		onDomChange((muts) => {
			for (const m of muts) {
				for (const n of m.addedNodes) {
					if (n.nodeType === 1 && n.tagName === "SCRIPT") { rewriteInlineJson(n); }
				}
			}
		});
		try {
			document.querySelectorAll('script[type="application/json"]').forEach(rewriteInlineJson);
		} catch (e) {}
	}

	// --- FILTRO DE RESPOSTAS (XHR + fetch) ---------------------------------
	// Instalado uma só vez e com teste de URL barato à cabeça: só as respostas
	// que interessam chegam a ser lidas. transform(texto) -> string | null.

	function installTextResponseFilter(isTarget, transform) {
		// XHR: getters instalados na instância no open(), avaliados só quando
		// alguém lê. Um listener de "load" chegaria TARDE — quem lê em
		// onreadystatechange (readyState 4), como o hls.js, lê primeiro.
		try {
			const XHRP = W.XMLHttpRequest.prototype;
			const dText = Object.getOwnPropertyDescriptor(XHRP, "responseText");
			const dResp = Object.getOwnPropertyDescriptor(XHRP, "response");
			const realOpen = XHRP.open;
			if (dText && dText.get && dResp && dResp.get) {
				XHRP.open = function (method, url) {
					try {
						// o mesmo objeto XHR pode ser reutilizado noutro pedido
						delete this.response; delete this.responseText;
						if (typeof url === "string" && isTarget(url)) {
							let memo, calculado = false;
							const filtrado = () => {
								if (calculado) { return memo; }
								calculado = true;
								try {
									const rt = this.responseType; // definido pela página DEPOIS do open()
									memo = (rt === "" || rt === "text") ? transform(dText.get.call(this)) : null;
								} catch (e) { memo = null; }
								return memo;
							};
							const pronto = () => { try { return this.readyState === 4; } catch (e) { return false; } };

							Object.defineProperty(this, "responseText", {
								configurable: true, enumerable: false,
								get() {
									const raw = dText.get.call(this); // delegar 1º preserva o InvalidStateError nativo
									if (!pronto()) { return raw; }
									const f = filtrado();
									return (typeof f === "string") ? f : raw;
								}
							});
							Object.defineProperty(this, "response", {
								configurable: true, enumerable: false,
								get() {
									if (!pronto()) { return dResp.get.call(this); }
									const f = filtrado();
									return (typeof f === "string") ? f : dResp.get.call(this);
								}
							});
						}
					} catch (e) {}
					return realOpen.apply(this, arguments);
				};
			}
		} catch (e) {}

		try {
			const realFetch = W.fetch;
			if (typeof realFetch !== "function") { return; }
			W.fetch = function (input, init) {
				const p = realFetch.apply(this, arguments);
				let url = "";
				try { url = String((input && input.url) || input || ""); } catch (e) {}
				if (!isTarget(url)) { return p; }
				return p.then((res) => {
					try {
						// 204/205 não podem ter corpo (TypeError); 206 traz Content-Range
						// que deixaria de bater certo com o corpo reescrito
						if (!res || !res.ok || res.status === 204 || res.status === 205 || res.status === 206) { return res; }
						return res.clone().text().then((t) => {
							const f = transform(t);
							if (!f) { return res; }
							const headers = new Headers(res.headers);
							headers.delete("content-length"); // o corpo mudou de tamanho
							const out = new Response(f, { status: res.status, statusText: res.statusText, headers });
							// new Response() perde url/redirected/type — e o hls.js usa
							// response.url como base para resolver URIs relativos
							for (const [k, v] of [["url", res.url], ["redirected", res.redirected], ["type", res.type]]) {
								try { Object.defineProperty(out, k, { value: v, configurable: true }); } catch (e) {}
							}
							return out;
						}).catch(() => res);
					} catch (e) { return res; }
				});
			};
		} catch (e) {}
	}

	// --- HOOK: master playlists HLS (.m3u8) --------------------------------
	// O equivalente do mpdRewriteHook para HLS: deixa no manifesto apenas a
	// variante de maior resolução. Como age na rede, funciona com QUALQUER
	// leitor — hls.js empacotado, HLS nativo (Safari/iOS) ou players fechados.

	function stripM3u8(text) {
		if (typeof text !== "string" || text.length > 4e6) { return null; }
		if (!/^﻿?\s*#EXTM3U/.test(text)) { return null; }
		if (text.indexOf("#EXT-X-STREAM-INF") === -1) { return null; } // playlist de media: não mexer

		const lines = text.split(/\r?\n/);
		const keep = [];      // tudo o resto (#EXT-X-MEDIA, chaves, etc.) fica intacto
		const variants = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.lastIndexOf("#EXT-X-STREAM-INF:", 0) !== 0) { keep.push(line); continue; }
			// o URI é a primeira linha seguinte que não é vazia nem comentário
			let j = i + 1;
			while (j < lines.length && (lines[j].trim() === "" || lines[j].charAt(0) === "#")) { j++; }
			if (j >= lines.length) { keep.push(line); break; } // manifesto truncado: não arriscar
			const res = /RESOLUTION=\d+x(\d+)/i.exec(line);
			const bw = /(?:^|[,:])BANDWIDTH=(\d+)/i.exec(line); // não apanhar AVERAGE-BANDWIDTH
			variants.push({
				h: res ? +res[1] : 0,
				score: (res ? +res[1] : 0) * 1e9 + (bw ? +bw[1] : 0),
				lines: [line, lines[j]]
			});
			i = j;
		}

		if (variants.length < 2) { return null; }
		const best = variants.reduce((a, b) => (b.score > a.score ? b : a));
		acao("m3u8 -> " + (best.h || "?") + "p (de " + variants.length + " variantes)");
		return keep.concat(best.lines).join("\n");
	}

	function m3u8RewriteHook() {
		if (!settings.m3u8Rewrite) { return; }
		const isM3u8 = (url) => /\.m3u8(\?|#|$)/i.test(url);
		installTextResponseFilter(isM3u8, (t) => (settings.m3u8Rewrite ? stripM3u8(t) : null));
	}

	// --- RESOLUÇÃO ATUAL (só na consola, com debug ligado) -----------------
	// videoWidth/videoHeight dão sempre a resolução real a ser reproduzida,
	// seja qual for o leitor (funciona também com blob:/MSE). Nada no ecrã:
	// isto é diagnóstico, não é para aparecer por cima do site.

	const resWatched = new WeakSet();

	function resLogWatch(video) {
		if (resWatched.has(video)) { return; }
		resWatched.add(video);
		const diz = () => {
			try {
				const w = video.videoWidth, h = video.videoHeight;
				if (w && h) { debugLog("resolução -> " + w + "x" + h); }
			} catch (e) {}
		};
		// "resize" no <video> dispara sempre que videoWidth/videoHeight mudam,
		// ou seja, exatamente quando o streaming adaptativo troca de nível
		for (const ev of ["resize", "loadedmetadata"]) {
			try { video.addEventListener(ev, diz); } catch (e) {}
		}
		diz();
	}

	function resLogApply() {
		if (!settings.debug) { return; } // sem debug não se liga sequer aos eventos
		try { todosOsVideos().forEach(resLogWatch); } catch (e) {}
	}

	// --- HOOK: manifest do vimeo.com --------------------------------------
	// Instalado APENAS em domínios Vimeo — não faz sentido reescrever fetch/XHR
	// em todos os sites do mundo por causa de um só serviço.

	function vimeoManifestHook() {
		if (!settings.vimeo || !hostMatches(/(^|\.)vimeo\.com$/)) { return; }

		const isManifest = (url) => /vimeocdn\.com/i.test(url) && /vod-adaptive|playlist|master/i.test(url);

		const filterManifest = (obj) => {
			if (!obj || !Array.isArray(obj.video) || obj.video.length < 2) { return null; }
			const score = (r) => (r.height || 0) * 1e6 + (r.bitrate || r.bandwidth || 0);
			const best = obj.video.reduce((a, b) => (score(b) > score(a) ? b : a));
			if (!best) { return null; }
			acao("vimeo -> " + (best.height || best.bitrate) + " (de " + obj.video.length + ")");
			return Object.assign({}, obj, { video: [best] });
		};

		const tryFilterText = (text) => {
			// regex ancorada: o teste antigo (text[0] !== "{") falhava com BOM ou espaço inicial
			if (typeof text !== "string" || text.length > 8e6 || !/^[\s﻿]*\{/.test(text)) { return null; }
			let parsed;
			try { parsed = JSON.parse(text); } catch (e) { return null; }
			const f = filterManifest(parsed);
			return f ? JSON.stringify(f) : null;
		};

		// Getters instalados na instância no open(), avaliados só quando alguém lê.
		// Um listener de "load" chegaria TARDE: quem lê em onreadystatechange
		// (readyState 4) — como o hls.js — lê sempre antes de qualquer "load".
		try {
			const XHRP = W.XMLHttpRequest.prototype;
			const dText = Object.getOwnPropertyDescriptor(XHRP, "responseText");
			const dResp = Object.getOwnPropertyDescriptor(XHRP, "response");
			const realOpen = XHRP.open;
			if (dText && dText.get && dResp && dResp.get) {
				XHRP.open = function (method, url) {
					try {
						// o mesmo objeto XHR pode ser reutilizado noutro pedido
						delete this.response; delete this.responseText;
						if (typeof url === "string" && isManifest(url)) {
							let memo, calculado = false;
							const filtrado = () => {
								if (calculado) { return memo; }
								calculado = true;
								try {
									// responseType é definido pela página DEPOIS do open()
									const rt = this.responseType;
									memo = (rt === "json") ? filterManifest(dResp.get.call(this))
										: ((rt === "" || rt === "text") ? tryFilterText(dText.get.call(this)) : null);
								} catch (e) { memo = null; }
								return memo;
							};
							const pronto = () => { try { return this.readyState === 4; } catch (e) { return false; } };

							Object.defineProperty(this, "responseText", {
								configurable: true, enumerable: false,
								get() {
									const raw = dText.get.call(this); // delegar 1º preserva o InvalidStateError nativo
									if (!pronto()) { return raw; }
									const f = filtrado();
									return (typeof f === "string") ? f : raw;
								}
							});
							Object.defineProperty(this, "response", {
								configurable: true, enumerable: false,
								get() {
									if (!pronto()) { return dResp.get.call(this); }
									const f = filtrado();
									if (f === null || f === undefined) { return dResp.get.call(this); }
									return (this.responseType === "json") ? f : String(f);
								}
							});
						}
					} catch (e) {}
					return realOpen.apply(this, arguments);
				};
			}
		} catch (e) {}

		try {
			const realFetch = W.fetch;
			if (typeof realFetch === "function") {
				W.fetch = function (input, init) {
					const p = realFetch.apply(this, arguments);
					let url = "";
					try { url = String((input && input.url) || input || ""); } catch (e) {}
					if (!isManifest(url)) { return p; }
					return p.then((res) => {
						try {
							// 204/205 não podem ter corpo (TypeError); 206 traz Content-Range
							// que deixaria de bater certo com o corpo reescrito
							if (!res || !res.ok || res.status === 204 || res.status === 205 || res.status === 206) { return res; }
							return res.clone().text().then((t) => {
								const f = tryFilterText(t);
								if (!f) { return res; }
								const headers = new Headers(res.headers);
								headers.delete("content-length"); // o corpo encolheu
								const out = new Response(f, { status: res.status, statusText: res.statusText, headers });
								// new Response() perde url/redirected/type — e o hls.js usa
								// response.url como base para resolver URIs relativos
								for (const [k, v] of [["url", res.url], ["redirected", res.redirected], ["type", res.type]]) {
									try { Object.defineProperty(out, k, { value: v, configurable: true }); } catch (e) {}
								}
								return out;
							}).catch(() => res);
						} catch (e) { return res; }
					});
				};
			}
		} catch (e) {}
	}

	// --- LISTAS DE QUALIDADE ESCOLHIDAS FORA DO LEITOR ---------------------
	// Há sites que decidem a qualidade ANTES de o leitor existir: entregam ao
	// hls.js/dash um manifesto já de qualidade única e a escolha real está numa
	// lista de variantes nos dados do próprio site. Não havendo leitor onde
	// agir, resta mudar qual dessas variantes está marcada como predefinida.
	//
	// NADA é apagado nem reordenado: só se move a flag de "predefinida" para a
	// variante de maior altura, e apenas quando a lista tem exatamente a forma
	// esperada. O menu do site fica intacto e o utilizador pode voltar atrás.
	// À mínima dúvida sobre a forma da lista, não se toca em nada.

	const QL_FLAG = /^(is)?(default|selected|current)(quality|track|source|media|level)?$/i;
	const QL_ALTURA = /^(height|quality|res|resolution)$/i;
	const QL_MEDIA = /\.(m3u8|mpd|mp4|webm)(\?|#|$)/i;
	const qlVistos = new WeakSet(); // listas já avaliadas: nunca reavaliar

	// Altura utilizável: 240..4320. Um "auto", um 0 ou um [] não contam.
	function qlAltura(o, ks) {
		for (const k of ks) {
			if (!QL_ALTURA.test(k)) { continue; }
			const v = o[k];
			const n = (typeof v === "number") ? v
				: ((typeof v === "string") ? parseInt(v, 10) : NaN);
			if (n >= 240 && n <= 4320) { return n; }
		}
		return 0;
	}

	// Exige uma URL que aponte MESMO para media: é o que separa uma lista de
	// qualidades de vídeo de uma galeria de imagens com height e default.
	function qlTemMedia(o, ks) {
		for (const k of ks) {
			const v = o[k];
			if (typeof v === "string" && v.length < 4096 && QL_MEDIA.test(v)) { return true; }
		}
		return false;
	}

	function qlFlag(o, ks) {
		for (const k of ks) {
			if (o[k] === true && QL_FLAG.test(k)) { return k; }
		}
		return null;
	}

	// Devolve true se mexeu
	function qlUpgrade(arr) {
		if (!Array.isArray(arr) || arr.length < 2 || arr.length > 200) { return false; }
		if (qlVistos.has(arr)) { return false; }

		const alturas = [], temMedia = [];
		let comAltura = 0, comMedia = 0, nFlags = 0, flagKey = null, flagIdx = -1;

		for (let i = 0; i < arr.length; i++) {
			const o = arr[i];
			if (!o || typeof o !== "object" || Array.isArray(o)) { return false; }
			let ks;
			try { ks = Object.keys(o); } catch (e) { return false; }
			if (ks.length > 60) { return false; }
			alturas[i] = qlAltura(o, ks);
			if (alturas[i]) { comAltura++; }
			temMedia[i] = qlTemMedia(o, ks);
			if (temMedia[i]) { comMedia++; }
			const f = qlFlag(o, ks);
			if (f) { nFlags++; flagKey = f; flagIdx = i; }
		}

		// as três condições, todas obrigatórias
		if (comAltura < 2 || comMedia < 2 || nFlags !== 1) { return false; }

		// a melhor só pode sair de entre as que têm mesmo URL de media
		let melhor = -1;
		for (let i = 0; i < arr.length; i++) {
			if (!temMedia[i] || !alturas[i]) { continue; }
			if (melhor < 0 || alturas[i] > alturas[melhor]) { melhor = i; }
		}
		if (melhor < 0) { return false; }

		qlVistos.add(arr);
		if (melhor === flagIdx) { return false; } // já estava na melhor
		// nunca inventar propriedades: a chave tem de já existir no destino
		if (!Object.prototype.hasOwnProperty.call(arr[melhor], flagKey)) { return false; }

		try {
			arr[flagIdx][flagKey] = false;
			arr[melhor][flagKey] = true;
		} catch (e) { return false; }
		acao("lista de qualidades -> " + alturas[melhor] + "p (o site queria "
			+ alturas[flagIdx] + "p, via " + flagKey + ")");
		return true;
	}

	// Travessia com orçamento de nós: nunca se transforma num varrimento caro
	function qlScan(raiz, orc) {
		let mexeu = false;
		const vistos = new Set();
		const anda = (o, prof) => {
			if (orc.n <= 0 || prof > 6 || !o || typeof o !== "object") { return; }
			if (vistos.has(o)) { return; }
			vistos.add(o);
			orc.n--;
			if (Array.isArray(o)) {
				if (qlUpgrade(o)) { mexeu = true; return; }
				for (let i = 0; i < o.length && i < 200; i++) { anda(o[i], prof + 1); }
				return;
			}
			let ks;
			try { ks = Object.keys(o); } catch (e) { return; }
			if (ks.length > 200) { return; }
			for (const k of ks) {
				let v;
				try { v = o[k]; } catch (e) { continue; } // getters do site podem rebentar
				if (v && typeof v === "object") { anda(v, prof + 1); }
			}
		};
		try { anda(raiz, 0); } catch (e) {}
		return mexeu;
	}

	function qualityListHook() {
		if (!settings.qualityList) { return; }

		// Via 1: JSON.parse — apanha a esmagadora maioria dos sites.
		// Filtro barato à cabeça: sem um sufixo de media no texto cru, nem se olha.
		try {
			const realParse = JSON.parse;
			JSON.parse = function (texto) {
				const out = realParse.apply(this, arguments);
				try {
					if (settings.qualityList && out && typeof out === "object"
						&& typeof texto === "string" && texto.length < 8e6
						&& /\.(m3u8|mpd|mp4|webm)/i.test(texto)) {
						qlScan(out, { n: 3000 });
					}
				} catch (e) {}
				return out;
			};
		} catch (e) {}

		// Via 2: res.json() — o fetch não passa pelo JSON.parse da página
		try {
			const RP = W.Response && W.Response.prototype;
			const realJson = RP && RP.json;
			if (typeof realJson === "function") {
				RP.json = function () {
					return realJson.apply(this, arguments).then((out) => {
						try {
							if (settings.qualityList && out && typeof out === "object") {
								qlScan(out, { n: 3000 });
							}
						} catch (e) {}
						return out;
					});
				};
			}
		} catch (e) {}

		// Via 3: globais da página definidos por <script> inline.
		// É o único caminho quando a lista vem escrita no HTML (o Chrome já não
		// deixa reescrever um <script> inline antes de ele correr). Funciona
		// porque o leitor costuma vir num <script> externo, carregado depois.
		let varridos = 0, parou = false, ultimoN = -1;
		const varrerGlobais = () => {
			if (parou || !settings.qualityList) { return; }
			if (++varridos > 40) { parar(); return; }
			let ks;
			try { ks = Object.keys(W); } catch (e) { return; }
			if (ks.length > 800) { parar(); return; }
			// travão barato: sem globais novos desde a última vez, não há nada
			// que possa ter aparecido — é o que torna os varrimentos frequentes
			// praticamente gratuitos
			if (ks.length === ultimoN) { return; }
			ultimoN = ks.length;
			const orc = { n: 6000 };
			for (const k of ks) {
				if (orc.n <= 0) { break; }
				let v;
				try { v = W[k]; } catch (e) { continue; }
				if (!v || typeof v !== "object") { continue; }
				// nunca entrar em nós do DOM nem noutras janelas
				if (v === W || v === W.document || typeof v.nodeType === "number") { continue; }
				if (v.window === v || typeof v.postMessage === "function") { continue; }
				try { if (qlScan(v, orc)) { parar(); return; } } catch (e) {}
			}
		};
		const parar = () => {
			parou = true;
			try { document.removeEventListener("load", varrerGlobais, true); } catch (e) {}
		};
		// o "load" de cada <script> passa pela captura no document antes de o
		// site lhe tocar: é a janela para corrigir a lista a tempo
		try { document.addEventListener("load", varrerGlobais, true); } catch (e) {}
		// e um <script> inline não dispara "load" nenhum: aí o aviso vem do
		// observador de DOM, logo a seguir ao script correr e definir o global
		onDomChange((muts) => {
			if (parou) { return; }
			for (const m of muts) {
				for (const n of m.addedNodes) {
					if (n.nodeType === 1 && n.tagName === "SCRIPT") { varrerGlobais(); return; }
				}
			}
		});
		onReady(varrerGlobais);
		setTimeout(parar, 15000);
	}

	// --- REDE DE SEGURANÇA -------------------------------------------------
	// Se o script mexeu nesta página e, apesar disso, um vídeo ficou preso a
	// tentar arrancar, assume-se que a culpa é nossa: o script desliga-se neste
	// domínio e a página recarrega uma vez. Antes um site a funcionar sem
	// melhoria nenhuma do que um site estragado.
	//
	// As condições são de propósito apertadas, para nunca disparar à toa:
	//   - o script tem de ter mesmo alterado alguma coisa nesta página
	//   - o vídeo tem de estar a TENTAR tocar (paused=false), não em pausa
	//   - readyState < 3: não tem sequer dados para continuar
	//   - currentTime congelado o tempo todo
	// Um vídeo em pausa, com autoplay bloqueado, ou a carregar mas a progredir,
	// nunca chega a acordar isto.

	const CAO_MS = 12000;
	const caoEstado = new WeakMap();
	let caoTimer = null, caoDisparado = false, caoTicks = 0;

	function caoDispara() {
		caoDisparado = true;
		caoPara();
		if (!desativarSite("um vídeo ficou " + (CAO_MS / 1000) + " s preso a tentar arrancar")) { return; }
		// recarrega no máximo uma vez por separador e por domínio: nunca um ciclo
		try {
			const marca = "maxq-recarregado";
			if (sessionStorage.getItem(marca) === location.hostname) { return; }
			sessionStorage.setItem(marca, location.hostname);
			location.reload();
		} catch (e) {} // sem sessionStorage não se arrisca recarregar
	}

	function caoPara() {
		if (caoTimer) { clearInterval(caoTimer); caoTimer = null; }
	}

	function caoTick() {
		if (caoDisparado || !settings.autoDisable) { caoPara(); return; }
		if (++caoTicks > 600) { caoPara(); return; } // ~10 min e desiste
		let videos;
		try { videos = todosOsVideos(); } catch (e) { return; }
		if (!videos.length) { return; }
		if (!houveAcao) { return; } // não mexemos em nada: não é problema nosso
		for (const v of videos) {
			let st = caoEstado.get(v);
			if (!st) { st = { desde: 0, tempo: -1 }; caoEstado.set(v, st); }
			let tempo, tentando;
			try {
				tempo = v.currentTime;
				tentando = !v.paused && !v.ended && v.readyState < 3;
			} catch (e) { continue; }
			if (!tentando || tempo !== st.tempo) { st.desde = 0; st.tempo = tempo; continue; }
			if (!st.desde) { st.desde = Date.now(); continue; }
			if (Date.now() - st.desde >= CAO_MS) { caoDispara(); return; }
		}
	}

	function caoArranca() {
		if (!settings.autoDisable || caoTimer || caoDisparado) { return; }
		caoTimer = setInterval(caoTick, 1000);
	}

	// --- MENU DO GESTOR ----------------------------------------------------
	// Saída de emergência a um clique, no ícone do Tampermonkey, sem ter de
	// procurar nada no separador Armazenamento.

	function registarMenu() {
		if (typeof GM_registerMenuCommand !== "function") { return; }
		const recarrega = () => { try { location.reload(); } catch (e) {} };
		try {
			if (estaDesativado()) {
				GM_registerMenuCommand("✅ Reativar neste site", () => {
					if (reativarSite()) { recarrega(); }
				});
			} else {
				GM_registerMenuCommand("⛔ Desativar neste site", () => {
					if (desativarSite("desativado pelo utilizador")) { recarrega(); }
				});
			}
			GM_registerMenuCommand(
				(settings.debug ? "🔇 Desligar" : "🔊 Ligar") + " mensagens na consola",
				() => {
					try { GM_setValue("debug", !settings.debug); recarrega(); } catch (e) {}
				});
		} catch (e) {}
	}

	// --- ARRANQUE ----------------------------------------------------------

	function startAdapters() {
		try { ytAdapter(); } catch (e) {}
		try { twitchAdapter(); } catch (e) {}
		try { vimeoAdapter(); } catch (e) {}

		// JW Player / Video.js carregam tarde: janela curta de scan por ativação,
		// renovada no máximo uma vez a cada 5 s (evita polling permanente).
		const scanAll = () => {
			try { jwApply(); } catch (e) {}
			try { vjsApply(); } catch (e) {}
			try { hlsGenericApply(); } catch (e) {}
			try { resLogApply(); } catch (e) {}
			try { caoArranca(); } catch (e) {} // rede de segurança, só onde há vídeo
		};
		let timer = null, ticks = 0, lastStart = 0;

		const startScan = () => {
			const agora = Date.now();
			if (timer) {
				if (agora - lastStart > 5000) { ticks = 0; lastStart = agora; } // renova a janela
				return;
			}
			lastStart = agora; ticks = 0;
			timer = setInterval(() => {
				scanAll();
				if (++ticks >= 40) { clearInterval(timer); timer = null; } // ~20 s por ativação
			}, 500);
		};

		window.addEventListener("loadstart", (e) => {
			if (e.target instanceof HTMLMediaElement) { startScan(); }
		}, true);

		onReady(() => {
			if (todosOsVideos().length || document.querySelector(".jwplayer, .video-js")) { startScan(); }
		});

		onDomChange((muts) => {
			for (const m of muts) {
				for (const n of m.addedNodes) {
					if (n.nodeType === 1 &&
						(n.matches?.("video, .jwplayer, .video-js") || n.querySelector?.("video, .jwplayer, .video-js"))) {
						startScan();
						return;
					}
				}
			}
		});
	}

	// 1) Definições primeiro (síncrono), para os hooks respeitarem os interruptores
	const sync = loadSettingsSync();

	// 2) Menu do gestor: tem de existir mesmo em sites desativados, senão o
	//    utilizador fica sem forma de voltar a ligar o script aqui
	registarMenu();

	// 3) Saída de emergência: neste domínio não se instala absolutamente nada
	if (estaDesativado()) {
		debugLog("desativado neste site — nada foi instalado");
		return;
	}

	// 4) Hooks de document-start
	ytStorageBoot();
	twitchStorageBoot();
	hlsHook();
	dashHook();
	shakaHook();
	mpdRewriteHook();
	m3u8RewriteHook();
	qualityListHook();
	vimeoManifestHook();

	// 5) Adaptadores de runtime
	if (sync) {
		startAdapters();
	} else {
		// Gestor sem API síncrona: carregar e só depois arrancar (com .catch para
		// uma falha do armazenamento não desativar tudo em silêncio)
		loadSettingsAsync().catch(() => {}).then(startAdapters).catch(() => {});
	}
})();
