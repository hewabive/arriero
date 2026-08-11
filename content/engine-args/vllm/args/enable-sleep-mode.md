---
schema: 1
engine: vllm
primaryName: "--enable-sleep-mode"
title: "--enable-sleep-mode"
summary: Разрешает усыплять инстанс, освобождая VRAM без остановки процесса. Управляющие эндпоинты `/sleep` и `/wake_up` поднимаются только при `VLLM_SERVER_DEV_MODE=1`, поэтому без этой переменной флаг в режиме `vllm serve` инертен.
group: ModelConfig
related:
  - --enable-cumem-allocator
  - --gpu-memory-utilization
  - --enable-prefix-caching
  - --tensor-parallel-size
---

# --enable-sleep-mode

## Кратко

Sleep mode позволяет отдать VRAM обратно драйверу, не убивая процесс: веса выгружаются в хостовую RAM (level 1) либо выбрасываются совсем (level 2), KV-cache уничтожается, а на `/wake_up` состояние восстанавливается.

Два ограничения, которые надо знать до включения. Первое: HTTP-эндпоинты управления регистрируются только при `VLLM_SERVER_DEV_MODE=1` — это dev-роутер, а не публичный API. Второе: усыплённый процесс остаётся живым, поэтому любой внешний учёт занятости (в том числе ledger arriero) продолжает считать его ресурсы занятыми.

## Оригинальная справка

```text
Enable sleep mode for the engine (only cuda and
hip platforms are supported).
```

## Паспорт аргумента

- Флаги: `--enable-sleep-mode`, `--no-enable-sleep-mode`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-sleep-mode` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется, но включает за собой `enable_cumem_allocator = True` на cuda-alike; на платформе, где `is_sleep_mode_available()` даёт `False`, старт падает. Вопреки тексту справки, доступность объявлена не только для cuda/hip: `Platform.is_sleep_mode_available()` возвращает `True` для CUDA, ROCM **и** XPU
- Где объявлен: `vllm/config/model.py:ModelConfig.enable_sleep_mode`
- Этап применения: `ModelConfig.__post_init__` (валидация платформы) → инициализация worker'а (пулы аллокатора) → runtime по вызову `/sleep` и `/wake_up`

## Что меняет в движке

**Старт.** В `ModelConfig.__post_init__`:

```
if not current_platform.is_sleep_mode_available(): raise ValueError("Sleep mode is not supported on current platform.")
if current_platform.is_cuda_alike() and not self.enable_cumem_allocator:
    logger.info_once("Enabling cumem allocator because sleep mode requires it.")
    self.enable_cumem_allocator = True
```

Дальше веса и KV-cache выделяются внутри именованных пулов `CuMemAllocator` (см. `--enable-cumem-allocator`). Именно эти пулы и умеет отвязывать sleep.

**Управляющая поверхность.** Роутер `/sleep`, `/wake_up`, `/is_sleeping` живёт в `vllm/entrypoints/serve/dev/sleep/api_router.py` и подключается через `register_vllm_dev_api_routers(app)`, который вызывается в `api_server.py` **только** под `if envs.VLLM_SERVER_DEV_MODE`. Без этой переменной окружения запущенный `vllm serve` с `--enable-sleep-mode` тратит ресурсы на пулы аллокатора, но управлять сном некому.

**Уровни** (`EngineCore.sleep`, docstring):

- level 0 — только пауза планировщика; запросы принимаются, но не исполняются; VRAM не меняется;
- level 1 — веса выгружаются в CPU, KV-cache уничтожается; prefix cache сбрасывается (`clear_prefix_cache = level >= 1`);
- level 2 — освобождается вся GPU-память; перед этим буферы модели (и черновой модели, если есть) копируются в CPU и восстанавливаются на `wake_up`.

Параметр `mode` (`?mode=abort` по умолчанию) определяет, что делать с активными запросами при паузе планировщика.

**Механизм.** Суспенд/резюм делегируются `SleepModeBackend` (`vllm/device_allocator/sleep_mode_backend.py`, RFC #34303). Дефолтный backend `cumem` повторяет прежний путь через `CuMemAllocator` 1:1. Имя backend'а лежит в `ModelConfig.sleep_mode_backend`, но **CLI-флага для него в этом commit'е нет** — поле настраивается только программно. Замерять эффект стоит по логу `Sleep mode freed %s GiB memory, %s GiB memory is still in use.`

Отдельно: `wake_up` принимает список тегов (`?tags=weights`), позволяя вернуть только веса и оставить KV-cache невыделенным.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- Уровень и режим — не аргументы CLI, а query-параметры эндпоинта: `POST /sleep?level=2&mode=abort`, `POST /wake_up?tags=weights`.
- Состояние читается `GET /is_sleeping` → `{"is_sleeping": true}`.

## Когда использовать

- RL-цикл и подобные сценарии, где на одной карте по очереди работают обучение и инференс: усыпить инференс дешевле, чем перезапускать процесс с прогревом и компиляцией.
- Стенд, где несколько моделей делят карту вручную и вы управляете переключением скриптом.
- **Не используйте** как «энергосбережение» на управляемом сервере arriero. Прокси-планировщик оперирует запуском/остановкой процессов и вытеснением (`docs/RESOURCE_MANAGEMENT.md`), а не sleep-эндпоинтами vLLM; усыплённый инстанс остаётся живым процессом с открытым `process_runs`, его объявленный `memory`-draw продолжает занимать бюджет пула, и освободившаяся VRAM ledger'ом не учитывается. Получится расхождение между реальностью и учётом — ровно то, чего просят избегать.
- Не включайте, если не собираетесь ставить `VLLM_SERVER_DEV_MODE=1`: без него флаг только меняет аллокатор.

## Влияние на производительность и память

- **VRAM в бодрствующем состоянии.** Не меняется: бюджет по-прежнему задаёт `--gpu-memory-utilization`, профилирование идёт как обычно.
- **VRAM во сне.** Level 1 освобождает KV-cache и переносит веса в хост; level 2 освобождает всё, кроме служебных структур вне пулов. Фактическая величина печатается в логе.
- **Хостовая RAM.** Level 1 требует места под все веса в RAM хоста — на 70B в BF16 это ~140 GiB. На машине без такого запаса усыпление превратится в своп.
- **Время пробуждения.** Level 1 — обратная копия host→device; level 2 — повторная загрузка весов из источника, то есть фактически стоимость холодного старта минус компиляция.
- **Prefix cache.** Начиная с level 1 сбрасывается; первые запросы после пробуждения идут без кэш-хитов.

## Взаимодействие с другими аргументами

- `--enable-cumem-allocator`: включается автоматически на cuda-alike; на нём и держится весь механизм.
- `--gpu-memory-utilization`: определяет, сколько будет что освобождать. При очень низком utilization выигрыш от сна мал.
- `--enable-prefix-caching`: кэш теряется на каждом усыплении от level 1 и выше.
- `--tensor-parallel-size`: sleep/wake выполняются коллективно на всех worker'ах; освобождение считается по каждому устройству отдельно.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Sleep mode is not supported on current platform.` **Причина:** платформа вне CUDA/ROCm/XPU (например, CPU-сборка). **Лечение:** снять флаг.
- **Симптом:** `ValueError: cumem allocator is not supported on current platform.` при заданном только `--enable-sleep-mode`. **Причина:** sleep включил аллокатор, а расширения `vllm.cumem_allocator` в сборке нет. **Лечение:** сборка с расширением.
- **Симптом:** `POST /sleep` возвращает 404. **Причина:** не задан `VLLM_SERVER_DEV_MODE=1`. **Лечение:** переменная окружения в конфигурации инстанса и перезапуск.
- **Симптом:** `AssertionError: Memory usage increased after sleeping.` **Причина:** сторонний процесс занял освободившуюся память между замерами (на ROCm предусмотрено окно ожидания в 5 секунд, на CUDA — нет). **Лечение:** усыплять на карте, где нет конкурента.
- **Симптом:** после `/wake_up` первые запросы медленные. **Причина:** сброшенный prefix cache и (на level 2) перезагрузка весов. **Действие:** штатно; закладывайте прогрев.
- **Подтверждение принятого значения:** `Enabling cumem allocator because sleep mode requires it.` при старте и `Sleep mode freed X GiB memory, Y GiB memory is still in use.` при усыплении.

## Примеры

```bash
VLLM_SERVER_DEV_MODE=1 vllm serve /models/Qwen3-4B --enable-sleep-mode --gpu-memory-utilization 0.85
```

```bash
VLLM_SERVER_DEV_MODE=1 vllm serve /models/Qwen3-4B --enable-sleep-mode --enable-cumem-allocator --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/device_allocator/sleep_mode_backend.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/entrypoints/serve/dev/sleep/api_router.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/platforms/interface.py`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
