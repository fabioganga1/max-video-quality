// Detetor de listas de qualidade escolhidas fora do leitor.
//
// Metade do valor destes testes está nos casos negativos: a lista só pode ser
// reconhecida quando tem exatamente a forma esperada. Tudo o resto — imagens,
// idiomas, legendas, capítulos, anúncios — tem de sair intacto.

const fs = require("fs");
const path = require("path");
const { bloco, montar, grupo, ok } = require("./harness");

const ditos = [];
const api = montar(
	bloco("\tconst QL_FLAG", "\tfunction qlScan("),
	{
		settings: { qualityList: true, debug: true },
		debugLog: (m) => ditos.push(m),
		acao: (m) => ditos.push(m) // no script, marca que houve mesmo uma alteração
	},
	"{ qlUpgrade, qlScan }"
);

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "lista-qualidades.json"), "utf8"));
const LISTA = FIXTURE.mediaDefinitions;
const clone = (x) => JSON.parse(JSON.stringify(x));

grupo("Caso real: quatro variantes HLS, o site queria a do meio");
{
	const arr = clone(LISTA);
	ditos.length = 0;
	const mexeu = api.qlUpgrade(arr);
	const marcadas = arr.filter((e) => e.defaultQuality === true);
	ok(mexeu, "reconheceu a lista");
	ok(marcadas.length === 1, "continua a haver exatamente uma predefinida");
	ok(marcadas[0] && marcadas[0].height === 1080, "a predefinida passou a ser a de 1080p");
	ok(marcadas[0] && marcadas[0].format === "hls", "escolheu a entrada HLS, não a mp4 sem manifesto");
	ok(arr.length === LISTA.length, "não foi apagada nenhuma entrada (o menu do site fica intacto)");
	ok(JSON.stringify(arr.map((e) => e.height)) === JSON.stringify(LISTA.map((e) => e.height)),
		"não foi reordenado nada");
	const soAFlag = arr.every((e, i) => Object.keys(e).every((k) =>
		k === "defaultQuality" || JSON.stringify(e[k]) === JSON.stringify(LISTA[i][k])));
	ok(soAFlag, "nenhum outro campo foi tocado");
	ok(/1080p/.test(ditos[0] || ""), "diz o que fez: " + (ditos[0] || "(nada)"));
}

grupo("Encontra a lista lá dentro do objeto do site");
{
	const fv = clone(FIXTURE);
	ok(api.qlScan(fv, { n: 3000 }), "achou a lista dentro do objeto");
	ok(fv.mediaDefinitions.find((e) => e.defaultQuality === true).height === 1080, "1080p marcada");
}

grupo("Idempotência");
{
	const arr = clone(LISTA);
	api.qlUpgrade(arr);
	const depois = JSON.stringify(arr);
	api.qlUpgrade(arr);
	ok(JSON.stringify(arr) === depois, "uma segunda passagem não muda nada");
}

grupo("Nunca tocar: estruturas que se parecem mas não são");
{
	const intocaveis = [
		["galeria de imagens (tem height e default, mas nenhuma media)", [
			{ height: 200, url: "https://x/a.jpg", default: true },
			{ height: 800, url: "https://x/b.jpg", default: false }]],
		["lista de idiomas", [
			{ code: "pt", label: "Português", selected: true },
			{ code: "en", label: "English", selected: false }]],
		["legendas .vtt (sem altura)", [
			{ lang: "pt", src: "https://x/pt.vtt", default: true },
			{ lang: "en", src: "https://x/en.vtt", default: false }]],
		["capítulos do mesmo vídeo (sem alturas)", [
			{ start: 0, title: "Intro", src: "https://x/v.mp4", current: true },
			{ start: 90, title: "Meio", src: "https://x/v.mp4", current: false }]],
		["banners publicitários", [
			{ height: 250, src: "https://ads/a.png", default: true },
			{ height: 600, src: "https://ads/b.png", default: false }]],
		["duas marcadas como predefinida (ambíguo)", [
			{ height: 480, url: "https://x/480.m3u8", default: true },
			{ height: 1080, url: "https://x/1080.m3u8", default: true }]],
		["nenhuma marcada como predefinida", [
			{ height: 480, url: "https://x/480.m3u8", default: false },
			{ height: 1080, url: "https://x/1080.m3u8", default: false }]],
		["alturas fora do intervalo plausível", [
			{ height: 12, url: "https://x/a.m3u8", default: true },
			{ height: 40, url: "https://x/b.m3u8", default: false }]],
		["a chave nem existe na entrada de destino", [
			{ height: 480, url: "https://x/480.m3u8", isDefault: true },
			{ height: 1080, url: "https://x/1080.m3u8" }]],
		["lista de strings", ["1080p", "720p"]],
		["lista com um só elemento", [
			{ height: 1080, url: "https://x/1080.m3u8", default: true }]]
	];
	for (const [nome, arr] of intocaveis) {
		const antes = JSON.stringify(arr);
		api.qlUpgrade(arr);
		ok(JSON.stringify(arr) === antes, nome);
	}
}

grupo("Já estava na melhor");
{
	const arr = [
		{ height: 480, url: "https://x/480.m3u8", default: false },
		{ height: 1080, url: "https://x/1080.m3u8", default: true }];
	const antes = JSON.stringify(arr);
	ok(!api.qlUpgrade(arr) && JSON.stringify(arr) === antes, "não escreve nada");
}

grupo("A travessia tem travões");
{
	let fundo = { arr: [
		{ height: 480, url: "a.m3u8", default: true },
		{ height: 1080, url: "b.m3u8", default: false }] };
	for (let i = 0; i < 40; i++) { fundo = { nivel: i, dentro: fundo }; }
	const orc = { n: 5 };
	api.qlScan(fundo, orc);
	ok(orc.n <= 0, "para quando o orçamento de nós acaba, em vez de varrer tudo");

	const ciclo = { nome: "raiz" };
	ciclo.eu = ciclo;
	let rebentou = false;
	try { api.qlScan(ciclo, { n: 100 }); } catch (e) { rebentou = true; }
	ok(!rebentou, "referências circulares não a fazem rebentar");

	const mau = {};
	Object.defineProperty(mau, "explode", { enumerable: true, get() { throw new Error("boom"); } });
	let rebentou2 = false;
	try { api.qlScan({ dentro: mau }, { n: 100 }); } catch (e) { rebentou2 = true; }
	ok(!rebentou2, "getters do site que rebentam são absorvidos");
}
