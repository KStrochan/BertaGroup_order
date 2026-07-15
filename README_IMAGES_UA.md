# Зображення товарів Berta HoReCa — версія 2

Цей патч замінює попередній завантажувач. Він шукає фотографії послідовно у:

1. Open Food Facts / Open Products Facts;
2. DuckDuckGo Images;
3. Bing Images.

Фото додається лише тоді, коли збігаються назва, бренд і фасування/вага/об’єм. Якщо точного збігу немає, сайт залишає стандартну іконку категорії.

## Що скопіювати в репозиторій

Скопіюйте в корінь `BertaGroup_order` зі збереженням папок:

```text
.github/workflows/fetch-product-images.yml
tools/fetch_product_images.py
requirements-images.txt
README_IMAGES_UA.md
```

Цей патч **не замінює** `products.json`, тому ваші останні товари, ціни, упаковки та видалені позиції не будуть перезаписані.

## Після копіювання

Зробіть commit і push. Далі в GitHub:

```text
Settings → Actions → General → Workflow permissions
```

Увімкніть:

```text
Read and write permissions
```

Потім:

```text
Actions → Fetch exact product images from internet → Run workflow
```

Параметри першого запуску:

```text
section: all
limit: 1000
min_score: 0.86
retry_unmatched: true
force: false
```

Після завершення workflow сам додасть знайдені WebP-фото, оновить `products.json`, сформує CSV-звіт і зробить commit. Render автоматично передеплоїть сайт.

## Важливе обмеження

Абсолютно всі 967 фотографій не можна гарантувати: частина позицій має скорочені внутрішні назви, не має штрихкодів або взагалі не представлена у відкритому інтернеті. Такі товари залишаться з іконкою — це безпечніше, ніж показати фото іншої фасовки.

## Права на зображення

Для Open Food Facts/Open Products Facts у звіті фіксується відкрита ліцензія. Для зображень із пошуку зберігаються сторінка-джерело та пряме посилання. Перед постійним комерційним використанням таких фото слід перевірити дозвіл виробника або власника сайту.
