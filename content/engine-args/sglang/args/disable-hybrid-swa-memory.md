---
schema: 1
engine: sglang
primaryName: "--disable-hybrid-swa-memory"
title: "--disable-hybrid-swa-memory"
summary: Заставляет модель со смешанным вниманием (часть слоев со скользящим окном) хранить KV так, будто все слои полноконтекстные. Резко уменьшает емкость пула и включается только как обход поломки.
group: schedule
related:
  - --swa-full-tokens-ratio
  - --mem-fraction-static
  - --max-total-tokens
  - --max-running-requests
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --chunked-prefill-size
  - --attention-backend
---

# --disable-hybrid-swa-memory

## Кратко

У ряда моделей часть слоев внимания работает со скользящим окном (SWA), а часть — с полным контекстом. Гибридный пул хранит для SWA-слоев только окно, а не всю последовательность, и за счет этого умещает в ту же VRAM в разы больше токенов. `--disable-hybrid-swa-memory` это отключает: пул считается так, будто все слои полноконтекстные. Флаг существует не как настройка производительности, а как аварийный выключатель — и для нескольких архитектур движок выставляет его сам, потому что там гибридный пул еще не поддержан.

## Оригинальная справка

```text
Disable the hybrid SWA memory pool.
```

## Паспорт аргумента

- Флаги: `--disable-hybrid-swa-memory`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false` — гибридный пул используется там, где архитектура его поддерживает
- Эффективное значение: принудительно `true` для Gemma2/Gemma3/Gemma3n, для Exaone4/ExaoneMoE с непустым `sliding_window_pattern`, для Olmo2 и для Step3p5 при включенном `--enable-hierarchical-cache` (все — реестр переопределений `arg_groups/overrides.py`, каждое с предупреждением в логе)
- Где объявлен: `ServerArgs.disable_hybrid_swa_memory`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение `ModelConfig` (`_derive_hybrid_model`) → выбор конфигуратора пула и типа кеша префиксов

## Что меняет в движке

Флаг участвует ровно в одном присваивании:

```python
self.is_hybrid_swa = is_hybrid_swa_model(architectures, hf_text_config) and not self.disable_hybrid_swa_memory
```

`is_hybrid_swa_model` перечисляет архитектуры явным списком — Llama4, DeepSeek V4 (все варианты), GPT-OSS, MiMo V2, Step3p5/Step3p7, Gemma4, Laguna (только при непустом `sliding_window`), Mellum, Inkling, UnlimitedOCR. Для всех остальных моделей флаг ничего не делает.

Дальше `is_hybrid_swa` определяет весь путь памяти:

- **конфигуратор пула**: `HybridSWAPoolConfigurator` вместо `DefaultPoolConfigurator`. Гибридный считает `cell_size` как «полные слои × байт на токен + `--swa-full-tokens-ratio` × SWA-слои × байт на токен», раскладывает бюджет на два под-пула и печатает `Use sliding window memory pool. full_layer_tokens=…, swa_layer_tokens=…`. Обычный конфигуратор считает все слои полными, поэтому та же VRAM дает существенно меньше токенов;
- **тип кеша префиксов**: `SWAChunkCache`/`PureSWAChunkCache` вместо `ChunkCache` при `--disable-radix-cache`, `PureSWARadixCache` или унифицированное radix-дерево вместо обычного;
- **планирование**: `PrefillAdder` ведет отдельный бюджет SWA-токенов (`rem_swa_tokens`), а scheduler сбрасывает `batch_is_full` перед каждым проходом, чтобы дать шанс освобождению окна.

Отключение гибридного пула не меняет корректность вывода — маскирование окна выполняется в ядрах внимания. Меняется только то, сколько KV движок обязан хранить.

## Значения и формат

- Флаг без значения; «не задан» означает «использовать гибридный пул там, где он поддерживается».
- Обратного флага нет: включить гибридный пул на архитектуре, которой нет в списке, или там, где реестр переопределений его отключил, невозможно.
- Задание флага на модели без смешанного внимания не является ошибкой и ничего не меняет.

## Когда использовать

- Как обход бага: если на поддерживаемой архитектуре гибридный пул дает неверный вывод или падение, флаг возвращает простую раскладку ценой емкости.
- Для сравнения при отладке емкости: с флагом и без него на одной конфигурации хорошо видно, сколько именно токенов дает гибридная раскладка.
- Не включайте ради «стабильности» на рабочем сервере: цена — кратное падение `max_total_num_tokens`, а вместе с ним и конкурентности.
- Не пытайтесь им лечить `SWA pool (…) cannot hold even one request`: правильные ручки — `--swa-full-tokens-ratio` и общий бюджет KV.

## Влияние на производительность и память

- VRAM: главный эффект. Отключение гибридного пула увеличивает `cell_size` до «все слои полные», и `max_total_num_tokens` падает пропорционально доле SWA-слоев в модели.
- RAM хоста: косвенно — host-пул HiCache считается от device-пула.
- Время старта: не меняется.
- Throughput: падает вслед за емкостью пула — раньше начинаются ретракты.
- Latency: прямого влияния нет.

## Взаимодействие с другими аргументами

- `--swa-full-tokens-ratio`: работает только при включенном гибридном пуле; задает соотношение SWA- и full-токенов.
- `--mem-fraction-static`, `--max-total-tokens`: определяют общий бюджет, который раскладывается по под-пулам.
- `--max-running-requests` + `--disable-radix-cache` + `--chunked-prefill-size`: при включенном гибридном пуле эта тройка активирует точный расчет SWA-пула по кэпу; с отключенным гибридным пулом ветка недоступна.
- `--enable-hierarchical-cache`: для Step3p5 сам выставляет этот флаг (и `--swa-full-tokens-ratio 1.0`).
- `--attention-backend`: у гибридных архитектур список допустимых backend'ов свой и проверяется отдельно; этот флаг его не расширяет.

## Типовые проблемы и диагностика

- Предупреждение `Disable hybrid SWA memory for <arch> as it is not yet supported.` — сработало переопределение реестра, ваш выбор здесь ни при чем.
- `max_total_num_tokens` неожиданно мал на модели со скользящим окном — проверьте, не выставлен ли флаг (вами или реестром).
- Отсутствие строки `Use sliding window memory pool. full_layer_tokens=…, swa_layer_tokens=…` при поддерживаемой архитектуре означает, что гибридный пул выключен.
- Строка `Hybrid SWA model detected. architectures=…` печатается только когда гибридный режим реально активен.
- Принятое значение флага — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/gpt-oss-20b --disable-hybrid-swa-memory
```

```bash
python -m sglang.launch_server --model-path /models/gpt-oss-20b --disable-hybrid-swa-memory --mem-fraction-static 0.9
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
