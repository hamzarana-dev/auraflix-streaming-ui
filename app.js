// ============================================
// AURA FLIX — STREAMING ENGINE v5.0
// ============================================

const API_KEY       = "bd13d24ec286868fcdd6a0ce531282a2";
const BASE_URL      = "https://api.themoviedb.org/3";
const IMG_URL       = "https://image.tmdb.org/t/p/original";
const IMG_URL_W500  = "https://image.tmdb.org/t/p/w500";
const IMG_URL_W1280 = "https://image.tmdb.org/t/p/w1280";

const CACHE_TTL_MS       = 1000 * 60 * 60;
const LOADER_FADE_MS     = 600;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_CACHE_ENTRIES  = 100;

const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

// === DEVICE DETECTION ===
const IS_IOS    = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent) || IS_IOS;

const DEVICE_TIER = (() => {
    try {
        const cores = navigator.hardwareConcurrency || 4;
        const mem   = navigator.deviceMemory || 4;
        if (IS_MOBILE && (cores <= 4 || mem <= 2)) return 'LITE';
        if (cores >= 8 && mem >= 8 && !IS_MOBILE)  return 'ELITE';
        return 'STANDARD';
    } catch { return 'STANDARD'; }
})();

document.documentElement.setAttribute('data-tier', DEVICE_TIER);

// === STATE ===
const apiCache   = new Map();
const imageCache = new Set();

// === POPUP AD BLOCKER ===
// Video embed servers (vidlink.pro, vidsrc.to, superembed.stream) fire
// popup ads via window.open(). AdGuard DNS cannot block these because
// the calls originate from the same domain as the player.
// Intercepting window.open here blocks all popup ads site-wide while
// having zero effect on video playback (players use iframe src, not popups).
(function() {
    const _origOpen = window.open;
    window.open = function(url, name, features) {
        // Allow only blank/named windows opened by our own code (none currently).
        // Block everything else — these are ad popups from the iframes.
        if (url && typeof url === 'string' && (
            url.includes('vidlink') ||
            url.includes('vidsrc') ||
            url.includes('superembed') ||
            url.startsWith('http')
        )) {
            console.info('[AuraFlix] Popup blocked:', url);
            return null;
        }
        return _origOpen.call(window, url, name, features);
    };
})();

let searchController = null;
let searchTimer      = null;
let currentSection   = 'home';
let allData = { trending: [], movies: [], tv: [], action: [], topRated: [], originals: [] };

// ============================================================
// PERFORMANCE UTILITIES
// ============================================================

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function debounce(fn, delay) {
    let t;
    return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}

function rafThrottle(fn) {
    let ticking = false;
    return function(...args) {
        if (!ticking) {
            requestAnimationFrame(() => { fn.apply(this, args); ticking = false; });
            ticking = true;
        }
    };
}

// ============================================================
// DOM REFERENCES
// ============================================================

const getEl = id => document.getElementById(id);
const navbar        = getEl('navbar');
const heroBackdrop  = document.querySelector('.hero-backdrop');
const rowsContainer = getEl('rowsContainer');
const masterLoader  = getEl('masterLoader');
const modal         = getEl('detailsModal');
const videoModal    = getEl('videoModal');
const youtubePlayer = getEl('youtubePlayer');
const searchOverlay = getEl('searchOverlay');
const adguardModal  = getEl('adguardModalOverlay');
const hrModal       = getEl('hrModal');

// ============================================================
// BODY SCROLL LOCK — DEFINITIVE iOS-SAFE IMPLEMENTATION
//
// The hard-learned truth on iOS Safari + iframes:
//   * `overflow:hidden` on body alone DOES NOT stop background
//     scroll on iOS. The page still rubber-bands behind modals.
//   * `position:fixed` on body IS required for iOS, but you MUST
//     save/restore scrollY yourself, otherwise the page jumps to
//     the top on unlock.
//   * After an <iframe> has been displayed and removed, iOS
//     retains a "phantom" touch context tied to the iframe. We
//     must explicitly clear `iframe.src` BEFORE removing the
//     modal, then force a layout flush, to release that context.
// ============================================================

let _savedScrollY = 0;
let _lockCount    = 0; // Reference count
let _pendingUnlockTimer = null; // Bug 4 fix: cancellable delayed unlock

function lockBodyScroll() {
    if (_pendingUnlockTimer) {
        clearTimeout(_pendingUnlockTimer);
        _pendingUnlockTimer = null;
        // CRITICAL FIX: Body is still physically locked from the previous
        // modal (the 780ms unlock timer was cancelled before it could fire).
        // Reset _lockCount to exactly 1 instead of incrementing.
        //
        // Without this fix: _lockCount goes 1→2 here. When the user closes
        // the modal, closeDetailsModal fires, the timer decrements from 2→1
        // but never reaches 0 — so unlockBodyScroll never executes and the
        // page stays permanently scroll-frozen. This is the root cause of
        // the "stuck scroll" bug after rapid open/close/reopen sequences
        // and after watching a video then navigating to another modal.
        _lockCount = 1;
        return;
    }
    _lockCount++;
    if (_lockCount > 1) return;
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.classList.add('body-locked');
    // Pin body so iOS can't scroll behind the modal.
    document.body.style.top = `-${_savedScrollY}px`;
}

function unlockBodyScroll() {
    _lockCount = Math.max(0, _lockCount - 1);
    if (_lockCount > 0) return;
    document.documentElement.classList.remove('body-locked');
    document.body.style.top = '';
    // CRITICAL Chrome fix: `html { scroll-behavior: smooth }` causes Chrome
    // to animate window.scrollTo() over 300-500ms. During that animation the
    // page visibly slides while the modal backdrop is still fading out —
    // this is the "jump up then down" bug on Chrome. Force instant scroll
    // by overriding scroll-behavior to 'auto' just for this operation,
    // then restore it on the next frame after the scroll has committed.
    const htmlEl = document.documentElement;
    htmlEl.style.scrollBehavior = 'auto';
    window.scrollTo(0, _savedScrollY);
    requestAnimationFrame(() => { htmlEl.style.scrollBehavior = ''; });
}

// ============================================================
// CACHE
// ============================================================

function cacheSet(key, val) {
    if (apiCache.size >= MAX_CACHE_ENTRIES)
        apiCache.delete(apiCache.keys().next().value);
    apiCache.set(key, val);
}

// ============================================================
// FETCH — localStorage cache + memory cache
// ============================================================

async function fetchData(url, signal) {
    if (apiCache.has(url)) return apiCache.get(url);

    const sk = `af5_${btoa(encodeURIComponent(url.slice(-60))).replace(/[^a-z0-9]/gi, '')}`;
    try {
        const raw = localStorage.getItem(sk);
        if (raw) {
            const { d, t } = JSON.parse(raw);
            if (Date.now() - t < CACHE_TTL_MS) { cacheSet(url, d); return d; }
            localStorage.removeItem(sk);
        }
    } catch { /* ignore */ }

    try {
        const opts = signal ? { signal } : undefined;
        const res  = await fetch(url, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const data = Array.isArray(json.results) ? json.results : json;
        cacheSet(url, data);
        try { localStorage.setItem(sk, JSON.stringify({ d: data, t: Date.now() })); } catch { /* quota */ }
        return data;
    } catch (err) {
        if (err.name === 'AbortError') return null;
        console.warn('[AuraFlix] Fetch:', err.message);
        return [];
    }
}

async function fetchDetails(id, type) {
    const url = `${BASE_URL}/${type}/${id}?api_key=${API_KEY}&language=en-US&append_to_response=credits,videos,spoken_languages,seasons`;
    return fetchData(url);
}

async function fetchRecommendations(id, type) {
    const url = `${BASE_URL}/${type}/${id}/recommendations?api_key=${API_KEY}&language=en-US`;
    return fetchData(url);
}

// ============================================================
// AUDIO — Uses inline base64 beep so no network required.
// External CDN audio was causing failed network requests that
// slowed page load. Native Web Audio API beep is instant.
// ============================================================

let _audioCtx = null;
let _audioUnlocked = false;

function getAudioCtx() {
    if (_audioCtx) return _audioCtx;
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    return _audioCtx;
}

function playBeep(freq = 440, dur = 0.06, vol = 0.08, type = 'sine') {
    try {
        const ctx = getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + dur);
    } catch { /* silently fail */ }
}

function playAudio(id, vol = 0.08) {
    // Map legacy IDs to Web Audio beeps — no network needed
    if (id === 'soundClick') playBeep(880, 0.05, vol, 'sine');
    else if (id === 'soundHover') playBeep(660, 0.04, vol * 0.6, 'sine');
    else if (id === 'soundModal') playBeep(520, 0.12, vol, 'triangle');
}
window.playAudio = playAudio;

function unlockAudioContext() {
    if (_audioUnlocked) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    
    if (ctx.state === 'suspended') ctx.resume();
    
    // Play silent oscillator to force unlock on iOS
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(0);
        osc.stop(0.001);
    } catch {}

    _audioUnlocked = true;
}

// ============================================================
// SOUND LISTENER WIRING
// ============================================================

function initSoundListeners() {
    document.querySelectorAll('button, .movie-card, .rec-card, .slider-btn, .nav-links a').forEach(el => {
        if (el._sfxBound) return;
        el._sfxBound = true;
        el.addEventListener('pointerdown', () => { unlockAudioContext(); playAudio('soundClick', 0.07); }, { passive: true });
        if (!IS_MOBILE) {
            el.addEventListener('mouseenter',  () => playAudio('soundHover', 0.04), { passive: true });
        }
    });
}

// ============================================================
// IMAGE PRELOAD
// ============================================================

function preloadImage(src) {
    if (!src || imageCache.has(src)) return Promise.resolve(!!src);
    return new Promise(resolve => {
        const img  = new Image();
        img.onload = () => { imageCache.add(src); resolve(true); };
        img.onerror = () => resolve(false);
        img.src = src;
    });
}

// ============================================================
// SLIDER UNLOCK — Resurrects frozen horizontal scroll on iOS
// after the video iframe modal has been opened and closed.
//
// Why this is needed: iOS WebKit caches the scroll-context of
// elements that were on-screen when an iframe took focus. After
// the iframe is destroyed, those elements still hold the cached
// (now-stale) context and refuse to accept new touch-pan events.
//
// The cure is a 3-step ritual that *forces* WebKit to rebuild
// the scroll context from scratch:
//   1. Briefly remove the element from the layout flow
//      (visibility:hidden + a synchronous reflow read).
//   2. Nudge scrollLeft by 1px and back — this re-registers the
//      element with the touch event router.
//   3. Restore visibility on the next frame.
//
// We do NOT use `display:none` — that triggers a full re-paint
// of the row and causes a visible flicker. visibility:hidden
// keeps the layout intact while still flushing the scroll cache.
// ============================================================

function unlockAllSliders() {
    const sliders = document.querySelectorAll('.slider');
    if (!sliders.length) return;

    sliders.forEach(s => {
        const sx = s.scrollLeft;

        // Step 1: temporarily disable the slider's touch handling
        // so the browser must rebuild its gesture context from scratch
        // when we re-enable it.
        const prevTouchAction = s.style.touchAction;
        s.style.touchAction = 'none';

        // Step 2: visibility flush — forces WebKit to drop its cached
        // scroll context without triggering a full repaint.
        s.style.visibility = 'hidden';
        // Force a synchronous layout read.
        // eslint-disable-next-line no-unused-expressions
        s.offsetHeight;

        // Step 3: nudge scrollLeft to re-register touch handlers.
        s.scrollLeft = sx + 1;
        s.scrollLeft = sx;

        // Step 4: restore everything on the next frame.
        requestAnimationFrame(() => {
            s.style.visibility = '';
            s.style.touchAction = prevTouchAction || '';
        });
    });

    // Bonus iOS fix: a tiny window scroll nudge re-arms the
    // document-level touch router after iframe focus return.
    if (IS_IOS) {
        const y = window.scrollY;
        window.scrollTo(0, y + 1);
        window.scrollTo(0, y);
    }
}

// ============================================================
// LANGUAGE HELPERS
// ============================================================

function getLangName(code) {
    if (!code) return null;
    try { return LANG_NAMES.of(code); } catch { return code.toUpperCase(); }
}

function buildLangOptions(spokenLanguages, originalLang) {
    const langSelect = getEl('langSelect');
    if (!langSelect) return;
    langSelect.innerHTML = '';

    const langs = [];
    if (Array.isArray(spokenLanguages) && spokenLanguages.length > 0) {
        spokenLanguages.forEach(l => {
            if (l.iso_639_1) langs.push({ code: l.iso_639_1, name: l.english_name || getLangName(l.iso_639_1) || l.iso_639_1 });
        });
    } else if (originalLang) {
        langs.push({ code: originalLang, name: getLangName(originalLang) || originalLang.toUpperCase() });
    }

    if (!langs.length) { langSelect.innerHTML = '<option value="">N/A</option>'; return; }

    langs.forEach(({ code, name }) => {
        const o = document.createElement('option');
        o.value = code; o.textContent = name;
        langSelect.appendChild(o);
    });

    if (originalLang) langSelect.value = originalLang;
    if (langs.some(l => l.code === 'en')) langSelect.value = 'en';
}

// ============================================================
// RECOMMENDATIONS
// ============================================================

function renderRecommendations(items, onClickItem) {
    const section   = getEl('recommendedSection');
    const container = getEl('recommendedContainer');
    if (!section || !container) return;

    const filtered = (Array.isArray(items) ? items : []).filter(m => m.poster_path).slice(0, 3);
    if (!filtered.length) { section.style.display = 'none'; return; }

    section.style.display = '';
    container.innerHTML   = '';
    const frag = document.createDocumentFragment();

    filtered.forEach(item => {
        const type  = item.media_type || (item.title ? 'movie' : 'tv');
        item._resolvedType = type;
        const rawTitle = item.title || item.name || '';
        const title  = escapeHTML(rawTitle);
        const year   = (item.release_date || item.first_air_date || '').split('-')[0] || '';
        const rating = item.vote_average ? (Math.round(item.vote_average * 10) / 10).toFixed(1) : '';

        const card = document.createElement('div');
        card.className = 'rec-card';
        card.innerHTML = `
            <div class="rec-poster">
                <img src="${IMG_URL_W500}${item.poster_path}" loading="lazy" decoding="async" alt="${title}">
                <div class="rec-play-icon"><i class="ph-fill ph-play-circle"></i></div>
            </div>
            <div class="rec-info">
                <span class="rec-title">${title}</span>
                <span class="rec-meta">${year}${rating ? ' ⭐ ' + rating : ''}</span>
            </div>`;

        // Same swipe-vs-tap discrimination as main cards (12px threshold)
        let _rx = 0, _ry = 0, _rmoved = false, _rStart = 0;
        card.addEventListener('touchstart', e => {
            const t = e.touches[0];
            _rx = t.clientX; _ry = t.clientY;
            _rmoved = false;
            _rStart = Date.now();
        }, { passive: true });
        card.addEventListener('touchmove', e => {
            if (_rmoved) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - _rx) > 12 || Math.abs(t.clientY - _ry) > 12) _rmoved = true;
        }, { passive: true });
        card.addEventListener('click', () => {
            if (_rmoved) return;
            if (_rStart && Date.now() - _rStart > 500) return;
            unlockAudioContext();
            playAudio('soundClick', 0.07);
            const content = modal?.querySelector('.modal-content');
            if (content) content.scrollTop = 0;
            openModal(item);
        });
        frag.appendChild(card);
    });

    container.appendChild(frag);
}

// ============================================================
// INIT — First 2 rows load immediately, rest defer for speed
// ============================================================

async function initApp() {
    setupGlobalListeners();
    try {
        // Load trending first — paint hero + first row ASAP
        const trending = await fetchData(`${BASE_URL}/trending/all/week?api_key=${API_KEY}&language=en-US`);
        allData.trending = Array.isArray(trending) ? trending : [];

        // Show first content immediately — don't wait for all 6 calls
        if (allData.trending.length) {
            setHeroFrom(allData.trending);
            buildRow('Trending Now', allData.trending, false, 'trending');
        } else {
            // Network failure fallback — don't leave user on blank loader
            const heroTitle = getEl('heroTitle');
            const heroOverview = getEl('heroOverview');
            const heroMeta = getEl('heroMeta');
            if (heroTitle) { heroTitle.classList.remove('skeleton-text'); heroTitle.textContent = 'Welcome to AuraFlix'; }
            if (heroOverview) { heroOverview.classList.remove('skeleton-text'); heroOverview.textContent = 'Connect to the internet to discover thousands of movies and TV shows.'; }
            if (heroMeta) { heroMeta.classList.remove('skeleton-text'); heroMeta.textContent = ''; }
        }
        dismissLoader();

        // Then load the rest in parallel
        const [originals, topRated, action, movies, tv] = await Promise.all([
            fetchData(`${BASE_URL}/discover/tv?api_key=${API_KEY}&with_networks=213&language=en-US`),
            fetchData(`${BASE_URL}/movie/top_rated?api_key=${API_KEY}&language=en-US`),
            fetchData(`${BASE_URL}/discover/movie?api_key=${API_KEY}&with_genres=28&language=en-US`),
            fetchData(`${BASE_URL}/discover/movie?api_key=${API_KEY}&sort_by=popularity.desc&language=en-US`),
            fetchData(`${BASE_URL}/discover/tv?api_key=${API_KEY}&sort_by=popularity.desc&language=en-US`),
        ]);

        allData.originals = Array.isArray(originals) ? originals : [];
        allData.topRated  = Array.isArray(topRated)  ? topRated  : [];
        allData.action    = Array.isArray(action)    ? action    : [];
        allData.movies    = Array.isArray(movies)    ? movies    : [];
        allData.tv        = Array.isArray(tv)        ? tv        : [];

        // Append remaining rows
        buildRow('Aura Originals',   allData.originals, true,  'tv');
        buildRow('Top Rated Movies', allData.topRated,  false, 'movie');
        buildRow('Action Thrillers', allData.action,    false, 'movie');
    } catch (err) {
        console.error('[AuraFlix] init failed:', err);
        dismissLoader();
    }

    setTimeout(initSoundListeners, 500);
}

// ============================================================
// SECTION RENDERER
// ============================================================

function renderSection(section) {
    // Defensive lock reset — only force-unlock if something is actually
    // locked. Setting _lockCount = 1 when it's already 0 caused
    // unlockBodyScroll() to call window.scrollTo(0, _savedScrollY=0)
    // on every nav click, snapping the page to top unexpectedly.
    if (_lockCount > 0) { _lockCount = 1; unlockBodyScroll(); }
    requestAnimationFrame(unlockAllSliders);
    currentSection = section;
    rowsContainer.innerHTML = '';
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.toggle('active', a.dataset.section === section));

    switch (section) {
        case 'home':
            setHeroFrom(allData.trending);
            buildRow('Trending Now',     allData.trending,  false, 'trending');
            buildRow('Aura Originals',   allData.originals, true,  'tv');
            buildRow('Top Rated Movies', allData.topRated,  false, 'movie');
            buildRow('Action Thrillers', allData.action,    false, 'movie');
            break;
        case 'movies':
            setHeroFrom(allData.movies);
            buildRow('Popular Movies',   allData.movies,   false, 'movie');
            buildRow('Top Rated',        allData.topRated, false, 'movie');
            buildRow('Action Thrillers', allData.action,   false, 'movie');
            break;
        case 'tv':
            setHeroFrom(allData.tv);
            buildRow('Popular TV Shows', allData.tv,        true, 'tv');
            buildRow('Aura Originals',   allData.originals, true, 'tv');
            break;
        case 'trending':
            setHeroFrom(allData.trending);
            buildRow('Trending This Week', allData.trending, false, 'trending');
            break;
    }

    setTimeout(initSoundListeners, 200);
}

function setHeroFrom(list) {
    if (!Array.isArray(list) || !list.length) return;
    const withBg = list.filter(m => m.backdrop_path);
    updateHero(withBg.length ? withBg[Math.floor(Math.random() * withBg.length)] : list[0]);
}

function dismissLoader() {
    if (!masterLoader || masterLoader.style.display === 'none') return;
    masterLoader.classList.add('fade-out');
    setTimeout(() => {
        masterLoader.style.display = 'none';
        document.body.classList.remove('loading-active');
    }, LOADER_FADE_MS);
}

// ============================================================
// HERO
// ============================================================

function updateHero(movie) {
    if (!movie) return;
    const heroTitle    = getEl('heroTitle');
    const heroOverview = getEl('heroOverview');
    const heroMeta     = getEl('heroMeta');
    if (!heroTitle || !heroOverview || !heroMeta) return;

    [heroTitle, heroOverview, heroMeta].forEach(el => el.classList.remove('skeleton-text'));

    const title   = movie.title || movie.name || 'Unknown Title';
    const overview= movie.overview || '';
    const year    = (movie.release_date || movie.first_air_date || '').split('-')[0] || '—';
    const lang    = getLangName(movie.original_language) || '—';
    const rating  = movie.vote_average != null ? (Math.round(movie.vote_average * 10) / 10).toFixed(1) : '—';
    const type    = movie.media_type || (movie.title ? 'movie' : 'tv');

    heroTitle.textContent    = title;
    heroOverview.textContent = overview.slice(0, 220) + (overview.length > 220 ? '…' : '');
    heroMeta.innerHTML = `⭐ ${rating} &nbsp;|&nbsp; ${year} &nbsp;|&nbsp; ${lang} &nbsp;|&nbsp; <span style="opacity:.7">${type === 'movie' ? '🎬 Movie' : '📺 Series'}</span>`;

    const bdPath = movie.backdrop_path || movie.poster_path;
    heroBackdrop.classList.remove('loaded');
    if (bdPath) {
        const url = DEVICE_TIER === 'ELITE' ? `${IMG_URL}${bdPath}` : `${IMG_URL_W1280}${bdPath}`;
        preloadImage(url).then(ok => {
            if (!ok) return;
            heroBackdrop.style.backgroundImage = `url(${url})`;
            heroBackdrop.classList.add('loaded');
        });
    }

    movie._resolvedType = type;
    const heroPlayBtn = getEl('heroPlayBtn');
    const heroInfoBtn = getEl('heroInfoBtn');
    if (heroPlayBtn) heroPlayBtn.onclick = () => { unlockAudioContext(); playAudio('soundClick', 0.08); playVideo(movie.id, type); };
    if (heroInfoBtn) heroInfoBtn.onclick = () => { unlockAudioContext(); playAudio('soundModal',  0.08); openModal(movie); };
}

// ============================================================
// ROW BUILDER
// ============================================================

const rowObserver = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
    });
}, { threshold: 0.05 });

function buildRow(title, movies, isOriginal = false, forceType = null) {
    if (!Array.isArray(movies) || !movies.length) return;

    const row = document.createElement('div');
    row.className = 'row' + (isOriginal ? ' original' : '');
    row.innerHTML = `
        <h3 class="row-header">${title}</h3>
        <div class="slider-wrapper">
            <button class="slider-btn left" aria-label="Scroll left"><i class="ph ph-caret-left"></i></button>
            <div class="slider-container">
                <div class="slider"></div>
            </div>
            <button class="slider-btn right" aria-label="Scroll right"><i class="ph ph-caret-right"></i></button>
        </div>`;

    const slider   = row.querySelector('.slider');
    const btnLeft  = row.querySelector('.slider-btn.left');
    const btnRight = row.querySelector('.slider-btn.right');
    const SCROLL_AMT = IS_MOBILE ? 280 : 620;

    // Smooth-scroll polyfill that doesn't depend on CSS scroll-behavior
    // (which we removed from the slider for performance reasons).
    function smoothScrollBy(el, dx) {
        try {
            el.scrollBy({ left: dx, behavior: 'smooth' });
        } catch {
            el.scrollLeft += dx;
        }
    }

    btnLeft.onclick  = e => { e.stopPropagation(); smoothScrollBy(slider, -SCROLL_AMT); };
    btnRight.onclick = e => { e.stopPropagation(); smoothScrollBy(slider,  SCROLL_AMT); };

    const updateArrows = rafThrottle(() => {
        const atStart = slider.scrollLeft <= 10;
        const atEnd   = slider.scrollLeft >= slider.scrollWidth - slider.clientWidth - 10;
        btnLeft.style.opacity        = atStart ? '0' : '1';
        btnRight.style.opacity       = atEnd   ? '0' : '1';
        btnLeft.style.pointerEvents  = atStart ? 'none' : 'auto';
        btnRight.style.pointerEvents = atEnd   ? 'none' : 'auto';
    });

    slider.addEventListener('scroll',      updateArrows,                       { passive: true });
    slider.addEventListener('touchend',    () => setTimeout(updateArrows, 80), { passive: true });
    slider.addEventListener('touchcancel', () => setTimeout(updateArrows, 80), { passive: true });
    setTimeout(updateArrows, 150);

    // === DESKTOP: drag-to-scroll with mouse (premium feel) ===
    // On touch devices we let native momentum scroll handle everything —
    // attaching mouse handlers there causes nothing but conflict. So this
    // is gated behind !IS_MOBILE.
    if (!IS_MOBILE) {
        let isDown = false, startX = 0, startScroll = 0, dragMoved = false;
        slider.addEventListener('mousedown', e => {
            // Only left button, and ignore clicks on cards
            if (e.button !== 0) return;
            isDown = true;
            dragMoved = false;
            startX = e.pageX - slider.offsetLeft;
            startScroll = slider.scrollLeft;
            slider.style.cursor = 'grabbing';
        });
        const endDrag = () => {
            if (!isDown) return;
            isDown = false;
            slider.style.cursor = '';
            // Brief delay so click handlers can read dragMoved state
            if (dragMoved) {
                slider.style.pointerEvents = 'none';
                setTimeout(() => { slider.style.pointerEvents = ''; }, 50);
            }
        };
        slider.addEventListener('mouseleave', endDrag);
        slider.addEventListener('mouseup',    endDrag);
        slider.addEventListener('mousemove', e => {
            if (!isDown) return;
            e.preventDefault();
            const x    = e.pageX - slider.offsetLeft;
            const walk = (x - startX) * 1.4;
            if (Math.abs(walk) > 5) dragMoved = true;
            slider.scrollLeft = startScroll - walk;
        });
    }

    const frag = document.createDocumentFragment();
    movies.forEach(movie => {
        const path = isOriginal
            ? (movie.backdrop_path || movie.poster_path)
            : (movie.poster_path   || movie.backdrop_path);
        if (!path) return;

        const posterUrl = DEVICE_TIER === 'ELITE'
            ? `https://image.tmdb.org/t/p/w780${path}`
            : `https://image.tmdb.org/t/p/w342${path}`;

        const rawTitle = movie.title || movie.name || '';
        const altText  = escapeHTML(rawTitle);
        const year     = (movie.release_date || movie.first_air_date || '').split('-')[0] || '';
        const rating   = movie.vote_average ? (Math.round(movie.vote_average * 10) / 10).toFixed(1) : '';
        const itemType = forceType === 'trending'
            ? (movie.media_type || (movie.title ? 'movie' : 'tv'))
            : (forceType || movie.media_type || (movie.title ? 'movie' : 'tv'));
        movie._resolvedType = itemType;

        const card = document.createElement('div');
        card.className = 'movie-card';
        card.innerHTML = `
            <img src="${posterUrl}" loading="lazy" decoding="async" class="high-res-img"
                 alt="${altText}" width="195" height="295">
            <div class="card-overlay">
                <h4>${altText}</h4>
                <div class="card-meta">
                    <span>${year}</span>
                    <span>${rating ? '⭐ ' + rating : ''}</span>
                </div>
            </div>`;

        // CLICK-vs-SWIPE DISCRIMINATION (REWRITTEN FOR RELIABILITY):
        // The previous 8px threshold was too sensitive — normal finger jitter
        // on a tap (3-6px) was sometimes classified as a swipe, killing taps.
        // Worse, the click event still fires AFTER touchend on mobile, so
        // we now also track the touch duration AND use a larger 12px threshold.
        // This matches the iOS/Android system-level threshold for tap-vs-pan.
        let _tx = 0, _ty = 0, _moved = false, _tStart = 0;
        card.addEventListener('touchstart', e => {
            const t = e.touches[0];
            _tx = t.clientX; _ty = t.clientY;
            _moved = false;
            _tStart = Date.now();
        }, { passive: true });
        card.addEventListener('touchmove', e => {
            if (_moved) return;
            const t = e.touches[0];
            const dx = Math.abs(t.clientX - _tx);
            const dy = Math.abs(t.clientY - _ty);
            // 12px threshold matches iOS UIKit's default tap slop.
            if (dx > 12 || dy > 12) _moved = true;
        }, { passive: true });

        card.addEventListener('click', e => {
            e.stopPropagation();
            // Skip if it was a swipe, OR if the touch was a long-press (>500ms)
            // — long-presses on mobile usually mean "context menu", not "open".
            if (_moved) return;
            if (_tStart && Date.now() - _tStart > 500) return;
            unlockAudioContext();
            playAudio('soundModal', 0.07);
            openModal(movie);
        });
        frag.appendChild(card);
    });

    slider.appendChild(frag);
    rowsContainer.appendChild(row);

    rowObserver.observe(row);
}

// ============================================================
// MODAL
// ============================================================

let _openModalController = null;

async function openModal(movie) {
    if (!movie) return;
    // Cancel any in-progress openModal call (rapid rec-card taps).
    // Without this, two async fetches run simultaneously and both
    // try to write into the same modal DOM elements — causing frozen
    // text, wrong cast info, wrong poster, and a stuck loading state.
    if (_openModalController) _openModalController.cancelled = true;
    const controller = { cancelled: false };
    _openModalController = controller;

    const wasAlreadyOpen = modal.classList.contains('active');
    modal.classList.add('active');
    if (!wasAlreadyOpen) {
        lockBodyScroll(); // Locks page scroll — NOT search overlay scroll
    } else if (_pendingUnlockTimer) {
        // Defensive: cancel any orphaned delayed unlock from rapid
        // close-then-reopen sequences. lockBodyScroll() already does this
        // when called, but we don't call it on re-open, so do it here.
        clearTimeout(_pendingUnlockTimer);
        _pendingUnlockTimer = null;
    }

    const modalTitle    = getEl('modalTitle');
    const modalOverview = getEl('modalOverview');
    const modalCast     = getEl('modalCast');
    const modalGenres   = getEl('modalGenres');
    const modalMeta     = getEl('modalMeta');
    const tvSelectors   = getEl('tvSelectors');
    const modalPlayBtn  = getEl('modalPlayBtn');
    const recSection    = getEl('recommendedSection');

    if (recSection) recSection.style.display = 'none';

    const type = movie._resolvedType || movie.media_type || (movie.title ? 'movie' : 'tv');

    if (modalTitle)    modalTitle.textContent    = movie.title || movie.name || '';
    if (modalOverview) modalOverview.textContent = movie.overview || '';
    if (modalCast)   { modalCast.textContent = ''; modalCast.classList.add('skeleton-text'); }
    if (modalGenres) { modalGenres.textContent = ''; modalGenres.classList.add('skeleton-text'); }

    const bgPath = movie.backdrop_path || movie.poster_path;
    if (bgPath) {
        const bgUrl = DEVICE_TIER === 'ELITE' ? `${IMG_URL}${bgPath}` : `${IMG_URL_W1280}${bgPath}`;
        preloadImage(bgUrl).then(ok => {
            if (!ok) return;
            const heroBg = document.querySelector('.modal-hero-bg');
            if (heroBg) heroBg.style.backgroundImage = `url(${bgUrl})`;
        });
    }

    buildLangOptions(movie.spoken_languages, movie.original_language);

    // Fetch details + recommendations in parallel
    const [details, recItems] = await Promise.all([
        fetchDetails(movie.id, type),
        fetchRecommendations(movie.id, type),
    ]);

    if (!details || !modal.classList.contains('active') || controller.cancelled) return;

    if (modalCast) {
        modalCast.classList.remove('skeleton-text');
        modalCast.textContent = details.credits?.cast?.slice(0, 6).map(c => c.name).join(', ') || '—';
    }
    if (modalGenres) {
        modalGenres.classList.remove('skeleton-text');
        modalGenres.textContent = details.genres?.map(g => g.name).join(', ') || '—';
    }
    if (modalMeta) {
        const year    = (details.release_date || details.first_air_date || '').split('-')[0] || '—';
        const rating  = details.vote_average ? (Math.round(details.vote_average * 10) / 10).toFixed(1) : '—';
        const runtime = details.runtime
            ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m`
            : details.number_of_seasons
            ? `${details.number_of_seasons} Season${details.number_of_seasons > 1 ? 's' : ''}`
            : '';
        modalMeta.innerHTML = `<span>⭐ ${rating}</span><span>${year}</span>${runtime ? `<span>${runtime}</span>` : ''}`;
    }

    buildLangOptions(details.spoken_languages, details.original_language);

    if (tvSelectors) {
        const seasons = (details.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0);
        if (type === 'tv' && seasons.length) {
            tvSelectors.style.display = 'flex';
            const sSelect = getEl('seasonSelect');
            const eSelect = getEl('episodeSelect');
            if (sSelect && eSelect) {
                sSelect.innerHTML = seasons.map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`).join('');
                const fillEps = n => {
                    eSelect.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">Episode ${i + 1}</option>`).join('');
                };
                fillEps(seasons[0].episode_count);
                sSelect.onchange = e => {
                    const s = seasons.find(x => x.season_number == e.target.value);
                    if (s) fillEps(s.episode_count);
                };
            }
        } else {
            tvSelectors.style.display = 'none';
        }
    }

    if (modalPlayBtn) {
        modalPlayBtn.onclick = () => {
            const s   = getEl('seasonSelect')?.value  || 1;
            const ep  = getEl('episodeSelect')?.value || 1;
            const srv = getEl('serverSelect')?.value  || 'vidlink';
            unlockAudioContext();
            playAudio('soundClick', 0.08);
            playVideo(movie.id, type, srv, s, ep);
        };
    }

    renderRecommendations(recItems, openModal);
}

function closeDetailsModal() {
    modal.classList.remove('active');
    const rec = getEl('recommendedSection');
    if (rec) rec.style.display = 'none';
    // Bug 2 fix: Delay body unlock until AFTER the modal's closing
    // animation completes. The modal-content transform transition is 0.75s.
    // Calling unlockBodyScroll() immediately causes window.scrollTo() to
    // fire while the modal is still animating closed — the page scroll
    // jump is visible through the fading backdrop.
    //
    // Bug 4 fix: Track this delayed unlock in _pendingUnlockTimer so it
    // can be cancelled by lockBodyScroll() / openModal() if the user
    // reopens a modal within 780ms. Otherwise the orphaned timer fires
    // mid-modal and breaks state.
    if (_pendingUnlockTimer) clearTimeout(_pendingUnlockTimer);
    _pendingUnlockTimer = setTimeout(() => {
        _pendingUnlockTimer = null;
        // Re-check that no modal is open before actually unlocking — extra
        // safety net in case a new modal opened via a path that didn't
        // clear the timer.
        if (modal.classList.contains('active')) return;
        if (videoModal && videoModal.classList.contains('active')) return;
        if (adguardModal && adguardModal.classList.contains('active')) return;
        if (hrModal && hrModal.classList.contains('active')) return;
        unlockBodyScroll();
        requestAnimationFrame(unlockAllSliders);
        setTimeout(unlockAllSliders, 200);
    }, 780);
}

function closeAdguardModal() {
    adguardModal.classList.remove('active');
    unlockBodyScroll();
}

function closeHrModal() {
    hrModal.classList.remove('active');
    unlockBodyScroll();
}

// ============================================================
// VIDEO
// ============================================================

async function playVideo(id, type, server = 'vidlink', s = 1, ep = 1) {
    const isMovie = type === 'movie';
    let url = '';

    switch (server) {
        case 'vidlink':
            url = isMovie ? `https://vidlink.pro/movie/${id}?primaryColor=fbbf24` : `https://vidlink.pro/tv/${id}/${s}/${ep}?primaryColor=fbbf24`;
            break;
        case 'vidsrc':
            url = isMovie ? `https://vidsrc.to/embed/movie/${id}` : `https://vidsrc.to/embed/tv/${id}/${s}/${ep}`;
            break;
        case 'super':
            url = isMovie ? `https://superembed.stream/movie/${id}` : `https://superembed.stream/tv/${id}/${s}/${ep}`;
            break;
        case 'trailer': {
            const cKey   = `${BASE_URL}/${type}/${id}?api_key=${API_KEY}&language=en-US&append_to_response=credits,videos,spoken_languages,seasons`;
            let cached = apiCache.get(cKey);
            if (!cached) cached = await fetchDetails(id, type);
            const tr     = cached?.videos?.results?.find(v => v.site === 'YouTube' && v.type === 'Trailer');
            if (tr) url  = `https://www.youtube.com/embed/${tr.key}?autoplay=1`;
            break;
        }
    }

    if (!url) { console.warn('[AuraFlix] No URL for server:', server); return; }
    youtubePlayer.src = url;
    videoModal.classList.add('active');
    lockBodyScroll();
}

function stopVideo() {
    // CRITICAL ORDER (do not change): on iOS, the iframe's touch
    // context must be killed BEFORE the modal hides, otherwise
    // WebKit retains it and freezes the underlying sliders.
    //
    // 1. Clear src first — destroys the iframe's content document
    //    and releases its touch grab on the page.
    try { youtubePlayer.src = 'about:blank'; } catch {}
    // 2. Force a reflow so the blank load is committed to the
    //    layout tree before we hide the modal.
    // eslint-disable-next-line no-unused-expressions
    youtubePlayer.offsetHeight;
    // 3. Now hide the modal.
    videoModal.classList.remove('active');
    // 4. Fully empty the src so it doesn't reload on next view.
    setTimeout(() => { try { youtubePlayer.src = ''; } catch {} }, 50);
    // 5. Release body lock (restores scroll position).
    unlockBodyScroll();
    // 6. Resurrect sliders — two passes catch both immediate
    //    freeze and the delayed iOS "phantom context" freeze.
    requestAnimationFrame(unlockAllSliders);
    setTimeout(unlockAllSliders, 220);
}

// ============================================================
// SEARCH — FIX: Does NOT lock body. Overlay has its own scroll.
// ============================================================

function showSearchOverlay() {
    searchOverlay.style.display = '';
    // Use rAF so display:'' is applied before adding active class (prevents flash)
    requestAnimationFrame(() => searchOverlay.classList.add('active'));
}

function hideSearchOverlay() {
    searchOverlay.classList.remove('active');
    // Wait for CSS transition to finish before setting display:none
    setTimeout(() => {
        if (!searchOverlay.classList.contains('active')) {
            searchOverlay.style.display = 'none';
            const grid = getEl('searchResultsGrid');
            if (grid) grid.innerHTML = '';
        }
    }, 300);
    if (searchController) { searchController.abort(); searchController = null; }
}

async function performSearch(query) {
    const grid = getEl('searchResultsGrid');
    if (!grid) return;
    grid.innerHTML = '<p style="color:var(--text-secondary);padding:20px 0;text-align:center">Searching…</p>';

    if (searchController) searchController.abort();
    searchController = new AbortController();

    const url     = `${BASE_URL}/search/multi?api_key=${API_KEY}&language=en-US&query=${encodeURIComponent(query)}`;
    const results = await fetchData(url, searchController.signal);
    if (results === null) return; // Aborted

    grid.innerHTML = '';
    const filtered = (Array.isArray(results) ? results : []).filter(r => r.poster_path);

    if (!filtered.length) {
        grid.innerHTML = '<p style="color:var(--text-secondary);padding:20px 0;text-align:center">No results found.</p>';
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(item => {
        const card = document.createElement('div');
        card.className = 'movie-card visible';
        const t = item.media_type || (item.title ? 'movie' : 'tv');
        item._resolvedType = t;
        const rawTitle = item.title || item.name || '';
        const title = escapeHTML(rawTitle);
        card.innerHTML = `
            <img src="${IMG_URL_W500}${item.poster_path}" loading="lazy" decoding="async" alt="${title}">
            <div class="card-overlay"><h4>${title}</h4></div>`;
        // Swipe-vs-tap discrimination for search results too (12px threshold)
        let _sx = 0, _sy = 0, _smoved = false, _sStart = 0;
        card.addEventListener('touchstart', e => {
            const t = e.touches[0];
            _sx = t.clientX; _sy = t.clientY;
            _smoved = false;
            _sStart = Date.now();
        }, { passive: true });
        card.addEventListener('touchmove', e => {
            if (_smoved) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - _sx) > 12 || Math.abs(t.clientY - _sy) > 12) _smoved = true;
        }, { passive: true });
        card.addEventListener('click', () => {
            if (_smoved) return;
            if (_sStart && Date.now() - _sStart > 500) return;
            hideSearchOverlay();
            openModal(item);
        });
        frag.appendChild(card);
    });
    grid.appendChild(frag);
}

// ============================================================
// GLOBAL LISTENERS
// ============================================================

function setupGlobalListeners() {
    // Nav section switching
    document.querySelectorAll('.nav-links a[data-section]').forEach(a => {
        a.addEventListener('click', e => {
            e.preventDefault();
            unlockAudioContext();
            playAudio('soundClick', 0.07);
            renderSection(a.dataset.section);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });

    // Nav modal buttons
    const adguardBtn = getEl('adguardBtn');
    const hrLogoBtn  = getEl('hrLogoBtn');
    if (adguardBtn) adguardBtn.onclick = () => {
        unlockAudioContext(); playAudio('soundModal', 0.08);
        adguardModal.classList.add('active'); lockBodyScroll();
    };
    if (hrLogoBtn) hrLogoBtn.onclick = () => {
        unlockAudioContext(); playAudio('soundModal', 0.08);
        hrModal.classList.add('active'); lockBodyScroll();
    };

    // HR logo: click-only float animation
    if (hrLogoBtn) {
        hrLogoBtn.addEventListener('click', () => {
            hrLogoBtn.classList.remove('hr-logo-anim');
            void hrLogoBtn.offsetWidth;
            hrLogoBtn.classList.add('hr-logo-anim');
        });
        hrLogoBtn.addEventListener('animationend', () => hrLogoBtn.classList.remove('hr-logo-anim'));
    }

    // Pause ambient animations when off-screen (GPU savings)
    if ('IntersectionObserver' in window) {
        const bgObs = new IntersectionObserver(entries => {
            entries.forEach(e => {
                e.target.style.animationPlayState = e.isIntersecting ? 'running' : 'paused';
            });
        }, { threshold: 0 });
        document.querySelectorAll('.particles-global, .hero-ambient-glow').forEach(el => {
            el.style.animationPlayState = 'paused';
            bgObs.observe(el);
        });
    }

    // Close buttons
    const closeModalBtn   = getEl('closeModal');
    const closeVideoBtn   = getEl('closeVideo');
    const closeAdguardBtn = getEl('closeAdguardModal');
    const hrCloseBtn      = getEl('hrModalClose');
    const adguardDoneBtn  = getEl('adguardDoneBtn');

    if (closeModalBtn)   closeModalBtn.onclick   = e => { e.stopPropagation(); closeDetailsModal(); };
    if (closeVideoBtn)   closeVideoBtn.onclick   = e => { e.stopPropagation(); stopVideo(); };
    if (closeAdguardBtn) closeAdguardBtn.onclick = e => { e.stopPropagation(); closeAdguardModal(); };
    if (hrCloseBtn)      hrCloseBtn.onclick      = e => { e.stopPropagation(); closeHrModal(); };
    if (adguardDoneBtn)  adguardDoneBtn.onclick  = () => closeAdguardModal();

    // Backdrop clicks
    if (modal)        modal.onclick        = e => { if (e.target === modal)        closeDetailsModal(); };
    if (videoModal)   videoModal.onclick   = e => { if (e.target === videoModal)   stopVideo(); };
    if (adguardModal) adguardModal.onclick = e => { if (e.target === adguardModal) closeAdguardModal(); };
    if (hrModal)      hrModal.onclick      = e => { if (e.target === hrModal)      closeHrModal(); };

    // Escape key
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if      (videoModal?.classList.contains('active'))   stopVideo();
        else if (modal?.classList.contains('active'))        closeDetailsModal();
        else if (adguardModal?.classList.contains('active')) closeAdguardModal();
        else if (hrModal?.classList.contains('active'))      closeHrModal();
        else if (searchOverlay?.classList.contains('active')) hideSearchOverlay();
    });

    // SEARCH INPUT — fixed: no lockBodyScroll, no display fighting
    const searchInput = getEl('searchInput');
    const searchIcon = document.querySelector('.search-box .ph-magnifying-glass');
    if (searchIcon && searchInput) {
        searchIcon.addEventListener('click', () => {
            searchInput.focus();
            if (IS_MOBILE) window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', e => {
            const q = e.target.value.trim();
            clearTimeout(searchTimer);
            if (q.length > 2) {
                showSearchOverlay();
                searchTimer = setTimeout(() => performSearch(q), SEARCH_DEBOUNCE_MS);
            } else {
                hideSearchOverlay();
            }
        });

        // Close search on clicking overlay background
        searchOverlay.addEventListener('pointerdown', e => {
            if (e.target === searchOverlay) {
                hideSearchOverlay();
                searchInput.value = '';
            }
        });
    }

    // Navbar scroll — RAF throttled, passive
    let _nTick = false;
    window.addEventListener('scroll', () => {
        if (!_nTick) {
            requestAnimationFrame(() => {
                navbar.classList.toggle('scrolled', window.scrollY > 50);
                _nTick = false;
            });
            _nTick = true;
        }
    }, { passive: true });

    // Instagram in-app browser — repaint on tab return
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            setTimeout(() => {
                unlockAllSliders();
                navbar.classList.toggle('scrolled', window.scrollY > 50);
            }, 200);
        }
    });

    // iOS resize spam debounce (address bar slide = 20+ resize events)
    window.addEventListener('resize', debounce(() => {
        document.querySelectorAll('.slider').forEach(slider => {
            const w = slider.closest('.slider-wrapper');
            if (!w) return;
            const atEnd   = slider.scrollLeft >= slider.scrollWidth - slider.clientWidth - 10;
            const atStart = slider.scrollLeft <= 10;
            const btnR = w.querySelector('.slider-btn.right');
            const btnL = w.querySelector('.slider-btn.left');
            if (btnR) btnR.style.opacity = atEnd   ? '0' : '1';
            if (btnL) btnL.style.opacity = atStart ? '0' : '1';
        });
    }, 150), { passive: true });

    // Unlock Web Audio on first touch/click
    document.addEventListener('touchstart',  unlockAudioContext, { once: true, passive: true });
    document.addEventListener('pointerdown', unlockAudioContext, { once: true, passive: true });
}

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', initApp);
