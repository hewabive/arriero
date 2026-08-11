---
schema: 1
engine: vllm
primaryName: "--ubatch-size"
title: "--ubatch-size"
summary: Число микробатчей, на которые разрезается шаг, чтобы перекрыть all2all-обмен MoE вычислением. Несмотря на имя, это счётчик, а не размер; значения `0` и `1` одинаково означают «выключено».
group: ParallelConfig
related:
  - --enable-dbo
  - --dbo-decode-token-threshold
  - --dbo-prefill-token-threshold
  - --all2all-backend
  - --enable-expert-parallel
  - --data-parallel-size
  - --disable-cascade-attn
  - --max-num-batched-tokens
---

# --ubatch-size

## Кратко

Имя вводит в заблуждение: `--ubatch-size` задаёт **количество** микробатчей, на которые разрезается один шаг движка, а не размер микробатча. Токены делятся поровну: точка разреза считается как `num_tokens_padded // num_ubatches`.

Смысл механизма — перекрытие: пока один микробатч ждёт all2all-обмена MoE, второй считает. Отсюда и жёсткое ограничение — микробатчинг разрешён только с backend'ами `deepep_low_latency`, `deepep_high_throughput` и `nixl_ep`.

Соотношение с `--enable-dbo` асимметричное: `--enable-dbo` фиксирует ровно два микробатча и перебивает это поле (`num_ubatches = 2 if enable_dbo else ubatch_size`). Само по себе `--ubatch-size` включает микробатчинг только при значении **больше 1**.

## Оригинальная справка

```text
Number of ubatch size.
```

## Паспорт аргумента

- Флаги: `--ubatch-size`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=0, ge=0)` — неотрицательное целое
- Значение по умолчанию: `0`
- Эффективное значение: `--enable-dbo` перебивает его — производные свойства `ParallelConfig.num_ubatches = 2 if enable_dbo else ubatch_size` и `use_ubatching = enable_dbo or ubatch_size > 1`. То есть при `--enable-dbo` значение этого флага не используется вовсе
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.ubatch_size`
- Этап применения: сборка `VllmConfig` (проверка all2all-backend'а, отключение cascade attention) → построение model runner'а (обёртка `UBatchWrapper`, число builder'ов метаданных внимания) → захват CUDA-графов → каждый шаг (решение «резать или нет»)

## Что меняет в движке

**Производные свойства** (`vllm/config/parallel.py`):

```
use_ubatching = enable_dbo or ubatch_size > 1
num_ubatches  = 2 if enable_dbo else ubatch_size
```

Из первой строки видно, что `--ubatch-size 1` эквивалентно `0`: микробатчинг не включается.

**Проверка backend'а.** `VllmConfig.__post_init__` при `use_ubatching` утверждает, что `all2all_backend` входит в `{deepep_low_latency, deepep_high_throughput, nixl_ep}`, иначе поднимает ошибку с текстом `Microbatching currently only supports the deepep_low_latency, deepep_high_throughput, and nixl_ep all2all backends. ... To fix use --all2all-backend=deepep_low_latency, --all2all-backend=deepep_high_throughput, or --all2all-backend=nixl_ep and install the matching kernels.`

**Cascade attention.** Там же: при `use_ubatching` принудительно выставляется `disable_cascade_attn = True` с логом `Disabling cascade attention when DBO is enabled.`

**Пороги.** `check_ubatch_thresholds` разрешает резать шаг, только если токенов достаточно: `dbo_decode_token_threshold` (32) для однородного decode, `dbo_prefill_token_threshold` (512) для батчей с prefill. Ниже порога шаг идёт целиком.

**Вето по корректности.** `gpu_model_runner` отказывается резать шаг при `num_reqs < 2` и в случае, когда запрос попал бы в первую половину как читатель блоков, которые пишет запрос из второй половины (prefix-cache hit внутри одного батча). Решение принимается коллективно всеми рангами.

**Исполнение.** При `use_ubatching` модель оборачивается в `UBatchWrapper` вместо обычной обёртки CUDA-графа; число builder'ов метаданных внимания становится равным `num_ubatches`; барьер потоков в `gpu_ubatch_wrapper` рассчитан на `num_ubatches + 1` (микробатчи плюс основной поток).

**Асимметрия с workspace.** `Worker.compile_or_warm_up_model` (`vllm/v1/worker/gpu_worker.py`) инициализирует менеджер рабочих буферов числом слотов `2 if enable_dbo else 1` — то есть смотрит только на `--enable-dbo`, а не на `num_ubatches`. Значение `--ubatch-size` больше 2 без `--enable-dbo` этот менеджер не расширяет.

## Значения и формат

- Целое ≥ 0.
- `0` (дефолт) и `1` — микробатчинг выключен.
- `2` и больше — включён, шаг режется на столько частей.
- Отрицательные значения отвергаются валидацией `ge=0`.
- Токены делятся поровну: `split_point = num_tokens_padded // num_ubatches`; последний срез добивается до полного числа токенов после DP-паддинга.

## Когда использовать

- **MoE-развёртывание с DeepEP или NIXL EP**, где профилирование показывает, что шаг простаивает на all2all. Это единственный сценарий, ради которого механизм существует.
- **Как замена `--enable-dbo`, если нужно больше двух микробатчей.** `--enable-dbo` жёстко даёт два.
- **Не включайте на обычном `allgather_reducescatter`** — старт остановится с явной ошибкой.
- **Не включайте на малых батчах.** Пороги (32 токена для decode, 512 для prefill) сами не дадут резать шаг, но конфигурация всё равно потеряет cascade attention и обычную обёртку CUDA-графа.
- **Учитывайте, что значение больше 2 расходится с числом слотов workspace-менеджера** (см. выше). Прежде чем задавать 3 и больше, проверьте поведение на своей сборке нагрузочным прогоном.

## Влияние на производительность и память

- **Throughput.** Растёт, если all2all действительно был на критическом пути. Иначе — только накладные расходы на разрезание и синхронизацию потоков.
- **Latency.** Каждый микробатч меньше, значит хуже утилизирует SM; при малых батчах это чистая потеря, поэтому и введены пороги.
- **VRAM.** Появляются буферы и builder'ы метаданных на каждый микробатч (`num_metadata_builders = num_ubatches`); отключение cascade attention меняет профиль потребления в attention.
- **CUDA-графы.** Микробатчинг несовместим с обычной full-cudagraph-обёрткой: используется `UBatchWrapper`, и графы захватываются в микробатченном виде только для однородного decode выше порога.
- **Время старта.** Растёт: захват графов идёт и для микробатченных, и для обычных вариантов.

## Взаимодействие с другими аргументами

- `--enable-dbo`: перебивает значение, фиксируя два микробатча.
- `--dbo-decode-token-threshold`, `--dbo-prefill-token-threshold`: пороги, ниже которых шаг не режется.
- `--all2all-backend`: обязан быть `deepep_low_latency`, `deepep_high_throughput` или `nixl_ep`.
- `--enable-expert-parallel`, `--data-parallel-size`: без EP и DP all2all не возникает, и перекрывать нечего.
- `--disable-cascade-attn`: принудительно включается при микробатчинге.
- `--max-num-batched-tokens`: определяет, будет ли в шаге достаточно токенов, чтобы разрез вообще состоялся.

## Типовые проблемы и диагностика

- **Симптом:** `Microbatching currently only supports the deepep_low_latency, deepep_high_throughput, and nixl_ep all2all backends. allgather_reducescatter is not supported.` **Лечение:** сменить backend (с установленными ядрами) или убрать флаг.
- **Симптом:** задали `--ubatch-size 1`, ничего не изменилось. **Причина:** `use_ubatching` требует строго больше 1. **Лечение:** задать 2 и больше.
- **Симптом:** в логе `Disabling cascade attention when DBO is enabled.`, хотя `--enable-dbo` не задан. **Причина:** микробатчинг включён через `--ubatch-size`, а сообщение общее для обоих путей.
- **Симптом:** флаг задан, но разрезов не видно. **Проверка:** отладочная строка `ubatch_slices: %s, ubatch_slices_padded: %s` (уровень DEBUG). Пусто — значит не набралось токенов до порога, либо в батче меньше двух запросов, либо сработало вето по prefix-cache.
- **Симптом:** throughput упал. **Причина:** all2all не был узким местом, а расход на разрезание и потерю cascade attention остался. **Лечение:** вернуть значение в 0.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `ubatch_size=N`; при активном микробатчинге модель обёрнута в `UBatchWrapper`, а в DEBUG-логе появляются срезы микробатчей.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --data-parallel-size 8 --all2all-backend deepep_low_latency --ubatch-size 2
```

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --data-parallel-size 8 --all2all-backend deepep_high_throughput --ubatch-size 2 --dbo-prefill-token-threshold 1024
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/worker/ubatch_utils.py`
- `vllm/vllm/v1/worker/gpu_ubatch_wrapper.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
