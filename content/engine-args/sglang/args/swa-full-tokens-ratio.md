---
schema: 1
engine: sglang
primaryName: "--swa-full-tokens-ratio"
title: "--swa-full-tokens-ratio"
summary: Отношение размера KV-пула SWA-слоев к пулу full-attention слоев на гибридных моделях. Задает раскладку одного и того же бюджета VRAM между двумя пулами; на не-гибридных моделях не используется.
group: schedule
related:
  - --disable-hybrid-swa-memory
  - --mem-fraction-static
  - --max-running-requests
  - --page-size
  - --disable-radix-cache
  - --chunked-prefill-size
  - --enable-hierarchical-cache
  - --context-length
---

# --swa-full-tokens-ratio

## Кратко

У гибридных моделей часть слоев работает с полным вниманием, часть — со скользящим окном. SGLang держит для них два раздельных KV-пула, и `--swa-full-tokens-ratio` задает, сколько токенов в SWA-пуле приходится на токен full-пула. Это не «доля памяти» и не число слоев: коэффициент применяется к количеству токенов независимо от того, сколько в модели swa- и full-слоев.

## Оригинальная справка

```text
The ratio of SWA layer KV tokens / full layer KV tokens, regardless of the number of swa:full layers. It should be between 0 and 1. E.g. 0.5 means if each swa layer has 50 tokens, then each full layer has 100 tokens.
```

## Паспорт аргумента

- Флаги: `--swa-full-tokens-ratio`
- Группа: `schedule`
- Тип значения: число с плавающей точкой
- Допустимые значения: полуинтервал `(0, 1.0]`; проверяется уже **разрешенное** значение, `ValueError: --swa-full-tokens-ratio should be in range (0, 1.0].`
- Значение по умолчанию: `0.8`
- Эффективное значение: переопределяется по архитектуре модели, но только если вы оставили умолчание (сравнение с `ServerArgs.swa_full_tokens_ratio`): DeepSeek V4 → `0.1`, Inkling → `0.1`. Для `Step3p5ForCausalLM` вместе с `--enable-hierarchical-cache` значение безусловно сбрасывается в `1.0` и одновременно включается `disable_hybrid_swa_memory`. Кроме того, коэффициент полностью игнорируется двумя конфигураторами пулов — см. ниже
- Где объявлен: `ServerArgs.swa_full_tokens_ratio`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`
- Этап применения: `__post_init__` (переопределения и валидация) → расчет размеров KV-пулов при инициализации model runner

## Что меняет в движке

Аргумент читают конфигураторы пулов (`sglang/python/sglang/srt/model_executor/pool_configurator.py`).

**`HybridSWAPoolConfigurator` — основной путь.** Коэффициент входит в оценку «байт на токен»:

```
cell_size = full_per_token * full_layers + ratio * swa_per_token * swa_layers  (+ слагаемые draft-модели)
```

затем `max_total_num_tokens = available_bytes // cell_size`, и пулы получают размеры

```
full_tokens = align_page_size(max_total_num_tokens)
swa_tokens  = align_page_size(int(full_tokens * ratio))
```

Оба размера выравниваются вниз по `--page-size`. `max_total_num_tokens`, который вы видите в логе и по которому планировщик считает допуск, — это размер **full**-пула.

**Модели без full-слоев (all-SWA).** Коэффициент не применяется вовсе: `max_total_num_tokens` равен размеру SWA-пула, соотносить его не с чем.

**`SWAChunkCapPoolConfigurator` — коэффициент игнорируется.** Он выбирается вместо основного, когда одновременно заданы `--max-running-requests`, `--disable-radix-cache`, `--chunked-prefill-size`, у модели есть скользящее окно и есть хотя бы один full-слой. Тогда SWA-пул считается «в обрез» по худшему случаю на запрос (окно + интервал вытеснения + запас на decode), а вся оставшаяся память отдается full-пулу. Ваш `--swa-full-tokens-ratio` в этой конфигурации не влияет ни на что.

**`DSV4PoolConfigurator`** (DeepSeek V4) использует коэффициент в собственной, более сложной раскладке на четыре пула.

Защита от слишком маленького SWA-пула: если `sliding_window_size + page_size >= swa_tokens`, старт падает с сообщением, что пул не вмещает даже один запрос, и предлагает увеличить `--swa-full-tokens-ratio` или общий бюджет KV.

Гибридным считается ограниченный список архитектур (`is_hybrid_swa_model` в `sglang/python/sglang/srt/configs/model_config.py`): Llama 4, DeepSeek V4, GPT-OSS, MiMo V2, Step3p5/Step3p7, Gemma 4, Laguna, Mellum, Inkling, UnlimitedOCR — плюс любые модели, объявившие `is_hybrid_swa` в своем HF-конфиге.

## Значения и формат

- Дробь в интервале `(0, 1.0]`. `1.0` означает «SWA-пул такого же размера в токенах, что и full-пул» — максимум емкости SWA, максимум расхода памяти.
- `0.8` (умолчание) — SWA-пул на 20% меньше full-пула по токенам.
- Малые значения (`0.1` для DeepSeek V4 и Inkling) уместны там, где SWA-слоев много, окно короткое, и держать длинную историю в них не нужно.
- `0` и отрицательные значения отвергаются валидацией; значения больше `1.0` — тоже.
- Проверяется разрешенное значение, поэтому ошибка может возникнуть и из-за архитектурного переопределения, а не только из-за вашего ввода.

## Когда использовать

- Модель гибридная, и при старте видно, что SWA-пул стал узким местом (ошибка «SWA pool … cannot hold even one request» или ранние retraction при незанятом full-пуле) — повышайте коэффициент.
- Наоборот, при коротком окне и длинных контекстах имеет смысл понижать: освободившаяся память уйдет в full-пул и увеличит `max_total_num_tokens`, то есть конкурентность.
- Не трогайте на не-гибридных моделях: значение не читается.
- Не трогайте, если сработал `SWAChunkCapPoolConfigurator` (см. выше) — там раскладку определяет `--max-running-requests`.

## Влияние на производительность и память

- Прямо перераспределяет VRAM между двумя пулами внутри бюджета, заданного `--mem-fraction-static`; суммарный объем KV не меняется.
- Понижение коэффициента увеличивает `max_total_num_tokens` (full-пул) и, значит, число одновременно обслуживаемых запросов — но повышает риск того, что SWA-пул станет ограничителем и начнет провоцировать retraction.
- Повышение стабилизирует SWA-часть ценой меньшей общей конкурентности.
- На время старта и на RAM хоста влияния нет.
- Оба размера выравниваются вниз по `--page-size`, так что при крупных страницах фактическое отношение может немного отличаться от заданного.

## Взаимодействие с другими аргументами

- `--disable-hybrid-swa-memory`: отключает гибридный пул целиком — коэффициент перестает применяться.
- `--mem-fraction-static`: задает общий бюджет, который этот коэффициент делит.
- `--max-running-requests` + `--disable-radix-cache` + `--chunked-prefill-size`: эта тройка на модели со скользящим окном переключает раскладку на `SWAChunkCapPoolConfigurator`, где коэффициент не используется.
- `--page-size`: выравнивание размеров обоих пулов.
- `--enable-hierarchical-cache`: для `Step3p5ForCausalLM` принудительно выставляет коэффициент в `1.0` и отключает гибридный пул.
- `--context-length`: определяет, сколько токенов нужно одному запросу, и тем самым — достаточен ли SWA-пул.

## Типовые проблемы и диагностика

- `ValueError: SWA pool (… tokens) cannot hold even one request: the prefill admission floor is sliding_window_size (…) + page_size (…). Increase --swa-full-tokens-ratio or the total KV budget.` — коэффициент слишком мал для окна модели.
- `ValueError: --swa-full-tokens-ratio should be in range (0, 1.0].` — значение вне допустимого интервала (в том числе после архитектурного переопределения).
- Строка при старте `Use sliding window memory pool. full_layer_tokens=…, swa_layer_tokens=…` подтверждает фактическую раскладку; для all-SWA моделей вместо нее печатается `Use sliding window memory pool (all SWA). swa_layer_tokens=…`.
- Предупреждения `Reset swa_full_tokens_ratio to 1.0 for Step3p5ForCausalLM model with hierarchical cache` и `Setting swa_full_tokens_ratio to 0.1 for …` показывают архитектурные переопределения.
- `RuntimeError: SWA pool cap (… tokens, … GiB) leaves no room for the full KV pool …` — вы попали в путь `SWAChunkCapPoolConfigurator`; лечится уменьшением `--max-running-requests` или ростом `--mem-fraction-static`, а не этим коэффициентом.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/gpt-oss-120b --swa-full-tokens-ratio 0.5 --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/gpt-oss-120b --swa-full-tokens-ratio 1.0 --page-size 64 --chunked-prefill-size 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
