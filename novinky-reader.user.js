// ==UserScript==
// @name         Novinky.cz - Clean Reader + Neural TTS
// @namespace    http://tampermonkey.net/
// @version      3.9
// @description  Category browser, clean article reader and high-quality Czech neural TTS (Azure) with local fallback.
// @author       You
// @match        *://*.novinky.cz/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      tts.speech.microsoft.com
// @connect      germanywestcentral.tts.speech.microsoft.com
// @connect      westeurope.tts.speech.microsoft.com
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
    if (el) el.textContent = `Využito ${getUsed().toLocaleString('cs-CZ')} / ${TTS.freeLimit.toLocaleString('cs-CZ')} znaků tento měsíc`;
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

  function updateSpeechButton() {
    const button = document.getElementById('tm-speech-btn');
    const modeLabel = document.getElementById('tm-tts-mode-label');
    document.querySelectorAll('.tm-row-play').forEach(b => {
      const mine = b.dataset.url === currentSpeechUrl;
      b.textContent = mine && speechPlaying ? (ttsPaused ? '▶' : '⏸') : (mine && busyUrl === b.dataset.url ? '…' : '▶');
      b.classList.toggle('playing', mine && speechPlaying);
    });
    updatePlayerUI();
    syncQueueChecks();
    if (!button) {
      if (modeLabel) modeLabel.textContent = modeText();
      return;
    }
    const active = speechPlaying && currentSpeechUrl === viewedArticleUrl;
    if (active && !ttsPaused) {
      button.innerHTML = `<span class="tm-speech-icon">⏸</span><span class="tm-speech-label">Pozastavit čtení</span>`;
      button.classList.add('playing');
    } else if (active && ttsPaused) {
      button.innerHTML = `<span class="tm-speech-icon">▶</span><span class="tm-speech-label">Pokračovat</span>`;
      button.classList.add('playing');
    } else {
      button.innerHTML = `<span class="tm-speech-icon">▶</span><span class="tm-speech-label">Přečíst článek</span>`;
      button.classList.remove('playing');
    }
    if (modeLabel) modeLabel.textContent = modeText();
  }

  function modeText() {
    return isPiperSel() ? (lastTtsError && !useExternalThisSession ? `Lokální hlas – Piper selhal: ${lastTtsError}` : 'Piper (offline)') : !isAzureSel() ? 'Hlas prohlížeče / systému' : lastTtsError && !useExternalThisSession ? `Lokální TTS – Azure selhal: ${lastTtsError}` : !getKey() ? 'Lokální TTS (chybí Azure klíč)' : (useExternalThisSession ? 'Neurální hlas (Azure)' : 'Neurální hlas (Azure) – připraven');
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
      <div id="tm-player" style="display:none;">
        <button id="tm-pl-toggle" class="tm-pl-btn" type="button" title="Přehrát / pozastavit">▶</button>
        <button id="tm-pl-next" class="tm-pl-btn" type="button" title="Další ve frontě">⏭</button>
        <button id="tm-pl-stop" class="tm-pl-btn" type="button" title="Zastavit">⏹</button>
        <div id="tm-pl-title"></div>
        <input id="tm-pl-seek" type="range" min="0" max="1000" value="0" step="1" disabled title="Posun v článku">
        <span id="tm-pl-pos">0 %</span>
        <button id="tm-pl-queue" class="tm-pl-btn tm-pl-queue" type="button">📋 Fronta (0)</button>
      </div>
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
      stopAll();
      overlay.style.display = 'none';
    });

    overlay.querySelector('#tm-back-btn').addEventListener('click', () => {
      showArticleList();
    });

    overlay.querySelector('#tm-pl-toggle').addEventListener('click', () => {
      if (speechPlaying) toggleSpeechUnified('');
      else playQueue();
    });
    overlay.querySelector('#tm-pl-next').addEventListener('click', () => {
      if (queueActive && queueIndex + 1 < queue.length) playArticle(queue[queueIndex + 1].url, queue[queueIndex + 1].title, queueIndex + 1);
      else if (queueActive) stopAll();
      else playQueue();
    });
    overlay.querySelector('#tm-pl-stop').addEventListener('click', stopAll);
    const seek = overlay.querySelector('#tm-pl-seek');
    seek.addEventListener('input', () => {
      seekDragging = true;
      overlay.querySelector('#tm-pl-pos').textContent = Math.round(seek.value / 10) + ' %';
    });
    seek.addEventListener('change', () => {
      seekDragging = false;
      seekToFraction(seek.value / 1000);
    });
    overlay.querySelector('#tm-pl-queue').addEventListener('click', showQueueView);

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
    queueViewOpen = false;
    viewedArticleUrl = '';
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
    const bar = document.createElement('div');
    bar.className = 'tm-list-tts';
    bar.innerHTML = `<div class="tm-tts-controls">${ttsOptionsHTML()}</div><div id="tm-usage-label" class="tm-tts-mode-label"></div>`;
    container.appendChild(bar);

    const list = document.createElement('div');
    list.id = 'tm-article-list';
    articles.forEach((article, index) => {
      const row = document.createElement('div');
      row.className = 'tm-article-row';

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'tm-row-play';
      play.dataset.url = article.url;
      play.title = 'Přečíst článek bez otevření';
      play.textContent = '▶';
      play.addEventListener('click', () => playFromList(article.url, article.title));

      const check = document.createElement('label');
      check.className = 'tm-row-queue-wrap';
      check.title = 'Přidat do fronty';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tm-row-queue';
      cb.dataset.url = article.url;
      cb.checked = queueHas(article.url);
      cb.addEventListener('change', () => cb.checked ? queueAdd(article) : queueRemoveUrl(article.url));
      check.appendChild(cb);

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tm-article-link';
      item.dataset.url = article.url;
      item.innerHTML = `
        <span class="tm-article-number">${index + 1}.</span>
        <span class="tm-article-title">${escapeHTML(article.title)}</span>
      `;
      item.addEventListener('click', () => loadArticle(article.url));

      row.appendChild(play);
      row.appendChild(check);
      row.appendChild(item);
      list.appendChild(row);
    });
    container.appendChild(list);
    bindTtsOptions();
    updateSpeechButton();
  }

  async function loadArticle(url) {
    const content = document.getElementById('tm-content');
    queueViewOpen = false;
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

  function ttsOptionsHTML() {
    return `
          <select id="tm-voice-select" class="tm-voice-select" title="Hlas"></select>
          <label class="tm-rate-wrap" title="Rychlost">
            <input id="tm-rate-range" type="range" min="0.7" max="1.6" step="0.05" value="${getRate()}">
            <span id="tm-rate-label">${getRate().toFixed(2)}×</span>
          </label>
          <span id="tm-tts-mode-label" class="tm-tts-mode-label"></span>`;
  }

  function bindTtsOptions() {
    populateVoiceSelect();
    document.getElementById('tm-voice-select').addEventListener('change', e => {
      GM_setValue('voiceSel', e.target.value);
      useExternalThisSession = false;
      lastTtsError = '';
      updateSpeechButton();
    });
    document.getElementById('tm-rate-range').addEventListener('input', e => {
      const v = Number(e.target.value);
      GM_setValue('rate', v);
      document.getElementById('tm-rate-label').textContent = v.toFixed(2) + '×';
      if (audioElement) audioElement.playbackRate = v;
    });
    updateUsageLabel();
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
      const text = getArticleSpeechText(extractArticle(doc));
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

  function syncQueueChecks() {
    document.querySelectorAll('.tm-row-queue').forEach(cb => {
      cb.checked = queueHas(cb.dataset.url);
    });
  }

  function updatePlayerUI() {
    const player = document.getElementById('tm-player');
    if (!player) return;
    const busy = !!busyUrl;
    player.style.display = (queue.length || speechPlaying || busy) ? 'flex' : 'none';
    document.getElementById('tm-pl-toggle').textContent = speechPlaying ? (ttsPaused ? '▶' : '⏸') : (busy ? '…' : '▶');
    document.getElementById('tm-pl-title').textContent = (speechPlaying || busy) && currentTitle
      ? currentTitle
      : (queue.length ? `Ve frontě: ${queue.length}` : '');
    document.getElementById('tm-pl-queue').textContent = `📋 Fronta (${queue.length})`;
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
    document.getElementById('tm-pl-pos').textContent = Math.round(frac * 100) + ' %';
  }

  function showQueueView() {
    queueViewOpen = true;
    viewedArticleUrl = '';
    setArticleMode(true);
    setHeaderTitle('Fronta');
    renderQueueView();
  }

  function refreshQueueView() {
    if (queueViewOpen) renderQueueView();
  }

  function renderQueueView() {
    const content = document.getElementById('tm-content');
    if (!content) return;
    const scroll = content.scrollTop;
    content.innerHTML = `
      <div class="tm-list-tts">
        <div class="tm-tts-controls">${ttsOptionsHTML()}</div>
        <div id="tm-usage-label" class="tm-tts-mode-label"></div>
        <div class="tm-queue-actions">
          <button id="tm-q-play" class="tm-speech-btn" type="button">▶ Přehrát frontu</button>
          <button id="tm-q-clear" class="tm-speech-btn" type="button">🗑 Vyčistit</button>
        </div>
      </div>
      <div id="tm-queue-list"></div>`;
    const list = content.querySelector('#tm-queue-list');
    if (!queue.length) {
      list.innerHTML = `<div class="tm-loader">Fronta je prázdná. V seznamu článků zaškrtněte políčka u titulků.</div>`;
    }
    queue.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'tm-queue-row' + (queueActive && i === queueIndex ? ' current' : '');
      const mk = (cls, text, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = cls; b.textContent = text; b.title = title;
        b.addEventListener('click', fn);
        return b;
      };
      row.appendChild(mk('tm-row-play' + (queueActive && i === queueIndex && speechPlaying ? ' playing' : ''),
        queueActive && i === queueIndex && speechPlaying ? (ttsPaused ? '▶' : '⏸') : '▶', 'Přehrát odtud',
        () => (queueActive && i === queueIndex && speechPlaying) ? toggleSpeechUnified('') : playArticle(item.url, item.title, i)));
      const num = document.createElement('span');
      num.className = 'tm-article-number'; num.textContent = `${i + 1}.`;
      const title = mk('tm-queue-title', item.title, 'Otevřít článek', () => loadArticle(item.url));
      row.appendChild(num);
      row.appendChild(title);
      row.appendChild(mk('tm-q-btn', '▲', 'Posunout nahoru', () => queueMove(i, -1)));
      row.appendChild(mk('tm-q-btn', '▼', 'Posunout dolů', () => queueMove(i, 1)));
      row.appendChild(mk('tm-q-btn tm-q-del', '✕', 'Odebrat z fronty', () => queueRemove(i)));
      list.appendChild(row);
    });
    content.querySelector('#tm-q-play').addEventListener('click', playQueue);
    content.querySelector('#tm-q-clear').addEventListener('click', () => { if (!queue.length || confirm('Vyčistit celou frontu?')) queueClear(); });
    bindTtsOptions();
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
    select.innerHTML = html;
    const sel = getSel();
    const exists = Array.from(select.options).some(o => o.value === sel);
    select.value = exists ? sel : 'local:auto';
    updateSpeechButton();
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
          ${ttsOptionsHTML()}
        </div>

        <div id="tm-usage-label" class="tm-tts-mode-label"></div>

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
    viewedArticleUrl = url;
    speechButton.addEventListener('click', () => {
      if (speechPlaying && currentSpeechUrl !== url) stopSpeech();   // something else is being read
      if (!speechPlaying) {
        queueActive = false; queueIndex = -1;
        currentSpeechUrl = url; currentTitle = article.headline || '';
      }
      toggleSpeechUnified(speechText);
    });
    bindTtsOptions();
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
    .tm-list-tts { margin-bottom:12px; }
    .tm-article-row { display:flex; gap:8px; align-items:stretch; }
    .tm-article-row .tm-article-link { flex:1 1 auto; min-width:0; }
    .tm-row-play { flex:0 0 48px; border-radius:6px; border:1px solid #ddd; background:#fff; font-size:16px; cursor:pointer; }
    .tm-row-play:hover { background:#f0f0f0; }
    .tm-row-queue-wrap { flex:0 0 40px; display:flex; align-items:center; justify-content:center; border:1px solid #ddd; border-radius:6px; background:#fff; cursor:pointer; }
    .tm-row-queue { width:20px; height:20px; cursor:pointer; accent-color:#cc0000; }
    #tm-player { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:8px 16px; background:#f4f6f8; border-top:1px solid #ddd; }
    #tm-pl-title { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:14px; color:#333; }
    #tm-pl-seek { flex:0 1 240px; min-width:80px; accent-color:#cc0000; }
    #tm-pl-pos { flex:0 0 auto; width:42px; text-align:right; font-size:13px; color:#555; }
    .tm-pl-btn { padding:8px 12px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer; font-size:15px; }
    .tm-pl-btn:hover { background:#f0f0f0; }
    .tm-queue-actions { display:flex; gap:8px; margin-top:10px; }
    #tm-queue-list { display:flex; flex-direction:column; gap:8px; }
    .tm-queue-row { display:flex; gap:8px; align-items:center; }
    .tm-queue-row.current .tm-queue-title { border-color:#cc0000; background:#fff4f4; }
    .tm-queue-title { flex:1 1 auto; min-width:0; text-align:left; padding:10px; border-radius:6px; border:1px solid #eee; background:#fafafa; cursor:pointer; font-weight:600; }
    .tm-q-btn { padding:8px 10px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer; }
    .tm-q-del:hover { background:#fff0f0; color:#900; }
    .tm-row-play.playing { background:#cc0000; color:#fff; border-color:#b30000; }
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
    .tm-voice-select { padding:6px; border-radius:6px; border:1px solid #ddd; background:#fff; }
    .tm-rate-wrap { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:#444; }
    .tm-error { color:#900; background:#fff0f0; padding:12px; border-radius:6px; border:1px solid #f2caca; }
  `);

  // ===========================
  // INIT
  // ===========================
  buildUI();

  // Auto-open overlay if you want (disabled)
  // document.getElementById('tm-clean-overlay').style.display = 'flex';

})();
