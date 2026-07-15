# Автоматичне додавання фотографій товарів Berta HoReCa

Цей патч додає до сайту:

- підтримку фотографій у картках товарів;
- автоматичний пошук **лише точних збігів**;
- завантаження та оптимізацію фотографій у формат WebP;
- автоматичне повернення до іконки категорії, якщо фото не знайдено або збіг сумнівний;
- звіт із джерелом, оцінкою збігу та штрихкодом;
- файл атрибуції для використаних зображень.

## Безпечне джерело фотографій

Скрипт використовує Open Food Facts для Food і Open Products Facts для NONFood. Зображення цих баз поширюються за відкритою ліцензією CC BY-SA 3.0. Випадкові фотографії з інтернет-магазинів скрипт не копіює.

## Які файли додати в GitHub

Скопіюйте в корінь репозиторію зі збереженням папок:

```text
.github/workflows/fetch-product-images.yml
tools/fetch_product_images.py
requirements-images.txt
public/index.html
public/styles.css
public/app.js
public/data/products.json
public/images/products/.gitkeep
```

Після завантаження зробіть Commit changes.

## Дозвіл GitHub Actions на автоматичний commit

У репозиторії відкрийте:

```text
Settings → Actions → General → Workflow permissions
```

Виберіть:

```text
Read and write permissions
```

Натисніть **Save**.

## Запуск пошуку всіх фотографій

1. Відкрийте вкладку **Actions**.
2. Виберіть **Fetch verified product images**.
3. Натисніть **Run workflow**.
4. Для першого запуску встановіть:

```text
section: all
limit: 1000
min_score: 0.82
retry_unmatched: false
force: false
```

5. Натисніть зелену кнопку **Run workflow**.

Повний прохід може тривати від 20 хвилин до кількох годин залежно від швидкості відкритих каталогів. Після завершення workflow сам зробить commit, а Render автоматично оновить сайт.

## Як перевірити результат

Після виконання з'являться:

```text
public/images/products/*.webp
public/data/image-attribution.json
public/data/image-fetch-state.json
reports/product-image-report.csv
```

У звіті статуси означають:

- `matched` — сильний збіг назви, бренду та фасування, фото додано;
- `no_match` — точного збігу немає, на сайті залишається іконка;
- `error` — тимчасова мережева помилка; такий товар перевіриться під час наступного запуску.

## Повторний запуск

Скрипт пропускає вже перевірені товари. Для повторної перевірки позицій зі статусом `no_match` увімкніть:

```text
retry_unmatched: true
```

Знижувати `min_score` нижче `0.78` не рекомендовано — зростає ризик підставити фото іншої фасовки.

## Резервна копія

Кожен запуск також створює ZIP-артефакт у GitHub Actions. Він доступний у нижній частині сторінки завершеного workflow протягом 14 днів.
