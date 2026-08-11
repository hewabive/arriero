---
schema: 1
engine: vllm
primaryName: "--mm-encoder-fp8-scale-path"
title: "--mm-encoder-fp8-scale-path"
summary: Путь к JSON с заранее откалиброванными FP8-масштабами Q/K/V по слоям ViT. Переводит FP8-внимание энкодера из динамического режима в статический, снимая пофорвардный оверхед. Файл проверяется на существование при старте.
group: MultiModalConfig
related:
  - --mm-encoder-attn-dtype
  - --mm-encoder-attn-backend
  - --mm-encoder-fp8-scale-save-path
  - --mm-encoder-fp8-scale-save-margin
---

# --mm-encoder-fp8-scale-path

## Кратко

Второй шаг процесса «откалибровать один раз, использовать всегда» из `docs/features/quantization/fp8_vit_attn.md`. Первый шаг — прогон с `--mm-encoder-fp8-scale-save-path`, который наблюдает реальные amax и записывает масштабы в файл. Здесь этот файл читается, и динамическое наблюдение выключается: масштабы фиксированы.

Аргумент бесполезен и запрещён без `--mm-encoder-attn-dtype fp8`, и взаимоисключён с `--mm-encoder-fp8-scale-save-path` — сохранять можно только то, что наблюдается динамически.

## Оригинальная справка

```text
Path to a JSON file containing per-layer FP8 Q/K/V scales for ViT
encoder attention. When provided (with `mm_encoder_attn_dtype="fp8"`),
static scaling is used. When omitted, dynamic scaling is used.
```

## Паспорт аргумента

- Флаги: `--mm-encoder-fp8-scale-path`
- Группа argparse: `MultiModalConfig`
- Тип значения: путь к файлу (строка), допустим `None`
- Допустимые значения: путь к существующему JSON-файлу
- Значение по умолчанию: `None` — динамическое шкалирование
- Эффективное значение: не переопределяется; несуществующий файл, отсутствие `fp8` или совместное указание с save-path роняют старт
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_encoder_fp8_scale_path`
- Этап применения: валидация конфига (проверка существования файла) → построение слоёв внимания энкодера → `process_weights_after_loading`

## Что меняет в движке

**Валидация при сборке конфига.** `MultiModalConfig._validate_multimodal_config` делает три проверки:

1. без `mm_encoder_attn_dtype == "fp8"` → `'mm_encoder_fp8_scale_path' and 'mm_encoder_fp8_scale_save_path' require 'mm_encoder_attn_dtype' to be 'fp8'.`;
2. вместе с `mm_encoder_fp8_scale_save_path` → `'mm_encoder_fp8_scale_save_path' cannot be used with 'mm_encoder_fp8_scale_path' (saving requires dynamic scaling).`;
3. файл должен существовать: `Path(...).is_file()`, иначе `FileNotFoundError: FP8 scale file not found: <path>`. Это происходит **до** загрузки весов.

**Выбор режима.** `MultiModalEncoderAttention._init_fp8_attn`: `self._fp8_dynamic_scale = mm_cfg.mm_encoder_fp8_scale_path is None`. При заданном пути буферы истории amax не регистрируются вообще — динамики нет.

**Загрузка масштабов.** `process_weights_after_loading` вызывает `_load_fp8_scales_file(path)` (результат кэшируется через `functools.cache`, поэтому файл читается один раз на процесс) и заполняет буферы `_fp8_q_scale` / `_fp8_k_scale` / `_fp8_v_scale`. Масштаб ровно `1.0` дополнительно взводит `skip_scale_*`, что убирает лишнее умножение.

Если для слоя нет записи, старт падает: `FP8 attention enabled but scales not found for layer '<name>' in <path>. Available layers: [...]` — то есть файл должен покрывать **все** слои внимания ViT данной модели.

**Кэш компиляции.** Путь входит в `MultiModalConfig.compute_hash()`, поэтому смена файла даёт другой ключ кэша графа.

## Значения и формат

Формат файла (из апстрим-документации и загрузчика):

```json
{
    "visual.blocks.0.attn.attn": {"q": 224.0, "k": 198.0, "v": 210.0},
    "visual.blocks.1.attn.attn": {"q": 218.0, "k": 195.0, "v": 207.0}
}
```

- Ключ верхнего уровня — имя слоя (`layer_name`), совпадающее с тем, под которым слой зарегистрирован в модели.
- Допускается обёртка `{"layers": {...}}` — загрузчик её разворачивает.
- Имена `q_scale` / `k_scale` / `v_scale` принимаются как синонимы `q` / `k` / `v`.
- Значения — положительные числа; ноль или отрицательное дают `FP8 scales must be positive, got q=..., k=..., v=... for layer '<name>'`.
- Запись, у которой нет всех трёх компонент, молча пропускается — и слой потом не найдётся при загрузке весов.
- Путь берётся как есть (относительный разрешается от рабочего каталога процесса). На управляемом сервере надёжнее абсолютный.

## Когда использовать

- Продакшн-эксплуатация FP8-внимания ViT: динамическое шкалирование стоит немного, но постоянно; статические масштабы этот оверхед снимают. Апстрим прямо рекомендует этот путь как основной.
- Когда нужна воспроизводимость численных результатов между запусками: динамика зависит от порядка запросов, статика — нет.
- Не используйте файл, откалиброванный на другой модели или другом чекпоинте: имена слоёв не совпадут, и старт упадёт.
- Не бойтесь использовать файл, откалиброванный на другом датасете: апстрим показывает, что калибровка на VisionArena-Chat сохраняет точность BF16 на ChartQA — именно за счёт запаса `--mm-encoder-fp8-scale-save-margin`.

## Влияние на производительность и память

- **Latency энкодера.** Убирает пофорвардное обновление масштабов по кольцевому буферу amax. Это и есть весь смысл аргумента.
- **VRAM.** Немного меньше, чем в динамике: буферы истории amax (по 16 float32 на каждый из Q/K/V на слой) не регистрируются.
- **CUDA graphs.** Статические масштабы снимают ограничение динамики, несовместимой с полными CUDA graphs ViT.
- **Время старта.** Добавляется чтение и разбор JSON — величина пренебрежимая; проверка существования файла происходит до загрузки весов, поэтому опечатка в пути обнаруживается быстро.
- **Точность.** По апстрим-замерам на ChartQA статические масштабы с дефолтным запасом совпадают с BF16 и с динамикой в пределах шума.

## Взаимодействие с другими аргументами

- `--mm-encoder-attn-dtype`: обязательное условие (`fp8`).
- `--mm-encoder-attn-backend`: файл масштабов не отменяет требований к backend'у — по-прежнему нужен `FLASHINFER` или `ROCM_AITER_FA`.
- `--mm-encoder-fp8-scale-save-path`: взаимоисключающий аргумент; сохранение требует динамики.
- `--mm-encoder-fp8-scale-save-margin`: применяется на этапе сохранения; при чтении готового файла уже учтён в записанных числах и повторно не применяется.

## Типовые проблемы и диагностика

- **Симптом:** `FileNotFoundError: FP8 scale file not found: /path/scales.json` **Причина:** путь неверен или файл недоступен процессу. **Лечение:** абсолютный путь и права на чтение.
- **Симптом:** `FP8 attention enabled but scales not found for layer 'visual.blocks.7.attn.attn' in <path>. Available layers: [...]` **Причина:** файл неполный или откалиброван на другой модели. **Лечение:** перекалибровать на нужном чекпоинте.
- **Симптом:** `'mm_encoder_fp8_scale_save_path' cannot be used with 'mm_encoder_fp8_scale_path' (saving requires dynamic scaling).` **Причина:** заданы оба флага. **Лечение:** оставить один — калибровка и эксплуатация это разные запуски.
- **Симптом:** `FP8 scales must be positive, got q=0.0, ...` **Причина:** битый файл. **Лечение:** перекалибровать.
- **Симптом:** качество просело после перехода на статику. **Причина:** калибровочный набор не покрывал реальные активации. **Лечение:** перекалибровать на репрезентативных данных или увеличить `--mm-encoder-fp8-scale-save-margin`.
- **Подтверждение принятого значения:** `Loaded FP8 attention scales from <path> (N layers)` (info, один раз). Если вместо неё видно `FP8 attention enabled with dynamic scaling (no scale file provided).` — путь не применился.

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8 --mm-encoder-fp8-scale-path /models/scales/qwen3vl-8b-vit.json
```

```bash
vllm serve /models/Qwen3-VL-30B-A3B-Instruct --mm-encoder-attn-backend ROCM_AITER_FA --mm-encoder-attn-dtype fp8 --mm-encoder-fp8-scale-path /models/scales/qwen3vl-30b-vit.json
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/model_executor/layers/attention/mm_encoder_attention.py`
- `vllm/docs/features/quantization/fp8_vit_attn.md`
