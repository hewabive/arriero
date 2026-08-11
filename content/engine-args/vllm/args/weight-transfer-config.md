---
schema: 1
engine: vllm
primaryName: "--weight-transfer-config"
title: "--weight-transfer-config"
summary: JSON-объект `WeightTransferConfig` из одного поля `backend` — включает движок горячей замены весов, которым RL-тренер обновляет модель прямо в работающем инстансе. Для инференс-сервера бесполезен: без dev-эндпоинтов вызвать его нечем.
group: VllmConfig
related:
  - --enable-sleep-mode
  - --enable-cumem-allocator
  - --load-format
  - --model
  - --worker-extension-cls
---

# --weight-transfer-config

## Кратко

`--weight-transfer-config` заполняет `WeightTransferConfig` (`vllm/config/weight_transfer.py`) — датакласс ровно с одним полем `backend`. Непустое значение заставляет каждый воркер сразу после загрузки модели создать weight-transfer engine через `WeightTransferEngineFactory`, который потом принимает новые веса от внешнего тренера.

Это узкая интеграция под RLHF-цикл (обучение и инференс в одном кластере), а не эксплуатационная ручка. Управляется она только dev-эндпоинтами `/init_weight_transfer_engine`, `/update_weights`, `/pause`, которые регистрируются лишь при `VLLM_SERVER_DEV_MODE=1` и сопровождаются предупреждением `SECURITY WARNING: Development endpoints are enabled! This should NOT be used in production!`. На обычном инференс-сервере конфиг создает движок, к которому никто не обратится.

## Оригинальная справка

```text
The configurations for weight transfer during RL training.
```

## Паспорт аргумента

- Флаги: `--weight-transfer-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект с единственным полем `backend` (либо точечный под-флаг `--weight-transfer-config.backend <значение>`)
- Допустимые значения: имя из реестра `WeightTransferEngineFactory`; тип поля объявлен как `Literal["nccl","ipc","sparse_nccl"] | str`, то есть строка не ограничена литералами и проверяется уже при создании движка
- Значение по умолчанию: `None` — движок не создается
- Эффективное значение: не переопределяется. `EngineArgs.__post_init__` дополнительно превращает переданный словарь в объект `WeightTransferConfig`, если конфигурация приходит из Python, а не с CLI
- Где объявлен: `vllm/config/vllm.py:VllmConfig.weight_transfer_config`
- Этап применения: разбор CLI → `Worker.load_model()` (создание движка сразу после загрузки весов) → вызовы dev-эндпоинтов во время работы

## Что меняет в движке

Единственное поле:

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `backend` | `"nccl"` (внутри объекта; сам объект по умолчанию `None`) | какой транспорт использовать для приема весов. В дереве зарегистрированы `nccl` (процесс-группа с тренером), `ipc` (передача через CUDA IPC на одной машине) и `sparse_nccl` (частичное обновление) |

`Worker.load_model()` создает движок, передавая ему конфиг, полный `VllmConfig`, устройство воркера и загруженную модель. Дальше движок ждет вызовов:

- `init_weight_transfer_engine(init_info)` — установить соединение с тренером (для NCCL это создание процесс-группы);
- обновление весов — тренер шлет новые тензоры, движок пишет их в уже размещенную модель;
- `/pause` — остановить генерацию на время обновления (`abort` или ожидание in-flight запросов, с очисткой кэша).

Если конфиг не задан, любой вызов этих операций падает с `Weight transfer not configured. Please set weight_transfer_config to enable weight transfer.`

## Значения и формат

- Обе формы: `--weight-transfer-config '{"backend":"nccl"}'` и `--weight-transfer-config.backend nccl`.
- Значение валидируется на разборе CLI как датакласс, но поле `backend` типизировано с `| str`, поэтому произвольная строка проходит валидацию и отвергается позже: `Invalid weight transfer backend: X. Available engines: [...]` — со списком доступных прямо в сообщении.
- **Список движков собирается в runtime** из `WeightTransferEngineFactory` (`vllm/distributed/weight_transfer/factory.py`) и расширяется через `register_engine`. На момент снятого снимка зарегистрированы `nccl`, `ipc`, `sparse_nccl`.
- Специальных значений (`auto`, `none`) нет: чтобы выключить механизм, не задавайте флаг вовсе.

## Когда использовать

- **RLHF/RL-обучение**, где инференс-инстанс vLLM выступает генератором ролловов и должен подхватывать обновленные веса без перезапуска.
- **Только вместе с `VLLM_SERVER_DEV_MODE=1`**, иначе управлять движком нечем.
- **Не включайте на инференс-сервере.** Помимо бесполезности, dev-эндпоинты дают неаутентифицированную возможность подменить веса и поставить генерацию на паузу; апстрим предупреждает об этом отдельной строкой в логе.
- **В arriero-инстансе не используйте**: горячая подмена весов ломает и оценку памяти, и config-drift detection (снимок запуска не меняется, а поведение модели меняется).

## Влияние на производительность и память

- **VRAM.** Сам движок памяти почти не занимает; расход появляется в момент приема весов — часть транспортов держит промежуточные буферы. Пиковое потребление во время обновления не учитывается профилированием памяти при старте, поэтому запас должен быть заложен вручную.
- **Latency/throughput.** В покое влияния нет. Во время обновления генерация останавливается через `/pause`.
- **Время старта.** Создание движка выполняется после загрузки весов и добавляет к старту установку соединения только при явном вызове инициализации.

## Взаимодействие с другими аргументами

- `--enable-sleep-mode`, `--enable-cumem-allocator`: типичные спутники RL-сценария — они позволяют освобождать VRAM между фазами обучения и генерации.
- `--load-format`, `--model`: определяют исходные веса; трансфер заменяет их значения, но не структуру модели.
- `--worker-extension-cls`: альтернативный способ добавить собственные RPC-методы в воркер; часто используется в тех же RL-интеграциях.
- С памятью, планировщиком, компиляцией и KV-cache конфиг не взаимодействует.

## Типовые проблемы и диагностика

- **Симптом:** `Invalid weight transfer backend: X. Available engines: ['nccl', 'ipc', 'sparse_nccl']` при старте. **Лечение:** взять имя из списка в сообщении.
- **Симптом:** `Weight transfer not configured. Please set weight_transfer_config to enable weight transfer.` **Причина:** вызов операции без конфига. **Лечение:** задать флаг и перезапустить сервер.
- **Симптом:** эндпоинты `/init_weight_transfer_engine` и `/update_weights` отвечают 404. **Причина:** не задан `VLLM_SERVER_DEV_MODE=1`, dev-роутеры не зарегистрированы. **Лечение:** включить переменную окружения — осознавая, что вместе с ней открываются все dev-эндпоинты.
- **Симптом:** обновление весов зависает. **Причина:** тренер и инстанс не сошлись в параметрах процесс-группы NCCL. **Лечение:** сверить `init_info`, передаваемое в `/init_weight_transfer_engine`.
- **Подтверждение принятого значения:** строка о создании weight-transfer engine в логе воркера после загрузки модели и предупреждение `SECURITY WARNING: Development endpoints are enabled!` при включенном dev-режиме.

## Примеры

```bash
vllm serve /models/Qwen3-4B --weight-transfer-config '{"backend":"nccl"}' --enable-sleep-mode
```

```bash
vllm serve /models/Qwen3-4B --weight-transfer-config.backend ipc --gpu-memory-utilization 0.6
```

## Источники

- `vllm/vllm/config/weight_transfer.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/weight_transfer/factory.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/entrypoints/serve/dev/rlhf/api_router.py`
- `vllm/vllm/entrypoints/serve/__init__.py`
