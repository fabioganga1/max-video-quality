// Corre todas as suites. Sem dependências: `node tests/run.js`.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const harness = require("./harness");

console.log("\nmax-video-quality — testes\n" + "=".repeat(40));

// O script tem de ser sintaticamente válido antes de mais nada
try {
	execFileSync(process.execPath, ["--check", path.join(harness.RAIZ, "max-video-quality.user.js")]);
	console.log("\n  sintaxe do userscript\n    ok  node --check passa");
} catch (e) {
	console.log("\n  sintaxe do userscript\n    FALHA node --check rejeitou o ficheiro");
	process.exit(1);
}

const suites = fs.readdirSync(__dirname)
	.filter((f) => f.endsWith(".test.js"))
	.sort();

for (const f of suites) { require(path.join(__dirname, f)); }

const { falhas, total } = harness.resumo();
console.log("\n" + "=".repeat(40));
console.log(falhas
	? "  " + falhas + " de " + total + " verificações falharam\n"
	: "  " + total + " verificações, todas a passar\n");
process.exit(falhas ? 1 : 0);
