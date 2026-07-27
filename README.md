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
| **dash.js** (v4 e v5) | ABR desligado + melhor representação | ✅ Testado |
| **Shaka Player** | ABR desligado + melhor variante | ✅ Testado |
| **Facebook** | Reescrita do manifest DASH | ⚠️ Parcial |

Estas tecnologias cobrem a maioria dos sites com vídeo: plataformas de streaming,
jornais, canais de TV online, cursos e portais de vídeo.

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
| `debug` | `false` | Mostra na consola (F12) cada ação do script, com o prefixo `MAXQ` |

Cada plataforma tem também o seu interruptor próprio (`youtube`, `twitch`, `vimeoSite`,
`jwplayer`, `videojs`, `hlsjs`, `dashjs`, `shaka`, `mpdRewrite`), para desativar
individualmente se necessário.

---

## Resolução de problemas

**O vídeo não sobe de qualidade**
Ativar `debug` e abrir a consola (F12), filtrando por `MAXQ`. Se não aparecer nenhuma
linha, o leitor desse site não é reconhecido. Se aparecer, o script atuou e a qualidade
apresentada é o máximo disponível.

**Um site específico deixou de funcionar bem**
Painel do Tampermonkey → clicar no nome do script → **Definições** →
**Exclusões do utilizador** → adicionar `https://exemplo.com/*`.

**O vídeo interrompe para carregar**
Consequência natural de fixar a qualidade máxima: em ligações mais lentas, o leitor
já não baixa automaticamente a resolução para compensar.

---

## Nota técnica

O script corre em `document-start` e não faz nada em páginas sem vídeo — as
interceções são passivas e a deteção só arranca quando é encontrado um elemento de
vídeo ou um leitor conhecido.
