---
schema: 1
engine: sglang
primaryName: "--eplb-algorithm"
title: "--eplb-algorithm"
summary: Выбирает алгоритм, который по накопленной статистике активаций строит новую карту физических экспертов. Значение `auto` решает между плоским и иерархическим вариантом DeepSeek по делимости числа групп экспертов на число узлов; elastic EP сужает выбор до своих двух алгоритмов.
group: exec.moe
related:
  - --enable-eplb
  - --init-expert-location
  - --ep-num-redundant-experts
  - --elastic-ep-backend
  - --eplb-rebalance-num-iterations
  - --nnodes
  - --ep-size
---

# --eplb-algorithm

## Кратко

Аргумент участвует ровно в двух местах: при перебалансировке в рантайме (`ExpertLocationMetadata.init_by_eplb` из `EPLBManager.rebalance`) и при разборе `--init-expert-location`, если поданный файл содержит `logical_count`. Во всех остальных случаях он ни на что не влияет. Выбор алгоритма — это выбор между плоской раскладкой по всем рангам и иерархической, которая сперва раскладывает группы экспертов по узлам, а уже потом реплики внутри узла.

## Оригинальная справка

```text
Chosen EPLB algorithm
```

## Паспорт аргумента

- Флаги: `--eplb-algorithm`
- Группа: `exec.moe`
- Тип значения: str
- Допустимые значения: `choices` в объявлении нет, но список разрешим статически — это имена элементов перечисления `EplbAlgorithm` (`sglang/python/sglang/srt/eplb/eplb_algorithms/__init__.py`) плюс литерал `auto`. На момент commit'а checkout'а перечисление содержит `deepseek`, `deepseek_hierarchical`, `deepseek_vec`, `deepseek_vec_hierarchical`, `elasticity_aware`, `elasticity_aware_hierarchical`. Проверить на своей сборке: `python -c "from sglang.srt.eplb.eplb_algorithms import EplbAlgorithm; print([e.name for e in EplbAlgorithm])"`
- Значение по умолчанию: `auto`
- Эффективное значение: `_handle_elastic_ep` при заданном `--elastic-ep-backend` и включенном `--enable-eplb` заменяет `auto` на `elasticity_aware` и затем требует, чтобы значение было `elasticity_aware` или `elasticity_aware_hierarchical`. Без elastic EP `auto` разрешается позже, уже внутри `compute_algorithm`, и в дампе `server_args=` остается строкой `auto`
- Где объявлен: `ServerArgs.eplb_algorithm`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (только ветка elastic EP) → каждая перебалансировка либо разбор `--init-expert-location`

## Что меняет в движке

`eplb_algorithms.compute_algorithm` превращает строку в элемент перечисления. При `auto` решение принимается так: если модель публикует число групп экспертов (`num_groups` из `get_model_config_for_expert_location`) и оно делится на число узлов, берется `deepseek_hierarchical`, иначе `deepseek`. Любое другое значение отображается напрямую через `EplbAlgorithm[...]`, поэтому опечатка дает `KeyError` уже во время перебалансировки, а не на старте.

Дальше `rebalance_experts` разводит семейства:

- **`deepseek` / `deepseek_hierarchical`** — эталонная реализация DeepSeek (`eplb_algorithms/deepseek.py`), работает по суммарным счетчикам за окно (`tokens_per_expert.sum(dim=0)`). Иерархический вариант получает реальные `num_groups`/`num_nodes` и старается держать группу экспертов внутри одного узла, чтобы a2a-трафик шел по NVLink, а не по RDMA. Плоский вариант вызывает ту же функцию с `num_groups=1, num_nodes=1`, то есть балансирует по всем GPU без учета топологии.
- **`deepseek_vec` / `deepseek_vec_hierarchical`** (`eplb_algorithms/deepseek_vec.py`) — векторизованный вариант, которому передается не сумма, а весь буфер по шагам `(steps, layers, experts)`. Иерархический вариант идет по пути `prefill_rebalance_experts`, плоский — `decode_rebalance_experts`; то есть разделение здесь не «узлы против плоскости», а «раскладка под prefill против раскладки под decode».
- **`elasticity_aware` / `elasticity_aware_hierarchical`** (`eplb_algorithms/elasticity_aware.py`) — то же ядро, но с учетом маски живых рангов из `ElasticEPStateManager`. Если часть рангов выпала, алгоритм принудительно переходит на глобальную политику и раскладывает экспертов только по активным рангам.

Результат — тройка `physical_to_logical_map`, `logical_to_all_physical_map`, `expert_count`, из которой собирается новая `ExpertLocationMetadata`.

## Значения и формат

- `auto` — рекомендуемое значение для обычной (не elastic) конфигурации: движок сам выберет иерархию, когда она применима.
- `deepseek_hierarchical` имеет смысл принудительно только если вы хотите иерархию вопреки тому, что `num_groups` не делится на `nnodes`; в этом случае деление возьмет на себя сам алгоритм, и корректность раскладки надо проверять по логу.
- `deepseek` — плоская раскладка; на одном узле она эквивалентна иерархической.
- `deepseek_vec*` — экспериментальное семейство, чувствительное к форме буфера статистики; при коротком окне (`--expert-distribution-recorder-buffer-size`) данных на шаг мало.
- `elasticity_aware*` — только вместе с `--elastic-ep-backend`; без него алгоритм обратится к `ElasticEPStateManager`, который не инициализирован, и раскладка будет считаться по «здоровому» состоянию рангов по умолчанию.
- Регистр и написание — точно как имя элемента перечисления; никаких дефисов.

## Когда использовать

- Многоузловая EP-группа, модель с группами экспертов (DeepSeek-V3 и родственные): оставляйте `auto` — он и даст `deepseek_hierarchical`, который экономит межузловой трафик.
- Один узел: значение не важно, `auto` даст `deepseek` или `deepseek_hierarchical` с `num_nodes=1` — раскладка одна и та же.
- Elastic EP: не задавайте руками, дайте `_handle_elastic_ep` подставить `elasticity_aware`; ручное значение из другого семейства отвергается ассертом.
- Не подбирайте алгоритм раньше, чем убедитесь, что перебалансировка вообще происходит: посмотрите `[EPLBManager] rebalance start` в логе.

## Влияние на производительность и память

- Алгоритм считается на CPU внутри паузы перебалансировки. Иерархические варианты делают больше работы (сортировки и упаковка групп по узлам), но на масштабе «десятки слоев × сотни экспертов» это доли секунды на фоне переноса весов.
- На VRAM аргумент не влияет: число физических экспертов задается `--ep-num-redundant-experts`, а не алгоритмом.
- На throughput влияет косвенно и заметно: иерархическая раскладка держит горячие группы экспертов внутри узла, что снижает RDMA-трафик DeepEP.

## Взаимодействие с другими аргументами

- `--enable-eplb`: без него алгоритм применяется только через `--init-expert-location` с `logical_count`.
- `--init-expert-location`: второй потребитель значения — статическая раскладка считается тем же алгоритмом.
- `--elastic-ep-backend`: переопределяет `auto` и ограничивает набор допустимых значений.
- `--nnodes`: вместе с числом групп экспертов модели решает исход `auto`.
- `--ep-num-redundant-experts`: задает, сколько реплик алгоритму разрешено расставить.
- `--expert-distribution-recorder-buffer-size`: определяет, сколько шагов статистики увидит векторизованное семейство.

## Типовые проблемы и диагностика

- `KeyError: '<значение>'` во время первой перебалансировки — опечатка в имени алгоритма; проверьте список командой из «Паспорта».
- `AssertionError: Elastic EP requires eplb_algorithm to be set to 'auto' or 'elasticity_aware(_hierarchical)'.` — задан алгоритм из семейства DeepSeek вместе с `--elastic-ep-backend`.
- Перебалансировка идет, а перекос не уменьшается — сравните раскладку до и после: переменная `SGLANG_LOG_EXPERT_LOCATION_METADATA` включает печать layout и диффа в `[EPLBManager] rebalance layout ...`.
- Нужно понять, во что развернулся `auto`, — в `server_args=` останется `auto`, реальное решение видно только через ту же переменную окружения либо по факту распределения экспертов в дампе layout.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-eplb --eplb-algorithm deepseek_hierarchical --ep-num-redundant-experts 32
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --init-expert-location /tmp/expert_distribution_recorder_1754900000.0.pt --eplb-algorithm deepseek
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/eplb_algorithms/__init__.py`
- `sglang/python/sglang/srt/eplb/eplb_algorithms/deepseek.py`
- `sglang/python/sglang/srt/eplb/eplb_algorithms/deepseek_vec.py`
- `sglang/python/sglang/srt/eplb/eplb_algorithms/elasticity_aware.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
