# Max Video Quality

**Força automaticamente a melhor qualidade disponível em vídeos na web.**

Sem cliques, sem menus, sem configurar site a site. O script deteta que tipo de leitor
de vídeo a página usa e seleciona sempre a qualidade mais alta que esse vídeo oferece.

---

## Instalação

**1.** Instalar o [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox ou Opera).

**2.** Abrir o link abaixo e confirmar a instalação:

### ➡️ [**Instalar Max Video Quality**](https://raw.githubusercontent.com/fabioganga1/max-video-quality/main/max-video-quality.user.js)

**3.** Configuração obrigatória (uma única vez) — ver [Requisitos](#requisitos).

As atualizações são automáticas. Sempre que sair uma versão nova, o Tampermonkey
instala-a sozinho.

---

## Compatibilidade

| Plataforma / Tecnologia | Como atua | Estado |
|---|---|:---:|
| **YouTube** (site e vídeos embebidos) | API do leitor | ✅ Testado |
| **Twitch** | API interna + preferência de origem | ✅ Testado |
| **Vimeo** (site e vídeos embebidos) | Reescrita da lista de qualidades | ✅ Testado |
| **JW Player** | `setCurrentQuality()` | ✅ Testado |
| **Video.js** | `qualityLevels()` / VHS | ✅ Testado |
| **hls.js** | Nível fixado no `MANIFEST_PARSED` | ✅ Testado |
| **hls.js empacotado** (sem `window.Hls`) | Instância encontrada a partir do `<video>` | ✅ Testado |
| **Qualquer leitor HLS** | Master playlist `.m3u8` reduzida à melhor variante | ✅ Testado |
| **Sites que escolhem a qualidade antes do leitor** | Predefinida movida para a variante mais alta da lista | ✅ Testado |
| **dash.js** (v4 e v5) | ABR desligado + melhor representação | ✅ Testado |
| **Shaka Player** | ABR desligado + melhor variante | ✅ Testado |
| **Facebook** | Reescrita do manifest DASH | ⚠️ Parcial |

Estas tecnologias cobrem a maioria dos sites com vídeo: plataformas de streaming,
jornais, canais de TV online, cursos e portais de vídeo.

As duas linhas de HLS são o que apanha os **players feitos à medida**. A maioria das
webapps modernas traz o `hls.js` dentro do seu próprio pacote, onde nunca chega ao
`window` — nesse caso o hook clássico do construtor não dispara. O script procura então
a instância pendurada no `<video>` e, se mesmo assim não a encontrar, corta o manifesto
na própria rede, o que funciona seja qual for o leitor.

O script nunca desenha nada por cima do site: não há avisos, ícones nem sobreposições.
A única saída visível é a consola, e só com `debug` ligado.

---

## O que não é possível

Nenhum script consegue contornar decisões tomadas do lado do servidor:

| Situação | Porquê |
|---|---|
| **Netflix, Disney+, HBO, Prime Video** | Conteúdo protegido por DRM: o servidor só envia a qualidade autorizada para a conta e o dispositivo |
| **Qualidades reservadas a contas pagas** | A qualidade superior nunca chega ao browser |
| **Limites regionais** | Alguns serviços limitam a resolução por país |
| **Leitores fechados sem manifest acessível** | Sites que escondem completamente a lista de qualidades |
| **Vídeos com uma só qualidade** | Não há nada para escolher — é o caso da maioria dos ficheiros `.mp4` simples |

**Regra prática:** o script coloca sempre na melhor qualidade **que esse vídeo oferece**.
Se um vídeo só existe em 720p, é 720p que vai ficar selecionado.

---

## Requisitos

Configuração feita uma única vez, necessária para o Tampermonkey funcionar em Chrome e Edge:

**1. Permitir userscripts no browser**
`chrome://extensions` → Tampermonkey → **Detalhes** → ativar **"Permitir scripts de utilizador"**
Confirmar ainda que **Acesso ao site** está em **"Em todos os sites"**.

**2. Arranque antecipado do script**
Painel do Tampermonkey → **Definições** → **Modo de configuração: Avançado** →
**Content Script API: `UserScripts API Dynamic`**

> Este segundo passo é essencial: sem ele, o script arranca depois dos leitores de vídeo
> e várias plataformas deixam de funcionar.

---

## Definições

Editáveis no painel do Tampermonkey, no separador **Armazenamento** (visível após a
primeira utilização do script):

| Opção | Predefinição | Descrição |
|---|:---:|---|
| `youtubeTargetRes` | `highest` | Resolução alvo no YouTube (`highest`, `hd2160`, `hd1080`, …) |
| `twitchSpoofVisibility` | `false` | Impede o Twitch de baixar a qualidade em separadores em segundo plano |
| `m3u8Rewrite` | `true` | Corta a master playlist HLS na melhor variante |
| `qualityList` | `true` | Sites que escolhem a qualidade antes de o leitor existir |
| `autoDisable` | `true` | Desliga-se sozinho num site onde tenha prendido o vídeo |
| `debug` | `false` | Mostra na consola (F12) cada ação do script e a resolução real de cada vídeo, com o prefixo `MAXQ` |

Cada plataforma tem também o seu interruptor próprio (`youtube`, `twitch`, `vimeoSite`,
`jwplayer`, `videojs`, `hlsjs`, `hlsGeneric`, `dashjs`, `shaka`, `mpdRewrite`), para
desativar individualmente se necessário.

> **Nota sobre `m3u8Rewrite`:** como o corte é feito no manifesto, o leitor passa a
> conhecer uma única qualidade — e o menu de qualidades do site fica com uma só entrada.
> É o preço de funcionar com leitores fechados. Quem preferir manter o menu intacto pode
> pôr esta opção a `false`: as restantes vias continuam a atuar.

---

## Resolução de problemas

**O vídeo não sobe de qualidade**
Ativar `debug` e abrir a consola (F12), filtrando por `MAXQ`. Se não aparecer nenhuma
linha, o leitor desse site não é reconhecido. Se aparecer, o script atuou e a qualidade
apresentada é o máximo disponível.

**Um site específico deixou de funcionar bem**
Clicar no ícone do Tampermonkey → **⛔ Desativar neste site**. A página recarrega e o
script deixa de instalar seja o que for nesse domínio. Para voltar atrás, no mesmo menu:
**✅ Reativar neste site**.

**O vídeo interrompe para carregar**
Consequência natural de fixar a qualidade máxima: em ligações mais lentas, o leitor
já não baixa automaticamente a resolução para compensar.

---

## Nota técnica

O script corre em `document-start` e não faz nada em páginas sem vídeo — as
interceções são passivas e a deteção só arranca quando é encontrado um elemento de
vídeo ou um leitor conhecido.

**Nunca são criadas variáveis globais novas na página.** Definir `window.Hls` (ou
`dashjs`, ou `shaka`) antes de a biblioteca existir faria `"Hls" in window` passar a
verdadeiro — e há sites que decidem exatamente por aí se ainda precisam de descarregar
o leitor. Convencidos de que já lá estava, abortavam o download e o vídeo ficava a
carregar para sempre, sem erro nenhum. O script limita-se a esperar que a biblioteca
apareça e só então lhe toca.

**Regra de base:** não conseguir subir a qualidade é aceitável; estragar a reprodução
nunca é. Perante qualquer dúvida, o script não age.

### Rede de segurança

Se o script mexeu numa página e, apesar disso, um vídeo ficou preso a tentar arrancar, o
script assume que a culpa é dele: desliga-se nesse domínio e recarrega a página uma vez.
O site volta ao normal sozinho, sem melhoria nenhuma mas a funcionar — que é sempre
preferível a ficar estragado.

As condições são apertadas de propósito, para nunca disparar à toa. É preciso que o
script tenha mesmo alterado alguma coisa na página, que o vídeo esteja a **tentar** tocar
(e não em pausa), que não tenha dados para continuar, e que o tempo fique congelado 12
segundos seguidos. Um vídeo em pausa, com autoplay bloqueado, ou a carregar mas a
progredir, nunca acorda isto.

Desliga-se em `autoDisable`. A lista de domínios onde o script já não atua fica em
`sitesDesativados`, no separador **Armazenamento**.

### Menu do Tampermonkey

No ícone do Tampermonkey, com a página aberta:

| Comando | O que faz |
|---|---|
| ⛔ **Desativar neste site** | O script deixa de instalar seja o que for neste domínio |
| ✅ **Reativar neste site** | Volta a atuar aqui |
| 🔊 **Ligar mensagens na consola** | O mesmo que pôr `debug` a `true` |

### Leitores dentro de web components

Um `<video>` dentro de um shadow root é invisível ao `querySelectorAll` normal, e havia
leitores modernos a escapar por aí. O script atravessa shadow roots **abertos**, com
orçamento de nós, e só quando não encontra nenhum `<video>` à vista — nas páginas normais
custa zero. Roots fechados não são forçados: ficam simplesmente de fora.

### Qualidade escolhida fora do leitor

Alguns sites decidem a qualidade **antes** de o leitor existir: entregam ao `hls.js` um
manifesto já de qualidade única e a escolha real está numa lista de variantes nos dados
do próprio site. Não havendo leitor onde agir, o script move a marca de *predefinida*
para a variante mais alta dessa lista.

A lista só é reconhecida quando tem exatamente esta forma: dois ou mais objetos, dois ou
mais com altura entre 240 e 4320, dois ou mais com uma URL que aponte mesmo para media
(`.m3u8`, `.mpd`, `.mp4`, `.webm`) e **exatamente um** marcado como predefinido. Falha
qualquer condição e não se toca em nada — é o que impede o script de mexer em listas de
imagens, idiomas, legendas ou capítulos, que se parecem mas não são.

Ao contrário do corte do `.m3u8`, **nada é apagado nem reordenado**: só muda a marca. O
menu de qualidades do site fica intacto e o utilizador pode voltar atrás quando quiser.
