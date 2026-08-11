---
schema: 1
engine: sglang
primaryName: "--mem-fraction-static"
title: "--mem-fraction-static"
summary: Доля GPU-памяти, отданная под статику (веса + KV-пул); остаток резервируется под активации и CUDA graph. Не задан — SGLang вычислит значение сам по объему карты, `--chunked-prefill-size` и размеру decode-графа.
group: schedule
related:
  - --chunked-prefill-size
  - --max-total-tokens
  - --max-running-requests
  - --max-prefill-tokens
  - --context-length
  - --tp-size
  - --cuda-graph-max-bs-decode
  - --attention-backend
  - --enable-hierarchical-cache
---

# --mem-fraction-static

## Кратко

`--mem-fraction-static` — главная ручка объема KV-пула. Формально это `(веса модели + KV-пул) / емкость GPU`; практически это дополнение к резерву: `1 − mem_fraction_static` — та доля памяти, которую движок обязуется **не** трогать статическими аллокациями, чтобы хватило на активации, CUDA graph и временные буферы. Значение по умолчанию не константа: `ServerArgs.__post_init__` считает его из объема карты, из `--chunked-prefill-size` и из размера decode-графа. Трогать его нужно ровно в двух ситуациях — старт падает с OOM (уменьшить) или после старта на карте остается 10–20 ГБ свободной памяти (увеличить).

## Оригинальная справка

```text
The fraction of the memory used for static allocation (model weights and KV cache memory pool). Use a smaller value if you see out-of-memory errors.
```

## Паспорт аргумента

- Флаги: `--mem-fraction-static`
- Группа: `schedule`
- Тип значения: float (`Optional[float]`)
- Допустимые значения: argparse ограничений не накладывает; осмысленный диапазон — примерно `0.5`…`0.95`. Значение `≥ 1.0` argparse примет, но тогда резерв под активации равен нулю или отрицателен, и старт падает на захвате графа либо на первом длинном prefill
- Значение по умолчанию: `null` — «подберет движок»
- Эффективное значение: вычисляется в `_handle_gpu_memory_settings` (см. ниже), затем может быть домножено на `0.85` в `_handle_attention_backend_compatibility` при `--attention-backend aiter` и `context_len > 8192`, и на `0.8…1.0` для мультимодальных моделей (`adjust_mem_fraction_for_vlm`, только когда значение подбиралось автоматически)
- Где объявлен: `ServerArgs.mem_fraction_static`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подбор) → выделение KV-пула в `KVCacheConfigurator._profile_available_bytes` после загрузки весов

## Что меняет в движке

### Автоподбор при незаданном значении

`_handle_gpu_memory_settings(gpu_mem)` получает емкость карты в МиБ (`get_device_memory_capacity`, для CUDA — минимум по всем видимым GPU из `nvidia-smi --query-gpu=memory.total`) и, если `mem_fraction_static is None`, считает резерв:

```python
activation_tokens = max(self.chunked_prefill_size, 2048)     # chunked prefill включен
reserved_mem  = 512                                           # константные метаданные backend'ов
reserved_mem += activation_tokens * 1.5                       # активации
reserved_mem += self.tp_size * self.pp_size / 8 * 1024        # запас на большой параллелизм
reserved_mem += self.reserve_for_graph_mb()                   # CUDA graph
if gpu_mem is not None and gpu_mem > 60 * 1024:
    reserved_mem = max(reserved_mem, 10 * 1024)               # пол 10 ГиБ для больших карт
reserved_mem += self.reserve_for_deepep_a2a_mb()              # +2 ГиБ при DeepEP a2a
self.mem_fraction_static = round((gpu_mem - reserved_mem) / gpu_mem, 3)
```

Все слагаемые — МиБ. `reserve_for_graph_mb()` — это `decode.max_bs * 2` МиБ на decode-граф (плюс надбавки под DP attention и prefill-граф). При отключенном chunked prefill вместо `chunked_prefill_size` берется `max_prefill_tokens`; в режиме `--disaggregation-mode decode` — `max_running_requests * speculative_num_draft_tokens`. Если емкость карты определить не удалось, подставляется `0.88`.

Численно на RTX 4090 (24564 МиБ, tp=1): `chunked_prefill_size` = 2048 и `decode.max_bs` = 24 подбираются в той же функции, резерв = 512 + 3072 + 128 + 48 = 3760 МиБ, итог ≈ `0.847`. На H100 80 ГБ: `chunked_prefill_size` = 8192, `decode.max_bs` = 256, резерв = 512 + 12288 + 128 + 512 = 13440 МиБ (пол 10 ГиБ не срабатывает), итог ≈ `0.836`.

Ветка `post_capture_kv_sizing_planned()` (переменная окружения `SGLANG_ENABLE_POST_CAPTURE_KV_SIZING`, CUDA, не-MLA и еще семь условий) выкидывает из резерва и активации, и графы: `reserved_mem = 512 + tp*pp/8*1024`. Там пул досчитывается уже после захвата графов, по реально свободной памяти.

### Как из значения получается KV-пул

Резервирование выполняется не от емкости карты, а от **свободной памяти до загрузки весов** (`pre_model_load_memory`, ГиБ, минимум по world group):

```python
slack_gb = pre_model_load_memory * (1 - mem_fraction_static)
rest_memory = get_available_gpu_memory(...) - slack_gb   # свободно уже после весов и графов
return int(rest_memory * (1 << 30))                      # бюджет KV-пула в байтах
```

Дальше `MemoryPoolConfigurator.calculate_pool_sizes` делит бюджет на размер одной ячейки KV (`cell_size` — число KV-голов на rank × (`head_dim` + `v_head_dim`) × число слоев × размер элемента) и округляет вниз до целого числа страниц. Получившееся число — `max_total_num_tokens`, которое печатается в лог и служит базой для `--max-running-requests` и для host-пула `--hicache-ratio`.

Практическое следствие: **прибавка 0.01 к `--mem-fraction-static` дает примерно `0.01 × pre_model_load_memory` ГиБ дополнительного KV-пула** — около 0.8 ГиБ на 80-ГиБ карте и около 0.24 ГиБ на 24-ГиБ. Веса в этой арифметике не участвуют напрямую: они уже вычтены из «свободно сейчас».

## Значения и формат

- Дробное число от 0 до 1. `--mem-fraction-static .9` и `--mem-fraction-static 0.9` эквивалентны.
- Значения нет отдельного «авто»: не задавать аргумент — и есть авто.
- Слишком большое значение не отвергается на разборе CLI. Отказ приходит либо из `_profile_available_bytes` (`Loaded weights leave no GPU memory for the KV cache under --mem-fraction-static=…` с подсказкой минимально жизнеспособного значения), либо позже — как CUDA OOM на захвате графа или на первом полном chunk'е prefill.
- Слишком маленькое значение не ломает старт: получается крошечный KV-пул, `max_total_num_tokens` в несколько тысяч и постоянные вытеснения (retract) под нагрузкой.
- Значение действует на каждый TP/PP-rank одинаково; асимметричных долей нет.

## Когда использовать

- После первого успешного старта посмотреть в логе `available_gpu_mem` в строке `max_total_num_tokens=…`. Апстрим рекомендует держать 5–8 ГБ: больше — поднимать `--mem-fraction-static` шагами по 0.01, меньше — опускать.
- Обязательно задавать явно, когда на карте живет что-то еще (второй инстанс, десктоп, другой процесс): автоподбор считает резерв от доли и молча заберет всю свободную память под KV-пул.
- Задавать явно в arriero, когда для инстанса объявлен GPU-draw (`docs/RESOURCE_MANAGEMENT.md`): менеджер сверяет заявку с фактическим потреблением, а автоподбор делает потребление зависимым от модели карты и от чужой загрузки. Preflight KTransformers прямо предупреждает, что при незаданном `--mem-fraction-static` объем статики выбирает SGLang.
- Не трогать ради «экономии VRAM», если проблема в prefill: снижение `--chunked-prefill-size` уменьшает и активации, и автоматически подобранный резерв, что бьет точнее.
- Не поднимать выше 0.9 на мультимодальных моделях с явным значением: понижающий множитель для ViT применяется только к автоподобранному значению.

## Влияние на производительность и память

- VRAM: линейно определяет размер KV-пула, а значит и максимальную конкурентность, и глубину radix-кеша. На саму загрузку весов не влияет.
- RAM хоста: напрямую не влияет; косвенно — через `--hicache-ratio`, где host-пул считается кратно device-пулу.
- Время старта: не меняет.
- Throughput: через `token usage`. При маленьком пуле планировщик постоянно ретрактит запросы (`KV cache pool is full. Retract requests.`), и throughput падает скачкообразно.
- Latency: прямого влияния нет; косвенно — очередь при недостатке пула.

## Взаимодействие с другими аргументами

- `--chunked-prefill-size`: главный вход автоподбора (`activation_tokens * 1.5`). Уменьшили chunk — авто-значение выросло, KV-пул стал больше. При явно заданном `--mem-fraction-static` эта связь исчезает, и следить за активациями приходится вручную.
- `--cuda-graph-max-bs-decode` (и весь `--cuda-graph-config`): второй вход автоподбора через `reserve_for_graph_mb()`. Увеличили decode-граф при явно заданном `--mem-fraction-static` — получите OOM на захвате.
- `--max-total-tokens`: жесткий потолок поверх посчитанного пула. Если он меньше — лишняя память просто не используется.
- `--max-running-requests`: не влияет на размер пула (кроме `--disaggregation-mode decode`), но сам ограничивается сверху величиной `max_total_num_tokens // 2`.
- `--context-length`: определяет `cell_size`-независимую часть — размер `req_to_token`-пула и оценку числа запросов; длинный контекст при том же `mem_fraction_static` дает меньшую конкурентность.
- `--tp-size` / `--pp-size`: входят в резерв (`tp*pp/8*1024` МиБ) и делят `cell_size` между rank'ами.
- `--attention-backend aiter` при `context_len > 8192` умножает **итоговое** значение на 0.85 — единственный случай, когда явно заданное значение молча уменьшается.
- `--enable-hierarchical-cache` / `--hicache-ratio`: host-пул считается от `device_pool.size`, то есть растет вместе с `mem_fraction_static`.
- `--max-mamba-cache-size` / `--mamba-full-memory-ratio`: для гибридных моделей mamba-состояния вычитаются из того же бюджета до расчета KV-пула.

## Типовые проблемы и диагностика

- `Loaded weights leave no GPU memory for the KV cache under --mem-fraction-static=X. Raise --mem-fraction-static above Y` — веса заняли больше, чем оставил резерв. Поднимите значение до предложенного `Y` (либо уменьшите модель/квантизацию). При спекулятивном декодировании веса draft-модели тоже считаются.
- `torch.OutOfMemoryError` на этапе `Capture cuda graph` — резерв меньше графов. Уменьшите `--mem-fraction-static` на 0.02–0.05 либо `--cuda-graph-max-bs-decode`.
- OOM на первом длинном запросе при успешном старте — не хватило на активации prefill. Уменьшайте `--chunked-prefill-size` (4096, затем 2048), это дешевле, чем резать KV-пул.
- Частые `KV cache pool is full. Retract requests. #retracted_reqs: …` — пул мал. Проверьте `token usage` в строках `Decode batch, …`: устойчиво >0.9 при непустой очереди значит, что памяти действительно не хватает.
- Что смотреть в логе: итоговый дамп `server_args=` (значение, как его принял движок), `KV Cache is allocated. dtype: …, #tokens: N, K size: … GB, V size: … GB`, `Memory pool end. avail mem=… GB` и сводку `max_total_num_tokens=…, chunked_prefill_size=…, max_prefill_tokens=…, max_running_requests=…, context_len=…, available_gpu_mem=… GB`.
- Значение «прыгает» между перезапусками при незаданном аргументе — это норма: `nvidia-smi` возвращает минимум по видимым картам, и другой процесс на GPU меняет и `pre_model_load_memory`, и итоговый пул. Лечится явным значением.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --mem-fraction-static 0.78 --chunked-prefill-size 2048 --max-running-requests 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/KTRANSFORMERS_SUPPORT.md`
