---
schema: 1
engine: sglang
primaryName: "--language-model-only"
title: "--language-model-only"
summary: Запускает мультимодальный чекпоинт как чисто текстовую модель: энкодер не строится и его веса не грузятся, освободившаяся VRAM уходит в KV-кеш, а запросы с картинками отклоняются. Сегодня поддержана ровно одна архитектура — `MuseGlimmerForConditionalGeneration`.
group: disagg
related:
  - --language-only
  - --encoder-only
  - --disaggregation-mode
  - --enable-prefix-mm-cache
  - --enable-broadcast-mm-inputs-process
  - --mm-enable-dp-encoder
  - --mem-fraction-static
---

# --language-model-only

## Кратко

Флаг для случая «у меня VLM-чекпоинт, но нужна от него только языковая часть». Vision tower не создается вообще (не «создается и простаивает»), его веса не читаются, освободившаяся VRAM достается KV-кешу. Мультимодальный процессор не инициализируется, запросы с изображениями отклоняются на входе.

Несмотря на группу `disagg`, это **не** режим дизагрегации: `--language-only` — половина схемы encoder/decoder, где энкодер работает отдельным сервисом и присылает признаки, а `--language-model-only` — самостоятельный однопроцессный режим без энкодера в принципе.

Ограничение, которое надо знать до планирования: список поддерживаемых архитектур в коде состоит из одного элемента — `MuseGlimmerForConditionalGeneration`. На любом другом чекпоинте старт падает с `ValueError`.

## Оригинальная справка

```text
Skip the multimodal encoder entirely: its weights are never loaded and the tower is never built, freeing that GPU memory for KV cache. Multimodal requests are rejected. Unlike --language-only this is a standalone mode, not part of encoder/decoder disaggregation.
```

## Паспорт аргумента

- Флаги: `--language-model-only`
- Группа: `disagg`
- Тип значения: булев флаг (`store_true`, парного `--no-*` нет)
- Допустимые значения: наличие флага
- Значение по умолчанию: `False`
- Эффективное значение: `False`, если флаг не задан, но **сам чекпоинт может включить режим за вас** — `ModelConfig` пишет `hf_config.language_model_only = language_model_only or self.is_lm_only`, где `is_lm_only` читается из конфига чекпоинта. Флаг умеет только включать режим, выключить объявленный чекпоинтом нельзя
- Где объявлен: `ServerArgs.language_model_only`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но с жестким списком поддерживаемых архитектур
- Этап применения: `__post_init__` → `_handle_language_model_only()` (валидация) → `ModelConfig` → инициализация tokenizer/processor → построение модели → warmup → отбраковка запросов в `TokenizerManager`

## Что меняет в движке

Валидация в `_handle_language_model_only` выполняется до всего остального и отклоняет несовместимые комбинации (см. «Взаимодействие»), а затем сверяет архитектуру чекпоинта с константой `LANGUAGE_MODEL_ONLY_ARCHITECTURES`.

Дальше режим протекает в четыре слоя:

- **Конфиг модели.** `hf_config.language_model_only` выставляется в `True`. Побочный эффект: `model_is_mrope` становится `False` — M-RoPE отключается, потому что позиционная схема мультимодального чекпоинта без энкодера не нужна.
- **Токенизатор и процессор.** `TokenizerManager.init_tokenizer_and_processor` заходит в мультимодальную ветку только при `is_multimodal and not language_model_only`, поэтому `get_processor_wrapper` не вызывается и процессоры не импортируются. Отдельно `hf_transformers/processor.py` для чекпоинтов с `language_model_only=True` возвращает `AutoTokenizer` вместо мультимодального процессора. `Scheduler` по той же причине не поднимает `_mm_processor` для M-RoPE-фолбэка.
- **Модель.** В `MuseGlimmerForConditionalGeneration.__init__` при включенном режиме `builds_vision_tower = False`, а `vision_tower`, `vision_adapter`, `vision_projection` и `perception_emb_norm` остаются `None` — конструктор выходит до их создания. В `forward` берется текстовая ветка с обычным `get_input_embeddings()`.
- **HTTP-слой.** Прогрев остается на текстовом пути: `is_vlm` в `http_server.py` требует `not language_only and not language_model_only`, так что стартовый запрос не пытается прогреть картинками.

Запрос с мультимодальным вводом отклоняется в `TokenizerManager` до токенизации: `Multimodal inputs are not supported when --language-model-only is set; the encoder is not loaded. Restart without the flag.`

## Значения и формат

- Флаг без значения. Не задан = обычный мультимодальный запуск.
- Отсутствие флага не гарантирует мультимодальность: чекпоинт с `language_model_only: true` в конфиге включит режим сам.
- Явно выключить режим для такого чекпоинта нечем — комментарий в `ModelConfig` объясняет почему: запись значения по умолчанию обратно построила бы vision tower, для которого в чекпоинте нет весов.

## Когда использовать

- Есть Muse Glimmer VLM-чекпоинт, а нагрузка чисто текстовая: снимаете вес энкодера с VRAM и отдаете его KV-кешу, ничего не переконвертируя.
- Нужен предсказуемый текстовый профиль памяти на модели, которая формально мультимодальна.
- Не использовать, если хоть часть трафика с картинками: они не деградируют, а отклоняются.
- Не использовать как «оптимизацию по умолчанию» для любого VLM — на неподдержанной архитектуре это отказ старта, а не тихий фолбэк.

## Влияние на производительность и память

- VRAM: минус веса vision tower, адаптера и проекции целиком (их даже не читают с диска), плюс отсутствие рабочих буферов энкодера. Величина зависит от чекпоинта — смотрите по разнице в логе выделения памяти.
- KV-кеш: освободившееся забирается по обычному правилу `--mem-fraction-static`; отдельной ручки не нужно, но при большом энкодере имеет смысл перепроверить, что доля все еще адекватна.
- Время старта: короче — меньше весов грузится, мультимодальные процессоры не импортируются.
- Пропускная способность текстовых запросов: косвенно выше за счет большего KV-пула; сам forward языковой части не меняется.

## Взаимодействие с другими аргументами

Комбинации, которые `_handle_language_model_only` отвергает с `ValueError` на старте:

- `--encoder-only` — противоположный режим (только энкодер).
- `--language-only` — режим EPD-дизагрегации, где энкодер существует, просто в другом процессе.
- `--enable-prefix-mm-cache` — кешировать нечего.
- `--enable-broadcast-mm-inputs-process` — мультимодальных входов нет.
- `--mm-enable-dp-encoder` — энкодера нет.
- `--disaggregation-mode` в значении `prefill`/`decode` — режим самостоятельный и с PD-дизагрегацией не совмещается.

Остальное:

- `--mem-fraction-static`: инструмент, которым освободившаяся память превращается в KV-емкость.
- `--mm-feature-transport`, `--mm-process-config`, `--enable-mm-global-cache`: становятся бессмысленными, мультимодальный тракт не поднимается.

## Типовые проблемы и диагностика

- **Симптом:** `--language-model-only does not support ['Qwen3VLForConditionalGeneration']. Supported: ['MuseGlimmerForConditionalGeneration'].` **Причина:** архитектура вне белого списка. **Лечение:** запускать без флага; для урезания VLM другими средствами смотрите `--language-only` в схеме EPD.
- **Симптом:** `--language-model-only cannot be combined with --enable-prefix-mm-cache` (и аналоги). **Причина:** перечисленные выше несовместимости. **Лечение:** убрать конфликтующий флаг.
- **Симптом:** запрос с картинкой падает с `Multimodal inputs are not supported when --language-model-only is set`. **Причина:** ожидаемое поведение. **Лечение:** перезапуск без флага, если мультимодальность нужна.
- **Симптом:** режим включился, хотя флага нет. **Причина:** `language_model_only: true` в конфиге чекпоинта (`is_lm_only`). **Проверка:** дамп `server_args=` покажет `language_model_only=False`, а поведение будет как у включенного — смотрите конфиг модели.
- Что смотреть: в логе отсутствуют строки загрузки весов vision tower, а размер KV-пула заметно больше, чем на том же чекпоинте без флага.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/MuseGlimmer --language-model-only --mem-fraction-static 0.9
```

```bash
python -m sglang.launch_server --model-path /models/MuseGlimmer --language-model-only --context-length 32768
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/models/muse_glimmer.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
