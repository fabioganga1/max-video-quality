# userscripts

Userscripts pessoais (Tampermonkey / Violentmonkey).

## Max Video Quality (todos os sites)

Força automaticamente a qualidade máxima de vídeo em todos os sites:
YouTube (site + embeds), Twitch, Vimeo (embeds), JW Player, Video.js, hls.js e dash.js.

**Instalar** (com o Tampermonkey já instalado — abre o link e confirma a instalação):

➡️ [max-video-quality.user.js](https://raw.githubusercontent.com/fabioganga1/userscripts/main/max-video-quality.user.js)

As atualizações são automáticas: o Tampermonkey verifica o `@updateURL` periodicamente
e instala novas versões quando o número de `@version` sobe.

### Requisitos (uma vez)

1. `chrome://extensions` → Tampermonkey → Detalhes → **Allow User Scripts** ligado; Site access: **On all sites**
2. Tampermonkey → Definições → Config Mode: **Advanced** → Content Script API: **UserScripts API Dynamic**

### Limitações

- Sites com DRM (Netflix, Disney+, …), qualidades só-premium e limites regionais não são forçáveis do lado do cliente
- Sites que fazem bundle do hls.js/dash.js sem expor `window.Hls`/`window.dashjs` escapam ao hook genérico
