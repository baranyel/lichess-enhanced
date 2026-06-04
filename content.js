/**
 * Lichess Enhanced Analysis (LEA) — Content Script
 *
 * Lichess analiz ve çalışma sayfalarına chess.com tarzı
 * görsel analiz paneli enjekte eder.
 *
 * Tüm kod tek bir IIFE içinde — global scope kirliliği yok.
 */
(function () {
  'use strict';

  // ══════════════════════════════════════════════════════
  // LOGGER
  // ══════════════════════════════════════════════════════

  /** @param {string} msg */
  const log = (msg) => console.log('[LEA]', msg);

  // ══════════════════════════════════════════════════════
  // DURUM (STATE)
  // ══════════════════════════════════════════════════════

  let panelInjected        = false;
  let observerInstance     = null;
  let updateThrottle       = null;
  let fontsInjected        = false;
  let lastMoveCount        = 0;
  let toolsEl              = null;
  let selectedSide         = 'white';  // 'white' | 'black'
  // Her kategori için sıradaki hamle indeksini tutar (döngüsel navigasyon)
  const statNavIndex = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };

  // ══════════════════════════════════════════════════════
  // FONT YÜKLEME
  // ══════════════════════════════════════════════════════

  /**
   * Google Fonts'tan Rajdhani ve JetBrains Mono'yu <head>'e inject eder.
   * Idempotent — birden fazla kez çağrılırsa yalnızca bir kez çalışır.
   */
  function injectFonts() {
    if (fontsInjected) return;
    try {
      const pc1 = document.createElement('link');
      pc1.rel = 'preconnect';
      pc1.href = 'https://fonts.googleapis.com';
      document.head.appendChild(pc1);

      const pc2 = document.createElement('link');
      pc2.rel = 'preconnect';
      pc2.href = 'https://fonts.gstatic.com';
      pc2.crossOrigin = 'anonymous';
      document.head.appendChild(pc2);

      const fl = document.createElement('link');
      fl.rel = 'stylesheet';
      fl.href =
        'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700' +
        '&family=JetBrains+Mono:wght@400;500&display=swap';
      document.head.appendChild(fl);

      fontsInjected = true;
      log('Fontlar enjekte edildi');
    } catch (e) {
      log('Font injection hatası: ' + e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // DOM SELECTORS — çoklu fallback
  // ══════════════════════════════════════════════════════

  /**
   * Lichess ana hat hamle elementlerini döndürür.
   * Descendant selector ile tüm move'lar bulunur; ardından
   * variation/kwdb/lines wrapper içindekiler filtrelenir.
   * @returns {Element[]}
   */
  function getMoveNodes() {
    try {
      const descCandidates = [
        'l4x move',
        '.moves move',
        'rm6 move',
        '.analyse__moves move',
        '[data-uci]',
      ];

      for (const sel of descCandidates) {
        const all = document.querySelectorAll(sel);
        if (!all || all.length === 0) continue;

        /* Variation + bizim gizlediğimiz orijinal Lichess içeriğini dışla */
        const mainLine = Array.from(all).filter(
          (el) => !el.closest('variation, kwdb, lines, line, .variation, interrupt, [data-lea-hidden]')
        );

        if (mainLine.length > 0) return mainLine;
        /* Filtre her şeyi siliyorsa ham listeyle devam et */
        if (all.length > 0) return Array.from(all);
      }
    } catch (e) {
      log('getMoveNodes hatası: ' + e.message);
    }
    return [];
  }

  /**
   * Şu an seçili (aktif) hamle elementini döndürür.
   * @returns {Element|null}
   */
  function getActiveMove() {
    try {
      const candidates = [
        'move.active',
        'move.current',
        'm2.active',
        '.active move',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
    } catch (e) {
      log('getActiveMove hatası: ' + e.message);
    }
    return null;
  }

  /**
   * Stockfish değerlendirme skorunu metin olarak döndürür (ör: "+1.4", "#3").
   * @returns {string}
   */
  function getEvalScore() {
    try {
      const candidates = [
        '.ceval .score',
        '.ceval-score',
        '[class*="ceval"] .score',
        'ceval .score',
        '.engine-score',
        '.eval-score',
        '.cp',
        /* Lichess yeni: değerlendirme sayısı */
        '.analyse__tools .score',
        '.ceval__score',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        const t  = el?.textContent?.trim();
        if (t && /^[+\-#]?[\d.]+/.test(t)) return t;
      }
      /* Son çare: sayfadaki ilk +/-/# ile başlayan sayısal metni ara */
      const all = document.querySelectorAll('.ceval *, ceval *');
      for (const el of all) {
        if (el.children.length) continue;          // leaf node iste
        const t = el.textContent.trim();
        if (/^[+\-#][\d.]+$/.test(t)) return t;
      }
    } catch (e) {
      log('getEvalScore hatası: ' + e.message);
    }
    return '0.0';
  }

  /**
   * Analiz derinliğini sayısal string olarak döndürür (ör: "22").
   * Her selectordan elde edilen metin regex ile sayıya dönüştürülür.
   * @returns {string}
   */
  function getDepth() {
    try {
      const candidates = [
        '.ceval .depth',
        '.ceval__depth',
        'ceval .depth',
        '.engine-depth',
        '.analyse__tools .depth',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const m = el.textContent.match(/\d+/);
        if (m) return m[0];
      }
      /* Ceval içindeki "depth NN" kalıbını ara */
      const cevalEl = document.querySelector('.ceval, ceval');
      if (cevalEl) {
        const m = cevalEl.textContent.match(/depth\s+(\d+)/i);
        if (m) return m[1];
      }
    } catch (e) {
      log('getDepth hatası: ' + e.message);
    }
    return '--';
  }

  /**
   * Motor tarafından önerilen hamle dizisini (PV) döndürür.
   * Eğer element listesi bulunamazsa .pv'nin textContent'ini
   * boşlukla bölüp sahte node dizisi olarak döndürür.
   * @returns {Array}
   */
  function getBestMovePV() {
    try {
      /* Önce move elementleri dene */
      const elCandidates = [
        '.ceval .pv move',
        '.ceval .pv san',
        'ceval .pv move',
        '.pv move',
        '[class*="pv"] move',
        '.engine-pvs move',
      ];
      for (const sel of elCandidates) {
        const nodes = document.querySelectorAll(sel);
        if (nodes && nodes.length > 0) return Array.from(nodes);
      }

      /* Element bulunamazsa düz metin PV'yi parse et */
      const textCandidates = [
        '.ceval .pv',
        'ceval .pv',
        '.analyse__tools .pv',
        '.ceval__pv',
      ];
      for (const sel of textCandidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const text = el.textContent.trim();
        if (!text) continue;
        /* Metin parçalarını sahte {textContent} objesine dönüştür */
        return text.split(/\s+/).filter(Boolean).map((s) => ({ textContent: s }));
      }
    } catch (e) {
      log('getBestMovePV hatası: ' + e.message);
    }
    return [];
  }

  /**
   * Mevcut pozisyonun açılış adını döndürür.
   * @returns {string}
   */
  function getOpeningName() {
    try {
      const candidates = [
        '.opening',
        '.opening-name',
        '[class*="opening"] span',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
    } catch (e) {
      log('getOpeningName hatası: ' + e.message);
    }
    return '';
  }

  /**
   * Panel kök elementini döndürür.
   * @returns {HTMLElement|null}
   */
  function getPanel() {
    return document.getElementById('lea-panel-root');
  }

  // ══════════════════════════════════════════════════════
  // HAMLE SINIFLANDIRMA
  // ══════════════════════════════════════════════════════

  /**
   * Bir hamle elementinin kalitesini Lichess glyph'ine göre belirler.
   * @param {Element} moveEl
   * @returns {'best'|'excellent'|'good'|'inaccuracy'|'mistake'|'blunder'}
   */
  function classifyMove(moveEl) {
    try {
      const glyph = moveEl.querySelector('glyph');
      if (!glyph) return 'good';
      const sym = glyph.textContent.trim();
      if (sym === '!!' || sym === '✓✓') return 'best';
      if (sym === '!')                  return 'excellent';
      if (sym === '?!')                 return 'inaccuracy';
      if (sym === '?')                  return 'mistake';
      if (sym === '??')                 return 'blunder';
      return 'good';
    } catch (_) {
      return 'good';
    }
  }

  /**
   * Filtrelenmiş indeks → hamle kalitesi haritası oluşturur.
   * Key: getMainLineMoves() içindeki sıra (placeholder'sız)
   * @returns {Map<number, string>}
   */
  function buildMoveMap() {
    const map = new Map();
    try {
      getMainLineMoves().forEach(({ el }, filteredIdx) => {
        map.set(filteredIdx, classifyMove(el));
      });
    } catch (e) {
      log('buildMoveMap hatası: ' + e.message);
    }
    return map;
  }

  // ══════════════════════════════════════════════════════
  // DOĞRULUK HESAPLAMA
  // ══════════════════════════════════════════════════════

  /** Hamle kalitesi → doğruluk ağırlığı */
  const WEIGHTS = {
    best: 100, excellent: 95, good: 82,
    inaccuracy: 60, mistake: 35, blunder: 8,
  };

  /**
   * Verilen renk için ortalama doğruluk yüzdesini hesaplar.
   * Placeholder'lar filtrelendiği için çift/tek indeks doğru eşleşir.
   * @param {'white'|'black'} color
   * @returns {number} 0-100
   */
  function computeAccuracy(color) {
    try {
      const moves    = getMainLineMoves();
      const relevant = moves.filter((_, i) =>
        color === 'white' ? i % 2 === 0 : i % 2 === 1
      );
      if (relevant.length === 0) return 0;
      const sum = relevant.reduce((acc, { el }) =>
        acc + (WEIGHTS[classifyMove(el)] ?? 82), 0
      );
      return Math.round(sum / relevant.length);
    } catch (e) {
      log('computeAccuracy hatası: ' + e.message);
      return 0;
    }
  }

  /**
   * Doğruluk yüzdesine göre CSS renk değişkeni döndürür.
   * @param {number} pct
   * @returns {string}
   */
  function getAccuracyColor(pct) {
    if (pct >= 90) return 'var(--lea-best)';
    if (pct >= 75) return 'var(--lea-good)';
    if (pct >= 60) return 'var(--lea-inaccuracy)';
    return 'var(--lea-blunder)';
  }

  /**
   * Seçili tarafın hamle kalitesi sayılarını döndürür.
   * @param {'white'|'black'} side
   * @returns {{ best:number, excellent:number, good:number, inaccuracy:number, mistake:number, blunder:number }}
   */
  function computeStatsForSide(side) {
    const moves = getMainLineMoves();
    const stats = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    moves.forEach(({ el }, i) => {
      const isWhite = i % 2 === 0;
      if (side === 'white' && !isWhite) return;
      if (side === 'black' &&  isWhite) return;
      const cls = classifyMove(el);
      if (cls in stats) stats[cls]++;
    });
    return stats;
  }

  /**
   * Seçili tarafın belirtilen kategorisindeki hamleler arasında döngüsel gezinir.
   * @param {string} category
   */
  function navigateStat(category) {
    try {
      const moves     = getMainLineMoves();
      const sideMoves = moves.filter((_, i) =>
        selectedSide === 'white' ? i % 2 === 0 : i % 2 === 1
      );
      const catMoves = sideMoves.filter(({ el }) => classifyMove(el) === category);
      if (catMoves.length === 0) return;

      const idx              = statNavIndex[category] % catMoves.length;
      statNavIndex[category] = (idx + 1) % catMoves.length;

      const { origIdx } = catMoves[idx];
      const lichessMove  = Array.from(getMoveNodes())[origIdx];
      if (lichessMove) {
        lichessMove.click();
        log(`Stat nav: ${category} ${idx + 1}/${catMoves.length}`);
      }
    } catch (e) {
      log('navigateStat hatası: ' + e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // EVAL BAR
  // ══════════════════════════════════════════════════════

  /**
   * Eval skorunu eval bar'ın beyaz-yüzdesi değerine dönüştürür.
   * Mat skorları (%4/%96), sayısal skor -6…+6 arasına sıkıştırılır.
   * Sonuç her zaman 3…97 arasındadır (bar hiç tam dolmaz).
   * @param {string} score - ör: "+1.4", "#3", "-0.8"
   * @returns {number}
   */
  function evalToPercent(score) {
    try {
      const s = (score || '0').trim();
      if (s.startsWith('#')) {
        return parseInt(s.slice(1), 10) > 0 ? 96 : 4;
      }
      const num = parseFloat(s);
      if (isNaN(num)) return 50;
      const clamped = Math.max(-6, Math.min(6, num));
      const pct = ((clamped + 6) / 12) * 100;
      return Math.max(3, Math.min(97, pct));
    } catch (_) {
      return 50;
    }
  }

  // ══════════════════════════════════════════════════════
  // COUNT-UP ANİMASYONLAR
  // ══════════════════════════════════════════════════════

  /**
   * Bir elementi 0'dan hedef değere easeOutCubic ile animates eder.
   * @param {HTMLElement} element
   * @param {number} target
   * @param {number} [duration=800]
   */
  function animateCount(element, target, duration = 800) {
    if (!element) return;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    const step = (now) => {
      const p = Math.min((now - start) / duration, 1);
      element.textContent = Math.round(ease(p) * target);
      if (p < 1) requestAnimationFrame(step);
      else element.textContent = target;
    };
    requestAnimationFrame(step);
  }

  /**
   * Hem yüzde metnini count-up yapar hem de bar genişliğini animates eder.
   * @param {HTMLElement} textEl   - "87%" gibi metin elementi
   * @param {HTMLElement} barEl    - bar dolgu elementi
   * @param {number}      target   - hedef yüzde (0-100)
   * @param {string}      color    - CSS renk değeri
   * @param {number}      [duration=900]
   */
  function animateAccuracy(textEl, barEl, target, color, duration = 900) {
    if (!textEl) return;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    if (barEl) {
      barEl.style.backgroundColor = color;
      barEl.style.width = '0%';
    }

    const step = (now) => {
      const p = Math.min((now - start) / duration, 1);
      const cur = Math.round(ease(p) * target);
      textEl.textContent = cur + '%';
      if (barEl) barEl.style.width = ease(p) * target + '%';
      if (p < 1) requestAnimationFrame(step);
      else {
        textEl.textContent = target + '%';
        if (barEl) barEl.style.width = target + '%';
      }
    };
    requestAnimationFrame(step);
  }

  // ══════════════════════════════════════════════════════
  // YARDIMCI
  // ══════════════════════════════════════════════════════

  /** HTML özel karakterlerini escape eder (XSS önleme). */
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Hamle kalitesi → move list badge sembolü */
  const SYMBOLS = {
    best: '!!', excellent: '!', good: '',
    inaccuracy: '?!', mistake: '?', blunder: '??',
  };

  /** Stat grid ikon (chess.com tarzı) */
  const QUALITY_ICONS = {
    best: '⚡', excellent: '✦', good: '●',
    inaccuracy: '▲', mistake: '?', blunder: '✕',
  };

  /** Stat grid tam etiket */
  const QUALITY_LABELS = {
    best: 'Mükemmel', excellent: 'Harika', good: 'İyi',
    inaccuracy: 'Hatalı', mistake: 'Hata', blunder: 'Gaf',
  };

  // Gauge sabitleri (r=32, 270° arc)
  const GAUGE_R      = 32;
  const GAUGE_C      = 2 * Math.PI * GAUGE_R;   // ≈ 201.06
  const GAUGE_ARC    = GAUGE_C * 0.75;           // ≈ 150.80
  const GAUGE_GAP    = GAUGE_C - GAUGE_ARC;      // ≈ 50.27

  /**
   * Accuracy SVG gauge HTML'ini döndürür.
   * @param {string} suffix  - 'w' veya 'b'
   * @param {string} symbol  - '♔' veya '♚'
   * @returns {string}
   */
  function buildGaugeSVG(suffix, symbol) {
    const cx = 40, cy = 42;
    return `<svg viewBox="0 0 80 74" class="lea-gauge-svg" width="80" height="74">
      <circle cx="${cx}" cy="${cy}" r="${GAUGE_R}" fill="none"
        stroke="rgba(255,255,255,0.08)" stroke-width="6"
        stroke-dasharray="${GAUGE_ARC.toFixed(2)} ${GAUGE_GAP.toFixed(2)}"
        stroke-linecap="round"
        transform="rotate(135 ${cx} ${cy})"/>
      <circle cx="${cx}" cy="${cy}" r="${GAUGE_R}" fill="none"
        stroke="var(--lea-good)" stroke-width="6"
        stroke-dasharray="0 ${GAUGE_C.toFixed(2)}"
        stroke-linecap="round"
        transform="rotate(135 ${cx} ${cy})"
        id="lea-gauge-arc-${suffix}"/>
      <text x="${cx}" y="${cy - 5}" class="lea-gauge-pct-text" id="lea-gauge-pct-${suffix}">0%</text>
      <text x="${cx}" y="${cy + 11}" class="lea-gauge-sym-text">${symbol}</text>
    </svg>`;
  }

  /**
   * SVG gauge'ı animasyonlu olarak doldurur.
   * @param {string} suffix
   * @param {number} targetPct
   * @param {string} color
   * @param {number} [duration=900]
   */
  function animateGauge(suffix, targetPct, color, duration = 900) {
    const arcEl = document.getElementById(`lea-gauge-arc-${suffix}`);
    const pctEl = document.getElementById(`lea-gauge-pct-${suffix}`);
    if (!arcEl && !pctEl) return;
    const start = performance.now();
    const ease  = (t) => 1 - Math.pow(1 - t, 3);
    if (arcEl) arcEl.setAttribute('stroke', color);
    const step = (now) => {
      const p   = Math.min((now - start) / duration, 1);
      const cur = ease(p) * targetPct;
      const f   = (cur / 100) * GAUGE_ARC;
      if (arcEl) arcEl.setAttribute('stroke-dasharray', `${f.toFixed(2)} ${GAUGE_C.toFixed(2)}`);
      if (pctEl) pctEl.textContent = Math.round(cur) + '%';
      if (p < 1) requestAnimationFrame(step);
      else {
        if (pctEl) pctEl.textContent = targetPct + '%';
        if (arcEl) arcEl.setAttribute('stroke-dasharray', `${((targetPct / 100) * GAUGE_ARC).toFixed(2)} ${GAUGE_C.toFixed(2)}`);
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * Gauge'ı animasyon olmadan set eder.
   */
  function setGauge(suffix, pct, color) {
    const arcEl = document.getElementById(`lea-gauge-arc-${suffix}`);
    const pctEl = document.getElementById(`lea-gauge-pct-${suffix}`);
    const f     = (pct / 100) * GAUGE_ARC;
    if (arcEl) {
      arcEl.setAttribute('stroke', color);
      arcEl.setAttribute('stroke-dasharray', `${f.toFixed(2)} ${GAUGE_C.toFixed(2)}`);
    }
    if (pctEl && pctEl.textContent !== pct + '%') pctEl.textContent = pct + '%';
  }

  /**
   * Bir move elementinden SAN metnini alır.
   * @param {Element} el
   * @returns {string}
   */
  function getSAN(el) {
    if (!el) return '';
    return (el.querySelector?.('san')?.textContent ?? el.textContent ?? '').trim();
  }

  /**
   * Elementin bir placeholder ("..." / "…") olup olmadığını döndürür.
   * Lichess, varyant geçişlerinde ana satıra bu sahte hamleleri ekler.
   * @param {Element} el
   * @returns {boolean}
   */
  function isPlaceholder(el) {
    const san = getSAN(el);
    return !san || /^[.…\s]+$/.test(san);
  }

  /**
   * Placeholder'ları filtreleyen, ana satır hamlelerini döndürür.
   * Her eleman: { el: Element, origIdx: number }
   * origIdx → getMoveNodes() içindeki orijinal indeks (Lichess click için)
   * @returns {{ el: Element, origIdx: number }[]}
   */
  function getMainLineMoves() {
    const all = Array.from(getMoveNodes());
    const result = [];
    all.forEach((el, origIdx) => {
      if (!isPlaceholder(el)) result.push({ el, origIdx });
    });
    return result;
  }

  // ══════════════════════════════════════════════════════
  // PANEL HTML OLUŞTURMA
  // ══════════════════════════════════════════════════════

  /**
   * Panelin tüm HTML yapısını bir string olarak döndürür.
   * Her bölümde data-section attribute bulunur.
   * @returns {string}
   */
  function buildPanelHTML() {
    /* --- Veri toplama --- */
    const mainMoves = getMainLineMoves();   // placeholder'sız, {el, origIdx}[]
    const moveMap   = buildMoveMap();       // filteredIdx → classification
    const evalScore = getEvalScore();
    const depth     = getDepth();
    const opening   = getOpeningName();
    const evalPct   = evalToPercent(evalScore);
    const activeEl  = getActiveMove();

    /* --- İstatistikler (seçili taraf için) --- */
    const stats = computeStatsForSide(selectedSide);

    /* --- En iyi hamle PV --- */
    const pvNodes = getBestMovePV();
    const pvArr   = Array.from(pvNodes)
      .map((n) => n.textContent.trim())
      .filter(Boolean);
    const bestSan = pvArr[0] || '—';
    const pvLine  = pvArr.slice(1, 5).join(' ');

    /* --- Hamle listesi satırları ---
         filteredIdx: 0=w,1=b,2=w,3=b… (placeholder yoktur)
         origIdx: Lichess DOM'undaki gerçek konum (tıklama için)    */
    let moveRows = '';
    for (let i = 0; i < mainMoves.length; i += 2) {
      const w     = mainMoves[i];
      const b     = mainMoves[i + 1] || null;
      const num   = Math.floor(i / 2) + 1;
      const wCls  = moveMap.get(i)     || 'good';
      const bCls  = moveMap.get(i + 1) || 'good';
      const wSan  = getSAN(w.el);
      const bSan  = b ? getSAN(b.el) : '';
      const wAct  = w.el === activeEl  ? 'lea-active' : '';
      const bAct  = b && b.el === activeEl ? 'lea-active' : '';
      const wSym  = SYMBOLS[wCls];
      const bSym  = SYMBOLS[bCls];

      moveRows += `<div class="lea-move-row">
        <span class="lea-move-num">${num}.</span>
        <div class="lea-move-cell ${wAct}" data-orig-idx="${w.origIdx}">
          <span class="lea-move-dot dot-${wCls}"></span>
          <span class="lea-move-name">${esc(wSan)}</span>
          ${wSym ? `<span class="lea-move-symbol">${wSym}</span>` : ''}
        </div>
        ${b
          ? `<div class="lea-move-cell ${bAct}" data-orig-idx="${b.origIdx}">
               <span class="lea-move-dot dot-${bCls}"></span>
               <span class="lea-move-name">${esc(bSan)}</span>
               ${bSym ? `<span class="lea-move-symbol">${bSym}</span>` : ''}
             </div>`
          : '<div></div>'}
      </div>`;
    }

    /* --- Kitap SVG ikonu --- */
    const bookSVG = `<svg class="lea-opening-svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>`;

    /* --- Birleştirilmiş HTML --- */
    return `<div id="lea-panel-root">

      <!-- 1. HEADER -->
      <div class="lea-header" data-section="header">
        <div class="lea-header-left">
          <span class="lea-header-icon">♟</span>
          <span class="lea-header-title">Enhanced Analysis</span>
        </div>
        <div class="lea-header-controls">
          <button class="lea-btn" id="lea-min-btn" title="Küçült">─</button>
          <button class="lea-btn" id="lea-close-btn" title="Kapat">✕</button>
        </div>
      </div>

      <!-- 2. OPENING BAR -->
      <div class="lea-opening ${opening ? '' : 'lea-hidden'}" data-section="opening">
        <span class="lea-opening-icon">${bookSVG}</span>
        <span class="lea-opening-name" id="lea-opening-text">${esc(opening)}</span>
      </div>

      <!-- 3. EVAL SECTION -->
      <div class="lea-eval-section" data-section="eval">
        <div class="lea-eval-top">
          <span class="lea-eval-score" id="lea-eval-score">${esc(evalScore)}</span>
          <span class="lea-eval-depth" id="lea-eval-depth">depth ${esc(depth)}</span>
        </div>
        <div class="lea-eval-bar-container">
          <div class="lea-eval-bar" id="lea-eval-bar" style="width:${evalPct}%"></div>
        </div>
        <div class="lea-eval-labels">
          <span>Beyaz ▲</span>
          <span>Siyah ▼</span>
        </div>
      </div>

      <!-- 4. BEST MOVE CARD -->
      <div class="lea-best-move-card" data-section="bestmove">
        <div class="lea-best-move-label">EN İYİ HAMLE</div>
        <div class="lea-best-move-row">
          <span class="lea-best-move-san" id="lea-best-san">${esc(bestSan)}</span>
          <span class="lea-best-move-cp"  id="lea-best-cp">±0.0</span>
        </div>
        <div class="lea-best-move-pv" id="lea-best-pv">${esc(pvLine)}</div>
      </div>

      <!-- 4b. SIDE SELECTOR -->
      <div class="lea-side-selector lea-collapsible" data-section="side">
        <button class="lea-side-btn ${selectedSide === 'white' ? 'lea-side-active' : ''}" id="lea-side-white" data-side="white">♔ Beyaz</button>
        <button class="lea-side-btn ${selectedSide === 'black' ? 'lea-side-active' : ''}" id="lea-side-black" data-side="black">♚ Siyah</button>
      </div>

      <!-- 5. MOVE QUALITY STATS -->
      <div class="lea-stats-section lea-collapsible" data-section="stats">
        <div class="lea-stats-grid">
          <div class="lea-stat-cell stat-best"       data-category="best">
            <div class="lea-stat-number" id="lea-stat-best"  data-target="${stats.best}">0</div>
            <div class="lea-stat-label">En İyi</div>
          </div>
          <div class="lea-stat-cell stat-excellent"  data-category="excellent">
            <div class="lea-stat-number" id="lea-stat-excel" data-target="${stats.excellent}">0</div>
            <div class="lea-stat-label">Mükem.</div>
          </div>
          <div class="lea-stat-cell stat-good"       data-category="good">
            <div class="lea-stat-number" id="lea-stat-good"  data-target="${stats.good}">0</div>
            <div class="lea-stat-label">İyi</div>
          </div>
          <div class="lea-stat-cell stat-inaccuracy" data-category="inaccuracy">
            <div class="lea-stat-number" id="lea-stat-inacc" data-target="${stats.inaccuracy}">0</div>
            <div class="lea-stat-label">Hatalı</div>
          </div>
          <div class="lea-stat-cell stat-mistake"    data-category="mistake">
            <div class="lea-stat-number" id="lea-stat-miss"  data-target="${stats.mistake}">0</div>
            <div class="lea-stat-label">Hata</div>
          </div>
          <div class="lea-stat-cell stat-blunder"    data-category="blunder">
            <div class="lea-stat-number" id="lea-stat-blund" data-target="${stats.blunder}">0</div>
            <div class="lea-stat-label">Gaf</div>
          </div>
        </div>
      </div>

      <!-- 6. ACCURACY BARS -->
      <div class="lea-accuracy-section lea-collapsible" data-section="accuracy">
        <div class="lea-accuracy-row">
          <div class="lea-accuracy-header">
            <span class="lea-accuracy-label">♔ Beyaz</span>
            <span class="lea-accuracy-pct" id="lea-acc-white">0%</span>
          </div>
          <div class="lea-accuracy-bar-bg">
            <div class="lea-accuracy-bar-fill" id="lea-acc-bar-w"></div>
          </div>
        </div>
        <div class="lea-accuracy-row">
          <div class="lea-accuracy-header">
            <span class="lea-accuracy-label">♚ Siyah</span>
            <span class="lea-accuracy-pct" id="lea-acc-black">0%</span>
          </div>
          <div class="lea-accuracy-bar-bg">
            <div class="lea-accuracy-bar-fill" id="lea-acc-bar-b"></div>
          </div>
        </div>
      </div>

      <!-- 7. MOVE LIST -->
      <div class="lea-moves-section lea-collapsible" data-section="movelist">
        <div class="lea-moves-header">Hamleler</div>
        <div class="lea-moves-list" id="lea-moves-list">
          ${moveRows || '<div class="lea-moves-empty">Analiz bekleniyor…</div>'}
        </div>
      </div>

      <!-- 8. FOOTER -->
      <div class="lea-footer" data-section="footer">
        <span class="lea-footer-text">Lichess Enhanced · v1.0</span>
      </div>

    </div>`;
  }

  // ══════════════════════════════════════════════════════
  // PANEL ENJEKTE
  // ══════════════════════════════════════════════════════

  /**
   * Paneli .analyse__tools içine yerleştirir.
   * Orijinal çocuk elementler innerHTML ile silinmez — sadece gizlenir.
   * Bu sayede l4x, ceval vb. DOM'da kalır ve selectors çalışmaya devam eder.
   * @returns {boolean} enjeksiyon başarılıysa true
   */
  function injectPanel() {
    if (getPanel()) {
      log('Panel zaten mevcut, tekrar enjekte edilmiyor');
      return true;
    }

    injectFonts();

    toolsEl = document.querySelector('.analyse__tools');
    if (!toolsEl) {
      log('.analyse__tools bulunamadı');
      return false;
    }

    try {
      /* Orijinal çocukları gizle ama DOM'dan çıkarma */
      Array.from(toolsEl.children).forEach((child) => {
        child.dataset.leaHidden = '1';
        child.style.display     = 'none';
      });

      /* Panelimizi en başa ekle */
      const wrapper = document.createElement('div');
      wrapper.id = 'lea-inject-wrapper';
      wrapper.innerHTML = buildPanelHTML();
      toolsEl.insertBefore(wrapper, toolsEl.firstChild);

      toolsEl.style.cssText += ';background:var(--lea-bg,#1a1a2e)!important;padding:0!important;overflow:hidden auto!important;';

      panelInjected = true;
      log('Panel yerleştirildi (orijinal içerik gizlendi, DOM\'da korundu)');

      attachPanelEvents();
      setTimeout(() => runEntryAnimations(), 50);
      return true;
    } catch (e) {
      log('injectPanel hatası: ' + e.message);
      return false;
    }
  }

  // ══════════════════════════════════════════════════════
  // PANEL OLAYLARI
  // ══════════════════════════════════════════════════════

  /**
   * Panel UI elementlerine event listener'ları ekler.
   * Event delegation ile hamle listesi tıklamaları yönetilir.
   */
  function attachPanelEvents() {
    try {
      /* Kapat butonu — wrapper silinir, gizlenen orijinal çocuklar geri gösterilir */
      const closeBtn = document.getElementById('lea-close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          document.getElementById('lea-inject-wrapper')?.remove();
          if (toolsEl) {
            toolsEl.querySelectorAll('[data-lea-hidden]').forEach((el) => {
              el.style.display = '';
              delete el.dataset.leaHidden;
            });
            toolsEl.style.cssText = toolsEl.style.cssText
              .replace(/background[^;]+;?/gi, '')
              .replace(/padding[^;]+;?/gi, '')
              .replace(/overflow[^;]+;?/gi, '');
          }
          panelInjected = false;
          log('Panel kapatıldı, orijinal içerik geri yüklendi');
        });
      }

      /* Minimize butonu */
      const minBtn = document.getElementById('lea-min-btn');
      if (minBtn) {
        minBtn.addEventListener('click', () => {
          const panel = getPanel();
          if (!panel) return;
          const isMin = panel.classList.toggle('lea-minimized');
          minBtn.textContent = isMin ? '□' : '─';
          minBtn.title = isMin ? 'Genişlet' : 'Küçült';
        });
      }

      /* Hamle listesi — event delegation */
      const movesList = document.getElementById('lea-moves-list');
      if (movesList) {
        movesList.addEventListener('click', handleMoveClick);
      }

      /* Taraf seçici butonlar */
      const sideSelector = document.querySelector('.lea-side-selector');
      if (sideSelector) {
        sideSelector.addEventListener('click', (e) => {
          const btn = e.target.closest('.lea-side-btn');
          if (!btn) return;
          const side = btn.dataset.side;
          if (!side || side === selectedSide) return;

          selectedSide = side;
          /* Nav indexleri sıfırla */
          Object.keys(statNavIndex).forEach((k) => { statNavIndex[k] = 0; });

          /* Buton görünümünü güncelle */
          document.querySelectorAll('.lea-side-btn').forEach((b) =>
            b.classList.toggle('lea-side-active', b.dataset.side === side)
          );

          /* Stats'ı yeni tarafa göre güncelle */
          refreshStatsDisplay(true);
          log('Taraf değişti: ' + side);
        });
      }

      /* Stat hücresi tıklaması — kategoriye göre gezinme */
      const statsGrid = document.querySelector('.lea-stats-grid');
      if (statsGrid) {
        statsGrid.addEventListener('click', (e) => {
          const cell = e.target.closest('.lea-stat-cell[data-category]');
          if (!cell) return;
          navigateStat(cell.dataset.category);
        });
      }
    } catch (e) {
      log('attachPanelEvents hatası: ' + e.message);
    }
  }

  /**
   * Stats grid'ini seçili tarafın verisiyle günceller.
   * @param {boolean} [animated] - count-up animasyonu kullanılsın mı
   */
  function refreshStatsDisplay(animated = false) {
    const stats = computeStatsForSide(selectedSide);
    const pairs = [
      ['lea-stat-best',  stats.best],
      ['lea-stat-excel', stats.excellent],
      ['lea-stat-good',  stats.good],
      ['lea-stat-inacc', stats.inaccuracy],
      ['lea-stat-miss',  stats.mistake],
      ['lea-stat-blund', stats.blunder],
    ];
    pairs.forEach(([id, val], i) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.dataset.target = val;
      if (animated) {
        setTimeout(() => animateCount(el, val, 500), i * 50);
      } else if (el.textContent !== String(val)) {
        el.textContent = val;
      }
    });
  }

  /**
   * Hamle hücresine tıklama olayını işler.
   * @param {MouseEvent} e
   */
  function handleMoveClick(e) {
    try {
      const cell = e.target.closest('.lea-move-cell');
      if (!cell) return;
      /* data-orig-idx → getMoveNodes() içindeki gerçek konum */
      const origIdx = parseInt(cell.dataset.origIdx, 10);
      if (isNaN(origIdx)) return;
      const lichessMove = Array.from(getMoveNodes())[origIdx];
      if (lichessMove) {
        lichessMove.click();
        log('Hamle tıklandı (origIdx): ' + origIdx);
      }
    } catch (err) {
      log('handleMoveClick hatası: ' + err.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // GİRİŞ ANİMASYONLARI
  // ══════════════════════════════════════════════════════

  /**
   * Panel ilk gösterildiğinde tüm giriş animasyonlarını tetikler.
   * Sıralama: slide-in → eval bar → stats count-up → accuracy count-up → semboller.
   */
  function runEntryAnimations() {
    try {
      /* 1. Slide-in */
      const panel = getPanel();
      if (panel) panel.classList.add('lea-panel-enter');

      /* 2. Eval bar — başlangıç 50%, hedef gerçek değer */
      const evalBar = document.getElementById('lea-eval-bar');
      if (evalBar) {
        const targetW = evalBar.style.width;
        evalBar.style.width = '50%';
        requestAnimationFrame(() =>
          requestAnimationFrame(() => { evalBar.style.width = targetW; })
        );
      }

      /* 3. Stats count-up */
      setTimeout(() => refreshStatsDisplay(true), 100);

      /* 4. Accuracy count-up */
      setTimeout(() => {
        const wAcc = computeAccuracy('white');
        const bAcc = computeAccuracy('black');
        animateAccuracy(
          document.getElementById('lea-acc-white'),
          document.getElementById('lea-acc-bar-w'),
          wAcc, getAccuracyColor(wAcc)
        );
        animateAccuracy(
          document.getElementById('lea-acc-black'),
          document.getElementById('lea-acc-bar-b'),
          bAcc, getAccuracyColor(bAcc)
        );
      }, 200);

      /* 5. Kalite sembolü bounce — stagger */
      setTimeout(() => {
        document.querySelectorAll('.lea-move-symbol').forEach((el, i) => {
          if (el.textContent.trim()) {
            setTimeout(() => el.classList.add('lea-sym-enter'), i * 8);
          }
        });
      }, 350);

    } catch (e) {
      log('runEntryAnimations hatası: ' + e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // PANEL GÜNCELLEME
  // ══════════════════════════════════════════════════════

  /**
   * Bir DOM elementinin textContent'ini yalnızca değer değişmişse günceller.
   * @param {HTMLElement|null} el
   * @param {string} val
   */
  function setText(el, val) {
    if (el && el.textContent !== val) el.textContent = val;
  }

  /**
   * Mevcut panelin içeriğini animasyon olmadan günceller.
   * Her alan için eski↔yeni değer karşılaştırması yapılır;
   * değer aynıysa DOM'a dokunulmaz (eval/depth spam önleme).
   * Scroll konumu korunur (moves list resetlenmez).
   */
  function updatePanel() {
    if (!getPanel()) return;
    try {
      /* Eval */
      const score = getEvalScore();
      const depth = getDepth();
      const pct   = evalToPercent(score);

      setText(document.getElementById('lea-eval-score'), score);
      setText(document.getElementById('lea-eval-depth'), 'depth ' + depth);

      const barEl = document.getElementById('lea-eval-bar');
      if (barEl) {
        const newW = pct.toFixed(2) + '%';
        if (barEl.style.width !== newW) barEl.style.width = newW;
      }

      /* Best move */
      const pvArr = Array.from(getBestMovePV())
        .map((n) => n.textContent.trim()).filter(Boolean);
      setText(document.getElementById('lea-best-san'), pvArr[0] || '—');
      setText(document.getElementById('lea-best-pv'),  pvArr.slice(1, 5).join(' '));

      /* Stats — seçili tarafa göre güncelle */
      refreshStatsDisplay(false);

      /* Aktif hamle highlight — scroll konumunu koru */
      const allNodes = Array.from(getMoveNodes());
      const activeEl = getActiveMove();
      const activeOrigIdx = activeEl ? allNodes.indexOf(activeEl) : -1;

      document.querySelectorAll('#lea-moves-list .lea-move-cell').forEach((cell) => {
        const shouldBeActive = parseInt(cell.dataset.origIdx, 10) === activeOrigIdx;
        if (cell.classList.contains('lea-active') !== shouldBeActive) {
          cell.classList.toggle('lea-active', shouldBeActive);
        }
      });

      if (activeOrigIdx !== -1) {
        const activeCell = document.querySelector(
          `#lea-moves-list .lea-move-cell[data-orig-idx="${activeOrigIdx}"]`
        );
        if (activeCell) activeCell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      /* Accuracy — yalnızca değişince yaz */
      const wAcc = computeAccuracy('white');
      const bAcc = computeAccuracy('black');

      const wEl  = document.getElementById('lea-acc-white');
      const wBar = document.getElementById('lea-acc-bar-w');
      const bEl  = document.getElementById('lea-acc-black');
      const bBar = document.getElementById('lea-acc-bar-b');

      setText(wEl, wAcc + '%');
      setText(bEl, bAcc + '%');

      if (wBar) {
        const wW = wAcc + '%';
        const wC = getAccuracyColor(wAcc);
        if (wBar.style.width !== wW)           wBar.style.width = wW;
        if (wBar.style.backgroundColor !== wC) wBar.style.backgroundColor = wC;
      }
      if (bBar) {
        const bW = bAcc + '%';
        const bC = getAccuracyColor(bAcc);
        if (bBar.style.width !== bW)           bBar.style.width = bW;
        if (bBar.style.backgroundColor !== bC) bBar.style.backgroundColor = bC;
      }

    } catch (e) {
      log('updatePanel hatası: ' + e.message);
    }
  }

  /**
   * Hamle listesi HTML'ini yeniden inşa eder.
   * Yalnızca hamle sayısı değiştiğinde çağrılır.
   */
  function rebuildMoveList() {
    const listEl = document.getElementById('lea-moves-list');
    if (!listEl) return;
    try {
      const mainMoves = getMainLineMoves();
      const moveMap   = buildMoveMap();
      const activeEl  = getActiveMove();

      let html = '';
      for (let i = 0; i < mainMoves.length; i += 2) {
        const w    = mainMoves[i];
        const b    = mainMoves[i + 1] || null;
        const num  = Math.floor(i / 2) + 1;
        const wCls = moveMap.get(i)     || 'good';
        const bCls = moveMap.get(i + 1) || 'good';
        const wSan = getSAN(w.el);
        const bSan = b ? getSAN(b.el) : '';
        const wAct = w.el === activeEl           ? 'lea-active' : '';
        const bAct = b && b.el === activeEl      ? 'lea-active' : '';
        const wSym = SYMBOLS[wCls];
        const bSym = SYMBOLS[bCls];

        html += `<div class="lea-move-row">
          <span class="lea-move-num">${num}.</span>
          <div class="lea-move-cell ${wAct}" data-orig-idx="${w.origIdx}">
            <span class="lea-move-dot dot-${wCls}"></span>
            <span class="lea-move-name">${esc(wSan)}</span>
            ${wSym ? `<span class="lea-move-symbol">${wSym}</span>` : ''}
          </div>
          ${b
            ? `<div class="lea-move-cell ${bAct}" data-orig-idx="${b.origIdx}">
                 <span class="lea-move-dot dot-${bCls}"></span>
                 <span class="lea-move-name">${esc(bSan)}</span>
                 ${bSym ? `<span class="lea-move-symbol">${bSym}</span>` : ''}
               </div>`
            : '<div></div>'}
        </div>`;
      }

      /* innerHTML güncelleme — event handler listEl üzerinde olduğu için korunur */
      listEl.innerHTML = html || '<div class="lea-moves-empty">Analiz bekleniyor…</div>';
    } catch (e) {
      log('rebuildMoveList hatası: ' + e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // MUTATION OBSERVER
  // ══════════════════════════════════════════════════════

  /**
   * document.body'yi gözlemleyen MutationObserver'ı başlatır.
   * 300ms throttle ile çalışır.
   * - Panel yoksa: injectPanel() dener.
   * - Panel varsa ve hamle sayısı değiştiyse: rebuildMoveList() çağırır.
   * - Her durumda updatePanel() çağırır.
   */
  function startObserver() {
    if (observerInstance) {
      observerInstance.disconnect();
    }

    observerInstance = new MutationObserver(() => {
      if (updateThrottle) return;
      updateThrottle = setTimeout(() => {
        updateThrottle = null;
        try {
          if (!panelInjected || !getPanel()) {
            if (isAnalysisPage()) {
              /* toolsEl kaybolmuşsa (SPA nav) sıfırla */
              /* toolsEl veya wrapper kaybolmuşsa (SPA nav) sıfırla */
              if (toolsEl && !document.contains(toolsEl)) {
                toolsEl = null;
                panelInjected = false;
              }
              if (panelInjected && !document.getElementById('lea-inject-wrapper')) {
                panelInjected = false;
              }
              const ok = injectPanel();
              if (ok) log('Observer: panel yeniden enjekte edildi');
            }
            return;
          }

          const currentCount = getMainLineMoves().length;
          if (currentCount !== lastMoveCount) {
            lastMoveCount = currentCount;
            rebuildMoveList();
          }

          updatePanel();
        } catch (e) {
          log('Observer callback hatası: ' + e.message);
        }
      }, 300);
    });

    observerInstance.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log('Observer başlatıldı');
  }

  // ══════════════════════════════════════════════════════
  // SAYFA TESPİT
  // ══════════════════════════════════════════════════════

  /**
   * Mevcut sayfanın Lichess analiz/çalışma sayfası olup olmadığını belirler.
   * URL ve DOM varlığı kontrol edilir.
   * @returns {boolean}
   */
  function isAnalysisPage() {
    try {
      if (/\/(analysis|study)(\/|$)/.test(window.location.pathname)) return true;
      if (document.querySelector('.ceval') !== null)                  return true;
      if (document.querySelector('.analyse__moves') !== null)         return true;
    } catch (e) {
      log('isAnalysisPage hatası: ' + e.message);
    }
    return false;
  }

  // ══════════════════════════════════════════════════════
  // SPA NAVİGASYON İZLEME
  // ══════════════════════════════════════════════════════

  /**
   * Lichess'in SPA navigasyonunu izlemek için history.pushState'i patch eder.
   * Analiz sayfasına geçildiğinde panel enjeksiyonunu tetikler.
   */
  function watchNavigation() {
    const handleNav = () => {
      setTimeout(() => {
        if (isAnalysisPage() && !getPanel()) {
          panelInjected = false;
          log('SPA navigasyon: analiz sayfası tespit edildi');
          injectPanel();
          startObserver();
        }
      }, 1500);
    };

    /* pushState patch */
    const origPush = history.pushState.bind(history);
    history.pushState = function (...args) {
      origPush(...args);
      handleNav();
    };

    /* popstate (geri/ileri) */
    window.addEventListener('popstate', handleNav);
  }

  // ══════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════

  /**
   * Extension başlangıç noktası.
   * Analiz sayfasındaysa 1500ms sonra paneli enjekte eder ve observer'ı başlatır.
   * Değilse SPA navigasyonu izler.
   */
  function init() {
    log('Başlatılıyor… (' + window.location.pathname + ')');

    watchNavigation();

    if (isAnalysisPage()) {
      log('Analiz sayfası tespit edildi, 1500ms sonra enjeksiyon');
      setTimeout(() => {
        injectPanel();
        startObserver();
      }, 1500);
    } else {
      log('Analiz sayfası değil — navigasyon bekleniyor');
    }
  }

  /* DOMContentLoaded veya hazırsa direkt çalıştır */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── Debug yardımcısı: tarayıcı konsoluna leaDebug() yaz ── */
  window.leaDebug = function () {
    const probes = [
      ['l4x move (raw)',         () => document.querySelectorAll('l4x move').length],
      ['l4x > move (direct)',    () => document.querySelectorAll('l4x > move').length],
      ['getMoveNodes() sonuç',   () => getMoveNodes().length],
      ['getEvalScore()',          () => getEvalScore()],
      ['getDepth()',              () => getDepth()],
      ['getBestMovePV().length',  () => getBestMovePV().length],
      ['getOpeningName()',        () => getOpeningName()],
      ['.ceval bulundu',         () => !!document.querySelector('.ceval, ceval')],
      ['variation elemanları',   () => document.querySelectorAll('variation, kwdb, lines').length],
    ];
    console.group('[LEA] Debug raporu');
    probes.forEach(([label, fn]) => {
      try { console.log(label + ':', fn()); }
      catch (e) { console.log(label + ': HATA -', e.message); }
    });
    console.groupEnd();
  };

})();
