---
schema: 1
engine: sglang
primaryName: "--custom-weight-loader"
title: "--custom-weight-loader"
summary: Список import-путей к функциям, которые разрешено вызывать как `load_format` в API обновления весов из тензоров. К загрузке модели со старта отношения не имеет.
group: model
related:
  - --load-format
  - --checkpoint-engine-wait-weights-before-ready
  - --model-path
  - --weight-cache-mode
---

# --custom-weight-loader

## Кратко

Несмотря на название, аргумент не участвует в первичной загрузке модели. Это **белый список** функций, которые внешний обучающий цикл может назвать в поле `load_format` запроса `update_weights_from_tensor`. Значение — список import-путей вида `my_package.weight_load_func`; при вызове путь резолвится через `dynamic_import` и функция получает `(model, named_tensors)`. Аргумент нужен только в RL/онлайн-дообучении и в интеграциях вроде checkpoint-engine.

## Оригинальная справка

```text
The custom dataloader which used to update the model. Should be set with a valid import path, such as my_package.weight_load_func
```

## Паспорт аргумента

- Флаги: `--custom-weight-loader`
- Группа: `model`
- Тип значения: список строк (`Optional[List[str]]`, объявлен с `nargs="*"`)
- Допустимые значения: import-пути, разрешимые в окружении сервера
- Значение по умолчанию: `null`
- Эффективное значение: `_handle_load_format` в `__post_init__` заменяет `None` на пустой список, поэтому в рантайме поле всегда список
- Где объявлен: `ServerArgs.custom_weight_loader`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но узкоспециальный
- Этап применения: инициализация `WeightUpdater` в `ModelRunner`; фактическое использование — при обработке запроса обновления весов

## Что меняет в движке

`ModelRunner.init_weight_updater` передает список в `WeightUpdater(custom_weight_loaders=get_model().custom_weight_loader, …)`. Дальше, в `model_runner_components/weight_updater.py`, при обновлении весов из тензоров:

```python
if load_format == "direct":
    _model_load_weights_direct(self.get_model(), named_tensors)
elif load_format in self.custom_weight_loaders:
    custom_loader = dynamic_import(load_format)
    custom_loader(self.get_model(), named_tensors)
elif load_format is None:
    self.get_model().load_weights(named_tensors)
else:
    raise NotImplementedError(f"Unknown load_format={load_format}")
```

То есть `load_format` в теле запроса — это либо `"direct"`, либо `"flattened_bucket"`, либо `None`, либо **строка из этого списка**. Любое другое значение получает `NotImplementedError`. Список работает именно как разрешающий: без него произвольный import-путь вызвать нельзя.

Сигнатура пользовательской функции — `(model, named_tensors)`, где `named_tensors` — список пар `(имя, тензор)`, уже развернутых на нужное устройство и по нужному TP-rank'у.

## Значения и формат

- `nargs="*"` означает, что после флага перечисляются значения через пробел: `--custom-weight-loader pkg.a pkg.b`. Флаг без значений даст пустой список.
- Каждый элемент — точечный import-путь до **функции**, а не до модуля.
- Строка в запросе должна совпадать с элементом списка **символ в символ**: сравнение обычное, без нормализации.
- Модуль должен быть импортируем из процесса воркера — то есть лежать в `PYTHONPATH` окружения, из которого запущен сервер (для arriero это неизменяемое uv-окружение, `docs/ENVIRONMENTS.md`).

## Когда использовать

- Онлайн-обновление весов из внешнего тренера, когда формат тензоров не совпадает с тем, что понимает `model.load_weights`.
- Интеграция с checkpoint-engine и подобными, где веса приходят по IPC и требуют собственной раскладки.
- Не нужен для обычного инференса: если вы не вызываете `update_weights_from_tensor` с кастомным `load_format`, аргумент бесполезен.
- Не путайте с `--load-format`: тот выбирает загрузчик стартовых весов, этот — функцию обновления уже поднятой модели.

## Влияние на производительность и память

Сам по себе аргумент только хранит список строк — ни VRAM, ни времени старта он не стоит. Стоимость целиком на стороне вызываемой функции: она работает с уже материализованными тензорами на устройстве, и всё, что она аллоцирует, добавляется к текущему расходу VRAM во время обновления.

## Взаимодействие с другими аргументами

- `--checkpoint-engine-wait-weights-before-ready`: типичная пара — сервер ждет первую заливку весов, которая приходит через тот же механизм обновления.
- `--load-format`: несвязанный слой (стартовая загрузка).
- `--weight-cache-mode`: обновление весов из тензоров несовместимо с активным weight cache — `WeightUpdater` проверяет это отдельно и возвращает ошибку.
- `--model-path`: модель, чьи веса будут переписаны; архитектура должна совпадать с тем, что присылает тренер.

## Типовые проблемы и диагностика

- `NotImplementedError: Unknown load_format=<path>` в ответе на обновление весов — путь не перечислен в `--custom-weight-loader`.
- `ModuleNotFoundError` при вызове — модуль не виден процессу воркера; проверьте окружение, а не аргумент.
- Обновление проходит с `"Success"`, но модель отвечает как раньше — функция получила тензоры и ничего не записала; проверяйте её саму, движок здесь только диспетчер.
- Значение списка, как его принял движок, — в дампе `server_args=` при старте (там он уже нормализован в список).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --custom-weight-loader my_package.weight_load_func
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --custom-weight-loader my_package.loader_a my_package.loader_b --checkpoint-engine-wait-weights-before-ready
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/weight_updater.py`
- arriero: `docs/ENVIRONMENTS.md`
