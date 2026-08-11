---
schema: 1
engine: sglang
primaryName: "--sidecar-args"
title: "--sidecar-args"
summary: JSON-массив строк, который передается в `main(argv)` sidecar-модуля. Один ключ SGLang забирает себе — `--sidecar-shutdown-timeout SECONDS`; остальное уходит модулю без изменений. Без `--sidecar` аргумент отвергается на старте.
group: serving
related:
  - --sidecar
  - --grpc-port
  - --smg-grpc-mode
---

# --sidecar-args

## Кратко

Спутник `--sidecar`: сам по себе смысла не имеет и без него даёт ошибку старта. Значение — строго JSON-массив строк, который после одного вычета передается функции `main(argv)` запущенного модуля.

Вычет ровно один: `--sidecar-shutdown-timeout SECONDS` разбирается самим SGLang и до модуля не доходит. Все остальные элементы уходят в `argv` в исходном порядке.

## Оригинальная справка

```text
JSON array passed to the selected sidecar module's main(argv) function. --sidecar-shutdown-timeout SECONDS is consumed by SGLang.
```

## Паспорт аргумента

- Флаги: `--sidecar-args`
- Группа: `serving`
- Тип значения: JSON-массив строк (в extract `type: json`), разбирается парсером `json_list_type` на этапе argparse
- Допустимые значения: `choices` нет; каждый элемент массива обязан быть строкой
- Значение по умолчанию: `null` — модулю передается пустой `argv`
- Эффективное значение: `__post_init__` не переопределяет, но проверяет наличие `--sidecar` и то, что значение — список строк
- Где объявлен: `ServerArgs.sidecar_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`json_list_type`) → валидация в `__post_init__` → `start_sidecar` при запуске дочернего процесса

## Что меняет в движке

### Валидация

```python
if self.sidecar_args is not None:
    if self.sidecar is None:
        raise ValueError("--sidecar-args requires --sidecar.")
    if not isinstance(self.sidecar_args, list) or not all(isinstance(arg, str) for arg in self.sidecar_args):
        raise ValueError("--sidecar-args must be a JSON array of strings.")
```

### Разделение

`_parse_sidecar_args` (`sglang/python/sglang/srt/entrypoints/sidecar.py`) использует отдельный `ArgumentParser` с `add_help=False` и `allow_abbrev=False`:

```python
parser.add_argument("--sidecar-shutdown-timeout", type=float, default=_DEFAULT_SIDECAR_SHUTDOWN_TIMEOUT)
parsed, provider_args = parser.parse_known_args(args or [])
if parsed.sidecar_shutdown_timeout <= 0:
    raise ValueError("--sidecar-shutdown-timeout must be greater than 0.")
return provider_args, parsed.sidecar_shutdown_timeout
```

`_DEFAULT_SIDECAR_SHUTDOWN_TIMEOUT` равен `45.0`. `allow_abbrev=False` важен: сокращения вроде `--sidecar-shut` не распознаются, и такой элемент уйдет модулю как обычный аргумент.

Остаток (`provider_args`) передается в дочерний процесс третьим позиционным элементом и попадает прямо в `main(argv)`. Апстрим-тест `test_start_sidecar_passes_endpoint_and_provider_argv_separately` фиксирует это поведение: из `["--sidecar-shutdown-timeout", "42", "--grpc-connections", "2"]` модуль получает `["--grpc-connections", "2"]`, а тайм-аут становится `42.0`.

### Где используется тайм-аут

Только при остановке: `Sidecar.stop()` делает `terminate()` и `join(timeout=shutdown_timeout)`; если процесс жив — `kill_process_tree(pid, wait_timeout=shutdown_timeout)` с той же величиной.

## Значения и формат

- Одна JSON-строка с массивом: `--sidecar-args '["--flag","value"]'`.
- **Все элементы — строки.** Число (`42` вместо `"42"`) даёт `ValueError: --sidecar-args must be a JSON array of strings.` — в том числе для значения тайм-аута.
- Невалидный JSON отвергает парсер типа: `Invalid JSON list: <value>. Please provide a valid JSON list.`
- Пустой массив `[]` допустим и означает «пустой `argv`, тайм-аут по умолчанию». Обратите внимание: `[]` проходит проверку на `--sidecar`, потому что она сравнивает с `None`, а не на truthiness.
- `--sidecar-shutdown-timeout` — число секунд в виде строки, строго больше нуля; `"0"` и отрицательные дают `ValueError: --sidecar-shutdown-timeout must be greater than 0.`
- Формат разделения ключа и значения — два отдельных элемента массива (`["--sidecar-shutdown-timeout", "30"]`); форма `--sidecar-shutdown-timeout=30` одним элементом argparse тоже примет.

## Когда использовать

- Sidecar-модулю нужны параметры (адреса, пулы соединений, режимы) — это единственный способ их передать.
- Модуль медленно завершается или, наоборот, останавливается мгновенно, а 45-секундный дефолт затягивает рестарт сервера — укоротите `--sidecar-shutdown-timeout`.
- **Не нужен**, если модуль полностью конфигурируется переменными окружения: они наследуются дочерним процессом и так.

## Влияние на производительность и память

Собственного влияния нет: список строк передается один раз при запуске процесса. Косвенно на время остановки сервера влияет `--sidecar-shutdown-timeout` — это верхняя граница ожидания при shutdown.

## Взаимодействие с другими аргументами

- `--sidecar`: обязателен; без него — ошибка старта.
- `--grpc-port`: требуется самим `--sidecar`. Адрес gRPC передается **не** через `--sidecar-args`, а переменной окружения `SGLANG_GRPC_ENDPOINT`.
- `--smg-grpc-mode` / `--grpc-mode`: несовместимы с `--sidecar`, а значит и с этим аргументом.

## Типовые проблемы и диагностика

- `ValueError: --sidecar-args requires --sidecar.` — задан только этот аргумент.
- `ValueError: --sidecar-args must be a JSON array of strings.` — верхний уровень не массив либо в нем не только строки (частая причина — число без кавычек).
- `argparse.ArgumentTypeError: Invalid JSON list: … Please provide a valid JSON list.` — строка не разобралась как JSON; обычно съедены кавычки оболочкой.
- `ValueError: --sidecar-shutdown-timeout must be greater than 0.` — ноль или отрицательное значение тайм-аута.
- **Модуль получил `--sidecar-shutdown-timeout` в своем `argv`** — значит вы написали сокращенную форму ключа: `allow_abbrev=False`, сокращения не распознаются и уходят модулю.
- **Модуль не видит своих аргументов** — проверьте, что он читает именно `argv`, переданный в `main`, а не `sys.argv`: у spawn-процесса `sys.argv` принадлежит запускающему коду multiprocessing, а не вам.
- Принятое значение — в дампе `server_args=` при старте (уже как список Python).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000 --sidecar my_provider.sidecar --sidecar-args '["--grpc-connections","2"]'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000 --sidecar my_provider.sidecar --sidecar-args '["--sidecar-shutdown-timeout","15","--log-level","debug"]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/sidecar.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
