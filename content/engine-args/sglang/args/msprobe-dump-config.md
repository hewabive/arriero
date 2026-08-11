---
schema: 1
engine: sglang
primaryName: "--msprobe-dump-config"
title: "--msprobe-dump-config"
summary: Узкая отладочная интеграция с msProbe из экосистемы Ascend MindStudio: подключает подампливание тензоров вокруг каждого forward. Сам факт задания пути выключает CUDA graph и прогрев — даже если пакет msprobe не установлен и дампа не будет.
group: observability
related:
  - --debug-tensor-dump-output-folder
  - --skip-server-warmup
  - --disable-cuda-graph
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --device
---

# --msprobe-dump-config

## Кратко

Путь к JSON-конфигурации msProbe (`PrecisionDebugger`). При заданном значении `ModelRunner` создает отладчик и оборачивает каждый forward парой `start()` / `stop() + step()`, выгружая тензоры по правилам из этого файла.

Главное, что надо знать до включения: аргумент имеет побочные эффекты **на уровне разбора аргументов**, и они наступают независимо от того, установлен ли msProbe:

```python
if self.msprobe_dump_config is not None:
    logger.warning(
        "When msProbe is enabled, "
        "cuda graph is disabled because msProbe only supports dump in eager mode, "
        "warmup is disabled(skip_server_warmup=True) because there is no need to dump data for this stage."
    )
    self.cuda_graph_config.decode.backend = Backend.DISABLED
    self.cuda_graph_config.prefill.backend = Backend.DISABLED
    self.skip_server_warmup = True
```

Если пакета в окружении нет, `create_msprobe_debugger` напечатает предупреждение и вернет `None` — дампа не будет, а CUDA graph и прогрев останутся выключенными. Это тихая и очень дорогая деградация производительности.

## Оригинальная справка

```text
The path of the JSON configuration file for msProbe. If specified, enables msProbe dump.
```

## Паспорт аргумента

- Флаги: `--msprobe-dump-config`
- Группа: `observability`
- Тип значения: str — путь к файлу JSON
- Допустимые значения: `choices` нет. Существование файла SGLang не проверяет; путь передается в `PrecisionDebugger(config_path=...)`, и разбор — забота msProbe
- Значение по умолчанию: `None` — интеграция выключена
- Эффективное значение: значение не переписывается, но **переписывает другие**: `cuda_graph_config.decode.backend` и `cuda_graph_config.prefill.backend` становятся `DISABLED`, `skip_server_warmup` становится `True`
- Где объявлен: `ServerArgs.msprobe_dump_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный аргумент узкоспециальной отладочной интеграции, а не эксплуатационная настройка
- Этап применения: `__post_init__` (выключение графов и прогрева) → `ModelRunner.init_msprobe` → каждый forward

## Что меняет в движке

### Создание отладчика

`create_msprobe_debugger` (`sglang/python/sglang/srt/model_executor/model_runner_components/misc_utils.py`):

```python
try:
    from msprobe.pytorch import PrecisionDebugger, seed_all
except ImportError:
    logger.warning(
        "Please install msprobe for tensor data dump: pip install mindstudio-probe --pre, "
        "see https://gitcode.com/Ascend/msprobe for details."
    )
    return None

seed_all(mode=True)
return PrecisionDebugger(config_path=server_args.msprobe_dump_config)
```

Обратите внимание на `seed_all(mode=True)`: перед созданием отладчика вызывается функция фиксации случайности из msProbe. Это меняет поведение сэмплирования и, как правило, включает детерминированные реализации операций — то есть влияет и на результаты, и на скорость, помимо самого дампа.

Проверки устройства здесь нет: SGLang не требует NPU. Будет ли пакет работать на вашей платформе, определяет сам msProbe.

### Обертка forward

В `ModelRunner.forward` (`sglang/python/sglang/srt/model_executor/model_runner.py`):

- перед вызовом модели — `self.msprobe_debugger.start(model=self.model, rank_id=rank_id)`, где `rank_id` равен `gpu_id` при `attn_dp_size > 1` и `None` иначе;
- после — `stop()` и `step()`.

Куда, что и в каком объеме выгружается, определяет JSON-конфигурация msProbe, а не SGLang.

## Значения и формат

- Путь к существующему файлу JSON: `--msprobe-dump-config /root/msprobe/config.json`.
- Относительный путь разрешается относительно рабочего каталога процесса.
- Ошибки в файле проявятся как исключение из `PrecisionDebugger` при инициализации `ModelRunner`, то есть падением scheduler-процесса на старте.
- Отключается только удалением аргумента; «пустого» значения, эквивалентного выключению, нет — пустая строка не равна `None`, а значит, побочные эффекты в `__post_init__` сработают.

## Когда использовать

- Разбор расхождений точности между эталонной и рабочей реализацией на отдельном стенде, когда нужен пооперационный дамп тензоров.
- Только вручную и только на время эксперимента. Это не то, что оставляют в определении инстанса.
- Не используйте как «включатель eager-режима»: если задача — выключить CUDA graph, для этого есть `--disable-cuda-graph` и `--cuda-graph-backend-decode/--cuda-graph-backend-prefill`, без побочной фиксации сидов и без зависимости от стороннего пакета.

## Влияние на производительность и память

- **Скорость decode падает кратно** — CUDA graph выключен по обеим фазам. Это самый заметный эффект, и он наступает даже без установленного msProbe.
- **Старт быстрее, первый запрос медленнее** — прогрев пропущен (`skip_server_warmup=True`), поэтому первые запросы платят за компиляцию и прогрев ядер.
- **Диск** — объем дампа определяется конфигурацией msProbe и на реальной модели измеряется гигабайтами.
- **VRAM/RAM** — msProbe копирует тензоры для выгрузки; пиковое потребление растет непредсказуемо, пропорционально охвату дампа.
- `seed_all(mode=True)` может дополнительно замедлить работу за счет детерминированных реализаций операций.

## Взаимодействие с другими аргументами

- `--disable-cuda-graph`, `--cuda-graph-backend-decode`, `--cuda-graph-backend-prefill`: значения, которые вы зададите, будут перезаписаны на `DISABLED` для обеих фаз.
- `--skip-server-warmup`: принудительно становится `True`.
- `--debug-tensor-dump-output-folder`: соседний, независимый механизм дампа тензоров в самом SGLang с ровно такими же побочными эффектами (тоже выключает CUDA graph и прогрев). Если нужен именно дамп средствами SGLang, используйте его, а не msProbe.
- `--device`: интеграция родом из экосистемы Ascend; на CUDA работоспособность определяется пакетом msProbe, а не SGLang.
- `--dp-size` / `--enable-dp-attention`: влияют на то, будет ли передан `rank_id` в `start()`.

## Типовые проблемы и диагностика

- **Симптом:** в логе `Please install msprobe for tensor data dump: pip install mindstudio-probe --pre …`, дампа нет, а сервер стал заметно медленнее. **Причина:** пакет не установлен, но CUDA graph и прогрев уже выключены `__post_init__`. **Лечение:** убрать аргумент или установить пакет.
- **Симптом:** при старте предупреждение `When msProbe is enabled, cuda graph is disabled …`. **Причина:** это ожидаемое поведение, а не ошибка.
- **Симптом:** scheduler падает на инициализации `ModelRunner` с исключением из msProbe. **Причина:** файл конфигурации отсутствует или не соответствует схеме msProbe. **Лечение:** проверить путь и содержимое по документации msProbe.
- **Симптом:** результаты генерации изменились после включения. **Причина:** `seed_all(mode=True)`. **Лечение:** сравнивать только между запусками с одинаковой настройкой.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `msprobe_dump_config=`, а рядом должно быть предупреждение про отключение CUDA graph.

## В arriero

- Аргумент несовместим с эксплуатацией управляемого инстанса: отключение CUDA graph по обеим фазам меняет и скорость, и профиль потребления памяти, из-за чего измеренные оценки памяти (`docs/MEMORY_ESTIMATION.md`, arriero) перестают соответствовать реальности, а фоновая переоценка увидит дрейф отпечатка.
- Предупреждение при старте содержит слово `disabled`, но не содержит слов, на которые реагирует разбор лога arriero (`apps/api/src/process/log-parsers/sglang.ts`); строка про отсутствующий пакет тоже не переводит инстанс в `degraded`. То есть по карточке инстанса вы не увидите, что дампа нет, а производительность уже потеряна — только по логу.
- Практический вывод: если нужен такой дамп, поднимайте отдельный временный инстанс с этим аргументом и удаляйте его после эксперимента, не трогая рабочее определение.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --msprobe-dump-config /root/msprobe/dump.json
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --debug-tensor-dump-output-folder /root/tensor-dump
```

## Источники

- `sglang/python/sglang/srt/model_executor/model_runner_components/misc_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/MEMORY_ESTIMATION.md`, `apps/api/src/process/log-parsers/sglang.ts`
