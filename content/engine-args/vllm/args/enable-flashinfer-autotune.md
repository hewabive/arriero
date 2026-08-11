---
schema: 1
engine: vllm
primaryName: "--enable-flashinfer-autotune"
title: "--enable-flashinfer-autotune"
summary: Управляет автотюнингом ядер FlashInfer в прогреве: движок прогоняет тактики на реальных размерах и кеширует лучшую. Удлиняет старт при холодном кеше и ничего не даёт, если FlashInfer-ядра не выбраны.
group: KernelConfig
related:
  - --kernel-config
  - --optimization-level
  - --attention-backend
  - --moe-backend
  - --linear-backend
  - --max-num-batched-tokens
---

# --enable-flashinfer-autotune

## Кратко

У FlashInfer на одну операцию приходится несколько реализаций («тактик»), и без автотюнинга выбор делается эвристикой. Автотюнинг прогоняет их все на прогревочном батче максимального размера, замеряет и запоминает лучшую; результат кешируется на диске и переиспользуется при следующих стартах.

Своего значения по умолчанию у флага нет — оно приходит из уровня оптимизации: `-O0` выключает автотюнинг, `-O1`/`-O2`/`-O3` включают. Поскольку уровень по умолчанию `O2`, **фактический дефолт — включено**. Явный `--no-enable-flashinfer-autotune` нужен, когда важнее короткий старт.

## Оригинальная справка

```text
If True, run FlashInfer autotuning during kernel warmup.
```

## Паспорт аргумента

- Флаги: `--enable-flashinfer-autotune`, `--no-enable-flashinfer-autotune`
- Группа argparse: `KernelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-…` ⇒ `False`, не задан ⇒ `None` («решит уровень оптимизации»)
- Значение по умолчанию: `None` — поле объявлено как `enable_flashinfer_autotune: bool = None`, и валидатор `_skip_none_validation` намеренно пропускает `None` через проверку типов
- Эффективное значение: доопределяется в `VllmConfig.__post_init__` через `_apply_optimization_level_defaults()`: `O0` ⇒ `False`, `O1`/`O2`/`O3` ⇒ `True`. Явно заданное значение при этом не перезаписывается. Если после применения уровня значение всё ещё `None` — `ValueError: KernelConfig.enable_flashinfer_autotune must be set after applying optimization level defaults.`
- Где объявлен: `vllm/config/kernel.py:KernelConfig.enable_flashinfer_autotune`
- Этап применения: прогрев ядер в worker'е (`kernel_warmup`), после захвата CUDA-графов и до выдачи первого запроса

## Что меняет в движке

В `kernel_warmup()` (`vllm/model_executor/warmup/kernel_warmup.py`) значение читается так:

```
if enable_flashinfer_autotune is False:
    logger.info_once("Skipping FlashInfer autotune because it is disabled.")
elif has_flashinfer() and current_platform.has_device_capability(90):
    flashinfer_autotune(worker.model_runner)
```

То есть автотюнинг фактически запускается только при трёх одновременных условиях: значение не `False`, FlashInfer установлен, compute capability ≥ 9.0 (Hopper и новее). На SM 8.x он молча не выполняется, никакой строки в логе при этом нет.

`flashinfer_autotune()` устроен так:

1. вычисляется путь кеша (`resolve_flashinfer_autotune_file`) — по умолчанию под `VLLM_CACHE_ROOT/flashinfer_autotune_cache/...`, переопределяется `VLLM_FLASHINFER_AUTOTUNE_CACHE_DIR`; путь печатается строкой `Using FlashInfer autotune cache file: <path>`;
2. лидер читает существующий кеш и рассылает его остальным рангам, после чего тактики загружаются в тюнер — то есть при тёплом кеше замеров почти нет;
3. выполняется один `_dummy_run` на `max_num_batched_tokens` токенов со случайными входами (FlashInfer тюнит все размеры вплоть до максимума, поэтому достаточно одного прогона; рандомизация нужна, чтобы эксперты MoE не остались без токенов и коллектив не завис);
4. при распределённом запуске тайминги усредняются по CPU-группе, чтобы все ранги выбрали одну тактику;
5. лидер сохраняет результат в файл кеша.

Отдельная ветка — автотюнинг decode-пути sparse MLA на SM 12x: он требует значения строго `True` (`is not True` ⇒ выход), то есть `None`-состояние там не считается согласием, а на момент прогрева `None` уже невозможен.

Тюнинг части операций можно исключить: `VLLM_FLASHINFER_AUTOTUNE_SKIP_OPS`, а при выбранном CuTe-DSL NVFP4-ядре движок сам пропускает `fp4_gemm` (`Skipping FlashInfer autotuning for ops ('fp4_gemm',)`), потому что там тюнинг означал бы JIT-компиляцию каждой тактики.

Значение исключено из хеша компиляции (`ignored_factors` в `KernelConfig.compute_hash`), так что переключение не инвалидирует кеш компиляции.

## Значения и формат

- Булев флаг без значения; парный `--no-enable-flashinfer-autotune` явно выключает.
- «Не задан» — это `None`, и он означает «взять из `--optimization-level`», а не «выключено».
- Структурная форма: `--kernel-config '{"enable_flashinfer_autotune": false}'`. В отличие от `--enable-bf16x3-router-gemm`, здесь взаимное исключение реализовано корректно: одновременное задание обоими способами даёт `ValueError: enable_flashinfer_autotune and kernel_config.enable_flashinfer_autotune are mutually exclusive`.
- Включение не «включает FlashInfer»: если библиотека не установлена или ядра FlashInfer не выбраны (`--attention-backend`, `--moe-backend`, `--linear-backend`), тюнить нечего.

## Когда использовать

- **Выключать (`--no-…`) при частых рестартах и холодном кеше.** Автотюнинг добавляет к старту полноценный прогон на `max_num_batched_tokens` токенов со всеми тактиками; при итеративном подборе аргументов это заметно.
- **Выключать в CI и при отладке.** Меньше движущихся частей и меньше разброс замеров между запусками.
- **Оставлять включённым в проде на Hopper/Blackwell с FlashInfer.** Кеш прогревается один раз, дальше стоимость близка к нулю, а выигрыш эвристики против замеров реален.
- **Не включайте `-O0` ради «чистоты», если хотите автотюнинг.** `-O0` выключает его вместе с компиляцией и CUDA-графами.
- **Не рассчитывайте на эффект на SM 8.x.** На карте ниже Hopper блок автотюнинга не выполняется вообще.

## Влияние на производительность и память

- **Время старта.** Основная статья расхода. При холодном кеше — один прогон на максимальный батч с перебором тактик по всем задействованным FlashInfer-операциям; при тёплом кеше — чтение файла и загрузка конфигураций.
- **Throughput и latency.** Выигрыш там, где эвристика FlashInfer промахивается по вашим размерностям; величина зависит от модели и карты и проверяется только замером.
- **VRAM.** Прогон выполняется в режиме профилирования уже после выделения KV-cache и захвата графов; постоянной памяти не добавляет, но кратковременный пик на `max_num_batched_tokens` токенов существует.
- **Диск.** Файл кеша на комбинацию модель/конфигурация под `VLLM_CACHE_ROOT`. При смене модели или ключевых аргументов появляется новый каталог, старые не удаляются.
- **Распределённый запуск.** Добавляет барьер и broadcast; при большом мире это несколько лишних синхронизаций на старте.

## Взаимодействие с другими аргументами

- `--optimization-level`: единственный источник значения по умолчанию (`O0` ⇒ выключено, `O1`–`O3` ⇒ включено).
- `--kernel-config`: то же поле в JSON-форме, взаимно исключено с флагом.
- `--attention-backend`, `--moe-backend`, `--linear-backend`: определяют, задействованы ли FlashInfer-ядра вообще. Без них автотюнинг — пустая трата времени старта.
- `--max-num-batched-tokens`: задаёт размер прогревочного прогона, то есть напрямую стоимость автотюнинга.
- `--enforce-eager`: убирает компиляцию и графы, но не автотюнинг — он живёт в прогреве ядер и выполняется в любом случае.
- `--data-parallel-size`, `--tensor-parallel-size`: включают усреднение таймингов по мировой CPU-группе и барьеры.

## Типовые проблемы и диагностика

- **Симптом:** старт стал заметно дольше после смены модели. **Причина:** новый каталог кеша автотюнинга, тюнинг с нуля. **Проверка:** строка `Using FlashInfer autotune cache file: <path>` — путь изменился. **Лечение:** ничего (второй старт будет быстрым) либо `--no-enable-flashinfer-autotune`.
- **Симптом:** флаг задан, но в логе ни одной строки об автотюнинге. **Причина:** FlashInfer не установлен либо compute capability ниже 9.0 — блок пропускается без сообщения. **Проверка:** `python -c "import flashinfer"` в окружении инстанса и compute capability карты.
- **Симптом:** `Skipping FlashInfer autotune because it is disabled.` **Причина:** значение `False` — либо явный `--no-…`, либо `-O0`.
- **Симптом:** `ValueError: enable_flashinfer_autotune and kernel_config.enable_flashinfer_autotune are mutually exclusive`. **Лечение:** оставить один способ задания.
- **Симптом:** зависание на старте при data parallelism в момент автотюнинга. **Причина:** синхронный тюнинг требует, чтобы все ранги дошли до одной точки; проблема обычно не в флаге, а в рассинхроне рангов. **Обход для проверки гипотезы:** временно выключить автотюнинг.
- **Симптом:** `ValueError: KernelConfig.enable_flashinfer_autotune must be set after applying optimization level defaults.` **Причина:** уровень оптимизации не проставил значение — это внутренняя ошибка сборки конфига, а не пользовательская; лечится явным заданием флага.
- **Подтверждение принятого значения:** `Using FlashInfer autotune cache file: ...` (включено и выполняется) либо `Skipping FlashInfer autotune because it is disabled.` (выключено).

## Примеры

```bash
vllm serve /models/Qwen3-4B --no-enable-flashinfer-autotune --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-30B-A3B --enable-flashinfer-autotune --moe-backend flashinfer_cutlass --max-num-batched-tokens 4096
```

## Источники

- `vllm/vllm/config/kernel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/model_executor/warmup/kernel_warmup.py`
- `vllm/vllm/model_executor/warmup/flashinfer_autotune_cache.py`
- `vllm/vllm/model_executor/warmup/flashinfer_sparse_mla_warmup.py`
- `vllm/vllm/engine/arg_utils.py`
