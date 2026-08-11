---
schema: 1
engine: vllm
primaryName: "--eplb-config"
title: "--eplb-config"
summary: JSON-объект с восемью параметрами балансировщика экспертов: окно учёта, период перекладки, число избыточных экспертов, асинхронность, политика, коммуникатор и логирование балансированности. Сам по себе EPLB не включает.
group: ParallelConfig
related:
  - --enable-eplb
  - --enable-expert-parallel
  - --enable-elastic-ep
  - --expert-placement-strategy
  - --gpu-memory-utilization
---

# --eplb-config

## Кратко

`--eplb-config` — единственное место, где настраивается балансировщик экспертов. Включается он отдельно, флагом `--enable-eplb`; передача одного лишь `--eplb-config` его **не** активирует (в отличие от `--fault-tolerance-config`, который свой флаг включает сам).

Аргумент принимает JSON-строку целиком или точечные под-флаги вида `--eplb-config.window_size 1000`. Обе формы разбирает `FlexibleArgumentParser`.

Из восьми ключей практически значимы три: `num_redundant_experts` (память против качества балансировки), `step_interval` (частота перекладки) и `use_async` (перекладка в фоне или в шаге).

## Оригинальная справка

```text
Expert parallelism configuration.
```

## Паспорт аргумента

- Флаги: `--eplb-config`
- Группа argparse: `ParallelConfig`
- Тип значения: JSON-объект (датакласс `EPLBConfig`)
- Допустимые значения: `choices` нет; набор ключей фиксирован датаклассом, лишний ключ отвергается конструктором
- Значение по умолчанию: `Field(default_factory=EPLBConfig)` — конструируемый объект со значениями `window_size=1000`, `step_interval=3000`, `num_redundant_experts=0`, `log_balancedness=false`, `log_balancedness_interval=1`, `use_async=true`, `policy="default"`, `communicator=null`
- Эффективное значение: `communicator=null` доопределяется в `ParallelConfig.__post_init__` — `nixl`, если пакет NIXL доступен; иначе `pynccl` при `--enable-elastic-ep`; иначе `torch_gloo`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.eplb_config`
- Этап применения: разбор CLI (`EngineArgs.__post_init__` превращает dict в `EPLBConfig`) → валидация `ParallelConfig` → инициализация `EplbState` → каждый шаг учёта и каждая перекладка

## Что меняет в движке

Ключи датакласса `EPLBConfig` (`vllm/config/parallel.py`):

- **`window_size`** (`Field(default=1000, gt=0)`) — длина скользящего окна учёта нагрузки. Тензор нагрузки имеет форму `(window_size, num_moe_layers, num_physical_experts)`, поэтому окно напрямую задаёт объём этой статистики.
- **`step_interval`** (`Field(default=3000, gt=0)`) — период перекладки в шагах движка. Если он больше окна, решение принимается только по последним `window_size` шагам. Начальное значение счётчика ставится в `step_interval − step_interval // 4`, то есть первая перекладка происходит примерно через четверть интервала после старта.
- **`num_redundant_experts`** (`Field(default=0, ge=0)`) — сколько дополнительных физических копий экспертов создать. При выключенном EPLB ненулевое значение — ошибка конфигурации.
- **`log_balancedness`** (`false`) — логировать метрику балансированности каждый шаг. Выключено по умолчанию, потому что добавляет коммуникацию.
- **`log_balancedness_interval`** (`Field(default=1, gt=0)`) — как часто печатать метрику.
- **`use_async`** (`true`) — выполнять перекладку в фоновом worker'е, а не внутри шага.
- **`policy`** (`"default"`) — алгоритм перекладки; сегодня допустимо единственное значение `default` (`EPLBPolicyOption`).
- **`communicator`** (`null`) — транспорт для переноса весов экспертов: `torch_nccl`, `torch_gloo` (через CPU-буферы), `nixl` (RDMA-чтения с нулевым копированием), `pynccl`; `null` означает автовыбор.

Валидатор `_validate_eplb_config` отвергает две комбинации: асинхронный EPLB с политикой, отличной от `default`, и асинхронный EPLB с коммуникаторами `torch_nccl`/`pynccl` (конфликт многопоточных стримов NCCL; в комментарии кода дана ссылка на issue PyTorch 174288).

## Значения и формат

Одна строка JSON:

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --enable-eplb --data-parallel-size 8 --eplb-config '{"window_size":1000,"step_interval":3000,"num_redundant_experts":2,"log_balancedness":true}'
```

Точечные под-флаги (эквивалентно):

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --enable-eplb --data-parallel-size 8 --eplb-config.window_size 1000 --eplb-config.step_interval 3000 --eplb-config.num_redundant_experts 2 --eplb-config.log_balancedness true
```

- Ключи можно писать и через дефис — `FlexibleArgumentParser` считает дефис и подчёркивание эквивалентными.
- Незаданные ключи берут значения из `EPLBConfig`, а не «выключаются».
- `communicator: null` — не «без коммуникатора», а «выбери сам».
- `--config file.yaml` подставляет значения **до** явных флагов, поэтому явный `--eplb-config` в командной строке перекрывает конфиг-файл.

## Когда использовать

- **Задать `num_redundant_experts`.** Это главный рычаг: без избыточных экспертов балансировщик может только переставлять существующих, что на сильном перекосе помогает слабо. Апстрим рекомендует 32 для больших развёртываний.
- **Измерить перекос перед настройкой.** `log_balancedness: true` на время диагностики, потом обратно в `false`.
- **Сдвинуть `step_interval`.** Реже — меньше накладных расходов и меньше рывков; чаще — быстрее реакция на смену профиля трафика.
- **Принудительно выбрать коммуникатор** — когда автовыбор сел на `torch_gloo` (медленно, через CPU), а NIXL в окружении есть, но не подхватился.
- **Не трогайте `policy`.** Значение одно, а `use_async` с ним связан валидатором.
- **Не оставляйте `log_balancedness` включённым в проде** — в описании поля прямо сказано, что это стоит коммуникации на каждом шаге.

## Влияние на производительность и память

- **VRAM.** Единственный ключ, который её меняет, — `num_redundant_experts`: `NUM_MOE_LAYERS × BYTES_PER_EXPERT × (N_экспертов + N_избыточных) / ep_size` по оценке апстрима. `window_size` тоже занимает память под тензор статистики, но на порядки меньше.
- **Latency.** `use_async: false` даёт периодический всплеск на шаге перекладки. `log_balancedness: true` добавляет постоянную коммуникацию.
- **Throughput.** Улучшается ровно в той мере, в какой был перекос.
- **Хост.** `communicator: torch_gloo` проводит веса через CPU-буферы: трафик host↔device и нагрузка на RAM.
- **Время старта.** Не меняется.

## Взаимодействие с другими аргументами

- `--enable-eplb`: обязателен, чтобы этот конфиг что-то значил. Без него ненулевой `num_redundant_experts` — ошибка.
- `--enable-expert-parallel`: обязателен для самого EPLB.
- `--enable-elastic-ep`: при `use_async: true` требует установленного NIXL (`Elastic EP with async EPLB requires the NIXL package. Either install NIXL or set --eplb-config.use_async=false.`); влияет и на автовыбор коммуникатора.
- `--expert-placement-strategy`: `round_robin` откатывается на `linear`, если `num_redundant_experts != 0` или включён EPLB.
- `--gpu-memory-utilization`: бюджет не меняется, но избыточные эксперты в нём — новая статья.

## Типовые проблемы и диагностика

- **Симптом:** `Async EPLB is only supported with the default policy.` **Причина:** `policy` изменена при `use_async: true`. **Лечение:** вернуть `policy: default` либо `use_async: false`.
- **Симптом:** `torch_nccl communicator is incompatible with async EPLB due to NCCL multi-stream conflicts. Use 'torch_gloo' or 'nixl' instead, or leave communicator unset for automatic selection.` **Лечение:** буквально по тексту.
- **Симптом:** `log_balancedness_interval must be greater than 0.` **Причина:** нулевой или отрицательный интервал.
- **Симптом:** `num_redundant_experts is set to N but EPLB is not enabled.` **Причина:** конфиг задан, флаг — нет.
- **Симптом:** `Elastic EP with async EPLB requires the NIXL package.` **Лечение:** установить NIXL или задать `--eplb-config.use_async false`.
- **Симптом:** перекладка происходит, но throughput не растёт. **Проверка:** метрика балансированности при `log_balancedness: true` до и после; если она и так близка к 1, перекоса не было.
- **Подтверждение принятого значения:** стартовая строка конфига печатает разобранный `EPLBConfig`; в логе видны периодические сообщения о перекладке и обратный отсчёт `steps until the next rearrangement`.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --enable-eplb --tensor-parallel-size 4 --eplb-config '{"window_size":1000,"step_interval":3000,"num_redundant_experts":2,"log_balancedness":true}'
```

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --enable-eplb --tensor-parallel-size 4 --eplb-config.num_redundant_experts 2 --eplb-config.use_async false
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/eplb/eplb_state.py`
- `vllm/vllm/distributed/eplb/eplb_communicator.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
