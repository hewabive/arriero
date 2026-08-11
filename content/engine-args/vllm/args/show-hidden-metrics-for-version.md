---
schema: 1
engine: vllm
primaryName: "--show-hidden-metrics-for-version"
title: "--show-hidden-metrics-for-version"
summary: Временно возвращает Prometheus-метрики, скрытые после устаревания. Работает только если указанная версия ровно на один minor младше установленной; в текущем коде под этим гейтом не находится ни одной метрики.
group: ObservabilityConfig
related:
  - --disable-log-stats
  - --enable-mfu-metrics
  - --kv-cache-metrics
  - --cudagraph-metrics
---

# --show-hidden-metrics-for-version

## Кратко

Механизм жёстко привязан к версии: значение сравнивается со строкой `"{major}.{minor - 1}"` установленного vLLM. Совпало — скрытые метрики показываются, не совпало — флаг молча не действует. Никакой ошибки при «неправильной» версии не будет, поэтому оставленный в конфиге флаг после апгрейда просто перестаёт работать.

Политика устаревания из `vllm/docs/usage/metrics.md`: метрика, объявленная устаревшей в `X.Y`, скрывается в `X.Y+1` (и вот там её возвращает этот флаг со значением `X.Y`), а в `X.Y+2` удаляется совсем.

## Оригинальная справка

```text
Enable deprecated Prometheus metrics that have been hidden since the
specified version. For example, if a previously deprecated metric has been
hidden since the v0.7.0 release, you use
`--show-hidden-metrics-for-version=0.7` as a temporary escape hatch while
you migrate to new metrics. The metric is likely to be removed completely
in an upcoming release.
```

## Паспорт аргумента

- Флаги: `--show-hidden-metrics-for-version`
- Группа argparse: `ObservabilityConfig`
- Тип значения: строка версии вида `MAJOR.MINOR`, допускается `None`
- Допустимые значения: любая строка, которую разбирает `packaging.version.parse`; семантически осмысленно ровно одно значение — предыдущий minor установленной версии
- Значение по умолчанию: `null` (`None`) — скрытые метрики не показываются
- Эффективное значение: сравнение выполняется в `cached_property show_hidden_metrics` через `vllm.version._prev_minor_version_was()`. В dev-дереве (`__version_tuple__[0:2] == (0, 0)`) функция возвращает `True` для любой строки. Для релизных версий она содержит `assert __version_tuple__[0] == 0`, то есть на будущей ветке 1.x упадёт с `AssertionError`
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.show_hidden_metrics_for_version`
- Этап применения: сборка `VllmConfig` (валидация формата) → создание `PrometheusStatLogger` (чтение признака)

## Что меняет в движке

Валидатор `_validate_show_hidden_metrics_for_version` только проверяет, что строка парсится как версия; ни диапазон, ни соответствие установленной версии на этом шаге не проверяются.

Признак вычисляется лениво: `show_hidden_metrics` возвращает `False` при `None`, иначе результат `_prev_minor_version_was(value)`, то есть строгое равенство `value == f"{major}.{minor - 1}"`. Значения вроде `0.7.0` (с патч-компонентом) не совпадут — сравнение строковое по двум компонентам.

`PrometheusStatLogger.__init__` присваивает `self.show_hidden_metrics = vllm_config.observability_config.show_hidden_metrics`. В checkout'е, по которому снят extract, это единственное использование поля: ни одна метрика в `vllm/v1/metrics/loggers.py` не гейтится по нему, а тестовый список скрытых метрик пуст (`HIDDEN_DEPRECATED_METRICS: list[str] = []` в `tests/entrypoints/serve/instrumentator/test_metrics.py`). То есть механизм присутствует и обслуживается тестом, но окна устаревания сейчас открытого нет.

## Значения и формат

- Формат `MAJOR.MINOR` без патч-компонента: `--show-hidden-metrics-for-version=0.7`.
- Значение должно быть ровно на один minor младше установленной версии. Для vLLM 0.8.x подходит только `0.7`.
- Нераспознаваемая строка (`abc`) отвергается валидатором `packaging.version.parse` при сборке конфига.
- Строка правильного формата, но «не та» версия, ошибки не даёт и просто не включает ничего.

## Когда использовать

- Апгрейд на minor, в котором ваши дашборды опираются на только что скрытую метрику, и нужен один релизный цикл на миграцию. Это единственное назначение флага.
- Не оставляйте его в постоянной конфигурации инстанса: после следующего апгрейда он бесшумно перестанет действовать, а через один — метрика исчезнет совсем.
- Не используйте как «показать все метрики»: список гейтится точечно, и сегодня он пуст.

## Влияние на производительность и память

На производительность не влияет: значение читается один раз при создании Prometheus-логгера. Единственный возможный эффект — несколько дополнительных серий в `/metrics`, когда окно устаревания открыто.

## Взаимодействие с другими аргументами

- `--disable-log-stats`: полностью отключает стат-логгеры, в том числе Prometheus; этот флаг тогда бессмыслен.
- `--enable-mfu-metrics`, `--kv-cache-metrics`, `--cudagraph-metrics`: добавляют новые метрики, а не возвращают старые; на этот механизм не влияют.

## Типовые проблемы и диагностика

- **Симптом:** старт падает на разборе значения. **Причина:** строка не парсится `packaging.version.parse`. **Лечение:** формат `MAJOR.MINOR`.
- **Симптом:** флаг задан, метрика в `/metrics` не появилась. **Причина:** либо версия не совпала с «предыдущим minor», либо в этой сборке под гейтом нет ни одной метрики. **Проверка:** установленная версия (`vllm --version` в нужном окружении) против заданного значения; затем поиск гейта в установленном пакете: `grep -rn "show_hidden_metrics" <site-packages>/vllm/v1/metrics/loggers.py`. **Лечение:** привести значение к предыдущему minor; если гейт нигде не читается, метрика скрыта не этим механизмом.
- **Симптом:** `AssertionError` внутри `_prev_minor_version_was`. **Причина:** установленная версия имеет major, отличный от 0 — функция это явно не поддерживает (комментарий в коде: «this won't do the right thing when we release 1.0»). **Лечение:** не задавать флаг на такой версии.
- **Подтверждение принятого значения:** отдельной строки в логе нет; проверяется только наличием ожидаемой серии в `GET /metrics`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --show-hidden-metrics-for-version 0.7
```

```bash
vllm serve /models/Qwen3-4B --show-hidden-metrics-for-version=0.7 --enable-mfu-metrics
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/version.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/tests/entrypoints/serve/instrumentator/test_metrics.py`
- `vllm/docs/usage/metrics.md`
- `vllm/docs/design/metrics.md`
