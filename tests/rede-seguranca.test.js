// Rede de segurança: o script desliga-se sozinho num site onde tenha prendido
// o vídeo.
//
// O risco aqui é o oposto do habitual: um cão de guarda que dispare à toa
// desliga o script em sites onde estava a funcionar bem, e em silêncio. Por
// isso a maior parte destes testes é sobre quando é que ele NÃO pode disparar.

const { SRC, funcao, bloco, montar, grupo, ok } = require("./harness");

const CONST_SITES = /\tconst SITES_OFF = .*/.exec(SRC)[0] + "\n";
const INTERRUPTOR = CONST_SITES + funcao("sitesDesativados") + funcao("estaDesativado") +
	funcao("guardarSites") + funcao("desativarSite") + funcao("reativarSite");
const CAO = bloco("\tconst CAO_MS", "\tfunction caoArranca(");

// --- interruptor por site --------------------------------------------

function interruptor(host) {
	const store = {};
	const api = montar(INTERRUPTOR, {
		GM_getValue: (k, d) => (k in store ? store[k] : d),
		GM_setValue: (k, v) => { store[k] = v; },
		location: { hostname: host },
		console: { log() {} }
	}, "{ sitesDesativados, estaDesativado, desativarSite, reativarSite }");
	return { api, store };
}

grupo("Interruptor por site");
{
	const { api, store } = interruptor("exemplo.com");
	ok(api.estaDesativado() === false, "por omissão um site não está desativado");
	ok(api.desativarSite("teste") === true, "desativa");
	ok(api.estaDesativado() === true, "e fica desativado");
	ok(JSON.stringify(store.sitesDesativados) === '["exemplo.com"]', "guardado como lista de domínios");
	api.desativarSite("outra vez");
	ok(store.sitesDesativados.length === 1, "desativar duas vezes não duplica");
	ok(api.reativarSite() === true && api.estaDesativado() === false, "reativa");

	const outro = interruptor("outro.com");
	outro.api.desativarSite("teste");
	ok(outro.api.estaDesativado() === true && interruptor("terceiro.com").api.estaDesativado() === false,
		"desativar um domínio não afeta os outros");
}

grupo("Sem API de armazenamento não rebenta nem finge que guardou");
{
	const api = montar(INTERRUPTOR, {
		GM_getValue: undefined, GM_setValue: undefined,
		location: { hostname: "x.com" }, console: { log() {} }
	}, "{ estaDesativado, desativarSite }");
	ok(api.estaDesativado() === false, "responde que não está desativado");
	ok(api.desativarSite("teste") === false, "e diz que não conseguiu desativar");
}

// --- cão de guarda ----------------------------------------------------

// Um <video> de mentira, com os estados que interessam ao cão
function video(estado) {
	return Object.assign({ paused: false, ended: false, readyState: 0, currentTime: 0 }, estado);
}

function cao(videos, opcoes) {
	const o = opcoes || {};
	const relogio = { t: 1000000 };
	const eventos = { desativou: null, recarregou: false };
	const sessao = {};
	const FakeDate = { now: () => relogio.t };

	const api = montar("let houveAcao = false;\n" + CAO, {
		settings: { autoDisable: o.autoDisable !== false },
		todosOsVideos: () => videos,
		desativarSite: (porque) => { eventos.desativou = porque; return true; },
		location: { hostname: "exemplo.com", reload: () => { eventos.recarregou = true; } },
		sessionStorage: {
			getItem: (k) => (k in sessao ? sessao[k] : null),
			setItem: (k, v) => { sessao[k] = v; }
		},
		setInterval: () => 1, clearInterval: () => {},
		Date: FakeDate
	}, "{ caoTick, setAcao: (v) => { houveAcao = v; } }");

	api.setAcao(o.houveAcao !== false);
	// avança o relógio em passos de 1 s, como o intervalo real
	const correr = (segundos) => {
		for (let i = 0; i < segundos; i++) { api.caoTick(); relogio.t += 1000; }
	};
	return { correr, eventos, relogio };
}

grupo("Quando o cão de guarda NÃO pode disparar");
{
	const presoMas = (estado, opcoes) => {
		const c = cao([video(estado)], opcoes);
		c.correr(30);
		return c.eventos.desativou === null;
	};

	ok(presoMas({ paused: true, readyState: 0 }),
		"vídeo em pausa (autoplay bloqueado, ou ninguém carregou em play)");
	ok(presoMas({ readyState: 4 }),
		"vídeo com dados suficientes, mesmo que o tempo não ande (pausado pelo utilizador)");
	ok(presoMas({ ended: true, readyState: 0 }), "vídeo que já acabou");
	ok(presoMas({ readyState: 0 }, { houveAcao: false }),
		"o script não mexeu em nada nesta página: o problema não é nosso");
	ok(presoMas({ readyState: 0 }, { autoDisable: false }), "rede de segurança desligada nas definições");

	{ // a carregar devagar, mas a progredir
		const v = video({ readyState: 2 });
		const c = cao([v]);
		for (let i = 0; i < 30; i++) { v.currentTime += 0.5; c.correr(1); }
		ok(c.eventos.desativou === null, "vídeo a carregar mas com o tempo a avançar");
	}

	{ // preso, mas ainda não o suficiente
		const c = cao([video({ readyState: 0 })]);
		c.correr(11);
		ok(c.eventos.desativou === null, "preso há 11 s: ainda dentro do aceitável");
	}

	{ // sem vídeo nenhum na página
		const c = cao([]);
		c.correr(30);
		ok(c.eventos.desativou === null, "página sem vídeos");
	}

	{ // recuperou a meio
		const v = video({ readyState: 0 });
		const c = cao([v]);
		c.correr(8);
		v.readyState = 4; v.currentTime = 3;
		c.correr(30);
		ok(c.eventos.desativou === null, "esteve preso 8 s mas depois arrancou");
	}
}

grupo("Quando tem mesmo de disparar");
{
	const c = cao([video({ readyState: 0 })]);
	c.correr(20);
	ok(c.eventos.desativou !== null, "vídeo a tentar tocar e preso além do limite");
	ok(/preso a tentar arrancar/.test(c.eventos.desativou || ""), "com um motivo legível: " + c.eventos.desativou);
	ok(c.eventos.recarregou === true, "recarrega a página para o site voltar ao normal");
}

grupo("Nunca entrar em ciclo de recargas");
{
	const c = cao([video({ readyState: 0 })]);
	c.correr(20);
	const primeira = c.eventos.recarregou;
	c.eventos.recarregou = false;
	c.correr(60);
	ok(primeira === true && c.eventos.recarregou === false, "dispara uma só vez por página");

	// segunda visita ao mesmo domínio, no mesmo separador: já não recarrega
	const sessao = { "maxq-recarregado": "exemplo.com" };
	const api = montar("let houveAcao = true;\n" + CAO, {
		settings: { autoDisable: true },
		todosOsVideos: () => [video({ readyState: 0 })],
		desativarSite: () => true,
		location: { hostname: "exemplo.com", reload: () => { sessao.recarregou = true; } },
		sessionStorage: { getItem: (k) => sessao[k] || null, setItem: (k, v) => { sessao[k] = v; } },
		setInterval: () => 1, clearInterval: () => {},
		Date: { now: () => 0 }
	}, "{ caoTick }");
	for (let i = 0; i < 40; i++) { api.caoTick(); }
	ok(!sessao.recarregou, "no mesmo separador não volta a recarregar o mesmo domínio");
}

grupo("Um vídeo preso entre vários dispara na mesma");
{
	const c = cao([video({ readyState: 4 }), video({ paused: true }), video({ readyState: 0 })]);
	c.correr(20);
	ok(c.eventos.desativou !== null, "encontra o encravado no meio dos que estão bem");
}
