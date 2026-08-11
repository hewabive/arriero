---
schema: 1
engine: sglang
primaryName: "--enable-return-routed-experts"
title: "--enable-return-routed-experts"
summary: Включает захват top-k экспертов MoE-роутера на каждом слое и каждом токене, чтобы отдавать их клиенту в base64. Стоит два постоянных буфера — на GPU и в закрепленной RAM хоста, причем host-буфер масштабируется размером KV-пула и может занять гигабайты.
group: exec.features
related:
  - --enable-return-indexer-topk
  - --enable-return-hidden-states
  - --return-hidden-states-mode
  - --chunked-prefill-size
  - --max-running-requests
  - --enable-dp-attention
  - --moe-a2a-backend
  - --ep-size
  - --enable-eplb
---

# --enable-return-routed-experts

## Кратко

У MoE-модели роутер каждого слоя выбирает `num_experts_per_tok` экспертов на токен. Флаг включает перехват этих индексов: `RoutedExpertsCapturer` пишет их в GPU-буфер на каждом форварде, копирует на хост в буфер, индексированный слотами KV-пула, и по запросу отдает срез `[routed_experts_start_len, seqlen − 1)` в виде base64-строки из int32. Инструмент анализа маршрутизации (какие эксперты активируются на каких данных, насколько равномерна загрузка) — не эксплуатационная ручка. Плата за него берется при старте, один раз и навсегда: два буфера, размер которых считается по числу MoE-слоев, top-k и размеру пула.

## Оригинальная справка

```text
Enable returning routed experts of each layer with responses.
```

## Паспорт аргумента

- Флаги: `--enable-return-routed-experts`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: поле не переписывается. Захват при этом не создается на draft-воркере спекуляции (`init_routed_experts_capturer` выходит по `is_draft_worker`, чтобы не перетереть process-global capturer таргета), и дополнительно снимается с draft-модели вызовом `disable_routed_experts_capture_for_draft`
- Где объявлен: `ServerArgs.enable_return_routed_experts`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `ModelRunner.init_routed_experts_capturer` (выделение буферов) → `layers/moe/topk.py` на каждом форварде → копирование device→host в конце форварда → `meta_info` ответа

## Что меняет в движке

### Буферы

`RoutedExpertsCapturer.create` (`state_capturer/routed_experts.py`) строится поверх `BaseTopkCapturer` (`state_capturer/base.py`) и выделяет два тензора `int32`:

- **device cache** формы `(max_batch_size, num_layers, topk_size + num_fused_shared_experts)`, где `max_batch_size = max(chunked_prefill_size, max_running_requests) × dp_size`. При старте печатается `DeviceCache[routed_experts] allocated: shape=…, size=… MB`;
- **host cache** формы `(num_tokens, num_layers, topk_size)` в **закрепленной** (`pin_memory=True`) памяти хоста, где `num_tokens = max_token_pool_size + page_size`. При старте печатается `HostCache[routed_experts] allocated: shape=…, size=… GB`.

Host-буфер — главный расход и он неочевиден: он индексируется слотами KV-пула, то есть растет вместе с ним. Для модели с 60 MoE-слоями, top-k 8 и пулом на 200 000 токенов это `200000 × 60 × 8 × 4 ≈ 384 МиБ` закрепленной RAM; при большом `--mem-fraction-static` и длинном контексте счет идет на гигабайты. Закрепленная память не выгружается в swap и уменьшает то, что доступно остальному хосту.

### Захват и выгрузка

Точка захвата — `layers/moe/topk.py` (плюс отдельная реализация в `models/inkling_common/moe.py`): после выбора top-k индексы пишутся в device cache по номеру слоя. Два особых случая учтены явно:

- при DeepEP-бэкенде all-to-all каждый attn-TP-ранг видит только свой срез, поэтому capturer делает `attn_tp_all_gather_into_tensor` в предвыделенный `gather_buffer` (еще один тензор на GPU);
- при DP-attention без DeepEP срез берется по локальному окну DP-ранга, чтобы не делать GPU→CPU-синхронизацию и не ломать overlap-планирование.

В конце форварда `on_forward_end` либо копирует срез на хост синхронно, либо (в overlap-режиме) отдает GPU-тензоры потоку результатов, который сделает неблокирующее D2H и финализацию.

### Что видит клиент

Запрос: `return_routed_experts: true` и необязательный `routed_experts_start_len` (абсолютная стартовая позиция, `0` — вся последовательность). Отрицательное значение или значение больше числа входных токенов приводят к аварийному завершению запроса с текстом ошибки от scheduler'а.

Ответ: индексы упаковываются в base64 от сырых int32 (`managers/detokenizer_manager.py`, `managers/tokenizer_manager.py` → `meta_info["routed_experts"]`). В OpenAI-совместимом ответе они кладутся **не** в choice, а в объект уровня ответа: `sglext.routed_experts` (`entrypoints/openai/protocol.py:SglExt`), причем `sglext` целиком выпиливается из сериализации, если он пуст. Клиент должен сам декодировать base64 и решейпить в `(seqlen − 1 − start, num_layers, topk)` — вспомогательная функция есть в `state_capturer/routed_experts.py`.

Важно: поле берется из **первого** элемента `ret`, то есть при `n > 1` вернется маршрутизация одного варианта, а не всех.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Осмысленен только для MoE-моделей: размер буфера считается по `num_experts_per_tok` и `num_hidden_layers` из конфига модели.
- Гранулярность выбирается запросом через `routed_experts_start_len`, а не флагом.
- Буферы выделяются при старте безусловно, даже если ни один запрос не попросит маршрутизацию.

## Когда использовать

- Исследование маршрутизации: перекос загрузки экспертов, влияние домена данных на выбор, подготовка данных для перестановки экспертов.
- Отладка EPLB и расстановки экспертов, когда агрегированной статистики распределения недостаточно и нужны сырые индексы по токенам.
- Не включайте на боевом инстансе: буферы съедают память постоянно, а пользы без анализа нет. Для агрегированной статистики есть рекордер распределения экспертов, который не требует этого флага.
- Не включайте на dense-модели: полезной информации не будет, а буферы (пусть и вырожденные) выделятся.
- Не рассчитывайте получить маршрутизацию всех `n` вариантов ответа.

## Влияние на производительность и память

- **RAM хоста.** `num_tokens × num_layers × topk × 4` байт закрепленной памяти. Это самая крупная и самая неожиданная статья.
- **VRAM.** Device cache `max_batch_size × num_layers × (topk + fused_shared) × 4` байт плюс `gather_buffer` при DeepEP. Десятки-сотни МиБ; уменьшает `max_total_num_tokens`.
- **Latency.** Запись индексов на каждом MoE-слое каждого форварда плюс D2H-копирование среза в конце. В overlap-режиме копирование уходит на отдельный поток, но остается в бюджете.
- **Throughput.** Заметно падает при большом числе слоев и большом батче.
- **Размер ответа.** `(seqlen − 1 − start) × num_layers × topk × 4` байт до base64 (то есть ×4/3 после). На 1000 токенов, 60 слоев и top-k 8 это порядка 1.9 МБ сырых данных.

## Взаимодействие с другими аргументами

- `--chunked-prefill-size` и `--max-running-requests`: вместе с `--dp-size` задают первую размерность device cache.
- `--mem-fraction-static` (косвенно): определяет `max_token_pool_size`, а значит и размер host cache.
- `--enable-dp-attention`: меняет способ выборки локального среза; при DeepEP добавляется all-gather.
- `--moe-a2a-backend`: значение `deepep` включает all-gather-путь и дополнительный GPU-буфер.
- `--ep-size`: индексы экспертов глобальные, но capturer живет на каждом ранге; при EP помните, что интерпретировать индексы надо в глобальной нумерации экспертов.
- `--enable-eplb`: перестановка экспертов меняет соответствие «физический индекс → логический эксперт»; сопоставляйте маршрутизацию с текущей расстановкой.
- `--enable-return-indexer-topk` / `--enable-return-hidden-states`: соседние расширения ответа, независимые друг от друга.
- `--speculative-algorithm`: захват выключен на draft-воркере.

## Типовые проблемы и диагностика

- **Симптом:** после включения флага процесс убит OOM-killer'ом хоста или хост ушел в swap. **Причина:** закрепленный host cache. **Проверка:** строка `HostCache[routed_experts] allocated: shape=…, size=… GB` в логе старта — она печатается до того, как память станет проблемой.
- **Симптом:** `max_total_num_tokens` уменьшился. **Причина:** device cache и gather buffer.
- **Симптом:** запрос завершается с ошибкой про `routed_experts_start_len`. **Причина:** значение вне `[0, prompt_tokens]`.
- **Симптом:** в ответе нет `sglext`. **Причина:** запрос не задал `return_routed_experts: true`, либо это стриминг (поле собирается на непотоковом пути).
- **Что смотреть:** обе строки `DeviceCache[routed_experts] …` и `HostCache[routed_experts] …` при старте; итоговый дамп `server_args=`.
- **В arriero:** прокси возвращает тело апстрима без изменений, поэтому `sglext.routed_experts` доходит до клиента на фасаде `/v1/*`; на Anthropic-фасаде мост собирает ответ из фиксированного набора полей (`packages/anthropic-openai-bridge/src/response.ts`) и это поле теряется. Если в маршруте стоит нода `cache`, мегабайтные тела будут сохраняться в `proxy_response_cache` (SQLite) — при регулярных запросах с маршрутизацией это быстро раздувает `data/arriero.db`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-return-routed-experts
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --ep-size 8 --moe-a2a-backend deepep --enable-return-routed-experts --max-running-requests 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/state_capturer/base.py`
- `sglang/python/sglang/srt/state_capturer/routed_experts.py`
- `sglang/python/sglang/srt/layers/moe/topk.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/detokenizer_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/entrypoints/openai/utils.py`
- arriero: `apps/api/src/proxy/forwarder.ts`, `packages/anthropic-openai-bridge/src/response.ts`, `docs/API_PROXY_RESPONSE_CACHE.md`
