---
schema: 1
engine: sglang
primaryName: "--language-only"
title: "--language-only"
summary: Языковая половина EPD: обычный OpenAI-совместимый сервер, который отдает обработку изображений отдельным энкодерам и получает от них готовые эмбеддинги. Поднимает `EncoderBootstrapServer` для их динамической регистрации.
group: disagg
related:
  - --encoder-only
  - --encoder-urls
  - --encoder-bootstrap-port
  - --encoder-transfer-backend
  - --enable-adaptive-dispatch-to-encoder
  - --disaggregation-mode
  - --mem-fraction-static
  - --cp-strategy
  - --host
  - --port
---

# --language-only

## Кратко

`--language-only` — это обычный сервер SGLang, который перестает считать изображения сам: мультимодальные элементы запроса уходят на отдельные энкодеры, а обратно приходят готовые эмбеддинги и подставляются вместо плейсхолдеров. В отличие от `--encoder-only`, этот флаг entrypoint не меняет — сервер остается тем же `entrypoints/http_server.py` со всем публичным OpenAI-фасадом. Флаг совместим с `--disaggregation-mode prefill`: именно так собирается полный трехъярусный EPD. Формулировку справки «load weights for the language model only» стоит читать осторожно: реально визуальную башню отбрасывают не все архитектуры.

## Оригинальная справка

```text
For VLM, load weights for the language model only.
```

## Паспорт аргумента

- Флаги: `--language-only`
- Группа: `disagg`
- Тип значения: bool (`action="store_true"`, парного `--no-*` нет)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; движок его не переписывает, но оно отключает VLM-надбавку к `--mem-fraction-static` и меняет ветку прогрева
- Где объявлен: `ServerArgs.language_only`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → авто-подбор `--mem-fraction-static` (VLM-надбавка пропускается) → `_handle_encoder_disaggregation` (проверки, разрешение `--encoder-transfer-backend auto`) → `ModelConfig` (`hf_config.language_only`) → загрузка весов без визуальной башни → `TokenizerManager.init_disaggregation` (запуск `EncoderBootstrapServer` и MM-receiver'а) → обработка каждого мультимодального запроса

## Что меняет в движке

### Веса

Значение оседает в `hf_config.language_only` (`configs/model_config.py`), и дальше **каждая обертка VLM решает сама** — обещание из справки выполняется не одинаково:

- **Kimi-VL, Kimi-K3, dots_vlm** действительно отбрасывают визуальную часть: в `load_weights` стоят явные фильтры вида `if self.config.language_only and is_vision_weight: continue`, а у Kimi-K3 при `language_only` еще и пропускается прекомпиляция vision-ядер.
- **Семейство Qwen VL** (`qwen2_5_vl.py`, `qwen3_vl.py`, `qwen3_vl_moe.py`) визуальную башню **строит и грузит**. Единственное, что там делает флаг, — разрешает пропускать веса, которых нет в словаре параметров (`if (self.config.encoder_only or self.config.language_only) and name not in params_dict: continue`). Не путайте с атрибутом чекпойнта `language_model_only`, который у Qwen3-VL действительно зануляет `self.visual`, — это независимая от CLI вещь.

Практический вывод: экономию VRAM от `--language-only` надо проверять на своей модели, а не принимать на веру. Для Qwen VL сохранение башни к тому же логично — именно она обрабатывает запросы, которые `--enable-adaptive-dispatch-to-encoder` оставил локально.

### Приемник эмбеддингов

`TokenizerManager.init_disaggregation` при `--language-only`:

1. заводит **разделяемый по ссылке** список URL, предзаполненный значениями `--encoder-urls`;
2. поднимает `EncoderBootstrapServer` на `--host`:`--encoder-bootstrap-port` — тот же список он мутирует при регистрации/снятии энкодеров;
3. создает MM-receiver, который читает этот же список.

Если `--encoder-urls` пуст, в лог идет `--language-only is set without --encoder-urls. Encoders are expected to register dynamically via the EncoderBootstrapServer.` — это информация, а не ошибка.

### Маршрут запроса

`_handle_epd_disaggregation_encode_request` вызывается на каждом запросе с мультимодальным входом и решает, отправлять ли его на энкодер (по умолчанию — всегда; с `--enable-adaptive-dispatch-to-encoder` — по числу элементов). Дальше путь зависит от `--encoder-transfer-backend`:

- `zmq_to_tokenizer` — эмбеддинги приходят обратно в tokenizer manager, и он ждет их синхронно в `recv_mm_data`. Если энкодер не ответил, а запрос был отправлен ему, включается `_reject_missing_dispatched_encoder_embedding` и клиент получает `503` с текстом `The encoder did not return multimodal embeddings. The request was not run locally in language-only mode.` — движок намеренно не подменяет отказ локальным счетом;
- `zmq_to_scheduler` / `mooncake` — эмбеддинги приезжают прямо в scheduler (`_apply_mm_receiver` в приемнике запросов), а tokenizer manager запрос не блокирует. Если запрос **не** был отправлен на энкодер (адаптивная диспетчеризация оставила его локально), tokenizer manager обрабатывает мультимодальные данные сам.

### Память и прогрев

- Авто-подбор `--mem-fraction-static` пропускает `adjust_mem_fraction_for_vlm` при `--language-only`: энкодера здесь нет, надбавка под обработку изображений не нужна.
- Стартовый прогрев остается текстовым, даже если модель рекламирует поддержку изображений: `is_vlm` в `_wait_and_warmup` явно занулен для `--language-only`.

## Значения и формат

- Флаг без значения.
- Взаимоисключающ с `--encoder-only` (`Cannot set --encoder-only and --language-only together`).
- Совместим с `--disaggregation-mode prefill` — это штатная конфигурация EPD; на decode-сервере в примерах апстрима флаг не ставят, потому что decode с изображениями не работает.
- Архитектура модели должна входить в белый список EPD (Qwen2VL/Qwen2.5VL/Qwen3VL/Qwen3VL-MoE/Qwen3.5, Qwen2Audio, Qwen2.5Omni, Qwen3OmniMoe, InternS2Preview, KimiVL/KimiK2.5/KimiK3, MiMoV2), иначе `Model type <arch> is not supported for encoder disaggregation.`
- `--encoder-urls` не обязателен: энкодеры могут зарегистрироваться сами через `EncoderBootstrapServer`.

## Когда использовать

- EPD-развертывание VLM: энкодеры на своих картах, языковая часть на своих, масштабируются независимо.
- Нагрузка с тяжелыми изображениями, где ViT конкурирует с LLM за одну карту и портит ITL.
- Нужна текстовая инференс-часть MiMo V2 с CP-v2: там `--language-only` требуется явно (`MiMo V2 CP-v2 only supports text inference; add --language-only.`).
- Не включайте на одиночном сервере без энкодеров: мультимодальные запросы будут либо ждать, либо (для `zmq_to_tokenizer`) отдавать 503.
- Не рассчитывайте, что флаг «просто экономит память на VLM»: обработка изображений никуда не девается, она переезжает на другой процесс.

## Влияние на производительность и память

- **VRAM.** Гарантированно экономится только VLM-надбавка к резерву (`adjust_mem_fraction_for_vlm` не применяется), из-за чего KV-пул получается больше, чем у полного VLM-сервера при том же `--mem-fraction-static`. Экономия на самих весах визуальной башни зависит от архитектуры (см. «Что меняет в движке»): для Kimi/dots она есть, для Qwen VL — нет.
- **TTFT.** Растет на время сетевого обмена с энкодером; падает на нагрузке, где ViT раньше блокировал prefill.
- **Хост.** `EncoderBootstrapServer` — легкий uvicorn в демон-потоке процесса tokenizer manager; заметного расхода не дает.
- **Устойчивость.** Появляется новая точка отказа: недоступный энкодер превращается в 503 (`zmq_to_tokenizer`) либо в ожидание с таймаутом.
- **Throughput.** Ограничен суммарной производительностью пула энкодеров; смотрите на латентность строки `[<req_id>] Received embedding from E in <t>s` в логе.

## Взаимодействие с другими аргументами

- `--encoder-only`: взаимоисключающ на одном процессе; это две половины одной схемы.
- `--encoder-urls`: статический список энкодеров, предзаполняющий реестр.
- `--encoder-bootstrap-port`: порт реестра, который поднимает именно этот сервер.
- `--encoder-transfer-backend`: определяет, куда приходят эмбеддинги (tokenizer manager или scheduler) и как обрабатывается их отсутствие. При `auto` разрешается в `zmq_to_scheduler`, либо в `zmq_to_tokenizer` для `KimiK3ForConditionalGeneration` при `--tp-size > 1`.
- `--enable-adaptive-dispatch-to-encoder`: разрешает оставлять «легкие» запросы локально; требует, чтобы модель умела считать изображения сама, то есть чтобы визуальная башня была — на `--language-only` локальный путь работает через `mm_processor`, а не через веса ViT.
- `--disaggregation-mode prefill`: штатная комбинация полного EPD.
- `--mem-fraction-static`: VLM-надбавка отключается.
- `--cp-strategy zigzag` на MiMo V2: `--language-only` требуется для CP-v2.

## Типовые проблемы и диагностика

- `ValueError: Cannot set --encoder-only and --language-only together`.
- `503` с текстом `The encoder did not return multimodal embeddings. The request was not run locally in language-only mode.` — энкодер не ответил при `--encoder-transfer-backend zmq_to_tokenizer`. Это осознанный отказ, а не деградация.
- `Encoder embedding not available, falling back to local mm processing` — предупреждение на пути, где локальная обработка разрешена; проверяйте доступность энкодеров.
- Информационная строка `--language-only is set without --encoder-urls. Encoders are expected to register dynamically via the EncoderBootstrapServer.` при старте — нормально, если энкодеры запускаются с `--encoder-register-urls`.
- `Model type <arch> is not supported for encoder disaggregation.` — модель вне белого списка EPD.
- Латентность энкодера видна по парам строк `[<req_id>] Sending encode request to E, modalities=..., num_items=...` и `[<req_id>] Received embedding from E in <t>s`; таймаут — `[<req_id>] Embedding recv timeout after <t>s`.
- Принятое значение — в дампе `server_args=` при старте.
- **В arriero:** сам процесс `--language-only` остается OpenAI-совместимым и формально укладывается в модель «один процесс на инстанс» (`process/supervisor.ts`), но работоспособен только при живом внешнем пуле энкодеров, которым менеджер не управляет и здоровье которого не наблюдает. В квалифицированный профиль (`docs/KTRANSFORMERS_OPERATIONS.md`) такая схема не входит.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --encoder-urls http://127.0.0.1:30000 --encoder-transfer-backend zmq_to_scheduler --port 30002
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --disaggregation-mode prefill --encoder-urls http://enc0:30000 http://enc1:30001 --encoder-transfer-backend zmq_to_scheduler --port 30002
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/request_receiver.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/models/qwen3_vl.py`
- `sglang/python/sglang/srt/models/qwen2_5_vl.py`
- `sglang/python/sglang/srt/models/kimi_vl.py`
- `sglang/python/sglang/srt/models/kimi_k3.py`
- `sglang/python/sglang/srt/models/dots_vlm.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
