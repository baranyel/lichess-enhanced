# Icons

Bu klasöre extension ikonlarını ekleyin:

| Dosya        | Boyut   | Kullanım                        |
|--------------|---------|---------------------------------|
| icon16.png   | 16×16   | Tarayıcı toolbar (küçük)        |
| icon48.png   | 48×48   | Extension yönetim sayfası       |
| icon128.png  | 128×128 | Chrome Web Store listeleme      |

## Hızlı Oluşturma

Herhangi bir SVG veya PNG'den şu araçlarla üretebilirsiniz:

```bash
# ImageMagick ile
convert source.png -resize 16x16   icon16.png
convert source.png -resize 48x48   icon48.png
convert source.png -resize 128x128 icon128.png
```

Veya online araç: https://favicon.io / https://www.pwabuilder.com/imageGenerator

İkon olmadan da extension çalışır — manifest.json'daki `"icons"` bölümünü
kaldırırsanız Chrome varsayılan ikon kullanır.
