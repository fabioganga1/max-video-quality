// Extrai pedaços do userscript e corre-os isolados.
//
// O script é um ficheiro único com um IIFE (é o que o Tampermonkey precisa),
// por isso não há exports para importar. Em vez de partir o ficheiro em
// módulos — que estragaria a instalação — recortam-se as funções pelo nome e
// injetam-se num escopo controlado. Se um nome mudar, o recorte falha alto,
// que é exatamente o que se quer.

const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(RAIZ, "max-video-quality.user.js"), "utf8");

// Recorta de `inicio` até ao fim do bloco de chavetas que começa em `marcaFn`
// (ou no próprio `inicio`, se não for dado). Serve para funções e também para
// secções que trazem estado de módulo antes da função.
function bloco(inicio, marcaFn) {
	const start = SRC.indexOf(inicio);
	if (start === -1) { throw new Error("harness: não encontrei " + JSON.stringify(inicio)); }
	const fn = marcaFn ? SRC.indexOf(marcaFn, start) : start;
	if (fn === -1) { throw new Error("harness: não encontrei " + JSON.stringify(marcaFn)); }
	let depth = 0, end = -1;
	for (let j = SRC.indexOf("{", fn); j < SRC.length; j++) {
		if (SRC[j] === "{") { depth++; }
		else if (SRC[j] === "}") { depth--; if (!depth) { end = j + 1; break; } }
	}
	if (end === -1) { throw new Error("harness: bloco sem fecho a partir de " + JSON.stringify(inicio)); }
	return SRC.slice(start, end) + "\n";
}

const funcao = (nome) => bloco("\tfunction " + nome + "(");

// Constrói um escopo com o código recortado e devolve o que `retorno` pedir.
// `deps` são as variáveis que o código do script espera encontrar à volta.
function montar(codigo, deps, retorno) {
	const nomes = Object.keys(deps);
	const f = new Function(...nomes, codigo + "\n; return (" + retorno + ");");
	return f(...nomes.map((n) => deps[n]));
}

// --- mini framework de asserções -------------------------------------

let falhas = 0, total = 0;

function grupo(nome) { console.log("\n  " + nome); }

function ok(cond, msg) {
	total++;
	if (!cond) { falhas++; }
	console.log("    " + (cond ? "ok  " : "FALHA ") + msg);
}

const resumo = () => ({ falhas, total });

// --- ambiente de browser mínimo --------------------------------------
// Só o que os hooks tocam: registo de listeners com disparo manual, para o
// teste controlar o tempo em vez de depender de temporizadores reais.

function ambiente() {
	const regs = [];
	const doc = {
		addEventListener(t, fn) { regs.push({ t, fn }); },
		removeEventListener(t, fn) {
			const i = regs.findIndex((r) => r.t === t && r.fn === fn);
			if (i >= 0) { regs.splice(i, 1); }
		},
		readyState: "complete",
		querySelectorAll: () => [],
		querySelector: () => null,
		// o "load" de um <script> passa pela captura no document antes de o
		// site lhe tocar: é a janela em que os hooks agem
		_scriptCarregou() { regs.filter((r) => r.t === "load").forEach((r) => r.fn({})); },
		_nListeners: () => regs.length
	};
	return { W: {}, document: doc };
}

module.exports = { SRC, RAIZ, bloco, funcao, montar, grupo, ok, resumo, ambiente };
