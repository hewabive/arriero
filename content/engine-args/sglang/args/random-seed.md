---
schema: 1
engine: sglang
primaryName: "--random-seed"
title: "--random-seed"
summary: Общее зерно ГПСЧ для всех воркеров. Не задано — движок каждый старт берет случайное; воспроизводимость выдачи одним этим аргументом не достигается.
group: device
related:
  - --enable-deterministic-inference
  - --sampling-backend
  - --tp-size
  - --dp-size
  - --speculative-algorithm
---

# --random-seed

## Кратко

`--random-seed` задает единое зерно для `random`, `numpy`, `torch` и CUDA-генераторов во всех процессах экземпляра. Значение по умолчанию — не константа: при незаданном аргументе `__post_init__` подставляет `random.randint(0, 1 << 30)`, поэтому каждый перезапуск получает свое зерно, и оно попадает в дамп `server_args=`. Само по себе фиксированное зерно **не делает выдачу воспроизводимой**: для этого существует `--enable-deterministic-inference`, потому что на результат влияют еще и состав батча, порядок редукций и выбранные ядра.

## Оригинальная справка

```text
The random seed.
```

## Паспорт аргумента

- Флаги: `--random-seed`
- Группа: `device`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `choices` нет; диапазон не проверяется. Автоподставляемое значение лежит в `[0, 2^30]`
- Значение по умолчанию: `null`
- Эффективное значение: `_handle_missing_default_values` заменяет `null` на `random.randint(0, 1 << 30)`. Дальше значение **синхронизируется по группе**: `TpModelWorker` делает `broadcast_pyobj([server_args.random_seed], …, src=world_group.ranks[0])`, то есть эффективным становится зерно нулевого ранга — даже если на других рангах в аргументах стояло другое число. Исключение — elastic-EP-присоединители (`is_ep_joiner`), которые не участвуют в стартовом broadcast и берут свое значение
- Где объявлен: `ServerArgs.random_seed`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `TpModelWorker.__init__` (broadcast + `set_random_seed`) → `Scheduler` (`set_random_seed` еще раз, уже полученным от воркера значением)

## Что меняет в движке

`set_random_seed(seed)` (`sglang/python/sglang/srt/utils/common.py`) выставляет четыре генератора:

```python
random.seed(seed)
np.random.seed(seed)
torch.manual_seed(seed)
if torch.cuda.is_available(): torch.cuda.manual_seed_all(seed)
if torch.xpu.is_available(): torch.xpu.manual_seed_all(seed)
```

Вызывается это дважды: в `TpModelWorker.__init__` сразу после broadcast и в `Scheduler.__init__` после получения `random_seed` из `get_worker_info()`. Значение уходит и обратно наружу — оно входит в набор полей, которые scheduler отдает по `/get_internal_state`.

Практически на выдачу зерно влияет через:

- сэмплирование при `temperature > 0` — состояние глобального CUDA-генератора;
- инициализацию весов там, где они не загружаются (dummy-load, тесты);
- любые случайные компоненты спекулятивного декодирования и служебных прогревов.

Отдельно существует **позапросное** зерно `sampling_seed` в параметрах сэмплирования (`sglang/python/sglang/srt/sampling/sampling_params.py`). Оно не связано с `--random-seed`, обрабатывается в `layers/sampler.py` и является тем механизмом, которым клиент получает повторяемость конкретного запроса под `--enable-deterministic-inference`.

## Значения и формат

- Целое. Отрицательные значения argparse примет, `random.seed`/`torch.manual_seed` их тоже принимают, но смысла в них нет.
- Не задавать — значит «случайное на каждый старт», а не «фиксированное умолчание».
- Значение глобально для экземпляра: асимметричные зерна по рангам невозможны из-за broadcast.
- Изменение зерна не требует перезагрузки весов, но применяется только при старте: на лету менять нечем.

## Когда использовать

- Воспроизводимые прогоны бенчмарков и A/B-сравнений: одно зерно на все запуски убирает один источник разброса. Для полной повторяемости выдачи добавляйте `--enable-deterministic-inference` и позапросный `sampling_seed`.
- Отладка редко воспроизводимого дефекта в сэмплировании — зафиксировав зерно, вы хотя бы получаете шанс повторить последовательность.
- Не задавать в продакшене без нужды: одинаковое зерно на всех репликах делает выдачу реплик коррелированной, что обычно нежелательно.
- Не рассчитывать, что одно зерно даст побайтово одинаковые ответы: при `temperature 0` результат и так почти детерминирован, а при `temperature > 0` на него влияет состав батча, из-за которого меняется порядок операций.

## Влияние на производительность и память

- На производительность и память не влияет: аргумент задает только начальное состояние генераторов.

## Взаимодействие с другими аргументами

- `--enable-deterministic-inference`: настоящий механизм воспроизводимости. Он фиксирует backend сэмплирования, backend внимания, алгоритм NCCL-all-reduce и число каналов; `--random-seed` без него даст повторяемость только при неизменном составе батчей.
- `--sampling-backend`: определяет, какой код читает состояние генератора; на `pytorch`-backend'е это стандартные генераторы torch.
- `--tp-size` / `--pp-size` / `--dp-size`: определяют, сколько процессов синхронизируют зерно через broadcast мировой группы.
- `--speculative-algorithm`: draft-воркер получает то же синхронизированное зерно.

## Типовые проблемы и диагностика

- «Задал зерно, а ответы все равно разные» — ожидаемо без `--enable-deterministic-inference`: при конкурентной нагрузке состав батча меняет порядок редукций. Проверьте гипотезу, отправив тот же запрос на пустом сервере последовательно.
- «Разные ранги получили разные зерна» — невозможно после broadcast; если в логах разных рангов видно разное `random_seed`, это дамп `server_args=` **до** синхронизации, а не эффективное значение.
- Нужно узнать зерно уже работающего сервера: `curl http://<host>:<port>/get_internal_state` — `random_seed` входит в состояние scheduler'а.
- Что смотреть в логе: `random_seed=` в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --random-seed 42
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --random-seed 42 --enable-deterministic-inference
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/layers/sampler.py`
- `sglang/python/sglang/srt/sampling/sampling_params.py`
