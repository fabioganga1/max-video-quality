// ==UserScript==
// @name          Max Video Quality
// @namespace     https://github.com/fabioganga1
// @version       2.5.0
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
		showResolution: true, // aviso curto com a resolução atual, ao mudar de nível
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
			debugLog("YouTube -> " + target + " (tentativa " + attempts + ")");
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
			debugLog("Twitch -> " + (best.name || best.height) + " (tentativa " + attempts + ")");
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
					if (best) { post({ method: "setQuality", value: best }); debugLog("Vimeo -> " + best); }
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
					if (best >= 0) { p.setCurrentQuality(best); debugLog("JW Player -> nível " + best); }
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
						debugLog("Video.js -> nível " + best);
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
						debugLog("Video.js (VHS) -> " + (best.height || best.bandwidth));
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
						debugLog("hls.js -> nível " + best);
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

		try {
			let Real, Wrapped;
			if (W.Hls) { Real = W.Hls; Wrapped = wrap(Real); }
			Object.defineProperty(W, "Hls", {
				configurable: true,
				get() { return Wrapped; },
				set(v) { Real = v; Wrapped = wrap(v); }
			});
		} catch (e) {}
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
			debugLog("hls.js (bundle) -> nível " + best + " ("
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
			document.querySelectorAll("video").forEach((v) => {
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
					debugLog("dash.js v5 -> " + best.id);
				} else if (typeof player.setQualityFor === "function") {
					const list = player.getBitrateInfoListFor("video");
					if (!list || list.length < 2) { return; }
					const top = list.reduce((a, b) => (b.bitrate > a.bitrate ? b : a));
					player.setQualityFor("video", top.qualityIndex, true);
					debugLog("dash.js v4 -> " + top.qualityIndex);
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

		try {
			let real;
			if (W.dashjs) { real = install(W.dashjs); }
			Object.defineProperty(W, "dashjs", {
				configurable: true,
				get() { return real; },
				set(v) { real = install(v); }
			});
		} catch (e) {}
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
							debugLog("shaka -> " + (best.height || best.bandwidth));
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

		try {
			let real;
			if (W.shaka) { real = install(W.shaka); }
			Object.defineProperty(W, "shaka", {
				configurable: true,
				get() { return real; },
				set(v) { real = install(v); }
			});
		} catch (e) {}
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
			if (mudou) { debugLog("MPD -> " + best.getAttribute("height") + "p (de " + reps.length + ")"); }
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
				if (novo !== txt) { node.textContent = novo; debugLog("MPD inline reescrito"); }
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
		debugLog("m3u8 -> " + (best.h || "?") + "p (de " + variants.length + " variantes)");
		return keep.concat(best.lines).join("\n");
	}

	function m3u8RewriteHook() {
		if (!settings.m3u8Rewrite) { return; }
		const isM3u8 = (url) => /\.m3u8(\?|#|$)/i.test(url);
		installTextResponseFilter(isM3u8, (t) => (settings.m3u8Rewrite ? stripM3u8(t) : null));
	}

	// --- MOSTRAR A RESOLUÇÃO ATUAL -----------------------------------------
	// videoWidth/videoHeight dão sempre a resolução real a ser reproduzida,
	// seja qual for o leitor (funciona também com blob:/MSE). O aviso aparece
	// uns segundos quando a resolução muda e desaparece sozinho.

	const resWatched = new WeakSet();
	let resBox = null, resTimer = null;

	const resLabel = (w, h) => {
		if (!w || !h) { return ""; }
		// Pelo lado menor: um vídeo de telemóvel 1080×1920 é "1080p", não "1440p"
		const p = Math.min(w, h);
		const nome = (p >= 4320) ? "8K" : (p >= 2160) ? "4K" : (p >= 1440) ? "1440p"
			: (p >= 1080) ? "1080p" : (p >= 720) ? "720p" : p + "p";
		return nome + "  " + w + "×" + h;
	};

	function resShow(video) {
		try {
			if (!settings.showResolution) { return; }
			const w = video.videoWidth, h = video.videoHeight;
			if (!w || !h) { return; }
			const r = video.getBoundingClientRect();
			if (r.width < 200 || r.height < 110) { return; } // ignorar miniaturas e pré-visualizações
			debugLog("resolução -> " + w + "x" + h);

			if (!resBox) {
				resBox = document.createElement("div");
				resBox.style.cssText = [
					"position:fixed", "z-index:2147483647", "pointer-events:none",
					"padding:4px 9px", "border-radius:6px",
					"background:rgba(0,0,0,.72)", "color:#fff",
					"font:600 12px/1.4 system-ui,sans-serif", "letter-spacing:.02em",
					"transition:opacity .25s", "opacity:0"
				].join(";");
			}
			// em ecrã inteiro só o elemento em fullscreen é desenhado
			const host = document.fullscreenElement || document.body;
			if (resBox.parentNode !== host) { host.appendChild(resBox); }
			resBox.textContent = resLabel(w, h);
			resBox.style.left = Math.round(r.left + 10) + "px";
			resBox.style.top = Math.round(r.top + 10) + "px";
			resBox.style.opacity = "1";

			clearTimeout(resTimer);
			resTimer = setTimeout(() => { if (resBox) { resBox.style.opacity = "0"; } }, 2500);
		} catch (e) {}
	}

	function resWatch(video) {
		if (resWatched.has(video)) { return; }
		resWatched.add(video);
		// "resize" no <video> dispara sempre que videoWidth/videoHeight mudam,
		// ou seja, exatamente quando o streaming adaptativo troca de nível
		for (const ev of ["resize", "loadedmetadata", "playing"]) {
			try { video.addEventListener(ev, () => resShow(video)); } catch (e) {}
		}
		resShow(video);
	}

	function resApply() {
		if (!settings.showResolution) { return; }
		try { document.querySelectorAll("video").forEach(resWatch); } catch (e) {}
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
			debugLog("vimeo -> " + (best.height || best.bitrate) + " (de " + obj.video.length + ")");
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
			try { resApply(); } catch (e) {}
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
			if (document.querySelector("video, .jwplayer, .video-js")) { startScan(); }
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

	// 2) Hooks de document-start
	ytStorageBoot();
	twitchStorageBoot();
	hlsHook();
	dashHook();
	shakaHook();
	mpdRewriteHook();
	m3u8RewriteHook();
	vimeoManifestHook();

	// 3) Adaptadores de runtime
	if (sync) {
		startAdapters();
	} else {
		// Gestor sem API síncrona: carregar e só depois arrancar (com .catch para
		// uma falha do armazenamento não desativar tudo em silêncio)
		loadSettingsAsync().catch(() => {}).then(startAdapters).catch(() => {});
	}
})();
