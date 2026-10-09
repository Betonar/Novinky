// ==UserScript==
// @name         Novinky.cz - Clean Reader + Neural TTS
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Category browser, clean article reader and high-quality Czech neural TTS (Azure) with local fallback.
// @author       You
// @match        *://*.novinky.cz/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *.tts.speech.microsoft.com
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
    voice: 'cs-CZ-VlastaNeural',          // or 'cs-CZ-AntoninNeural' (male)
    format: 'audio-24khz-96kbitrate-mono-mp3',
    chunkChars: 600,                       // size of one request (sentence-aligned)
    rate: 1.0                              // playback speed
  };
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
  // CATEGORY MAPPING
  // ===========================
  const categories = {
    "Titulka (Hlavní)": "/",
    "Stalo se": "/stalo-se",
    "Domácí": "/domaci",
    "Volby": "/volby",
    "Zahraniční": "/zahranicni",
    "Válka na Ukrajině": "/valka-na-ukrajine",
    "Komentáře": "/komentare",
    "Krimi": "/krimi",
    "Ekonomika": "/ekonomika"
  };

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

  function absoluteUrl(href) {
    try {
      return new URL(href, window.location.origin).href;
    } catch {
      return href;
    }
  }

  async function fetchDocument(url) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // ===========================
  // EXTRACT ARTICLES / ARTICLE
  // ===========================
  function extractArticles(doc) {
    const articles = [];
    const seenUrls = new Set();
    const links = doc.querySelectorAll('a[href*="/clanek/"]');
    links.forEach(link => {
      if (link.closest('.section-box, .box, .external-box, footer')) return;
      const rawHref = link.getAttribute('href');
      if (!rawHref) return;
      const url = absoluteUrl(rawHref);
      if (seenUrls.has(url)) return;
      const titleEl = link.querySelector('h1, h2, h3, h4, h5, h6, [class*="headline"], [class*="title"]');
      let title = titleEl ? titleEl.textContent.trim() : link.textContent.trim();
      title = title.replace(/\s+/g, ' ').trim();
      if (!title || title.length < 10) return;
      seenUrls.add(url);
      articles.push({ title, url });
    });
    return articles;
  }

  function extractArticle(doc) {
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

  // ===========================
  // TTS: Azure neural voice
  // ===========================
  function ssmlFor(text) {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<speak version="1.0" xml:lang="cs-CZ" xmlns="http://www.w3.org/2001/10/synthesis">` +
      `<voice name="${TTS.voice}">${esc}</voice></speak>`;
  }

  // Returns a blob: URL with MP3 audio for one chunk of text.
  function synthesizeChunk(text) {
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
          if (r.status !== 200) return reject(new Error(`Azure TTS HTTP ${r.status}`));
          resolve(URL.createObjectURL(new Blob([r.response], { type: 'audio/mpeg' })));
        },
        onerror: () => reject(new Error('Azure TTS network error')),
        ontimeout: () => reject(new Error('Azure TTS timeout'))
      });
    });
  }

  function playUrl(url, session) {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      a.playbackRate = TTS.rate;
      a.preservesPitch = true;
      audioElement = a;
      a.onended = () => resolve();
      a.onerror = () => reject(new Error('Audio playback error'));
      a.play().catch(reject);
    });
  }

  // Plays all chunks in order, synthesizing chunk N+1 while N is playing (gapless).
  async function startNeuralSpeech(text, session) {
    const chunks = sentenceChunking(text, TTS.chunkChars);
    if (!chunks.length) return;
    let next = synthesizeChunk(chunks[0]);
    next.catch(() => {});
    for (let i = 0; i < chunks.length; i++) {
      const url = await next;                       // throws -> caller falls back
      if (session !== ttsSession) { URL.revokeObjectURL(url); return; }
      if (i === 0) { speechPlaying = true; useExternalThisSession = true; updateSpeechButton(); }
      if (i + 1 < chunks.length) { next = synthesizeChunk(chunks[i + 1]); next.catch(() => {}); }
      await playUrl(url, session);
      URL.revokeObjectURL(url);
      if (session !== ttsSession) return;
    }
    speechPlaying = false;
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
    const preferredKeys = ['neural', 'google', 'microsoft', 'premium', 'cs-cz', 'cs', 'czech'];
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
  function sentenceChunking(text, maxChars = 700) {
    // Basic sentence split using punctuation
    const sentences = text
      .replace(/\r\n/g, ' ')
      .replace(/\n/g, ' ')
      .split(/(?<=[.?!…])\s+/u)
      .map(s => s.trim())
      .filter(Boolean);

    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if ((current + ' ' + s).trim().length <= maxChars) {
        current = (current + ' ' + s).trim();
      } else {
        if (current) chunks.push(current);
        current = s;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function stopLocalSpeech() {
    window.speechSynthesis.cancel();
    speechPlaying = false;
    speechUtterance = null;
    speechChunks = [];
    speechIndex = 0;
    updateSpeechButton();
  }

  async function startLocalSpeech(text) {
    stopLocalSpeech();
    speechChunks = sentenceChunking(text, 700);
    if (!speechChunks.length) return;
    speechIndex = 0;
    speechPlaying = true;
    const voice = await chooseVoice();
    speakNextLocalChunk(voice);
  }

  function speakNextLocalChunk(selectedVoice) {
    if (!speechPlaying || speechIndex >= speechChunks.length) {
      speechPlaying = false;
      speechIndex = 0;
      updateSpeechButton();
      return;
    }
    const text = speechChunks[speechIndex];
    speechUtterance = new SpeechSynthesisUtterance(text);
    if (selectedVoice) {
      speechUtterance.voice = selectedVoice;
      speechUtterance.lang = selectedVoice.lang || 'cs-CZ';
    } else {
      speechUtterance.lang = 'cs-CZ';
    }
    // Gentle settings
    speechUtterance.rate = 0.98;
    speechUtterance.pitch = 0.95;
    speechUtterance.volume = 1.0;

    speechUtterance.onend = function () {
      // small pause between chunks to improve naturalness
      speechIndex++;
      setTimeout(() => speakNextLocalChunk(selectedVoice), 220);
    };
    speechUtterance.onerror = function () {
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

  async function toggleSpeechUnified(text) {
    // Pause / resume of the neural audio
    if (audioElement && speechPlaying) {
      if (ttsPaused) { await audioElement.play(); ttsPaused = false; }
      else { audioElement.pause(); ttsPaused = true; }
      updateSpeechButton();
      return;
    }
    if (speechPlaying) { stopSpeech(); return; }

    const session = ++ttsSession;
    if (getKey()) {
      try {
        await startNeuralSpeech(text, session);
        return;
      } catch (err) {
        if (session !== ttsSession) return;
        console.warn('Neural TTS failed, falling back to local TTS:', err);
        stopSpeech();
      }
    } else {
      console.info('Azure key not set (Tampermonkey menu), using local TTS.');
    }
    useExternalThisSession = false;
    await startLocalSpeech(text);
  }

  function updateSpeechButton() {
    const button = document.getElementById('tm-speech-btn');
    const modeLabel = document.getElementById('tm-tts-mode-label');
    if (!button) return;
    if (speechPlaying && !ttsPaused) {
      button.innerHTML = `<span class="tm-speech-icon">⏸</span><span class="tm-speech-label">Pozastavit čtení</span>`;
      button.classList.add('playing');
    } else if (speechPlaying && ttsPaused) {
      button.innerHTML = `<span class="tm-speech-icon">▶</span><span class="tm-speech-label">Pokračovat</span>`;
      button.classList.add('playing');
    } else {
      button.innerHTML = `<span class="tm-speech-icon">▶</span><span class="tm-speech-label">Přečíst článek</span>`;
      button.classList.remove('playing');
    }
    if (modeLabel) {
      modeLabel.textContent = !getKey() ? 'Lokální TTS (chybí Azure klíč)' : (useExternalThisSession ? 'Neurální hlas (Azure)' : 'Neurální hlas (Azure) – připraven');
    }
  }

  // ===========================
  // UI BUILD (mostly same as original, with TTS mode toggle)
  // ===========================
  function buildUI() {
    if (document.getElementById('tm-clean-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'tm-clean-overlay';
    overlay.innerHTML = `
      <div id="tm-header">
        <div id="tm-left-header">
          <button id="tm-back-btn" class="tm-header-btn" type="button" style="display:none;">← Zpět na články</button>
          <div id="tm-title">Novinky – Text Reader</div>
        </div>
        <div id="tm-right-header">
          <button id="tm-close-btn" class="tm-header-btn" type="button">✕ Zavřít</button>
        </div>
      </div>
      <div id="tm-nav"></div>
      <div id="tm-content"></div>
    `;
    document.body.appendChild(overlay);

    const nav = overlay.querySelector('#tm-nav');
    Object.entries(categories).forEach(([name, path]) => {
      const button = document.createElement('button');
      button.className = 'tm-nav-btn';
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', () => loadCategory(path, button));
      nav.appendChild(button);
    });

    overlay.querySelector('#tm-close-btn').addEventListener('click', () => {
      stopSpeech();
      overlay.style.display = 'none';
    });

    overlay.querySelector('#tm-back-btn').addEventListener('click', () => {
      stopSpeech();
      showArticleList();
    });

    const trigger = document.createElement('button');
    trigger.id = 'tm-trigger-btn';
    trigger.type = 'button';
    trigger.textContent = '📖 Text View';
    trigger.addEventListener('click', () => {
      overlay.style.display = 'flex';
      if (!currentCategoryButton) {
        const firstButton = nav.firstElementChild;
        loadCategory('/', firstButton);
      }
    });
    document.body.appendChild(trigger);
  }

  function setArticleMode(isArticle) {
    const nav = document.getElementById('tm-nav');
    const backBtn = document.getElementById('tm-back-btn');
    if (isArticle) {
      nav.style.display = 'none';
      backBtn.style.display = 'inline-flex';
    } else {
      nav.style.display = 'flex';
      backBtn.style.display = 'none';
    }
  }

  function setHeaderTitle(title) {
    const element = document.getElementById('tm-title');
    if (element) element.textContent = title;
  }

  // ===========================
  // LOAD CATEGORY / RENDER / ARTICLE
  // ===========================
  async function loadCategory(path, activeBtn) {
    const content = document.getElementById('tm-content');
    stopSpeech();
    currentCategoryPath = path;
    currentCategoryButton = activeBtn || currentCategoryButton;
    setArticleMode(false);
    setHeaderTitle(activeBtn ? activeBtn.textContent : 'Novinky – Text Reader');
    document.querySelectorAll('.tm-nav-btn').forEach(button => button.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');
    content.innerHTML = `<div class="tm-loader">Načítám články…</div>`;
    try {
      let docToParse;
      if (path === '/' && window.location.pathname === '/') {
        docToParse = document;
      } else {
        docToParse = await fetchDocument(window.location.origin + path);
      }
      const articles = extractArticles(docToParse);
      renderArticles(articles, content);
    } catch (error) {
      content.innerHTML = `<div class="tm-error">Chyba při načítání článků:<br>${escapeHTML(error.message)}</div>`;
    }
  }

  function renderArticles(articles, container) {
    container.innerHTML = '';
    if (!articles.length) {
      container.innerHTML = `<div class="tm-error">Nenalezeny žádné články.</div>`;
      return;
    }
    const list = document.createElement('div');
    list.id = 'tm-article-list';
    articles.forEach((article, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tm-article-link';
      item.dataset.url = article.url;
      item.innerHTML = `
        <span class="tm-article-number">${index + 1}.</span>
        <span class="tm-article-title">${escapeHTML(article.title)}</span>
      `;
      item.addEventListener('click', () => loadArticle(article.url));
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  async function loadArticle(url) {
    const content = document.getElementById('tm-content');
    stopSpeech();
    setArticleMode(true);
    setHeaderTitle('Načítám článek…');
    content.innerHTML = `<div class="tm-loader">Načítám článek…</div>`;
    try {
      const doc = await fetchDocument(url);
      const article = extractArticle(doc);
      renderArticle(article, url);
    } catch (error) {
      setHeaderTitle('Chyba');
      content.innerHTML = `
        <div class="tm-error">
          Chyba při načítání článku:<br>
          ${escapeHTML(error.message)}
          <br><br>
          <button id="tm-error-back" class="tm-back-inline" type="button">← Zpět na seznam</button>
        </div>
      `;
      document.getElementById('tm-error-back').addEventListener('click', showArticleList);
    }
  }

  function getArticleSpeechText(article) {
    const parts = [];
    if (article.headline) parts.push(article.headline);
    if (article.perexText) parts.push(article.perexText);
    if (article.paragraphs && article.paragraphs.length) parts.push(...article.paragraphs);
    return parts.filter(Boolean).join('\n\n');
  }

  function renderArticle(article, url) {
    const content = document.getElementById('tm-content');
    setHeaderTitle(article.headline || 'Článek');
    const wrapper = document.createElement('article');
    wrapper.id = 'tm-article-reader';
    wrapper.innerHTML = `
      <div class="tm-article-top">
        <h1>${escapeHTML(article.headline)}</h1>

        <div class="tm-tts-controls">
          <button id="tm-speech-btn" class="tm-speech-btn" type="button">
            <span class="tm-speech-icon">▶</span>
            <span class="tm-speech-label">Přečíst článek</span>
          </button>
          <span id="tm-tts-mode-label" class="tm-tts-mode-label">${getKey() ? 'Neurální hlas (Azure)' : 'Lokální TTS (chybí Azure klíč)'}</span>
        </div>

        ${article.perexText ? `<div class="tm-perex">${escapeHTML(article.perexText)}</div>` : ''}

        <div class="tm-source">
          <a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Otevřít původní článek ↗</a>
        </div>
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
    speechButton.addEventListener('click', () => {
      // prefer external if enabled
      toggleSpeechUnified(speechText);
    });
    updateSpeechButton();
  }

  function showArticleList() {
    if (currentCategoryButton) {
      loadCategory(currentCategoryPath, currentCategoryButton);
    } else {
      const firstButton = document.querySelector('.tm-nav-btn');
      loadCategory('/', firstButton);
    }
  }

  // ===========================
  // CSS
  // ===========================
  GM_addStyle(`
    #tm-trigger-btn {
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 999999;
      background: #cc0000;
      color: #fff;
      border: none;
      padding: 12px 18px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 4px 10px rgba(0,0,0,0.3);
    }
    #tm-trigger-btn:hover { background: #a90000; }
    #tm-clean-overlay {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      background: #fff;
      z-index: 9999999;
      display: none;
      flex-direction: column;
      font-family: Arial, Helvetica, sans-serif;
      color: #111;
      overflow: hidden;
    }
    #tm-header {
      flex: 0 0 auto;
      background: #f4f6f8;
      border-bottom: 1px solid #ddd;
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
    }
    #tm-left-header { display:flex; align-items:center; gap:14px; min-width:0; }
    #tm-title { font-size:18px; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #tm-nav { display:flex; gap:8px; padding:10px 20px; flex-wrap:wrap; background:#fff; border-bottom:1px solid #eee; }
    .tm-nav-btn { padding:8px 12px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer; }
    .tm-nav-btn.active { background:#cc0000; color:#fff; border-color:#b30000; }
    #tm-content { padding:18px; overflow:auto; flex:1 1 auto; }
    .tm-loader { color:#666; font-style:italic; }
    #tm-article-list { display:flex; flex-direction:column; gap:8px; }
    .tm-article-link { text-align:left; padding:10px; border-radius:6px; border:1px solid #eee; background:#fafafa; cursor:pointer; display:flex; gap:10px; align-items:center; }
    .tm-article-number { color:#888; width:36px; flex:0 0 36px; text-align:right; padding-right:8px; }
    .tm-article-title { font-weight:600; }
    #tm-article-reader h1 { margin:0 0 8px 0; font-size:22px; }
    .tm-perex { margin:10px 0; color:#333; font-style:italic; }
    .tm-source { margin-top:8px; font-size:13px; }
    .tm-article-body p { line-height:1.6; margin:12px 0; }
    .tm-speech-btn { display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border-radius:8px; border:1px solid #ddd; background:#fff; cursor:pointer; }
    .tm-speech-btn.playing { background:#f0f0f0; border-color:#ccc; }
    .tm-tts-controls { display:flex; gap:12px; align-items:center; margin:8px 0; }
    .tm-tts-mode-label { font-size:13px; color:#666; }
    .tm-error { color:#900; background:#fff0f0; padding:12px; border-radius:6px; border:1px solid #f2caca; }
  `);

  // ===========================
  // INIT
  // ===========================
  buildUI();

  // Auto-open overlay if you want (disabled)
  // document.getElementById('tm-clean-overlay').style.display = 'flex';

})();
