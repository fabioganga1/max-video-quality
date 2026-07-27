// ==UserScript==
// @name          Max Video Quality (todos os sites)
// @namespace     https://github.com/fabioganga1
// @version       1.3.0
// @description   Qualidade máxima automática em todos os sites: YouTube, Twitch, Vimeo, JW Player, Video.js, hls.js, dash.js
// @author        fabioganga1
// @homepageURL   https://github.com/fabioganga1/max-video-quality
// @downloadURL   https://raw.githubusercontent.com/fabioganga1/max-video-quality/main/max-video-quality.user.js
// @updateURL     https://raw.githubusercontent.com/fabioganga1/max-video-quality/main/max-video-quality.user.js
// @match         *://*/*
// @run-at        document-start
// @sandbox       raw
// @grant         unsafeWindow
// @grant         GM.getValue
// @grant         GM.setValue
// ==/UserScript==

// Corre em todos os sites e frames (necessário para apanhar players embebidos em iframes).
// Em páginas sem vídeo não faz praticamente nada: os hooks são passivos e o scan
// só arranca quando é detetado um <video> ou um container de player.
// Se algum site der problemas: Dashboard -> nome do script -> Settings -> "User excludes" -> Add.

(function () {
	"use strict";

	// unsafeWindow = window real da página (Tampermonkey @sandbox raw)
	const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

	// --- DEFINIÇÕES ------------------------------------------------------
	// Guardadas no 1º arranque (aba "Storage" do Tampermonkey). Para reaplicar
	// alterações feitas aqui no código, põe overwriteStoredSettings: true uma vez.
	const settings = {
		youtube: true,
		youtubeTargetRes: "highest", // "highest" | "hd2160" | "hd1440" | "hd1080" | ...
		twitch: true,
		twitchSpoofVisibility: false, // impede baixar qualidade em tab de fundo (tem efeitos secundários)
		vimeoEmbeds: true,
		jwplayer: true,
		videojs: true,
		hlsjs: true,
		dashjs: true,
		debug: false,
		overwriteStoredSettings: false
	};

	const debugLog = (msg) => { if (settings.debug) console.log(`MAXQ | ${msg}`); };

	// --- HELPERS ---------------------------------------------------------

	function onReady(fn) {
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", fn, { once: true });
		} else {
			fn();
		}
	}

	function observeDom(fn) {
		onReady(() => {
			new MutationObserver(fn).observe(document.documentElement, { childList: true, subtree: true });
		});
	}

	const hostMatches = (re) => re.test(location.hostname);

	// --- ADAPTADOR: YouTube (site + embeds) ------------------------------

	// Alturas numéricas de cada nível (o YouTube guarda a preferência como número)
	const YT_NUM = { highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };

	function ytWriteStoredQuality(level) {
		// Formato atual do YouTube (verificado jul/2026):
		// {"data":"{\"quality\":2160,\"previousQuality\":720}","expiration":...,"creation":...}
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
		// Em document-start, antes do player arrancar: assim o próprio YouTube já
		// escolhe alto à partida e o menu mostra a qualidade (não "Auto")
		if (!hostMatches(/(^|\.)youtube(-nocookie)?\.com$/)) { return; }
		ytWriteStoredQuality(settings.youtubeTargetRes === "highest" ? "hd2160" : settings.youtubeTargetRes);
	}

	function ytAdapter() {
		if (!settings.youtube || !hostMatches(/(^|\.)youtube(-nocookie)?\.com$/)) { return; }

		let appliedFor = "";    // vídeo onde já aplicámos
		let appliedTarget = ""; // qualidade aplicada nesse vídeo

		const videoIdOf = (p) => {
			try {
				const m = /[?&]v=([\w-]+)/.exec((p.getVideoUrl && p.getVideoUrl()) || "");
				return m ? m[1] : location.href;
			} catch (e) { return location.href; }
		};

		const apply = () => {
			const p = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
			if (!p || typeof p.getPlaybackQuality !== "function") { return; }
			if (p.getPlaybackQuality() === "unknown") { return; }

			const levels = ((typeof p.getAvailableQualityLevels === "function" && p.getAvailableQualityLevels()) || [])
				.filter((l) => l !== "auto");
			if (!levels.length) { return; }

			// levels vem por ordem decrescente; usa o alvo se existir, senão o melhor disponível
			let target = (settings.youtubeTargetRes === "highest") ? levels[0] : settings.youtubeTargetRes;
			if (!levels.includes(target)) { target = levels[0]; }

			// Re-aplica se o vídeo mudou OU se entretanto apareceu um nível melhor
			// (o YouTube às vezes só revela o 4K/8K uns segundos depois do arranque).
			// Se o utilizador baixar manualmente, não lutamos: id e target não mudam.
			const id = videoIdOf(p);
			if (id === appliedFor && target === appliedTarget) { return; }
			appliedFor = id;
			appliedTarget = target;

			if (typeof p.setPlaybackQualityRange === "function") { p.setPlaybackQualityRange(target); }
			p.setPlaybackQuality(target);
			ytWriteStoredQuality(target);

			debugLog("YouTube -> " + target);
		};

		window.addEventListener("loadstart", (e) => {
			if (e.target instanceof HTMLMediaElement) { setTimeout(apply, 0); }
		}, true);
		window.addEventListener("yt-navigate-finish", () => { appliedFor = ""; setTimeout(apply, 300); }, true);

		// Watchdog permanente e leve (só em páginas YouTube): apanha navegação SPA,
		// vídeos novos e níveis que aparecem tarde — sem janela que expira
		setInterval(() => { try { apply(); } catch (e) {} }, 1000);
	}

	// --- ADAPTADOR: Twitch -----------------------------------------------

	function twitchStorageBoot() {
		// Tem de correr ANTES do player arrancar (document-start): "chunked" = Source
		if (!hostMatches(/(^|\.)twitch\.tv$/)) { return; }
		try { localStorage.setItem("video-quality", JSON.stringify({ default: "chunked" })); } catch (e) {}
	}

	function twitchAdapter() {
		if (!settings.twitch || !hostMatches(/(^|\.)twitch\.tv$/)) { return; }

		// Player interno via React fiber (padrão dos scripts mantidos em 2026)
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

		const apply = () => {
			const player = findPlayer(document.querySelector("video"));
			if (!player) { return; }
			const qs = (player.getQualities && player.getQualities()) || [];
			if (qs.length < 2) { return; }

			const best = qs.slice().sort((a, b) =>
				((b.height || 0) - (a.height || 0)) || ((b.framerate || 0) - (a.framerate || 0)))[0];
			const cur = player.getQuality?.();
			if (cur && best && (cur.group === best.group || cur.name === best.name)) { return; }

			player.setAutoQualityMode?.(false); // impede o "Auto" de voltar a descer
			player.abrManager?.disable?.();
			if (best) { player.setQuality(best); debugLog("Twitch -> " + (best.name || best.height)); }
		};

		if (settings.twitchSpoofVisibility) {
			try {
				Object.defineProperty(Document.prototype, "hidden", { get: () => false });
				Object.defineProperty(document, "visibilityState", { get: () => "visible" });
				document.hasFocus = () => true;
				for (const ev of ["visibilitychange", "blur"]) {
					document.addEventListener(ev, (e) => e.stopImmediatePropagation(), true);
				}
			} catch (e) {}
		}

		onReady(() => {
			for (const ev of ["loadedmetadata", "playing", "canplay"]) {
				document.addEventListener(ev, apply, true);
			}
			setInterval(() => { try { apply(); } catch (e) {} }, 2000); // watchdog: anúncios/raids/navegação
		});
	}

	// --- ADAPTADOR: embeds Vimeo (postMessage) ---------------------------

	function vimeoAdapter() {
		if (!settings.vimeoEmbeds) { return; }

		if (location.hostname === "player.vimeo.com") {
			// Dentro do próprio embed: só a preferência persistida (best-effort)
			try { localStorage.setItem("sync_quality", JSON.stringify("1080p")); } catch (e) {}
			return;
		}

		// "4k"/"2k" não podem ser ordenados por parseInt
		const rank = (id) => id === "4k" ? 2160 : id === "2k" ? 1440 : (parseInt(id, 10) || 0);
		const seen = new WeakSet();

		function hook(iframe) {
			if (seen.has(iframe)) { return; }
			seen.add(iframe);
			const post = (o) => {
				try { iframe.contentWindow.postMessage(JSON.stringify(o), "https://player.vimeo.com"); } catch (e) {}
			};
			window.addEventListener("message", (e) => {
				if (e.origin !== "https://player.vimeo.com" || e.source !== iframe.contentWindow) { return; }
				let d;
				try { d = (typeof e.data === "string") ? JSON.parse(e.data) : e.data; } catch { return; }
				if (d.event === "ready" || d.method === "ping") { post({ method: "getQualities" }); }
				if (d.method === "getQualities" && Array.isArray(d.value)) {
					const best = d.value.map((q) => q.id).filter((id) => id !== "auto")
						.sort((a, b) => rank(b) - rank(a))[0];
					if (best) { post({ method: "setQuality", value: best }); debugLog("Vimeo -> " + best); }
				}
			});
			post({ method: "ping" }); // o player responde quando estiver pronto
		}

		const scan = () => document.querySelectorAll('iframe[src*="player.vimeo.com/video"]').forEach(hook);
		onReady(scan);
		observeDom(scan);
	}

	// --- ADAPTADOR: JW Player 8 ------------------------------------------

	function jwApply() {
		if (!settings.jwplayer || typeof W.jwplayer !== "function") { return; }

		function forceMax(p) {
			if (!p || typeof p.getQualityLevels !== "function" || p.__maxq) { return; }
			p.__maxq = true;
			const apply = () => {
				const levels = p.getQualityLevels() || [];
				if (levels.length < 2) { return; }
				// índice 0 é sempre "Auto" em streams adaptativos; ordem não garantida -> calcular
				let best = -1, bestScore = -1;
				levels.forEach((l, i) => {
					if (/auto/i.test(l.label || "")) { return; }
					const score = (l.height || 0) * 1e6 + (l.bitrate || 0);
					if (score > bestScore) { bestScore = score; best = i; }
				});
				if (best >= 0 && p.getCurrentQuality() !== best) {
					p.setCurrentQuality(best); // nota: fixa a qualidade (desativa ABR)
					debugLog("JW Player -> nível " + best);
				}
			};
			p.on("levels", apply);
			apply();
		}

		document.querySelectorAll("div.jwplayer[id], .jw-player[id]").forEach((el) => {
			try { forceMax(W.jwplayer(el.id)); } catch (e) {}
		});
		try { forceMax(W.jwplayer()); } catch (e) {}
	}

	// --- ADAPTADOR: Video.js 8 -------------------------------------------

	function vjsApply() {
		const vjs = W.videojs;
		if (!settings.videojs || typeof vjs !== "function") { return; }

		function forceMax(player) {
			if (!player || player.__maxq) { return; }
			player.__maxq = true;

			let ql = null;
			try { ql = (typeof player.qualityLevels === "function") ? player.qualityLevels() : null; } catch (e) {}

			if (ql && typeof ql.length === "number") {
				// plugin videojs-contrib-quality-levels (caminho standard)
				const apply = () => {
					let best = -1, bestScore = -1;
					for (let i = 0; i < ql.length; i++) {
						const s = (ql[i].height || 0) * 1e6 + (ql[i].bitrate || 0);
						if (s > bestScore) { bestScore = s; best = i; }
					}
					for (let i = 0; i < ql.length; i++) { ql[i].enabled = (i === best); }
					if (best >= 0) { debugLog("Video.js -> nível " + best); }
				};
				ql.on("addqualitylevel", apply);
				apply();
			} else {
				// fallback: API interna do VHS (".hls" foi removido no video.js 8 — só ".vhs")
				const applyVhs = () => {
					try {
						const vhs = player.tech(true) && player.tech(true).vhs;
						const reps = (vhs && vhs.representations) ? vhs.representations() : [];
						if (!reps.length) { return; }
						const best = reps.reduce((a, b) =>
							(((b.height || 0) * 1e6 + (b.bandwidth || 0)) > ((a.height || 0) * 1e6 + (a.bandwidth || 0))) ? b : a);
						reps.forEach((r) => r.enabled(r.id === best.id));
						debugLog("Video.js (VHS) -> " + (best.height || best.bandwidth));
					} catch (e) {}
				};
				player.on("loadedmetadata", applyVhs);
				applyVhs();
			}
		}

		const players = (typeof vjs.getAllPlayers === "function") ? vjs.getAllPlayers()
			: Object.values((vjs.getPlayers && vjs.getPlayers()) || vjs.players || {});
		players.filter(Boolean).forEach(forceMax);

		// apanhar players futuros sem polling (API oficial de hooks)
		if (!vjs.__maxqHook && typeof vjs.hook === "function") {
			vjs.__maxqHook = true;
			vjs.hook("setup", forceMax);
		}
	}

	// --- HOOK: hls.js (instalar em document-start) -----------------------

	function hlsHook() {
		// desde hls.js 1.5 os níveis são ordenados por altura/fps/codec — escolher explicitamente
		const pickBest = (levels) => levels.reduce((bi, l, i, a) => {
			const b = a[bi];
			if ((l.height || 0) !== (b.height || 0)) { return ((l.height || 0) > (b.height || 0)) ? i : bi; }
			return ((l.bitrate || 0) > (b.bitrate || 0)) ? i : bi;
		}, 0);

		const hookInstance = (hls, HlsClass) => {
			try {
				hls.on(HlsClass.Events.MANIFEST_PARSED, (_evt, data) => {
					if (!settings.hlsjs || !data || !data.levels || data.levels.length < 2) { return; }
					const best = pickBest(data.levels);
					hls.autoLevelCapping = -1;
					hls.startLevel = best;  // evita arrancar em qualidade baixa
					hls.loadLevel = best;   // sem flush do buffer (currentLevel interromperia o vídeo)
					debugLog("hls.js -> nível " + best);
				});
			} catch (e) {}
		};

		function wrap(v) {
			if (typeof v !== "function") { return v; }
			return new Proxy(v, {
				construct(target, args, newTarget) {
					args[0] = Object.assign({}, args[0], { capLevelToPlayerSize: false });
					const inst = Reflect.construct(target, args, newTarget);
					hookInstance(inst, target);
					return inst;
				}
			});
		}

		try {
			let Real, Wrapped;
			if (W.Hls) { Real = W.Hls; Wrapped = wrap(Real); } // já perdemos a corrida? embrulha na mesma
			Object.defineProperty(W, "Hls", {
				configurable: true,
				get() { return Wrapped; },
				set(v) { Real = v; Wrapped = wrap(v); }
			});
		} catch (e) {}
	}

	// --- HOOK: dash.js (instalar em document-start) ----------------------

	function dashForceMax(player, dashjsRef) {
		if (!settings.dashjs) { return; }
		try {
			player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false, audio: false } } } });
		} catch (e) {}
		const apply = () => {
			try {
				if (typeof player.getRepresentationsByType === "function") {
					// dash.js v5 (2025+): setQualityFor foi removido
					const reps = player.getRepresentationsByType("video");
					if (!reps || !reps.length) { return; }
					const best = reps.reduce((a, b) =>
						(((b.bitrateInKbit || b.bandwidth || 0) > (a.bitrateInKbit || a.bandwidth || 0)) ? b : a));
					player.setRepresentationForTypeById("video", best.id);
					debugLog("dash.js v5 -> " + best.id);
				} else if (typeof player.setQualityFor === "function") {
					// dash.js v4
					const list = player.getBitrateInfoListFor("video");
					if (!list || !list.length) { return; }
					const top = list.reduce((a, b) => (b.bitrate > a.bitrate ? b : a));
					player.setQualityFor("video", top.qualityIndex, true);
					debugLog("dash.js v4 -> " + top.qualityIndex);
				}
			} catch (e) {}
		};
		const events = (dashjsRef && dashjsRef.MediaPlayer && dashjsRef.MediaPlayer.events) || {};
		player.on(events.STREAM_INITIALIZED || "streamInitialized", apply);
	}

	function dashHook() {
		try {
			let real;
			const install = (v) => {
				if (v && typeof v.MediaPlayer === "function" && !v.__maxqHooked) {
					const RealMP = v.MediaPlayer;
					const WrapMP = function (...a) {
						const factory = RealMP.apply(this, a);
						const realCreate = factory.create;
						factory.create = function (...c) {
							const player = realCreate.apply(this, c);
							try { dashForceMax(player, v); } catch (e) {}
							return player;
						};
						return factory;
					};
					Object.assign(WrapMP, RealMP); // preserva dashjs.MediaPlayer.events e restantes estáticos
					v.MediaPlayer = WrapMP;
					v.__maxqHooked = true;
				}
				return v;
			};
			if (W.dashjs) { real = install(W.dashjs); }
			Object.defineProperty(W, "dashjs", {
				configurable: true,
				get() { return real; },
				set(v) { real = install(v); }
			});
		} catch (e) {}
	}

	// --- DEFINIÇÕES (GM storage -> aba "Storage" do Tampermonkey) --------

	async function applySettings() {
		if (typeof GM === "undefined" || !GM.getValue || !GM.setValue) { return; }

		const saved = await GM.getValue("SettingsSaved");
		if (settings.overwriteStoredSettings || !saved) {
			await Promise.all(Object.entries(settings).map(([k, v]) => GM.setValue(k, v)));
			await GM.setValue("SettingsSaved", true);
			return;
		}
		const entries = await Promise.all(Object.keys(settings).map(async (k) => [k, await GM.getValue(k)]));
		for (const [k, v] of entries) {
			if (v !== undefined && k !== "overwriteStoredSettings") { settings[k] = v; }
		}
	}

	// --- ARRANQUE --------------------------------------------------------

	// Síncrono, em document-start (não pode esperar pelas definições):
	ytStorageBoot();
	twitchStorageBoot();
	hlsHook();
	dashHook();

	// Assíncrono, depois de carregar definições guardadas:
	applySettings().then(() => {
		ytAdapter();
		twitchAdapter();
		vimeoAdapter();

		// Deteção universal: o scan de JW/Video.js só arranca quando existe vídeo na página
		const scanAll = () => { jwApply(); vjsApply(); };
		let pollTimer = null, tries = 0;
		const startScan = () => {
			tries = 0;
			if (pollTimer) { return; } // já a correr — só reinicia a janela
			pollTimer = setInterval(() => {
				try { scanAll(); } catch (e) {}
				if (++tries >= 60) { clearInterval(pollTimer); pollTimer = null; } // ~30s
			}, 500);
		};

		// 1) qualquer <video> que comece a carregar, em qualquer site
		window.addEventListener("loadstart", (e) => {
			if (e.target instanceof HTMLMediaElement) { startScan(); }
		}, true);

		// 2) players já presentes quando a página carrega
		onReady(() => {
			if (document.querySelector("video, .jwplayer, .video-js")) { startScan(); }
		});

		// 3) players adicionados mais tarde (SPAs, lazy-load)
		observeDom((muts) => {
			for (const m of muts) {
				for (const n of m.addedNodes) {
					if (n.nodeType === 1 && (n.matches?.("video, .jwplayer, .video-js") || n.querySelector?.("video, .jwplayer, .video-js"))) {
						startScan();
						return;
					}
				}
			}
		});
	});
})();
