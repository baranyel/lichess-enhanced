# Lichess Enhanced — Yapılacaklar Listesi

## Proje
Chrome extension, Lichess analiz sayfasına chess.com tarzı panel ekliyor.
Repo: https://github.com/baranyel/lichess-enhanced

---

## Mevcut Durum (yarım kalan)

### Çalışıyor ✅
- Panel `.analyse__tools` içine yerleşiyor (orijinal içerik gizli, DOM'da koruluyor)
- Hamle listesi doğru (placeholder "..." filtreleniyor)
- Beyaz/Siyah taraf seçici (gauge'a tıklama)
- Stat hücrelerine tıklayınca o kategorinin hamlelerine sırayla gitme
- `getMoveNodes()` varyant hamlelerini dışlıyor
- Observer + throttle ile canlı güncelleme
- Animasyonlar (count-up, slide-in, badge bounce)

### Eksik / Yarım ❌

#### 1. `buildPanelHTML()` — CHESS.COM TARZI REDESIGN (yarım kaldı)
Mevcut HTML hâlâ eski yapıda. Aşağıdaki yeni tasarıma taşınması lazım:

**Yeni bölüm sırası:**
```
Header
Opening (varsa)
Eval Card:
  └── Skor (+1.4) + eval bar + depth
  └── Best move strip (EN İYİ tag | Nf3 san | d5 Bb5+ pv | ±0.3 cp)
Accuracy Gauges (= taraf seçici):
  └── SVG arc gauge x2 (♔ Beyaz | ♚ Siyah) — tıklanabilir
Stats Grid:
  └── 3x2 grid, her hücre: [icon + number] / [label]
  └── Tıklanınca o kategoride sıradaki hamleye git
Move List:
  └── Numara | Beyaz hamle | Siyah hamle
  └── Kalite badge'i sağda (yuvarlak renkli daire, sembolle)
Footer
```

**Gauge SVG kodları zaten content.js'de var:**
- `buildGaugeSVG(suffix, symbol)` — SVG string döndürür
- `animateGauge(suffix, pct, color, duration)` — animasyonlu doldurma
- `setGauge(suffix, pct, color)` — animasyonsuz set

**Sabitleri de var:**
```js
QUALITY_ICONS  = { best:'⚡', excellent:'✦', good:'●', inaccuracy:'▲', mistake:'?', blunder:'✕' }
QUALITY_LABELS = { best:'Mükemmel', excellent:'Harika', good:'İyi', ... }
GAUGE_R=32, GAUGE_C≈201.06, GAUGE_ARC≈150.80
```

**Yapılacak:**
- `buildPanelHTML()` içindeki eski HTML'i yeni yapıya çevir
- Stat hücreleri: `<div class="lea-stat-top"><span icon/><span number/></div><div label/>`
- Move cell'leri: `.lea-move-dot` kaldır → sağda `.lea-move-badge badge-{cls}` ekle
- `<div class="lea-accuracy-section">` içine gauge SVG'lerini koy (eski bar sistemi kaldır)
- Side selector butonlarını kaldır (gauge'lar onun görevi artık)

#### 2. `attachPanelEvents()` — gauge click handler
Şu an `.lea-side-selector` dinliyor. Değiştirilmeli:
```js
// ESKİ (kaldır):
const sideSelector = document.querySelector('.lea-side-selector');

// YENİ (ekle):
const accuracySec = document.querySelector('.lea-accuracy-section');
accuracySec.addEventListener('click', e => {
  const card = e.target.closest('.lea-gauge-card');
  if (!card) return;
  const side = card.dataset.side;
  // ... selectedSide güncelle, gauge active class toggle, refreshStatsDisplay
});
```

#### 3. `runEntryAnimations()` — accuracy animasyonu güncelle
```js
// ESKİ kaldır:
animateAccuracy(wEl, wBar, wAcc, ...) // bar sistemi

// YENİ:
animateGauge('w', computeAccuracy('white'), getAccuracyColor(...));
animateGauge('b', computeAccuracy('black'), getAccuracyColor(...));
```

#### 4. `updatePanel()` — accuracy güncelleme
```js
// ESKİ kaldır: wEl.textContent, wBar.style.width vs

// YENİ:
setGauge('w', computeAccuracy('white'), getAccuracyColor(...));
setGauge('b', computeAccuracy('black'), getAccuracyColor(...));
```

#### 5. `rebuildMoveList()` — badge sistemi
Eski `.lea-move-dot` + `.lea-move-symbol` yerine:
```html
<!-- ESKİ -->
<span class="lea-move-dot dot-${cls}"></span>
<span class="lea-move-symbol">${sym}</span>

<!-- YENİ -->
${cls !== 'good' ? `<span class="lea-move-badge badge-${cls}">${BADGE_SYMBOLS[cls]}</span>` : ''}
```
`BADGE_SYMBOLS` tanımı: `{ best:'⚡', excellent:'!', inaccuracy:'?!', mistake:'?', blunder:'✕' }`

---

## Bilinen Sorunlar

### Selector sorunları (Lichess DOM'una bağlı)
- `getEvalScore()` — hâlâ 0.0 dönüyor (ceval selector'ları tutmuyor olabilir)
- `getDepth()` — hâlâ `--` (aynı sebep)
- `getBestMovePV()` — `—` dönüyor
- **Debug için:** Lichess analiz sayfasında konsola `leaDebug()` yaz, sonucu incele
- Gerçek class isimlerini bul, `getEvalScore/getDepth/getBestMovePV` içine ekle

### Hamle kalite sınıflandırması
- `classifyMove()` Lichess'in `<glyph>` elementine bakıyor
- Eğer glyphlar yoksa tüm hamleler 'good' sayılıyor
- Lichess glyph element adını `leaDebug()` ile doğrula

---

## Devam Etmek İçin

```bash
cd ~/Documents/lichess  # veya nereye clone ettiysen
git clone https://github.com/baranyel/lichess-enhanced
cd lichess-enhanced
# VS Code / Cursor ile aç
# Chrome: chrome://extensions → Geliştirici modu → Paketlenmemiş yükle
```

Claude Code'a söyle:
> "lichess-enhanced reposunu çek, TODO.md'deki maddeleri sırayla tamamla.
>  Özellikle buildPanelHTML chess.com redesign'ı, gauge animasyonları ve
>  selector sorunlarını fix et."

---

## Referans Linkler
- Lichess analiz sayfası: https://lichess.org/analysis
- Chess.com analiz görünümü için referans alınacak tasarım
- `leaDebug()` — konsola yaz, DOM durumunu görürsün
