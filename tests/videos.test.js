// Encontrar os <video> da página, incluindo os que vivem dentro de um
// web component. querySelectorAll não atravessa shadow roots, por isso um
// leitor feito em componente ficava invisível a tudo o que o script faz.
//
// A procura em shadow roots só pode acontecer quando não há um único <video>
// à vista: nas páginas normais tem de custar zero.

const { funcao, montar, grupo, ok } = require("./harness");

const CODIGO = "let srCache = [], srQuando = 0;\n" +
	funcao("shadowRootsAbertos") + funcao("todosOsVideos");

// DOM de mentira: elementos com querySelectorAll e um shadowRoot opcional
function elemento(tag, filhos, shadow) {
	const el = {
		tagName: tag.toUpperCase(),
		filhos: filhos || [],
		shadowRoot: shadow || null,
		querySelectorAll(sel) {
			const out = [];
			const anda = (n) => {
				for (const f of n.filhos || []) {
					if (f.tagName === sel.toUpperCase()) { out.push(f); }
					anda(f);
				}
			};
			anda(this);
			return out;
		}
	};
	return el;
}

function raiz(filhos) {
	const r = elemento("root", filhos);
	r.filhos = filhos;
	return r;
}

// TreeWalker de mentira: percorre a árvore de `filhos` em profundidade
function palco(documentElement, contador) {
	return {
		documentElement,
		querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
		createTreeWalker(no) {
			const pilha = (no.filhos || []).slice().reverse();
			return {
				nextNode() {
					if (contador) { contador.n++; }
					if (!pilha.length) { return null; }
					const atual = pilha.pop();
					const f = (atual.filhos || []).slice().reverse();
					for (const x of f) { pilha.push(x); }
					return atual;
				}
			};
		}
	};
}

function carregar(doc) {
	return montar(CODIGO, {
		document: doc,
		NodeFilter: { SHOW_ELEMENT: 1 },
		Date: { now: () => Date.now() }
	}, "{ todosOsVideos, shadowRootsAbertos }");
}

grupo("Caminho normal: <video> à vista");
{
	const v = elemento("video");
	const doc = palco(raiz([elemento("div", [v])]));
	let entrouEmShadow = 0;
	doc.createTreeWalker = () => { entrouEmShadow++; return { nextNode: () => null }; };
	const api = carregar(doc);
	const achados = api.todosOsVideos();
	ok(achados.length === 1 && achados[0] === v, "encontra o vídeo directamente");
	ok(entrouEmShadow === 0, "nem chega a procurar em shadow roots (custo zero)");
}

grupo("Leitor dentro de um web component");
{
	const escondido = elemento("video");
	const sr = raiz([elemento("div", [escondido])]);
	const host = elemento("meu-player", [], sr);
	const doc = palco(raiz([elemento("div", [host])]));
	const api = carregar(doc);
	const achados = api.todosOsVideos();
	ok(achados.length === 1 && achados[0] === escondido, "atravessa o shadow root aberto");
}

grupo("Shadow root dentro de shadow root");
{
	const fundo = elemento("video");
	const srInterno = raiz([fundo]);
	const hostInterno = elemento("player-interno", [], srInterno);
	const srExterno = raiz([hostInterno]);
	const hostExterno = elemento("player-externo", [], srExterno);
	const doc = palco(raiz([hostExterno]));
	const api = carregar(doc);
	ok(api.todosOsVideos()[0] === fundo, "desce por roots encaixados");
}

grupo("Roots fechados não são forçados");
{
	// um root fechado devolve shadowRoot === null: fica simplesmente invisível
	const host = elemento("player-fechado", [], null);
	const doc = palco(raiz([host]));
	const api = carregar(doc);
	ok(api.todosOsVideos().length === 0, "não há vídeo nenhum e não se tenta nada");
}

grupo("A procura tem travões");
{
	// árvore funda de propósito, sem shadow roots nenhuns
	let no = elemento("div");
	for (let i = 0; i < 9000; i++) { no = elemento("div", [no]); }
	const contador = { n: 0 };
	const doc = palco(raiz([no]), contador);
	const api = carregar(doc);
	api.todosOsVideos();
	ok(contador.n <= 4001, "para ao fim do orçamento em vez de varrer a árvore toda (" + contador.n + " nós)");
}

grupo("Resultado guardado por 2 s");
{
	const host = elemento("meu-player", [], raiz([elemento("video")]));
	const contador = { n: 0 };
	const doc = palco(raiz([host]), contador);
	const api = carregar(doc);
	api.todosOsVideos();
	const depoisDaPrimeira = contador.n;
	api.todosOsVideos();
	api.todosOsVideos();
	ok(contador.n === depoisDaPrimeira, "chamadas seguidas não repetem a travessia");
}
