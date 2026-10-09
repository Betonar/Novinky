// ==UserScript==
// @name         Novinky.cz + iDNES.cz - Clean Reader + Neural TTS
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Multi-source (Novinky.cz, iDNES.cz, Aktuálně.cz; launcher at https://example.com/) category browser, clean article reader and high-quality Czech neural TTS (Azure) with local fallback.
// @author       You
// @match        *://*.novinky.cz/*
// @match        *://*.idnes.cz/*
// @match        *://*.aktualne.cz/*
// @match        https://example.com/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      tts.speech.microsoft.com
// @connect      germanywestcentral.tts.speech.microsoft.com
// @connect      westeurope.tts.speech.microsoft.com
// @connect      novinky.cz
// @connect      www.novinky.cz
// @connect      idnes.cz
// @connect      www.idnes.cz
// @connect      aktualne.cz
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===========================
  // CONFIGURATION
  // ===========================
  // Neural voice: Azure AI Speech (free tier = 500 000 characters / month).
  // 1) Create a "Speech" resource at https://portal.azure.com (F0 = free tier).
  // 2) Copy its KEY and REGION (e.g. westeurope).
  // 3) Tampermonkey icon -> this script -> "Nastavit Azure klíč a region".
  // The key is stored by Tampermonkey (GM_setValue), never in the script text.
  const TTS = {
    voice: 'cs-CZ-VlastaNeural',          // default; changeable in the reader UI
    format: 'audio-24khz-96kbitrate-mono-mp3',
    chunkChars: 600,                       // size of one request (sentence-aligned)
    rate: 1.0,                             // default playback speed (changeable in UI)
    freeLimit: 500000                      // Azure F0 free tier, characters / month
  };
  const VOICES = { 'cs-CZ-VlastaNeural': 'Vlasta (žena)', 'cs-CZ-AntoninNeural': 'Antonín (muž)' };
  // Voice selection: 'azure:<voice>' (cloud, counts against free tier)
  // or 'local:<voiceURI>' / 'local:auto' (browser / system voices, free, unlimited).
  const getSel = () => GM_getValue('voiceSel', getKey() ? 'azure:' + TTS.voice : 'local:auto');
  const isAzureSel = () => getSel().startsWith('azure:');
  const isPiperSel = () => getSel().startsWith('piper:');
  const PIPER_URL = 'http://127.0.0.1:5000/synthesize';   // see piper-server/start-piper.bat
  const getVoice = () => isAzureSel() ? getSel().slice(6) : TTS.voice;
  const getRate = () => Number(GM_getValue('rate', TTS.rate)) || 1;

  // Locally counted characters sent to Azure this calendar month (this browser only).
  const monthKey = () => new Date().toISOString().slice(0, 7);
  function getUsed() {
    const u = GM_getValue('usage', null);
    return u && u.month === monthKey() ? u.chars : 0;
  }
  function addUsed(n) {
    GM_setValue('usage', { month: monthKey(), chars: getUsed() + n });
    updateUsageLabel();
  }
  function updateUsageLabel() {
    const el = document.getElementById('tm-usage-label');
    if (el) el.textContent = `Azure: využito ${getUsed().toLocaleString('cs-CZ')} / ${TTS.freeLimit.toLocaleString('cs-CZ')} znaků tento měsíc`;
    const bar = document.getElementById('tm-usage-bar');
    if (bar) bar.style.width = Math.min(100, getUsed() / TTS.freeLimit * 100) + '%';
    const box = document.getElementById('tm-usage');
    if (box) box.hidden = !getKey();             // only relevant with an Azure key
  }
  const getKey = () => GM_getValue('azureKey', '');
  const getRegion = () => GM_getValue('azureRegion', 'westeurope');

  GM_registerMenuCommand('Nastavit Azure klíč a region', () => {
    const key = prompt('Azure Speech KEY:', getKey());
    if (key === null) return;
    const region = prompt('Azure region (např. westeurope):', getRegion());
    if (region === null) return;
    GM_setValue('azureKey', key.trim());
    GM_setValue('azureRegion', region.trim() || 'westeurope');
    alert('Uloženo.');
  });

  // ===========================
  // SOURCES (one entry per news site)
  // ===========================
  // To add a site: add an entry here (domain, origin, categories, extractArticles, extractArticle)
  // and an @match / @connect line in the header.
  const normText = t => String(t ?? '').replace(/\s+/g, ' ').trim();

  const SOURCES = {
    novinky: {
      name: 'Novinky.cz',
      domain: 'novinky.cz',
      origin: 'https://www.novinky.cz',
      categories: {
        "Titulka (Hlavní)": "/",
        "Stalo se": "/stalo-se",
        "Domácí": "/domaci",
        "Volby": "/volby",
        "Zahraniční": "/zahranicni",
        "Válka na Ukrajině": "/valka-na-ukrajine",
        "Komentáře": "/komentare",
        "Krimi": "/krimi",
        "Ekonomika": "/ekonomika"
      },
      extractArticles(doc, origin) {
        const articles = [];
        const seenUrls = new Set();
        const links = doc.querySelectorAll('a[href*="/clanek/"]');
        links.forEach(link => {
          if (link.closest('.section-box, .box, .external-box, footer')) return;
          const rawHref = link.getAttribute('href');
          if (!rawHref) return;
          const url = absoluteUrl(rawHref, origin);
          if (seenUrls.has(url)) return;
          const titleEl = link.querySelector('h1, h2, h3, h4, h5, h6, [class*="headline"], [class*="title"]');
          let title = titleEl ? titleEl.textContent.trim() : link.textContent.trim();
          title = title.replace(/\s+/g, ' ').trim();
          if (!title || title.length < 10) return;
          seenUrls.add(url);
          articles.push({ title, url });
        });
        return articles;
      },
      extractArticle(doc) {
        let headline = '';
        const h1Node = doc.querySelector('h1');
        const metaTitle = doc.querySelector('meta[property="og:title"]');
        if (h1Node && h1Node.innerText.trim()) {
          headline = h1Node.innerText.trim();
        } else if (metaTitle && metaTitle.getAttribute('content')) {
          headline = metaTitle.getAttribute('content').replace(/\s*-\s*Novinky\s*$/i, '').trim();
        } else {
          headline = doc.title || '';
        }

        let perexText = '';
        const perexNode = doc.querySelector('[data-dot="perex"], [class*="perex"], .article-perex');
        const metaDescription = doc.querySelector('meta[name="description"], meta[property="og:description"]');
        if (perexNode && perexNode.innerText.trim()) {
          perexText = perexNode.innerText.trim();
        } else if (metaDescription && metaDescription.getAttribute('content')) {
          perexText = metaDescription.getAttribute('content').trim();
        }

        const articleContainer = doc.querySelector('article') || doc.querySelector('[data-dot="content"]');
        let paragraphs = [];
        if (articleContainer) {
          paragraphs = Array.from(articleContainer.querySelectorAll('p')).map(p => p.innerText.trim()).filter(text => text.length > 0 && text !== perexText);
        } else {
          paragraphs = Array.from(doc.querySelectorAll('p')).map(p => p.innerText.trim()).filter(text => text.length > 0 && text !== perexText);
        }
        paragraphs = [...new Set(paragraphs)];
        return { headline, perexText, paragraphs };
      }
    },

    idnes: {
      name: 'iDNES.cz',
      domain: 'idnes.cz',
      origin: 'https://www.idnes.cz',
      categories: {
        "Titulka (Hlavní)": "/",
        "Zprávy": "/zpravy",
        "Domácí": "/zpravy/domaci",
        "Zahraničí": "/zpravy/zahranicni",
        "Krimi": "/zpravy/cerna-kronika",
        "Ekonomika": "/ekonomika",
        "Finance": "/finance",
        "Kultura": "/kultura",
        "Sport": "/sport",
        "Technet": "/technet"
      },
      // Article URLs look like /zpravy/domaci/titulek.A261009_214210_domaci_abc
      extractArticles(doc, origin) {
        const articles = [];
        const seenUrls = new Set();
        const idRe = /\.A\d{6}_\d{6}_/;
        doc.querySelectorAll('a[href]').forEach(link => {
          const rawHref = link.getAttribute('href');
          if (!rawHref || !idRe.test(rawHref)) return;
          if (link.closest('footer, nav, header')) return;
          const titleEl = link.querySelector('h1, h2, h3, h4');
          if (!titleEl) return;                       // thumbnail / duplicate links have no heading
          const url = absoluteUrl(rawHref, origin);
          if (seenUrls.has(url)) return;
          // other subdomains (e.g. sdeleni.idnes.cz = paid press releases) are not news
          try { if (!/^(www\.)?idnes\.cz$/.test(new URL(url).hostname)) return; } catch { return; }
          const title = normText(titleEl.textContent);
          if (!title || title.length < 10) return;
          seenUrls.add(url);
          articles.push({ title, url });
        });
        return articles;
      },
      extractArticle(doc) {
        const h1Node = doc.querySelector('h1.arttit') || doc.querySelector('h1');
        const metaTitle = doc.querySelector('meta[property="og:title"]');
        let headline = h1Node ? normText(h1Node.textContent) : '';
        if (!headline && metaTitle) headline = normText(metaTitle.getAttribute('content')).replace(/\s*-\s*iDNES\.cz\s*$/i, '');
        if (!headline) headline = normText(doc.title);

        let perexText = '';
        const perexNode = doc.querySelector('.opener');
        const metaDescription = doc.querySelector('meta[property="og:description"], meta[name="description"]');
        if (perexNode && normText(perexNode.textContent)) {
          perexText = normText(perexNode.textContent);
        } else if (metaDescription) {
          perexText = normText(metaDescription.getAttribute('content'));
        }

        // Related-article tables, ads, paywall box and tag list are skipped.
        const body = doc.querySelector('#art-text') || doc.querySelector('.art-full');
        let paragraphs = [];
        if (body) {
          paragraphs = Array.from(body.querySelectorAll('p, h2, h3'))
            .filter(p => !p.closest('table, .paywall, [data-redistribute], .r-main, .artend, .tag-list, .blockquote-box, aside'))
            .map(p => normText(p.textContent))
            .filter(text => text.length > 0 && text !== perexText);
          // Premium articles: only the beginning is public
          if (body.querySelector('.paywall')) paragraphs.push('Zbytek článku je jen pro předplatitele iDNES Premium.');
        }
        paragraphs = [...new Set(paragraphs)];
        return { headline, perexText, paragraphs };
      }
    }
  };

  SOURCES.aktualne = {
    name: 'Aktuálně.cz',
    domain: 'aktualne.cz',
    origin: 'https://www.aktualne.cz',
    // full URLs: sections live on different subdomains
    categories: {
      "Titulka (Hlavní)": "https://www.aktualne.cz/",
      "Zprávy": "https://zpravy.aktualne.cz/",
      "Domácí": "https://zpravy.aktualne.cz/domaci/",
      "Zahraničí": "https://zpravy.aktualne.cz/zahranici/",
      "Ekonomika": "https://zpravy.aktualne.cz/ekonomika/",
      "Sport": "https://sport.aktualne.cz/",
      "Kultura": "https://magazin.aktualne.cz/kultura/"
    },
    // Article URLs end with /r~<32 hex>/ ; the link sits inside the heading (h2 > a)
    extractArticles(doc, origin) {
      const articles = [];
      const seenUrls = new Set();
      const idRe = /\/r~[0-9a-f]{32}\/?/;
      doc.querySelectorAll('a[href]').forEach(link => {
        const rawHref = link.getAttribute('href');
        if (!rawHref || !idRe.test(rawHref)) return;
        if (link.closest('footer, nav, header')) return;
        const heading = link.closest('h1, h2, h3, h4') || link.querySelector('h1, h2, h3, h4');
        if (!heading) return;                          // image / duplicate links have no heading
        const url = absoluteUrl(rawHref, origin).replace(/[?#].*$/, '');
        if (seenUrls.has(url)) return;
        try { if (!/(^|\.)aktualne\.cz$/.test(new URL(url).hostname)) return; } catch { return; }
        const clone = heading.cloneNode(true);
        clone.querySelectorAll('span.e-data-layer-trigger, script, style').forEach(x => x.remove());
        const title = normText(clone.textContent);
        if (!title || title.length < 10) return;
        seenUrls.add(url);
        articles.push({ title, url });
      });
      return articles;
    },
    extractArticle(doc) {
      const h1Node = doc.querySelector('h1');
      const metaTitle = doc.querySelector('meta[property="og:title"]');
      let headline = h1Node ? normText(h1Node.textContent) : '';
      if (!headline && metaTitle) headline = normText(metaTitle.getAttribute('content')).replace(/\s*[–-]\s*Aktuálně\.cz\s*$/i, '');
      if (!headline) headline = normText(doc.title);

      let perexText = '';
      const perexNode = doc.querySelector('.e-web-aktualne-articles-show-header__perex');
      const metaDescription = doc.querySelector('meta[property="og:description"], meta[name="description"]');
      if (perexNode && normText(perexNode.textContent)) {
        perexText = normText(perexNode.textContent);
      } else if (metaDescription) {
        perexText = normText(metaDescription.getAttribute('content'));
      }

      // Direct children only: embeds, ad wrappers and related boxes are nested elsewhere.
      const body = doc.querySelector('.f-tiptap-content__root');
      let paragraphs = [];
      if (body) {
        paragraphs = Array.from(body.querySelectorAll(':scope > p, :scope > h2, :scope > h3'))
          .map(p => normText(p.textContent))
          .filter(text => text.length > 0 && text !== perexText && !/^(Viděli jste|Čtěte také|Přečtěte si)/i.test(text));
      }
      paragraphs = [...new Set(paragraphs)];
      return { headline, perexText, paragraphs };
    }
  };

  const findSource = url => {
    let host = '';
    try { host = new URL(url, location.href).hostname; } catch { /* ignore */ }
    return Object.values(SOURCES).find(s => host === s.domain || host.endsWith('.' + s.domain));
  };
  const sourceForUrl = url => findSource(url) || SOURCES.novinky;

  // Launcher mode: the reader runs on a neutral page (bookmark it), so no news site has to be visited.
  // All fetches then go through GM_xmlhttpRequest (different origin).
  const LAUNCHER_HOST = 'example.com';
  const isLauncher = location.hostname === LAUNCHER_HOST;
  const lastSourceId = () => { const id = GM_getValue('lastSource', 'novinky'); return SOURCES[id] ? id : 'novinky'; };
  // On the source's own site use the real origin (same behaviour as before), elsewhere its default.
  const sourceOrigin = src => (location.hostname === src.domain || location.hostname.endsWith('.' + src.domain)) ? location.origin : src.origin;

  // opens on the site you are on; on the launcher page on the last used source
  let currentSource = findSource(location.href) || SOURCES[lastSourceId()];
  let currentCategoryPath = "/";
  let currentCategoryButton = null;

  // ===========================
  // TTS STATE
  // ===========================
  let speechUtterance = null;
  let speechChunks = [];
  let speechIndex = 0;
  let speechPlaying = false;
  let audioElement = null;
  let useExternalThisSession = false;
  let ttsSession = 0;          // bumped on every stop/start to cancel stale async work
  let ttsPaused = false;
  let lastTtsError = '';
  let currentSpeechUrl = '';   // article currently read (for the list play buttons)
  let busyUrl = '';            // article being fetched / synthesized
  let listPlayToken = 0;
  let currentTitle = '';       // title of the article being read (for the player bar)
  let viewedArticleUrl = '';   // article open in the reader view ('' in list / queue view)

  // Reading queue (persisted). Played items are removed from it automatically.
  let queue = (() => { try { const q = GM_getValue('queue', []); return Array.isArray(q) ? q : []; } catch { return []; } })();
  let queueActive = false;     // true while the current article was started from the queue
  let queueIndex = -1;         // index of the playing item in queue
  let queueViewOpen = false;

  // Position tracking (for the seek slider). Text is split into sentences; positions are
  // measured in characters of the sentence-normalised text.
  let speechFullText = '';
  let speechSentences = [];
  let speechStarts = [];
  let speechTotalChars = 1;
  let speechPos = 0;
  let seekDragging = false;

  // ===========================
  // HELPERS
  // ===========================
  // ===========================
  function escapeHTML(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function absoluteUrl(href, base) {
    try {
      return new URL(href, base || window.location.origin).href;
    } catch {
      return href;
    }
  }

  // iDNES is windows-1250: bytes must be decoded by the page's charset, not as UTF-8.
  function decodeHtml(buf, contentType) {
    let cs = (/charset=["']?([\w-]+)/i.exec(contentType || '') || [])[1];
    if (!cs) {
      const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
      cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
    }
    try { return new TextDecoder(cs || 'utf-8').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }

  const CONSENT_RE = /nastaveni-souhlasu/i;
  function consentError(src) {
    return new Error(`${src.name} vyžaduje souhlas s cookies. Otevřete ${src.origin} v prohlížeči, klikněte „Souhlasím“ a zkuste to znovu.`);
  }

  // Same origin: plain fetch (as before). Other site: GM_xmlhttpRequest (cross-origin, cookies of that site).
  async function fetchDocument(url) {
    const src = sourceForUrl(url);
    let buf, contentType, finalUrl;
    if (new URL(url, location.href).origin === location.origin) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buf = await response.arrayBuffer();
      contentType = response.headers.get('content-type');
      finalUrl = response.url;
    } else {
      const r = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout: 30000,
          onload: resolve,
          onerror: () => reject(new Error(`${src.name}: síťová chyba / blokováno (povolte připojení v Tampermonkey)`)),
          ontimeout: () => reject(new Error(`${src.name}: timeout`))
        });
      });
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      buf = r.response;
      contentType = (/content-type:\s*([^\r\n]+)/i.exec(r.responseHeaders || '') || [])[1];
      finalUrl = r.finalUrl || url;
    }
    if (CONSENT_RE.test(finalUrl)) throw consentError(src);
    return new DOMParser().parseFromString(decodeHtml(buf, contentType), 'text/html');
  }

  // ===========================
  // EXTRACT ARTICLES / ARTICLE (per source, see SOURCES)
  // ===========================
  const extractArticles = (doc, src) => src.extractArticles(doc, sourceOrigin(src));
  const extractArticle = (doc, url) => sourceForUrl(url).extractArticle(doc);

  // ===========================
  // TTS: Azure neural voice
  // ===========================
  function ssmlFor(text) {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<speak version="1.0" xml:lang="cs-CZ" xmlns="http://www.w3.org/2001/10/synthesis">` +
      `<voice name="${getVoice()}">${esc}</voice></speak>`;
  }

  // Returns a blob: URL with MP3 audio for one chunk of text.
  function synthesizeChunk(text) {
    if (isPiperSel()) return synthesizePiper(text);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://${getRegion()}.tts.speech.microsoft.com/cognitiveservices/v1`,
        headers: {
          'Ocp-Apim-Subscription-Key': getKey(),
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': TTS.format,
          'User-Agent': 'novinky-clean-reader'
        },
        data: ssmlFor(text),
        responseType: 'arraybuffer',
        timeout: 30000,
        onload: r => {
          if (r.status !== 200) return reject(new Error(`HTTP ${r.status} (401/403 = špatný klíč nebo region)`));
          addUsed(text.length);
          resolve(URL.createObjectURL(new Blob([r.response], { type: 'audio/mpeg' })));
        },
        onerror: e => reject(new Error('síťová chyba / blokováno (' + ((e && e.error) || 'povolte připojení v Tampermonkey') + ')')),
        ontimeout: () => reject(new Error('Azure TTS timeout'))
      });
    });
  }

  // Local Piper server (offline, free): POST {text} -> WAV
  function synthesizePiper(text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: PIPER_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ text }),
        responseType: 'arraybuffer',
        timeout: 180000,
        onload: r => r.status === 200
          ? resolve(URL.createObjectURL(new Blob([r.response], { type: 'audio/wav' })))
          : reject(new Error(`Piper HTTP ${r.status}`)),
        onerror: () => reject(new Error('Piper server neběží (spusťte start-piper.bat)')),
        ontimeout: () => reject(new Error('Piper timeout'))
      });
    });
  }

  function playUrl(url, session, chunk) {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      a.ontimeupdate = () => {
        if (session === ttsSession && chunk && a.duration > 0) {
          setSpeechPos(chunk.startChar + (a.currentTime / a.duration) * chunk.text.length);
        }
      };
      a.playbackRate = getRate();
      a.preservesPitch = true;
      audioElement = a;
      a.onended = () => resolve();
      a.onerror = () => reject(new Error('Audio playback error'));
      a.play().catch(reject);
    });
  }

  // Plays all chunks in order, synthesizing chunk N+1 while N is playing (gapless).
  async function startNeuralSpeech(session, fromSentence) {
    // Piper runs on the user's own CPU - use short chunks so playback starts sooner.
    const chunks = chunksFrom(fromSentence, isPiperSel() ? 220 : TTS.chunkChars);
    if (!chunks.length) return;
    let next = synthesizeChunk(chunks[0].text);
    next.catch(() => {});
    for (let i = 0; i < chunks.length; i++) {
      const url = await next;                       // throws -> caller falls back
      if (session !== ttsSession) { URL.revokeObjectURL(url); return; }
      if (i === 0) { speechPlaying = true; useExternalThisSession = true; updateSpeechButton(); }
      if (i + 1 < chunks.length) { next = synthesizeChunk(chunks[i + 1].text); next.catch(() => {}); }
      setSpeechPos(chunks[i].startChar);
      await playUrl(url, session, chunks[i]);
      URL.revokeObjectURL(url);
      if (session !== ttsSession) return;
    }
    speechFinished();
  }

  // Called when an article has been read to the end (not when it was stopped).
  function speechFinished() {
    speechPlaying = false;
    ttsPaused = false;
    speechSentences = []; speechFullText = ''; speechPos = 0;
    if (queueActive && queue[queueIndex] && queue[queueIndex].url === currentSpeechUrl) {
      const i = queueIndex;
      queue.splice(i, 1);                           // played items leave the queue
      saveQueue();
      if (queue[i]) playArticle(queue[i].url, queue[i].title, i);
      else { queueActive = false; queueIndex = -1; currentSpeechUrl = ''; currentTitle = ''; }
    }
    uiQueueChanged();
    updateSpeechButton();
  }

  // ===========================
  // TTS: Local fallback (Web Speech API)
  // ===========================
  // ===========================
  function loadVoices() {
    return new Promise(resolve => {
      let voices = window.speechSynthesis.getVoices();
      if (voices.length) return resolve(voices);
      window.speechSynthesis.onvoiceschanged = () => {
        voices = window.speechSynthesis.getVoices();
        resolve(voices);
      };
      // Fallback timeout
      setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
    });
  }

  async function chooseVoice() {
    const voices = await loadVoices();
    const sel = getSel();
    if (sel.startsWith('local:') && sel !== 'local:auto') {
      const wanted = sel.slice(6);
      const chosen = voices.find(v => v.voiceURI === wanted || v.name === wanted);
      if (chosen) return chosen;
    }
    const preferredKeys = ['natural', 'neural', 'online', 'google', 'microsoft', 'premium', 'cs-cz', 'cs', 'czech'];
    // Try to find voice by name keywords and cs language
    for (const key of preferredKeys) {
      const found = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('cs') && v.name && v.name.toLowerCase().includes(key));
      if (found) return found;
    }
    // Then any cs voice
    const csVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('cs'));
    if (csVoice) return csVoice;
    // Then sk voice
    const skVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('sk'));
    if (skVoice) return skVoice;
    // Fallback to first voice
    return voices[0] || null;
  }

  // Split text into sentences and group into chunks of ~300-800 chars for natural pauses
  function prepareSentences(text) {
    speechFullText = text;
    speechSentences = text
      .replace(/\r\n/g, ' ')
      .replace(/\n/g, ' ')
      .split(/(?<=[.?!…])\s+/u)
      .map(t => t.trim())
      .filter(Boolean);
    speechStarts = [];
    let pos = 0;
    for (const t of speechSentences) { speechStarts.push(pos); pos += t.length + 1; }
    speechTotalChars = Math.max(1, pos);
    speechPos = 0;
  }

  // Group sentences from index k on into chunks of at most maxChars (a long sentence stays whole).
  function chunksFrom(k, maxChars) {
    const out = [];
    let cur = '', curStart = 0;
    for (let i = k; i < speechSentences.length; i++) {
      const t = speechSentences[i];
      if (cur && (cur + ' ' + t).length > maxChars) {
        out.push({ text: cur, startChar: curStart });
        cur = t; curStart = speechStarts[i];
      } else {
        if (!cur) curStart = speechStarts[i];
        cur = cur ? cur + ' ' + t : t;
      }
    }
    if (cur) out.push({ text: cur, startChar: curStart });
    return out;
  }

  function setSpeechPos(pos) {
    speechPos = Math.max(0, Math.min(speechTotalChars, pos));
    updateSeekUI();
  }

  // Jump to a fraction (0..1) of the article: restart reading from the nearest sentence start.
  async function seekToFraction(f) {
    if (!speechSentences.length || !speechFullText) return;
    const target = f * speechTotalChars;
    let k = 0;
    for (let i = 0; i < speechStarts.length; i++) if (speechStarts[i] <= target) k = i;
    const text = speechFullText;
    stopSpeech();
    await toggleSpeechUnified(text, k);
  }

  function stopLocalSpeech() {
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();   // a paused engine would otherwise swallow the next utterance
    speechPlaying = false;
    speechUtterance = null;
    speechChunks = [];
    speechIndex = 0;
    updateSpeechButton();
  }

  async function startLocalSpeech(fromSentence) {
    stopLocalSpeech();
    const session = ttsSession;
    speechChunks = chunksFrom(fromSentence, 700);
    if (!speechChunks.length) { speechFinished(); return; }
    speechIndex = 0;
    speechPlaying = true;
    const voice = await chooseVoice();
    if (session !== ttsSession) return;           // stopped while the voices were loading
    speakNextLocalChunk(voice, session);
  }

  function speakNextLocalChunk(selectedVoice, session) {
    if (session !== ttsSession) return;
    if (!speechPlaying || speechIndex >= speechChunks.length) {
      const natural = speechPlaying && speechIndex >= speechChunks.length;
      speechPlaying = false;
      speechIndex = 0;
      if (natural) speechFinished(); else updateSpeechButton();
      return;
    }
    const chunk = speechChunks[speechIndex];
    setSpeechPos(chunk.startChar);
    speechUtterance = new SpeechSynthesisUtterance(chunk.text);
    speechUtterance.onboundary = e => {
      if (session === ttsSession && typeof e.charIndex === 'number') setSpeechPos(chunk.startChar + e.charIndex);
    };
    if (selectedVoice) {
      speechUtterance.voice = selectedVoice;
      speechUtterance.lang = selectedVoice.lang || 'cs-CZ';
    } else {
      speechUtterance.lang = 'cs-CZ';
    }
    // Gentle settings
    speechUtterance.rate = getRate();
    speechUtterance.pitch = 1.0;
    speechUtterance.volume = 1.0;

    speechUtterance.onend = function () {
      // small pause between chunks to improve naturalness
      if (session !== ttsSession) return;
      speechIndex++;
      setTimeout(() => speakNextLocalChunk(selectedVoice, session), 220);
    };
    speechUtterance.onerror = function () {
      if (session !== ttsSession) return;
      speechPlaying = false;
      updateSpeechButton();
    };
    window.speechSynthesis.speak(speechUtterance);
    updateSpeechButton();
  }

  // ===========================
  // Unified controls: Neural or Local
  // ===========================
  function stopSpeech() {
    ttsSession++;
    ttsPaused = false;
    if (audioElement) {
      audioElement.onended = audioElement.onerror = null;
      audioElement.pause();
      audioElement = null;
    }
    stopLocalSpeech();
    speechPlaying = false;
    updateSpeechButton();
  }

  async function toggleSpeechUnified(text, fromSentence = 0) {
    // Pause / resume of the neural audio
    if (speechPlaying) {
      if (audioElement) {
        if (ttsPaused) { await audioElement.play(); ttsPaused = false; }
        else { audioElement.pause(); ttsPaused = true; }
      } else if (ttsPaused) {
        window.speechSynthesis.resume(); ttsPaused = false;
      } else {
        window.speechSynthesis.pause(); ttsPaused = true;
      }
      updateSpeechButton();
      return;
    }

    const session = ++ttsSession;
    lastTtsError = '';
    prepareSentences(text);
    fromSentence = Math.min(fromSentence, Math.max(0, speechSentences.length - 1));
    setSpeechPos(speechStarts[fromSentence] || 0);
    if ((getKey() && isAzureSel()) || isPiperSel()) {
      try {
        await startNeuralSpeech(session, fromSentence);
        return;
      } catch (err) {
        if (session !== ttsSession) return;
        console.warn('Neural TTS failed, falling back to local TTS:', err);
        stopSpeech();
        lastTtsError = err && err.message ? err.message : String(err);
      }
    } else {
      // local voice selected (or no Azure key)
    }
    useExternalThisSession = false;
    await startLocalSpeech(fromSentence);
    updateSpeechButton();
  }

  // ===========================
  // ICONS (inline SVG, colour follows currentColor)
  // ===========================
  const ICON_PATHS = {
    play: '<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" class="tm-fill"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1" class="tm-fill"/><rect x="13.5" y="5" width="4" height="14" rx="1" class="tm-fill"/>',
    next: '<path d="M5 5.8v12.4a.8.8 0 0 0 1.2.7l9.3-6.2a.8.8 0 0 0 0-1.4L6.2 5.1A.8.8 0 0 0 5 5.8z" class="tm-fill"/><rect x="17" y="5" width="2.6" height="14" rx="1" class="tm-fill"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" class="tm-fill"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
    queue: '<path d="M4 6h13M4 11h13M4 16h7"/><path d="M15 14.5v5.5l4.5-2.75z" class="tm-fill"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    book: '<path d="M4 19V5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'
  };
  const icon = name => `<svg class="tm-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;

  const plural = (n, one, few, many) => n === 1 ? one : (n >= 2 && n <= 4 ? few : many);
  const articlesCount = n => `${n} ${plural(n, 'článek', 'články', 'článků')}`;

  // Play-style buttons: idle / busy / playing / paused. The DOM is only touched when the state changes.
  function setPlayState(btn, state) {
    if (!btn || btn.dataset.state === state) return;
    btn.dataset.state = state;
    btn.innerHTML = state === 'busy' ? '<span class="tm-spinner" aria-hidden="true"></span>' : icon(state === 'playing' ? 'pause' : 'play');
    btn.setAttribute('aria-label', state === 'playing' ? 'Pozastavit' : state === 'busy' ? 'Načítám…' : (state === 'paused' ? 'Pokračovat' : 'Přehrát'));
  }

  function updateSpeechButton() {
    document.querySelectorAll('.tm-row-play').forEach(b => {
      const mine = !!b.dataset.url && b.dataset.url === currentSpeechUrl;
      setPlayState(b, mine && speechPlaying ? (ttsPaused ? 'paused' : 'playing') : (mine && busyUrl === b.dataset.url ? 'busy' : 'idle'));
      const row = b.closest('.tm-article-row, .tm-queue-row');
      if (row) row.classList.toggle('is-current', mine && (speechPlaying || busyUrl === b.dataset.url));
    });
    updatePlayerUI();
    syncQueueChecks();
    const warn = !!lastTtsError && !useExternalThisSession;
    document.querySelectorAll('.tm-mode-text').forEach(el => {
      el.textContent = modeText();
      el.classList.toggle('tm-warn', warn);
    });
    const status = document.getElementById('tm-status');
    if (status) status.classList.toggle('tm-warn', warn);

    const button = document.getElementById('tm-speech-btn');
    if (!button) return;
    const active = speechPlaying && currentSpeechUrl === viewedArticleUrl;
    const state = active ? (ttsPaused ? 'paused' : 'playing') : 'idle';
    if (button.dataset.state === state) return;
    button.dataset.state = state;
    const label = state === 'playing' ? 'Pozastavit' : state === 'paused' ? 'Pokračovat' : 'Přečíst článek';
    button.innerHTML = `${icon(state === 'playing' ? 'pause' : 'play')}<span>${label}</span>`;
    button.classList.toggle('is-active', active);
  }

  function modeText() {
    return isPiperSel() ? (lastTtsError && !useExternalThisSession ? `Lokální hlas – Piper selhal: ${lastTtsError}` : 'Piper (offline)') : !isAzureSel() ? 'Hlas prohlížeče / systému' : lastTtsError && !useExternalThisSession ? `Lokální TTS – Azure selhal: ${lastTtsError}` : !getKey() ? 'Lokální TTS (chybí Azure klíč)' : (useExternalThisSession ? 'Neurální hlas (Azure)' : 'Neurální hlas (Azure) – připraven');
  }

  // ===========================
  // UI BUILD
  // ===========================
  // Layout: app bar / (sidebar | content) / player bar. On phones the sidebar becomes
  // a source switcher + scrolling category chips, and settings open as a bottom sheet.
  const RATE_PRESETS = [0.8, 1, 1.2, 1.4];
  const FONT_SCALES = [['S', 0.9], ['M', 1], ['L', 1.12], ['XL', 1.25]];
  const getScale = () => Number(GM_getValue('fontScale', 1)) || 1;

  function buildUI() {
    if (document.getElementById('tm-clean-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'tm-clean-overlay';
    overlay.style.setProperty('--tm-scale', getScale());
    overlay.innerHTML = `
      <header id="tm-header">
        <button id="tm-back-btn" class="tm-icon-btn" type="button" title="Zpět na články" aria-label="Zpět na články">${icon('back')}</button>
        <div id="tm-brand" aria-hidden="true">${icon('book')}</div>
        <div id="tm-title-wrap">
          <div id="tm-eyebrow"></div>
          <div id="tm-title">Čtečka zpráv</div>
        </div>
        <div id="tm-header-actions">
          <button id="tm-hd-queue" class="tm-icon-btn" type="button" title="Fronta" aria-label="Fronta">${icon('queue')}<span class="tm-badge tm-q-count" hidden>0</span></button>
          <button id="tm-hd-settings" class="tm-icon-btn" type="button" title="Hlas a rychlost" aria-label="Hlas a rychlost">${icon('settings')}</button>
          <button id="tm-close-btn" class="tm-icon-btn" type="button" title="Zavřít čtečku" aria-label="Zavřít čtečku">${icon('close')}</button>
        </div>
      </header>
      <div id="tm-body">
        <aside id="tm-side">
          <div class="tm-side-label">Zdroj</div>
          <div id="tm-sources" role="tablist" aria-label="Zdroj"></div>
          <div class="tm-side-label">Rubriky</div>
          <nav id="tm-nav" aria-label="Rubriky"></nav>
        </aside>
        <main id="tm-content"></main>
      </div>
      <div id="tm-player" hidden>
        <input id="tm-pl-seek" class="tm-range" type="range" min="0" max="1000" value="0" step="1" disabled aria-label="Posun v článku">
        <div class="tm-pl-controls">
          <button id="tm-pl-toggle" class="tm-pl-main" type="button" title="Přehrát / pozastavit (mezerník)"></button>
          <button id="tm-pl-next" class="tm-icon-btn" type="button" title="Další ve frontě (N)" aria-label="Další ve frontě">${icon('next')}</button>
          <button id="tm-pl-stop" class="tm-icon-btn" type="button" title="Zastavit" aria-label="Zastavit">${icon('stop')}</button>
        </div>
        <div class="tm-pl-info">
          <div id="tm-pl-title"></div>
          <div id="tm-pl-sub"></div>
        </div>
        <span id="tm-pl-pos">0 %</span>
        <button id="tm-pl-rate" class="tm-chip" type="button" title="Hlas a rychlost">1.00×</button>
        <button id="tm-pl-queue" class="tm-icon-btn" type="button" title="Fronta" aria-label="Fronta">${icon('queue')}<span class="tm-badge tm-q-count" hidden>0</span></button>
      </div>
      <div id="tm-sheet-backdrop"></div>
      <section id="tm-sheet" role="dialog" aria-modal="true" aria-labelledby="tm-sheet-title">
        <div class="tm-sheet-grab" aria-hidden="true"></div>
        <div class="tm-sheet-head">
          <h2 id="tm-sheet-title">Předčítání</h2>
          <button id="tm-sheet-close" class="tm-icon-btn" type="button" aria-label="Zavřít">${icon('close')}</button>
        </div>
        <div class="tm-field">
          <label class="tm-field-label" for="tm-voice-select">Hlas</label>
          <div class="tm-select-wrap">
            <select id="tm-voice-select" class="tm-select"></select>
            ${icon('chevron')}
          </div>
        </div>
        <div class="tm-field">
          <div class="tm-field-head">
            <label class="tm-field-label" for="tm-rate-range">Rychlost čtení</label>
            <output id="tm-rate-label">${getRate().toFixed(2)}×</output>
          </div>
          <input id="tm-rate-range" class="tm-range" type="range" min="0.7" max="1.6" step="0.05" value="${getRate()}">
          <div class="tm-seg" id="tm-rate-presets">
            ${RATE_PRESETS.map(r => `<button type="button" data-rate="${r}">${r.toFixed(1)}×</button>`).join('')}
          </div>
        </div>
        <div class="tm-field">
          <div class="tm-field-label">Velikost písma článku</div>
          <div class="tm-seg" id="tm-font-scale">
            ${FONT_SCALES.map(([l, s]) => `<button type="button" data-scale="${s}">${l}</button>`).join('')}
          </div>
        </div>
        <div id="tm-status" class="tm-status"><span class="tm-dot" aria-hidden="true"></span><span id="tm-tts-mode-label" class="tm-mode-text"></span></div>
        <div id="tm-usage" class="tm-usage">
          <div id="tm-usage-label"></div>
          <div class="tm-meter"><span id="tm-usage-bar"></span></div>
        </div>
        <p class="tm-hint">Azure klíč: menu Tampermonkey → „Nastavit Azure klíč a region“. Hlas Piper potřebuje spuštěný <code>start-piper.bat</code>.</p>
        <p class="tm-hint tm-kbd-hint"><kbd>Mezerník</kbd> přehrát / pauza · <kbd>N</kbd> další · <kbd>Esc</kbd> zpět</p>
      </section>
    `;
    document.body.appendChild(overlay);

    const nav = overlay.querySelector('#tm-nav');
    const sourcesBar = overlay.querySelector('#tm-sources');
    Object.entries(SOURCES).forEach(([id, src]) => {
      const button = document.createElement('button');
      button.className = 'tm-src-btn' + (src === currentSource ? ' active' : '');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.textContent = src.name;
      button.dataset.source = id;
      button.addEventListener('click', () => switchSource(src));
      sourcesBar.appendChild(button);
    });
    buildNav();

    overlay.querySelector('#tm-close-btn').addEventListener('click', () => {
      stopAll();
      closeSheet();
      overlay.style.display = 'none';
    });
    overlay.querySelector('#tm-back-btn').addEventListener('click', showArticleList);
    overlay.querySelector('#tm-hd-queue').addEventListener('click', showQueueView);
    overlay.querySelector('#tm-pl-queue').addEventListener('click', showQueueView);
    overlay.querySelector('#tm-hd-settings').addEventListener('click', openSheet);
    overlay.querySelector('#tm-pl-rate').addEventListener('click', openSheet);
    overlay.querySelector('#tm-sheet-close').addEventListener('click', closeSheet);
    overlay.querySelector('#tm-sheet-backdrop').addEventListener('click', closeSheet);

    overlay.querySelector('#tm-pl-toggle').addEventListener('click', () => {
      if (speechPlaying) toggleSpeechUnified('');
      else if (!busyUrl) playQueue();
    });
    overlay.querySelector('#tm-pl-next').addEventListener('click', playNext);
    overlay.querySelector('#tm-pl-stop').addEventListener('click', stopAll);
    const seek = overlay.querySelector('#tm-pl-seek');
    seek.addEventListener('input', () => {
      seekDragging = true;
      seek.style.setProperty('--tm-fill', seek.value / 10 + '%');
      overlay.querySelector('#tm-pl-pos').textContent = Math.round(seek.value / 10) + ' %';
    });
    seek.addEventListener('change', () => {
      seekDragging = false;
      seekToFraction(seek.value / 1000);
    });

    bindSettings();

    const trigger = document.createElement('button');
    trigger.id = 'tm-trigger-btn';
    trigger.type = 'button';
    trigger.innerHTML = `${icon('book')}<span>Čtečka</span>`;
    trigger.addEventListener('click', () => {
      overlay.style.display = 'flex';
      if (!currentCategoryButton) {
        const firstButton = nav.firstElementChild;
        loadCategory(firstButton.dataset.path, firstButton);
      }
    });
    document.body.appendChild(trigger);
    document.addEventListener('keydown', onKeyDown);
    updatePlayerUI();
  }

  function playNext() {
    if (queueActive && queueIndex + 1 < queue.length) playArticle(queue[queueIndex + 1].url, queue[queueIndex + 1].title, queueIndex + 1);
    else if (queueActive) stopAll();
    else playQueue();
  }

  // Desktop shortcuts: Space = play/pause, N = next, Esc = close settings / back to list.
  function onKeyDown(e) {
    const overlay = document.getElementById('tm-clean-overlay');
    if (!overlay || overlay.style.display !== 'flex' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) {
      if (e.key === 'Escape' && overlay.classList.contains('tm-sheet-open')) closeSheet();
      return;
    }
    if (e.key === 'Escape') {
      if (overlay.classList.contains('tm-sheet-open')) closeSheet();
      else if (overlay.classList.contains('tm-mode-detail')) showArticleList();
      else return;
    } else if (e.key === ' ' && !(t && t.tagName === 'BUTTON')) {
      const articleBtn = document.getElementById('tm-speech-btn');
      if (speechPlaying) toggleSpeechUnified('');
      else if (articleBtn) articleBtn.click();
      else if (!busyUrl) playQueue();
    } else if (e.key === 'n' || e.key === 'N') {
      playNext();
    } else {
      return;
    }
    e.preventDefault();
  }

  function openSheet() {
    const overlay = document.getElementById('tm-clean-overlay');
    populateVoiceSelect();
    updateUsageLabel();
    overlay.classList.add('tm-sheet-open');
  }

  function closeSheet() {
    const overlay = document.getElementById('tm-clean-overlay');
    if (overlay) overlay.classList.remove('tm-sheet-open');
  }

  function setRate(v) {
    v = Math.min(1.6, Math.max(0.7, Number(v) || 1));
    GM_setValue('rate', v);
    if (audioElement) audioElement.playbackRate = v;
    syncRateUI();
  }

  function syncRateUI() {
    const v = getRate();
    const range = document.getElementById('tm-rate-range');
    if (range) {
      range.value = String(v);
      range.style.setProperty('--tm-fill', (v - 0.7) / 0.9 * 100 + '%');
    }
    const label = document.getElementById('tm-rate-label');
    if (label) label.textContent = v.toFixed(2) + '×';
    const chip = document.getElementById('tm-pl-rate');
    if (chip) chip.textContent = v.toFixed(2) + '×';
    document.querySelectorAll('#tm-rate-presets button').forEach(b => {
      b.classList.toggle('active', Math.abs(Number(b.dataset.rate) - v) < 0.001);
    });
  }

  function setFontScale(s) {
    GM_setValue('fontScale', s);
    document.getElementById('tm-clean-overlay').style.setProperty('--tm-scale', s);
    document.querySelectorAll('#tm-font-scale button').forEach(b => {
      b.classList.toggle('active', Math.abs(Number(b.dataset.scale) - s) < 0.001);
    });
  }

  function bindSettings() {
    populateVoiceSelect();
    document.getElementById('tm-voice-select').addEventListener('change', e => {
      GM_setValue('voiceSel', e.target.value);
      useExternalThisSession = false;
      lastTtsError = '';
      updateSpeechButton();
    });
    document.getElementById('tm-rate-range').addEventListener('input', e => setRate(e.target.value));
    document.querySelectorAll('#tm-rate-presets button').forEach(b => b.addEventListener('click', () => setRate(b.dataset.rate)));
    document.querySelectorAll('#tm-font-scale button').forEach(b => b.addEventListener('click', () => setFontScale(Number(b.dataset.scale))));
    syncRateUI();
    setFontScale(getScale());
    updateUsageLabel();
  }

  function buildNav() {
    const nav = document.getElementById('tm-nav');
    nav.innerHTML = '';
    Object.entries(currentSource.categories).forEach(([name, path]) => {
      const button = document.createElement('button');
      button.className = 'tm-nav-btn';
      button.type = 'button';
      button.textContent = name;
      button.dataset.path = path;
      button.addEventListener('click', () => loadCategory(path, button));
      nav.appendChild(button);
    });
  }

  function switchSource(src) {
    if (src === currentSource && currentCategoryButton) { showArticleList(); return; }
    currentSource = src;
    GM_setValue('lastSource', Object.keys(SOURCES).find(id => SOURCES[id] === src));
    currentCategoryButton = null;
    document.querySelectorAll('.tm-src-btn').forEach(b => {
      const on = SOURCES[b.dataset.source] === src;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    buildNav();
    const first = document.querySelector('.tm-nav-btn');
    loadCategory(first.dataset.path, first);
  }

  // Detail mode = article or queue view: back button shown; on phones the source / category bars hide.
  function setArticleMode(isArticle) {
    const overlay = document.getElementById('tm-clean-overlay');
    overlay.classList.toggle('tm-mode-detail', isArticle);
  }

  function setHeaderTitle(title, eyebrow = '') {
    const element = document.getElementById('tm-title');
    if (element) element.textContent = title;
    const eb = document.getElementById('tm-eyebrow');
    if (eb) { eb.textContent = eyebrow; eb.hidden = !eyebrow; }
  }

  // Keep the active category chip visible in the horizontally scrolling bar (phones).
  function revealNavButton(btn) {
    const nav = document.getElementById('tm-nav');
    if (!btn || !nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: btn.offsetLeft - (nav.clientWidth - btn.offsetWidth) / 2, behavior: 'smooth' });
  }

  function skeletonHTML(rows = 8) {
    return `<div class="tm-page" aria-busy="true"><div class="tm-skel-meta tm-skel"></div><div class="tm-list">` +
      Array.from({ length: rows }, (_, i) => `<div class="tm-skel-row"><span class="tm-skel tm-skel-dot"></span><span class="tm-skel tm-skel-line" style="width:${55 + (i * 37) % 40}%"></span></div>`).join('') +
      `</div></div>`;
  }

  function stateHTML(kind, title, text, actionLabel) {
    return `<div class="tm-page"><div class="tm-state ${kind === 'error' ? 'tm-state-error' : ''}">
      <div class="tm-state-icon">${icon(kind === 'error' ? 'alert' : 'queue')}</div>
      <div class="tm-state-title">${escapeHTML(title)}</div>
      ${text ? `<div class="tm-state-text">${escapeHTML(text)}</div>` : ''}
      ${actionLabel ? `<button type="button" class="tm-btn tm-state-action">${kind === 'error' ? icon('refresh') : ''}<span>${escapeHTML(actionLabel)}</span></button>` : ''}
    </div></div>`;
  }

  // ===========================
  // LOAD CATEGORY / RENDER / ARTICLE
  // ===========================
  async function loadCategory(path, activeBtn) {
    const content = document.getElementById('tm-content');
    queueViewOpen = false;
    viewedArticleUrl = '';
    currentCategoryPath = path;
    currentCategoryButton = activeBtn || currentCategoryButton;
    setArticleMode(false);
    setHeaderTitle(activeBtn ? activeBtn.textContent : 'Čtečka zpráv', currentSource.name);
    document.querySelectorAll('.tm-nav-btn').forEach(button => button.classList.toggle('active', button === activeBtn));
    revealNavButton(activeBtn);
    content.innerHTML = skeletonHTML();
    content.scrollTop = 0;
    const src = currentSource;
    try {
      let docToParse;
      if (src === SOURCES.novinky && path === '/' && window.location.pathname === '/' && findSource(location.href) === src) {
        docToParse = document;
      } else {
        docToParse = await fetchDocument(/^https?:/i.test(path) ? path : sourceOrigin(src) + path);
      }
      if (src !== currentSource || path !== currentCategoryPath || queueViewOpen || viewedArticleUrl) return;   // user moved on
      const articles = extractArticles(docToParse, src);
      renderArticles(articles, content);
    } catch (error) {
      if (src !== currentSource || path !== currentCategoryPath) return;
      content.innerHTML = stateHTML('error', 'Články se nepodařilo načíst', error.message, 'Zkusit znovu');
      content.querySelector('.tm-state-action').addEventListener('click', () => loadCategory(path, activeBtn));
    }
  }

  function renderArticles(articles, container) {
    container.innerHTML = '';
    if (!articles.length) {
      container.innerHTML = stateHTML('empty', 'Nenalezeny žádné články', 'Zkuste jinou rubriku.');
      return;
    }
    const page = document.createElement('div');
    page.className = 'tm-page';
    page.innerHTML = `<div class="tm-list-meta"><span>${articlesCount(articles.length)}</span><span class="tm-list-hint">${icon('play')} přečíst · ${icon('plus')} do fronty</span></div>`;

    const list = document.createElement('ol');
    list.id = 'tm-article-list';
    list.className = 'tm-list';
    articles.forEach((article, index) => {
      const row = document.createElement('li');
      row.className = 'tm-article-row';

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'tm-row-play';
      play.dataset.url = article.url;
      play.title = 'Přečíst článek bez otevření';
      play.addEventListener('click', () => playFromList(article.url, article.title));

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tm-article-link';
      item.dataset.url = article.url;
      item.innerHTML = `
        <span class="tm-article-number">${index + 1}</span>
        <span class="tm-article-title">${escapeHTML(article.title)}</span>
      `;
      item.addEventListener('click', () => loadArticle(article.url));

      const q = document.createElement('button');
      q.type = 'button';
      q.className = 'tm-row-queue';
      q.dataset.url = article.url;
      q.addEventListener('click', () => queueHas(article.url) ? queueRemoveUrl(article.url) : queueAdd(article));

      row.appendChild(play);
      row.appendChild(item);
      row.appendChild(q);
      list.appendChild(row);
    });
    page.appendChild(list);
    container.appendChild(page);
    updateSpeechButton();
  }

  async function loadArticle(url) {
    const content = document.getElementById('tm-content');
    queueViewOpen = false;
    viewedArticleUrl = url;
    setArticleMode(true);
    setHeaderTitle(sourceForUrl(url).name);
    content.innerHTML = `<div class="tm-page tm-reader" aria-busy="true">
      <div class="tm-skel tm-skel-kicker"></div><div class="tm-skel tm-skel-h1"></div><div class="tm-skel tm-skel-h1" style="width:60%"></div>
      ${Array.from({ length: 6 }, (_, i) => `<div class="tm-skel tm-skel-p" style="width:${92 - (i * 13) % 30}%"></div>`).join('')}</div>`;
    content.scrollTop = 0;
    try {
      const doc = await fetchDocument(url);
      if (viewedArticleUrl !== url) return;                       // user moved on
      const article = extractArticle(doc, url);
      renderArticle(article, url);
    } catch (error) {
      if (viewedArticleUrl !== url) return;
      setHeaderTitle('Chyba');
      content.innerHTML = stateHTML('error', 'Článek se nepodařilo načíst', error.message, 'Zkusit znovu');
      content.querySelector('.tm-state-action').addEventListener('click', () => loadArticle(url));
    }
  }

  function getArticleSpeechText(article) {
    const parts = [];
    if (article.headline) parts.push(article.headline);
    if (article.perexText) parts.push(article.perexText);
    if (article.paragraphs && article.paragraphs.length) parts.push(...article.paragraphs);
    return parts.filter(Boolean).join('\n\n');
  }

  // Fetch an article and read it. idx >= 0 means it is played from the queue.
  async function playArticle(url, title, idx = -1) {
    stopSpeech();
    const token = ++listPlayToken;
    currentSpeechUrl = url;
    currentTitle = title || '';
    busyUrl = url;
    queueActive = idx >= 0;
    queueIndex = idx;
    speechSentences = []; speechFullText = ''; speechPos = 0;   // slider disabled until the text is loaded
    refreshQueueView();
    updateSpeechButton();
    try {
      const doc = await fetchDocument(url);
      if (token !== listPlayToken) return;
      const text = getArticleSpeechText(extractArticle(doc, url));
      if (!text) throw new Error('Text článku se nepodařilo najít');
      await toggleSpeechUnified(text);
    } catch (err) {
      if (token === listPlayToken) lastTtsError = err.message || String(err);
    }
    if (token === listPlayToken) busyUrl = '';
    updateSpeechButton();
  }

  // Play button next to a headline: read the article without opening it.
  async function playFromList(url, title) {
    if (speechPlaying && currentSpeechUrl === url) {
      await toggleSpeechUnified('');          // pause / resume
      return;
    }
    await playArticle(url, title, -1);
  }

  function stopAll() {
    speechSentences = []; speechFullText = ''; speechPos = 0;
    listPlayToken++;
    queueActive = false;
    queueIndex = -1;
    busyUrl = '';
    currentSpeechUrl = '';
    currentTitle = '';
    stopSpeech();
    uiQueueChanged();
  }

  // ===========================
  // QUEUE
  // ===========================
  const saveQueue = () => { try { GM_setValue('queue', queue); } catch { /* ignore */ } };
  const queueHas = url => queue.some(q => q.url === url);

  function uiQueueChanged() {
    syncQueueChecks();
    updatePlayerUI();
    refreshQueueView();
  }

  function queueAdd(article) {
    if (!queueHas(article.url)) {
      queue.push({ url: article.url, title: article.title });
      saveQueue();
    }
    uiQueueChanged();
  }

  function queueRemove(i) {
    if (i < 0 || i >= queue.length) return;
    const wasCurrent = queueActive && i === queueIndex;
    queue.splice(i, 1);
    saveQueue();
    if (queueActive) {
      if (wasCurrent) {
        listPlayToken++;
        stopSpeech();
        busyUrl = '';
        if (queue[i]) { playArticle(queue[i].url, queue[i].title, i); return; }
        queueActive = false; queueIndex = -1; currentSpeechUrl = ''; currentTitle = '';
      } else if (i < queueIndex) {
        queueIndex--;
      }
    }
    uiQueueChanged();
    updateSpeechButton();
  }

  function queueRemoveUrl(url) { queueRemove(queue.findIndex(q => q.url === url)); }

  function queueMove(i, dir) {
    const j = i + dir;
    if (i < 0 || j < 0 || i >= queue.length || j >= queue.length) return;
    [queue[i], queue[j]] = [queue[j], queue[i]];
    if (queueActive) {
      if (queueIndex === i) queueIndex = j;
      else if (queueIndex === j) queueIndex = i;
    }
    saveQueue();
    uiQueueChanged();
  }

  function queueClear() {
    if (queueActive) stopAll();
    queue = [];
    saveQueue();
    uiQueueChanged();
  }

  function playQueue() {
    if (queue.length) playArticle(queue[0].url, queue[0].title, 0);
  }

  // Queue toggles (+ / ✓) in the list and in the reader. data-text = show a text label too.
  function syncQueueChecks() {
    document.querySelectorAll('.tm-row-queue').forEach(b => {
      const on = queueHas(b.dataset.url);
      if (b.dataset.on === String(on)) return;
      b.dataset.on = String(on);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Odebrat z fronty' : 'Přidat do fronty';
      b.setAttribute('aria-label', b.title);
      b.innerHTML = icon(on ? 'check' : 'plus') + (b.dataset.text ? `<span>${on ? 'Ve frontě' : 'Do fronty'}</span>` : '');
    });
  }

  function updatePlayerUI() {
    const player = document.getElementById('tm-player');
    if (!player) return;
    const busy = !!busyUrl;
    const active = speechPlaying || busy;
    player.hidden = !(queue.length || active);
    setPlayState(document.getElementById('tm-pl-toggle'), speechPlaying ? (ttsPaused ? 'paused' : 'playing') : (busy ? 'busy' : 'idle'));
    document.getElementById('tm-pl-title').textContent = active && currentTitle
      ? currentTitle
      : (queue.length ? `Fronta: ${articlesCount(queue.length)}` : '');
    const sub = document.getElementById('tm-pl-sub');
    sub.textContent = speechPlaying ? (ttsPaused ? 'Pozastaveno · ' : '') + modeText()
      : busy ? 'Připravuji článek…'
      : lastTtsError ? lastTtsError
      : 'Připraveno k přehrání';
    sub.classList.toggle('tm-warn', !!lastTtsError && !useExternalThisSession);
    document.getElementById('tm-pl-next').disabled = !(queueActive || queue.length);
    document.getElementById('tm-pl-stop').disabled = !active;
    document.querySelectorAll('.tm-q-count').forEach(el => {
      el.textContent = queue.length > 99 ? '99+' : String(queue.length);
      el.hidden = !queue.length;
    });
    updateSeekUI();
  }

  function updateSeekUI() {
    const seek = document.getElementById('tm-pl-seek');
    if (!seek) return;
    const enabled = speechSentences.length > 0 && (speechPlaying || !!busyUrl);
    seek.disabled = !enabled;
    if (seekDragging) return;
    const frac = enabled ? speechPos / speechTotalChars : 0;
    seek.value = String(Math.round(frac * 1000));
    seek.style.setProperty('--tm-fill', frac * 100 + '%');
    document.getElementById('tm-pl-pos').textContent = Math.round(frac * 100) + ' %';
  }

  function showQueueView() {
    queueViewOpen = true;
    viewedArticleUrl = '';
    setArticleMode(true);
    setHeaderTitle('Fronta');
    const content = document.getElementById('tm-content');
    renderQueueView();
    content.scrollTop = 0;
  }

  function refreshQueueView() {
    if (queueViewOpen) renderQueueView();
  }

  function renderQueueView() {
    const content = document.getElementById('tm-content');
    if (!content) return;
    const scroll = content.scrollTop;
    setHeaderTitle('Fronta', queue.length ? articlesCount(queue.length) : '');
    if (!queue.length) {
      content.innerHTML = stateHTML('empty', 'Fronta je prázdná', 'V seznamu článků přidejte titulky tlačítkem +. Přehrané články z fronty samy zmizí.', 'Zpět na články');
      content.querySelector('.tm-state-action').addEventListener('click', showArticleList);
      return;
    }
    content.innerHTML = `
      <div class="tm-page">
        <div class="tm-page-head">
          <div>
            <h2 class="tm-page-title">Fronta čtení</h2>
            <div class="tm-page-sub">${articlesCount(queue.length)} · přehrané články se samy odeberou</div>
          </div>
          <div class="tm-page-actions">
            <button id="tm-q-play" class="tm-btn tm-btn-primary" type="button">${icon('play')}<span>Přehrát frontu</span></button>
            <button id="tm-q-clear" class="tm-btn" type="button">${icon('trash')}<span>Vyčistit</span></button>
          </div>
        </div>
        <ol id="tm-queue-list" class="tm-list"></ol>
      </div>`;
    const list = content.querySelector('#tm-queue-list');
    queue.forEach((item, i) => {
      const row = document.createElement('li');
      row.className = 'tm-queue-row';
      const mk = (cls, html, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = cls; b.innerHTML = html; b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', fn);
        return b;
      };
      const play = mk('tm-row-play', '', 'Přehrát odtud',
        () => (queueActive && i === queueIndex && speechPlaying) ? toggleSpeechUnified('') : playArticle(item.url, item.title, i));
      play.dataset.url = item.url;
      row.appendChild(play);
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'tm-article-link';
      title.innerHTML = `<span class="tm-article-number">${i + 1}</span><span class="tm-article-title">${escapeHTML(item.title)}</span>`;
      title.addEventListener('click', () => loadArticle(item.url));
      row.appendChild(title);
      const actions = document.createElement('div');
      actions.className = 'tm-q-actions';
      const up = mk('tm-q-btn', icon('up'), 'Posunout nahoru', () => queueMove(i, -1));
      const down = mk('tm-q-btn', icon('down'), 'Posunout dolů', () => queueMove(i, 1));
      up.disabled = i === 0;
      down.disabled = i === queue.length - 1;
      actions.appendChild(up);
      actions.appendChild(down);
      actions.appendChild(mk('tm-q-btn tm-q-del', icon('trash'), 'Odebrat z fronty', () => queueRemove(i)));
      row.appendChild(actions);
      list.appendChild(row);
    });
    content.querySelector('#tm-q-play').addEventListener('click', playQueue);
    content.querySelector('#tm-q-clear').addEventListener('click', () => { if (confirm('Vyčistit celou frontu?')) queueClear(); });
    updateSpeechButton();
    content.scrollTop = scroll;
  }

  async function populateVoiceSelect() {
    const select = document.getElementById('tm-voice-select');
    if (!select) return;
    const voices = await loadVoices();
    let local = voices.filter(v => /^(cs|sk)/i.test(v.lang || ''));
    if (!local.length) local = voices;
    const opt = (value, label) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`;
    let html = '';
    if (getKey()) {
      html += `<optgroup label="Azure (limit zdarma)">` +
        Object.entries(VOICES).map(([id, name]) => opt('azure:' + id, name)).join('') + `</optgroup>`;
    }
    html += `<optgroup label="Piper (offline, vlastní server)">` + opt('piper:jirka', 'Jirka (Piper)') + `</optgroup>`;
    html += `<optgroup label="Prohlížeč / systém (zdarma)">` + opt('local:auto', 'Automaticky (nejlepší dostupný)') +
      local.map(v => opt('local:' + v.voiceURI, `${v.name} [${v.lang}]`)).join('') + `</optgroup>`;
    if (select.innerHTML !== html) select.innerHTML = html;
    const sel = getSel();
    const exists = Array.from(select.options).some(o => o.value === sel);
    select.value = exists ? sel : 'local:auto';
    updateSpeechButton();
  }

  function renderArticle(article, url) {
    const content = document.getElementById('tm-content');
    const src = sourceForUrl(url);
    setHeaderTitle(src.name);
    const wrapper = document.createElement('article');
    wrapper.id = 'tm-article-reader';
    wrapper.className = 'tm-page tm-reader';
    wrapper.innerHTML = `
      <div class="tm-kicker">${escapeHTML(src.name)}</div>
      <h1>${escapeHTML(article.headline)}</h1>
      ${article.perexText ? `<p class="tm-perex">${escapeHTML(article.perexText)}</p>` : ''}
      <div class="tm-reader-actions">
        <button id="tm-speech-btn" class="tm-btn tm-btn-primary" type="button"></button>
        <button class="tm-btn tm-row-queue" data-url="${escapeHTML(url)}" data-text="1" type="button"></button>
        <span class="tm-spacer"></span>
        <a class="tm-btn tm-btn-ghost" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" title="Otevřít původní článek"><span>Originál</span>${icon('external')}</a>
      </div>
      <div class="tm-article-body">
        ${article.paragraphs.length ? article.paragraphs.map(paragraph => `<p>${escapeHTML(paragraph)}</p>`).join('') : `<div class="tm-error">Text článku se nepodařilo najít.</div>`}
      </div>
    `;
    content.innerHTML = '';
    content.appendChild(wrapper);
    content.scrollTop = 0;

    const speechButton = document.getElementById('tm-speech-btn');
    const speechText = getArticleSpeechText(article);
    viewedArticleUrl = url;
    speechButton.addEventListener('click', () => {
      if (speechPlaying && currentSpeechUrl !== url) stopSpeech();   // something else is being read
      if (!speechPlaying) {
        listPlayToken++; busyUrl = '';
        queueActive = false; queueIndex = -1;
        currentSpeechUrl = url; currentTitle = article.headline || '';
      }
      toggleSpeechUnified(speechText);
    });
    wrapper.querySelector('.tm-row-queue').addEventListener('click', () =>
      queueHas(url) ? queueRemoveUrl(url) : queueAdd({ url, title: article.headline || url }));
    updateSpeechButton();
  }

  function showArticleList() {
    if (currentCategoryButton) {
      loadCategory(currentCategoryPath, currentCategoryButton);
    } else {
      const firstButton = document.querySelector('.tm-nav-btn');
      loadCategory(firstButton.dataset.path, firstButton);
    }
  }

  // ===========================
  // CSS
  // ===========================
  GM_addStyle(`
    #tm-clean-overlay, #tm-trigger-btn {
      --tm-bg: #f5f5f3;
      --tm-surface: #ffffff;
      --tm-surface-2: #f0f0ed;
      --tm-text: #15171c;
      --tm-text-2: #555a64;
      --tm-text-3: #868b94;
      --tm-border: #e4e4e0;
      --tm-track: #dcdcd7;
      --tm-accent: #c8102e;
      --tm-accent-hover: #a90d26;
      --tm-accent-ink: #ffffff;
      --tm-accent-soft: #fcebee;
      --tm-warn: #b45309;
      --tm-ok: #15803d;
      --tm-shadow: 0 1px 2px rgba(16,18,24,.06), 0 4px 16px rgba(16,18,24,.06);
      --tm-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --tm-serif: Charter, "Iowan Old Style", "Source Serif Pro", Georgia, Cambria, "Times New Roman", serif;
      --tm-fs-base: 19px;
    }
    @media (prefers-color-scheme: dark) {
      #tm-clean-overlay, #tm-trigger-btn {
        --tm-bg: #0e0f11;
        --tm-surface: #17181b;
        --tm-surface-2: #222429;
        --tm-text: #eceef2;
        --tm-text-2: #a9aeb8;
        --tm-text-3: #767b85;
        --tm-border: #2a2d33;
        --tm-track: #3a3d44;
        --tm-accent: #e8324a;
        --tm-accent-hover: #f04d63;
        --tm-accent-soft: rgba(232,50,74,.16);
        --tm-warn: #f59e0b;
        --tm-ok: #4ade80;
        --tm-shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 20px rgba(0,0,0,.35);
      }
    }

    /* --- reset (low specificity, so component rules below win) --- */
    :where(#tm-clean-overlay), :where(#tm-clean-overlay) *, :where(#tm-clean-overlay) *::before, :where(#tm-clean-overlay) *::after { box-sizing: border-box; }
    :where(#tm-clean-overlay) :where(button, input, select, output) { font: inherit; color: inherit; margin: 0; letter-spacing: normal; text-transform: none; }
    :where(#tm-clean-overlay) :where(button) { -webkit-tap-highlight-color: transparent; }
    :where(#tm-clean-overlay) :where(h1, h2, p, ol, li) { margin: 0; padding: 0; }
    :where(#tm-clean-overlay) :where(ol) { list-style: none; }
    #tm-clean-overlay [hidden] { display: none !important; }
    #tm-clean-overlay svg.tm-ic, #tm-trigger-btn svg.tm-ic {
      width: 20px; height: 20px; flex: none; display: block;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    #tm-clean-overlay svg.tm-ic .tm-fill { fill: currentColor; stroke: none; }
    #tm-clean-overlay :focus-visible { outline: 2px solid var(--tm-accent); outline-offset: 2px; }
    #tm-clean-overlay button:disabled { opacity: .4; cursor: default; }

    /* --- floating launcher button --- */
    #tm-trigger-btn {
      position: fixed; left: 16px; bottom: calc(16px + env(safe-area-inset-bottom));
      z-index: 2147482999;
      display: inline-flex; align-items: center; gap: 8px;
      height: 48px; padding: 0 20px 0 16px; border: 0; border-radius: 999px;
      background: var(--tm-accent); color: var(--tm-accent-ink);
      font: 600 15px/1 var(--tm-sans); letter-spacing: .01em; cursor: pointer;
      box-shadow: 0 8px 24px rgba(200,16,46,.35), 0 2px 6px rgba(0,0,0,.18);
      transition: transform .15s ease, background .15s ease;
    }
    #tm-trigger-btn:hover { background: var(--tm-accent-hover); transform: translateY(-1px); }

    /* --- shell --- */
    #tm-clean-overlay {
      position: fixed; inset: 0; width: 100%; height: 100vh; height: 100dvh;
      z-index: 2147483000;
      display: none; flex-direction: column; overflow: hidden; overflow: clip;   /* clip: cannot be scrolled by focus() */
      background: var(--tm-bg); color: var(--tm-text);
      font: 15px/1.45 var(--tm-sans); text-align: left;
      -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
      -webkit-font-smoothing: antialiased;
    }
    #tm-header {
      flex: none; display: flex; align-items: center; gap: 6px;
      min-height: 60px; padding: env(safe-area-inset-top) 10px 0 16px;
      background: var(--tm-surface); border-bottom: 1px solid var(--tm-border);
    }
    #tm-brand {
      width: 34px; height: 34px; flex: none; display: grid; place-items: center;
      border-radius: 9px; background: var(--tm-accent); color: var(--tm-accent-ink); margin-right: 6px;
    }
    #tm-brand svg.tm-ic { width: 18px; height: 18px; }
    #tm-back-btn { display: none; margin-left: -8px; }
    #tm-clean-overlay.tm-mode-detail #tm-back-btn { display: inline-grid; }
    #tm-clean-overlay.tm-mode-detail #tm-brand { display: none; }
    #tm-title-wrap { flex: 1 1 auto; min-width: 0; }
    #tm-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--tm-accent); line-height: 1.2; }
    #tm-title { font-size: 17px; font-weight: 700; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tm-header-actions { flex: none; display: flex; align-items: center; gap: 2px; }

    .tm-icon-btn {
      position: relative; width: 40px; height: 40px; flex: none;
      display: inline-grid; place-items: center; padding: 0;
      border: 0; border-radius: 10px; background: transparent; color: var(--tm-text-2); cursor: pointer;
      transition: background .15s ease, color .15s ease;
    }
    .tm-icon-btn:hover:not(:disabled) { background: var(--tm-surface-2); color: var(--tm-text); }
    .tm-badge {
      position: absolute; top: 3px; right: 1px; min-width: 18px; height: 18px; padding: 0 5px;
      border-radius: 9px; background: var(--tm-accent); color: var(--tm-accent-ink);
      font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
      box-shadow: 0 0 0 2px var(--tm-surface);
    }

    #tm-body { flex: 1 1 auto; min-height: 0; display: flex; }

    /* --- sidebar (desktop) --- */
    #tm-side {
      flex: none; width: 248px; overflow-y: auto; overscroll-behavior: contain;
      padding: 16px 12px 24px; background: var(--tm-surface); border-right: 1px solid var(--tm-border);
    }
    .tm-side-label { padding: 0 12px; margin: 4px 0 6px; font-size: 11.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--tm-text-3); }
    .tm-side-label + #tm-nav, #tm-sources + .tm-side-label { margin-top: 20px; }
    #tm-sources, #tm-nav { display: flex; flex-direction: column; gap: 2px; }
    #tm-nav { position: relative; }
    .tm-src-btn, .tm-nav-btn {
      display: flex; align-items: center; width: 100%; min-height: 38px; padding: 8px 12px;
      border: 0; border-radius: 8px; background: transparent; color: var(--tm-text-2);
      font-size: 14.5px; font-weight: 500; text-align: left; cursor: pointer;
      transition: background .15s ease, color .15s ease;
    }
    .tm-src-btn:hover, .tm-nav-btn:hover { background: var(--tm-surface-2); color: var(--tm-text); }
    .tm-src-btn.active { background: var(--tm-surface-2); color: var(--tm-text); font-weight: 700; box-shadow: inset 3px 0 0 var(--tm-text); }
    .tm-nav-btn.active { background: var(--tm-accent-soft); color: var(--tm-accent); font-weight: 650; }

    /* --- content --- */
    #tm-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .tm-page { max-width: 820px; margin: 0 auto; padding: 24px 28px 56px; }

    .tm-list-meta { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 0 4px 10px; font-size: 13px; color: var(--tm-text-3); }
    .tm-list-hint { display: inline-flex; align-items: center; gap: 4px; }
    .tm-list-hint svg.tm-ic { width: 14px; height: 14px; }
    .tm-list {
      display: flex; flex-direction: column;
      background: var(--tm-surface); border: 1px solid var(--tm-border); border-radius: 14px; overflow: hidden;
      box-shadow: var(--tm-shadow);
    }
    .tm-article-row, .tm-queue-row {
      display: flex; align-items: center; gap: 6px; padding: 6px 10px 6px 12px;
      border-top: 1px solid var(--tm-border); transition: background .12s ease;
    }
    .tm-article-row:first-child, .tm-queue-row:first-child { border-top: 0; }
    .tm-article-row:hover, .tm-queue-row:hover { background: var(--tm-surface-2); }
    .tm-article-row.is-current, .tm-queue-row.is-current { background: var(--tm-accent-soft); }
    .tm-article-row.is-current .tm-article-title, .tm-queue-row.is-current .tm-article-title { color: var(--tm-accent); }

    .tm-row-play {
      width: 38px; height: 38px; flex: none; display: grid; place-items: center; padding: 0;
      border: 0; border-radius: 50%; background: var(--tm-accent-soft); color: var(--tm-accent); cursor: pointer;
      transition: background .15s ease, color .15s ease, transform .1s ease;
    }
    .tm-row-play svg.tm-ic { width: 16px; height: 16px; }
    .tm-row-play:hover { background: var(--tm-accent); color: var(--tm-accent-ink); }
    .tm-row-play:active { transform: scale(.94); }
    .tm-row-play[data-state="playing"], .tm-row-play[data-state="paused"] { background: var(--tm-accent); color: var(--tm-accent-ink); }

    .tm-article-link {
      flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 12px;
      padding: 10px 6px; border: 0; background: transparent; color: var(--tm-text); text-align: left; cursor: pointer;
    }
    .tm-article-number { flex: none; min-width: 1.6em; text-align: right; font-size: 12.5px; font-weight: 600; color: var(--tm-text-3); font-variant-numeric: tabular-nums; }
    .tm-article-title { font-size: 16px; font-weight: 600; line-height: 1.38; overflow-wrap: anywhere; }
    .tm-article-link:hover .tm-article-title { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }

    .tm-row-queue {
      width: 34px; height: 34px; flex: none; display: grid; place-items: center; padding: 0;
      border: 1.5px solid var(--tm-border); border-radius: 10px; background: transparent; color: var(--tm-text-3); cursor: pointer;
      transition: all .15s ease;
    }
    .tm-row-queue svg.tm-ic { width: 17px; height: 17px; }
    .tm-row-queue:hover { border-color: var(--tm-text-3); color: var(--tm-text); }
    .tm-row-queue[aria-pressed="true"] { background: var(--tm-text); border-color: var(--tm-text); color: var(--tm-surface); }

    .tm-q-actions { flex: none; display: flex; gap: 2px; }
    .tm-q-btn {
      width: 34px; height: 34px; display: grid; place-items: center; padding: 0;
      border: 0; border-radius: 8px; background: transparent; color: var(--tm-text-3); cursor: pointer;
    }
    .tm-q-btn svg.tm-ic { width: 18px; height: 18px; }
    .tm-q-btn:hover:not(:disabled) { background: var(--tm-surface); color: var(--tm-text); }
    .tm-q-del:hover:not(:disabled) { color: var(--tm-accent); }

    .tm-page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; margin: 0 4px 16px; }
    .tm-page-title { font-size: 24px; font-weight: 750; letter-spacing: -.01em; line-height: 1.2; }
    .tm-page-sub { margin-top: 2px; font-size: 13.5px; color: var(--tm-text-3); }
    .tm-page-actions { display: flex; flex-wrap: wrap; gap: 8px; }

    /* --- buttons --- */
    .tm-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      height: 40px; padding: 0 16px; border: 1px solid var(--tm-border); border-radius: 999px;
      background: var(--tm-surface); color: var(--tm-text);
      font-size: 14px; font-weight: 600; line-height: 1; text-decoration: none; white-space: nowrap; cursor: pointer;
      transition: background .15s ease, border-color .15s ease, color .15s ease;
    }
    .tm-btn svg.tm-ic { width: 18px; height: 18px; }
    .tm-btn:hover { background: var(--tm-surface-2); }
    .tm-btn-primary { background: var(--tm-accent); border-color: var(--tm-accent); color: var(--tm-accent-ink); }
    .tm-btn-primary:hover { background: var(--tm-accent-hover); border-color: var(--tm-accent-hover); }
    .tm-btn-ghost { background: transparent; border-color: transparent; color: var(--tm-text-2); }
    .tm-btn-ghost:hover { color: var(--tm-text); }
    .tm-btn.tm-row-queue { width: auto; height: 40px; padding: 0 16px; border-width: 1px; border-radius: 999px; color: var(--tm-text); display: inline-flex; }
    .tm-btn.tm-row-queue[aria-pressed="true"] { background: var(--tm-text); color: var(--tm-surface); }
    .tm-chip {
      height: 32px; padding: 0 12px; border: 1px solid var(--tm-border); border-radius: 999px;
      background: var(--tm-surface); color: var(--tm-text-2); font-size: 13px; font-weight: 600;
      font-variant-numeric: tabular-nums; cursor: pointer;
    }
    .tm-chip:hover { color: var(--tm-text); border-color: var(--tm-text-3); }

    /* --- reader --- */
    .tm-reader { max-width: 720px; padding-top: 36px; }
    .tm-kicker { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--tm-accent); margin-bottom: 10px; }
    .tm-reader h1 {
      font-family: var(--tm-serif); font-size: clamp(27px, 3.4vw, 38px); font-weight: 700;
      line-height: 1.18; letter-spacing: -.012em; color: var(--tm-text); margin: 0 0 14px;
    }
    .tm-perex { font-size: calc(var(--tm-fs-base) * var(--tm-scale, 1) * 1.05); line-height: 1.55; color: var(--tm-text-2); font-weight: 500; margin-bottom: 20px; }
    .tm-reader-actions {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 14px 0; margin-bottom: 28px; border-top: 1px solid var(--tm-border); border-bottom: 1px solid var(--tm-border);
    }
    .tm-spacer { flex: 1 1 auto; }
    #tm-speech-btn { min-width: 168px; }
    .tm-article-body p {
      font-family: var(--tm-serif); font-size: calc(var(--tm-fs-base) * var(--tm-scale, 1));
      line-height: 1.72; color: var(--tm-text); margin: 0 0 1.15em; overflow-wrap: break-word;
    }

    /* --- states / skeleton --- */
    .tm-state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 56px 20px; }
    .tm-state-icon { width: 56px; height: 56px; display: grid; place-items: center; border-radius: 50%; background: var(--tm-surface-2); color: var(--tm-text-3); margin-bottom: 4px; }
    .tm-state-icon svg.tm-ic { width: 26px; height: 26px; }
    .tm-state-error .tm-state-icon { background: var(--tm-accent-soft); color: var(--tm-accent); }
    .tm-state-title { font-size: 18px; font-weight: 700; }
    .tm-state-text { max-width: 460px; color: var(--tm-text-2); font-size: 14.5px; overflow-wrap: anywhere; }
    .tm-state-action { margin-top: 8px; }
    .tm-error { color: var(--tm-accent); background: var(--tm-accent-soft); padding: 14px 16px; border-radius: 10px; }

    @keyframes tm-shimmer { 0% { opacity: .55; } 50% { opacity: 1; } 100% { opacity: .55; } }
    .tm-skel { display: block; background: var(--tm-surface-2); border-radius: 6px; animation: tm-shimmer 1.4s ease-in-out infinite; }
    .tm-skel-meta { width: 90px; height: 12px; margin: 4px 4px 14px; }
    .tm-skel-row { display: flex; align-items: center; gap: 14px; padding: 16px 14px; border-top: 1px solid var(--tm-border); }
    .tm-skel-row:first-child { border-top: 0; }
    .tm-skel-dot { width: 38px; height: 38px; border-radius: 50%; flex: none; }
    .tm-skel-line { height: 14px; }
    .tm-skel-kicker { width: 100px; height: 12px; margin-bottom: 16px; }
    .tm-skel-h1 { height: 30px; margin-bottom: 10px; }
    .tm-skel-p { height: 15px; margin-top: 18px; }

    @keyframes tm-spin { to { transform: rotate(360deg); } }
    .tm-spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: tm-spin .8s linear infinite; display: block; }

    /* --- range sliders --- */
    .tm-range { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; margin: 0; padding: 0; background: transparent; cursor: pointer; --tm-fill: 0%; }
    .tm-range:disabled { cursor: default; opacity: .5; }
    .tm-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--tm-accent) var(--tm-fill), var(--tm-track) var(--tm-fill)); }
    .tm-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border: 0; border-radius: 50%; background: var(--tm-accent); box-shadow: 0 0 0 3px var(--tm-surface), 0 1px 3px rgba(0,0,0,.3); }
    .tm-range::-moz-range-track { height: 4px; border-radius: 2px; background: var(--tm-track); }
    .tm-range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--tm-accent); }
    .tm-range::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: var(--tm-accent); box-shadow: 0 0 0 3px var(--tm-surface), 0 1px 3px rgba(0,0,0,.3); }
    .tm-range:disabled::-webkit-slider-thumb { background: var(--tm-text-3); }
    .tm-range:disabled::-moz-range-thumb { background: var(--tm-text-3); }

    /* --- player bar --- */
    #tm-player {
      flex: none; position: relative; z-index: 2;
      display: grid; align-items: center; gap: 6px 16px;
      grid-template-columns: auto minmax(0, 1.2fr) minmax(140px, 2fr) auto auto auto;
      grid-template-areas: "controls info seek pos rate queue";
      padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
      background: var(--tm-surface); border-top: 1px solid var(--tm-border);
      box-shadow: 0 -6px 20px rgba(16,18,24,.06);
    }
    .tm-pl-controls { grid-area: controls; display: flex; align-items: center; gap: 4px; }
    .tm-pl-main {
      width: 44px; height: 44px; flex: none; display: grid; place-items: center; padding: 0; margin-right: 4px;
      border: 0; border-radius: 50%; background: var(--tm-accent); color: var(--tm-accent-ink); cursor: pointer;
      box-shadow: 0 4px 12px rgba(200,16,46,.3); transition: background .15s ease, transform .1s ease;
    }
    .tm-pl-main:hover { background: var(--tm-accent-hover); }
    .tm-pl-main:active { transform: scale(.94); }
    .tm-pl-main svg.tm-ic { width: 20px; height: 20px; }
    .tm-pl-main .tm-spinner { width: 18px; height: 18px; }
    .tm-pl-info { grid-area: info; min-width: 0; }
    #tm-pl-title { font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tm-pl-sub { font-size: 12px; color: var(--tm-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tm-pl-sub.tm-warn { color: var(--tm-warn); }
    #tm-pl-seek { grid-area: seek; }
    #tm-pl-pos { grid-area: pos; min-width: 3.2em; text-align: right; font-size: 12px; font-weight: 600; color: var(--tm-text-3); font-variant-numeric: tabular-nums; }
    #tm-pl-rate { grid-area: rate; }
    #tm-pl-queue { grid-area: queue; }

    /* --- settings panel (popover on desktop, bottom sheet on phones) --- */
    #tm-sheet-backdrop {
      position: absolute; inset: 0; z-index: 10; background: rgba(8,10,14,.32);
      opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility .2s ease;
    }
    #tm-sheet {
      position: absolute; z-index: 11; top: 68px; right: 16px; width: 380px; max-height: calc(100% - 84px); overflow-y: auto;
      padding: 16px 20px 20px; border: 1px solid var(--tm-border); border-radius: 16px;
      background: var(--tm-surface); color: var(--tm-text);
      box-shadow: 0 16px 48px rgba(8,10,14,.22), 0 2px 8px rgba(8,10,14,.08);
      opacity: 0; visibility: hidden; transform: translateY(-6px) scale(.98); transform-origin: top right;
      transition: opacity .18s ease, transform .18s ease, visibility .18s ease;
    }
    #tm-clean-overlay.tm-sheet-open #tm-sheet-backdrop { opacity: 1; visibility: visible; }
    #tm-clean-overlay.tm-sheet-open #tm-sheet { opacity: 1; visibility: visible; transform: none; }
    .tm-sheet-grab { display: none; width: 36px; height: 4px; border-radius: 2px; background: var(--tm-track); margin: -4px auto 10px; }
    .tm-sheet-head { display: flex; align-items: center; justify-content: space-between; margin: 0 -8px 8px 0; }
    .tm-sheet-head h2 { font-size: 17px; font-weight: 700; }
    .tm-field { padding: 12px 0; }
    .tm-field + .tm-field { border-top: 1px solid var(--tm-border); }
    .tm-field-head { display: flex; justify-content: space-between; align-items: baseline; }
    .tm-field-label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 650; color: var(--tm-text-2); }
    #tm-rate-label { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .tm-select-wrap { position: relative; }
    .tm-select {
      -webkit-appearance: none; appearance: none; width: 100%; height: 44px; padding: 0 40px 0 12px;
      border: 1px solid var(--tm-border); border-radius: 10px; background: var(--tm-surface-2); color: var(--tm-text);
      font-size: 15px; cursor: pointer; text-overflow: ellipsis;
    }
    .tm-select option, .tm-select optgroup { background: var(--tm-surface); color: var(--tm-text); }
    .tm-select-wrap svg.tm-ic { position: absolute; right: 12px; top: 12px; pointer-events: none; color: var(--tm-text-3); }
    .tm-seg { display: flex; gap: 2px; margin-top: 10px; padding: 3px; border-radius: 10px; background: var(--tm-surface-2); }
    .tm-seg button {
      flex: 1 1 0; height: 32px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent;
      color: var(--tm-text-2); font-size: 13px; font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums;
    }
    .tm-seg button:hover { color: var(--tm-text); }
    .tm-seg button.active { background: var(--tm-surface); color: var(--tm-text); box-shadow: 0 1px 3px rgba(0,0,0,.14); }
    .tm-status {
      display: flex; align-items: flex-start; gap: 10px; margin-top: 4px; padding: 10px 12px;
      border-radius: 10px; background: var(--tm-surface-2); font-size: 13.5px; color: var(--tm-text-2);
    }
    .tm-dot { width: 8px; height: 8px; flex: none; margin-top: 6px; border-radius: 50%; background: var(--tm-ok); }
    .tm-status.tm-warn .tm-dot { background: var(--tm-warn); }
    .tm-status .tm-warn { color: var(--tm-warn); }
    .tm-usage { margin-top: 12px; font-size: 12.5px; color: var(--tm-text-3); }
    .tm-meter { height: 4px; margin-top: 6px; border-radius: 2px; background: var(--tm-track); overflow: hidden; }
    .tm-meter span { display: block; height: 100%; width: 0; background: var(--tm-accent); }
    .tm-hint { margin-top: 12px; font-size: 12.5px; line-height: 1.5; color: var(--tm-text-3); }
    .tm-hint code { font-size: 12px; padding: 1px 4px; border-radius: 4px; background: var(--tm-surface-2); }
    .tm-hint kbd { font: 600 11px/1 var(--tm-sans); padding: 3px 6px; border: 1px solid var(--tm-border); border-bottom-width: 2px; border-radius: 5px; background: var(--tm-surface); color: var(--tm-text-2); }

    /* ======= tablets & phones ======= */
    @media (max-width: 899px) {
      #tm-clean-overlay { --tm-fs-base: 18px; }
      #tm-header { min-height: 56px; padding-left: 12px; padding-right: 6px; }
      #tm-title { font-size: 16px; }
      #tm-body { flex-direction: column; }
      #tm-side {
        width: auto; flex: none; overflow: visible; padding: 10px 0 0;
        border-right: 0; border-bottom: 1px solid var(--tm-border);
      }
      .tm-side-label { display: none; }
      #tm-clean-overlay.tm-mode-detail #tm-side { display: none; }
      #tm-sources { flex-direction: row; gap: 2px; margin: 0 12px; padding: 3px; border-radius: 10px; background: var(--tm-surface-2); }
      .tm-src-btn { flex: 1 1 0; min-width: 0; min-height: 34px; padding: 6px 4px; justify-content: center; text-align: center; font-size: 13.5px; white-space: nowrap; }
      .tm-src-btn.active { background: var(--tm-surface); box-shadow: 0 1px 3px rgba(0,0,0,.14); }
      #tm-nav {
        flex-direction: row; flex-wrap: nowrap; gap: 8px; margin-top: 0 !important;
        padding: 10px 12px 12px; overflow-x: auto; scrollbar-width: none; scroll-padding: 0 12px;
        -webkit-mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 20px), transparent 100%);
                mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 20px), transparent 100%);
      }
      #tm-nav::-webkit-scrollbar { display: none; }
      .tm-nav-btn {
        flex: none; width: auto; min-height: 36px; padding: 0 14px; white-space: nowrap;
        border: 1px solid var(--tm-border); border-radius: 999px; background: var(--tm-surface); font-size: 14px;
      }
      .tm-nav-btn.active { background: var(--tm-text); border-color: var(--tm-text); color: var(--tm-surface); }
      .tm-page { padding: 14px 12px 32px; }
      .tm-list-hint { display: none; }
      .tm-list { border-radius: 12px; }
      .tm-article-row, .tm-queue-row { padding: 4px 8px 4px 10px; gap: 4px; }
      .tm-article-link { gap: 8px; padding: 12px 6px; }
      .tm-article-number { display: none; }
      .tm-article-title { font-size: 15.5px; }
      .tm-row-queue { width: 36px; height: 36px; }
      .tm-queue-row .tm-article-number { display: inline; }
      .tm-q-btn { width: 32px; height: 36px; }
      .tm-page-title { font-size: 21px; }
      .tm-page-actions { width: 100%; }
      .tm-page-actions .tm-btn { flex: 1 1 0; }
      .tm-reader { padding: 20px 18px 40px; }
      .tm-reader h1 { font-size: 26px; }
      .tm-reader-actions { gap: 8px; }
      #tm-speech-btn { flex: 1 1 auto; min-width: 0; }
      .tm-reader-actions .tm-spacer { display: none; }
      .tm-reader-actions .tm-btn-ghost { width: 40px; padding: 0; }
      .tm-reader-actions .tm-btn-ghost span { display: none; }

      #tm-player {
        grid-template-columns: minmax(0, 1fr) auto auto;
        grid-template-areas: "seek seek pos" "info controls queue";
        gap: 2px 6px; padding: 4px 10px calc(8px + env(safe-area-inset-bottom)) 14px;
      }
      #tm-pl-rate { display: none; }
      #tm-pl-pos { min-width: 2.8em; font-size: 11px; }
      .tm-pl-controls { gap: 0; }
      .tm-pl-main { order: 0; margin-right: 0; width: 46px; height: 46px; }
      #tm-pl-next { order: 1; }
      #tm-pl-stop { order: -1; }

      .tm-kbd-hint { display: none; }
      #tm-sheet {
        top: auto; right: 0; left: 0; bottom: 0; width: auto; max-height: 88%;
        padding: 14px 18px calc(20px + env(safe-area-inset-bottom));
        border: 0; border-radius: 20px 20px 0 0;
        transform: translateY(100%); transform-origin: bottom center;
        transition: transform .26s cubic-bezier(.2,.8,.2,1), visibility .26s, opacity .26s;
      }
      .tm-sheet-grab { display: block; }
      #tm-trigger-btn { left: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); }
    }
    @media (max-width: 380px) {
      .tm-src-btn { font-size: 12.5px; }
      #tm-hd-queue { display: none; }
    }
    @media (hover: none) {
      .tm-article-row:hover, .tm-queue-row:hover { background: transparent; }
      .tm-article-row.is-current, .tm-queue-row.is-current { background: var(--tm-accent-soft); }
      .tm-row-play:hover { background: var(--tm-accent-soft); color: var(--tm-accent); }
      .tm-row-play[data-state="playing"]:hover, .tm-row-play[data-state="paused"]:hover { background: var(--tm-accent); color: var(--tm-accent-ink); }
    }
    @media (prefers-reduced-motion: reduce) {
      #tm-clean-overlay *, #tm-trigger-btn { transition: none !important; animation-duration: 0s !important; }
    }
  `);

  // ===========================
  // INIT
  // ===========================
  buildUI();

  if (isLauncher) {
    document.title = 'Čtečka zpráv';
    document.getElementById('tm-trigger-btn').click();               // open straight away
    document.getElementById('tm-trigger-btn').style.display = 'none';
    document.getElementById('tm-close-btn').style.display = 'none';   // nothing to return to
  }

})();
