// Leitor de mentira, com a forma de um leitor real: lê a lista de qualidades
// que o HTML deixou num global, escolhe a marcada como predefinida, e entrega
// esse master.m3u8 ao hls.js.
(function () {
	const R = window.__r;
	const diz = (nome, passa, detalhe) => R.push([nome, passa, detalhe]);

	// depois de o bundle carregar, o global tem de existir e estar utilizável
	diz('depois do bundle: "Hls" in window', ("Hls" in window) === true, String("Hls" in window));
	diz("Hls.version legível", window.Hls && window.Hls.version === "1.5.14", String(window.Hls && window.Hls.version));
	diz("Hls.isSupported()", !!(window.Hls && window.Hls.isSupported()), String(window.Hls && window.Hls.isSupported()));

	// a escolha de qualidade, tal como um site a faria
	const defs = window.flashvars_991122.mediaDefinitions;
	const escolhida = defs.filter((d) => d.format === "hls").find((d) => d.defaultQuality === true);
	diz("qualidade escolhida pelo site", !!escolhida && escolhida.height === 1080,
		escolhida ? escolhida.height + "p (" + escolhida.videoUrl + ")" : "nenhuma");
	diz("continua a haver só uma predefinida", defs.filter((d) => d.defaultQuality === true).length === 1,
		String(defs.filter((d) => d.defaultQuality === true).length));
	diz("nenhuma entrada foi apagada", defs.length === 5, String(defs.length));

	if (!escolhida) { render(); return; }

	let hls;
	try {
		hls = new window.Hls({ enableWorker: true, capLevelToPlayerSize: true, maxBufferLength: 30 });
		diz("new Hls(config) constrói", true, "ok");
		diz("capLevelToPlayerSize forçado a false", hls.config.capLevelToPlayerSize === false,
			String(hls.config.capLevelToPlayerSize));
		diz("maxBufferLength do site preservado", hls.config.maxBufferLength === 30,
			String(hls.config.maxBufferLength));
	} catch (e) {
		diz("new Hls(config) constrói", false, e.message);
		render();
		return;
	}

	hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
		// o master servido tem 3 variantes; o corte do .m3u8 deixa só a melhor
		diz("master cortado à melhor variante", data.levels.length === 1,
			data.levels.length + " nível(is): " + data.levels.map((l) => l.height + "p").join(", "));
		diz("nível que ficou é o de 1080p", data.levels[0] && data.levels[0].height === 1080,
			String(data.levels[0] && data.levels[0].height));
		render();
	});
	hls.on(window.Hls.Events.ERROR, (_e, d) => {
		// sem segmentos reais o erro de rede é esperado; o que interessa é que
		// o manifesto foi lido e o nível escolhido antes disso
		if (d.fatal && !R.some((r) => r[0] === "master cortado à melhor variante")) {
			diz("master cortado à melhor variante", false, "erro fatal: " + d.details);
			render();
		}
	});

	hls.loadSource(escolhida.videoUrl);
	hls.attachMedia(document.getElementById("v"));
	setTimeout(render, 4000);

	let feito = false;
	function render() {
		if (feito) { return; }
		feito = true;
		const falhas = R.filter((r) => !r[1]).length;
		document.getElementById("out").innerHTML =
			'<h2 style="margin-top:2rem">' + (falhas ? falhas + " FALHA(S)" : "tudo a passar") + "</h2><ul>" +
			R.map((r) => '<li style="color:' + (r[1] ? "#0a0" : "#c00") + '">' +
				(r[1] ? "ok" : "FALHA") + " — " + r[0] + " <em style=\"color:#666\">(" + r[2] + ")</em></li>").join("") +
			"</ul>";
		window.__resultado = { falhas: falhas, total: R.length, itens: R };
	}
})();
