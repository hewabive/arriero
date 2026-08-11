---
schema: 1
engine: sglang
primaryName: "--forward-hooks"
title: "--forward-hooks"
summary: JSON-список спецификаций forward-хуков PyTorch, которые движок навешивает на модули модели по glob-шаблонам. Импортирует и вызывает произвольный Python-код и не срабатывает под CUDA graph.
group: observability
related:
  - --cuda-graph-config
  - --debug-tensor-dump-output-folder
  - --debug-tensor-dump-layers
  - --msprobe-dump-config
  - --enable-torch-compile
  - --speculative-algorithm
---

# --forward-hooks

## Кратко

Расширительная точка для собственной инструментации: вы описываете в JSON, какие модули модели пометить и какой фабричный вызов должен вернуть хук, а движок после захвата CUDA graph навешивает результат через `torch.nn.Module.register_forward_hook`. Два свойства определяют всю практику применения. Первое: хуки навешиваются **после** захвата графов и потому не срабатывают на replay — при включенном decode-графе ваш хук не увидит ни одной decode-итерации. Второе: значение `hook_factory` — это путь для `importlib.import_module`, то есть аргумент выполняет произвольный код в процессе движка.

## Оригинальная справка

```text
JSON-formatted forward hook specifications to attach to the model.
```

## Паспорт аргумента

- Флаги: `--forward-hooks`
- Группа: `observability`
- Тип значения: одна строка, разбираемая `json_list_type` (`orjson.loads`); ожидается JSON-массив объектов (`Optional[List[dict[str, Any]]]`)
- Допустимые значения: `choices` нет. Что результат разбора — именно список словарей, не проверяется; при другой форме ошибка вылезет позже, при обходе спецификаций
- Значение по умолчанию: `null` — хуков нет
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.forward_hooks`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `capture_cuda_graphs` в model runner'е, **после** захвата графов prefill и decode, до предвыделения symmetric memory pool

## Что меняет в движке

`capture_cuda_graphs` (`sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`) в конце вызывает `register_forward_hooks(model_runner.model, server_args.forward_hooks)`. Комментарий в коде объясняет порядок: захват должен остаться свободным от хуков, чтобы их тензорные операции не попали в граф, а replay графа Python-хуки все равно не исполняет.

`register_forward_hooks` (`sglang/python/sglang/srt/model_executor/hook_manager.py`) для каждой спецификации:

1. читает `name` (только для сообщений), `target_modules`, `hook_factory`, `config`;
2. при отсутствии `target_modules` или `hook_factory` пишет предупреждение и **пропускает** спецификацию — старт не падает;
3. разрешает `hook_factory` через `resolve_callable`: путь вида `module.submodule:factory` или `module.submodule.factory`, дальше `importlib.import_module` и `getattr`;
4. вызывает `hook_factory(config)`; если вернулся `None`, пишет предупреждение и пропускает;
5. сопоставляет `target_modules` с именами из `model.named_modules()` по `fnmatch` (то есть шаблоны в стиле glob: `model.layers.*.mlp`); если совпадений нет — предупреждение и пропуск;
6. на каждый совпавший модуль вызывает `module.register_forward_hook(hook)` и пишет `Registered forward hook '<name>' on <module_name>`.

Сигнатура хука — стандартная для PyTorch: `hook(module, input, output)`. Возвращаемый дескриптор нигде не сохраняется, снять хук после регистрации нельзя.

Регистрация выполняется в контексте конкретного model runner'а, то есть в каждом TP-ранге отдельно и, при спекулятивном декодировании, в runner'ах draft-модели тоже — если они проходят тот же путь захвата графов.

## Значения и формат

- Один аргумент — одна строка JSON. Форма:

  ```json
  [{"name": "mlp-probe", "target_modules": ["model.layers.*.mlp"], "hook_factory": "my_pkg.hooks:make_probe", "config": {"every": 100}}]
  ```

- В shell строку надо взять в одинарные кавычки целиком.
- `target_modules` — список шаблонов `fnmatch` по полным именам из `named_modules()`; сопоставление идет по полному имени, поэтому `mlp` без префикса не совпадет ни с чем, нужен `*.mlp` или `model.layers.*.mlp`.
- `hook_factory` — путь, разрешаемый обычным импортом. Модуль должен быть доступен в `sys.path` процесса движка; для окружения arriero это означает пакет, установленный в то же uv-окружение, либо `PYTHONPATH` в переменных окружения инстанса.
- `config` необязателен; при отсутствии фабрика получает пустой словарь.
- `name` необязателен, используется только в сообщениях лога.
- Ошибки формы (`invalid json_list_type value` при неразбираемом JSON) отсекаются на разборе CLI; все остальные проблемы — предупреждения в лог, кроме ошибок импорта: `ValueError` за некорректный путь, `AttributeError` за отсутствующий атрибут и `ImportError` пробрасываются и валят инициализацию model runner'а.

## Когда использовать

- Когда нужна инструментация, которой нет в движке: собственный сбор статистики активаций, счетчик срабатываний конкретного слоя, проверка численной стабильности на выбранных модулях.
- Когда нужен точечный дамп: в отличие от `--debug-tensor-dump-output-folder`, который вешает хук на **каждый** листовой модуль и пишет всё, здесь вы контролируете и выбор модулей, и что делать с тензором.
- Не использовать на сервере, конфигурацию которого задает не тот же человек, что владеет процессом: аргумент — это исполнение произвольного кода внутри движка со всеми его правами.
- Не рассчитывать на срабатывание в decode, если CUDA graph для decode включен: хуки увидят только eager-прогоны. Для наблюдения за decode граф придется отключить через `--cuda-graph-config`, заплатив производительностью.
- Не писать в хуке ничего синхронизирующего (`.cpu()`, `.item()`, `print` тензора) без крайней нужды: каждая такая операция ставит барьер на горячем пути.

## Влияние на производительность и память

- VRAM: сам механизм не выделяет память, но всё, что удерживает ваш хук (сохраненные тензоры), остается на устройстве до освобождения. Классическая утечка — накапливать `output` в списке.
- RAM хоста: определяется хуком.
- Latency и throughput: PyTorch вызывает хук синхронно после forward каждого совпавшего модуля. При шаблоне вида `model.layers.*` это число слоев вызовов на каждый forward. Любая передача тензора на CPU внутри хука вызывает синхронизацию с устройством и рушит перекрытие.
- Время старта: обход `named_modules()` и `fnmatch` по каждому шаблону — незаметно на фоне загрузки весов.
- Важная асимметрия: при включенных decode-графах цена платится только на prefill и на eager-fallback'ах; при отключенных — на каждой итерации.

## Взаимодействие с другими аргументами

- `--cuda-graph-config`: определяет, будут ли хуки вообще срабатывать в decode. Replay захваченного графа не исполняет Python-хуки.
- `--debug-tensor-dump-output-folder` / `--debug-tensor-dump-layers`: соседний, встроенный механизм на тех же `register_forward_hook`, но с фиксированным поведением (сохранить всё в `.pt`) и с принудительным отключением CUDA graph. Если задача — «выгрузить тензоры», начинайте с него; `--forward-hooks` нужен, когда требуется своя логика.
- `--msprobe-dump-config`: еще один внешний инструментальный путь, который тоже принудительно отключает CUDA graph и warmup.
- `--enable-torch-compile`: скомпилированные участки могут не давать привычных границ модулей; поведение хуков внутри compiled-региона нужно проверять на своей сборке.
- `--speculative-algorithm`: у draft-модели свой model runner, и шаблоны будут сопоставляться и с ее модулями.

## Типовые проблемы и диагностика

- `argument --forward-hooks: invalid json_list_type value: '…'` — строка не разбирается как JSON. Чаще всего съедены кавычки shell'ом.
- `Hook spec '<name>' has no 'target_modules', skipping` / `has no 'hook_factory', skipping` — предупреждение в логе, спецификация проигнорирована; сервер продолжает работать без вашего хука.
- `No modules matched hook spec '<name>' patterns=[…]` — шаблон не совпал ни с одним именем. Получите реальный список имен: `python -c "…; print([n for n,_ in model.named_modules()][:50])"` либо начните с широкого `*` и сузьте.
- `Hook factory '<path>' for spec '<name>' returned None, not registering any hook` — фабрика вернула `None`.
- `ValueError: Invalid hook callable path '<path>'. Expected 'module.submodule:factory' or 'module.submodule.factory'` — в пути нет точки и нет двоеточия.
- `ModuleNotFoundError` при инициализации model runner'а — модуль недоступен в окружении движка.
- Хук зарегистрирован (`Registered forward hook …` в логе), но не срабатывает — почти всегда включен CUDA graph для decode.
- **В arriero:** аргумент попадет в `config/instances/<name>.json` как обычная строка со всеми кавычками JSON — редактировать ее в форме неудобно, но она передается в argv без изменений (`argparse-flags`, `apps/api/src/process/argv.ts`). Окружения неизменяемы (`docs/ENVIRONMENTS.md`), поэтому модуль с фабрикой должен быть либо установлен в то же окружение при его создании, либо подложен через `PYTHONPATH` в переменных окружения инстанса. Строки `Registered forward hook …` попадут в лог инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --forward-hooks '[{"name": "mlp-probe", "target_modules": ["model.layers.*.mlp"], "hook_factory": "my_pkg.hooks:make_probe", "config": {"every": 100}}]'
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --cuda-graph-config '{"decode": {"backend": "disabled"}}' --forward-hooks '[{"name": "norm-check", "target_modules": ["model.layers.0.*", "model.norm"], "hook_factory": "my_pkg.hooks.make_norm_check"}]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/hook_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- arriero: `docs/ENVIRONMENTS.md`
