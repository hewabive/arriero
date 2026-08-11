---
schema: 1
engine: vllm
primaryName: "--allow-deprecated-quantization"
title: "--allow-deprecated-quantization"
summary: Снимает жёсткий отказ старта на методах квантизации, помеченных в vLLM как устаревшие. Временный костыль для чекпоинта, который ещё не переквантован, а не постоянная настройка.
group: ModelConfig
related:
  - --quantization
  - --quantization-config
  - --dtype
---

# --allow-deprecated-quantization

## Кратко

vLLM ведёт список методов квантизации, объявленных устаревшими. Если итоговый метод модели попал в этот список, старт падает с `ValueError` ещё до загрузки весов. `--allow-deprecated-quantization` меняет отказ на предупреждение в логе.

Метод определяется не только флагом `--quantization`: он может прийти из `quantization_config` в `config.json` модели. Поэтому падение возможно на «обычном» запуске без единого флага квантизации.

## Оригинальная справка

```text
Whether to allow deprecated quantization methods.
```

## Паспорт аргумента

- Флаги: `--allow-deprecated-quantization`, `--no-allow-deprecated-quantization`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг задан ⇒ `True`, `--no-allow-deprecated-quantization` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется ни платформенными хуками, ни `create_engine_config`
- Где объявлен: `vllm/config/model.py:ModelConfig.allow_deprecated_quantization`
- Этап применения: сборка `VllmConfig` → `ModelConfig.__post_init__` → `_verify_quantization()`, то есть после чтения HF-конфига и до загрузки весов

## Что меняет в движке

`ModelConfig._verify_quantization()` выполняет три шага подряд:

1. если `--quantization` не задан, берёт метод из `model_arch_config.quantization_config["quant_method"]` (то есть из `config.json` модели); при конфликте заданного и найденного значений падает с «Quantization method specified in the model config (X) does not match the quantization method specified in the `quantization` argument (Y)»;
2. проверяет, что метод есть в `me_quant.QUANTIZATION_METHODS` и поддержан платформой (`current_platform.verify_quantization`);
3. проверяет вхождение в `me_quant.DEPRECATED_QUANTIZATION_METHODS`. Вот здесь и работает флаг: при `True` пишется `warning` «The quantization method %s is deprecated and will be removed in future versions of vLLM.», при `False` — поднимается `ValueError`.

На саму математику квантизации флаг не влияет: он только решает, продолжится ли запуск. Дальше метод обрабатывается ровно так же, как любой поддержанный.

Список устаревших методов живёт в коде (`vllm/model_executor/layers/quantization/__init__.py:DEPRECATED_QUANTIZATION_METHODS`) и меняется от релиза к релизу — в этом commit'е checkout'а там `fbgemm_fp8` и `fp_quant`. Не закладывайтесь на конкретный состав: проверяйте свою сборку.

## Значения и формат

- Булев флаг без значения. `--allow-deprecated-quantization` включает, `--no-allow-deprecated-quantization` выключает явно.
- Специальных значений нет; «не задан» эквивалентно `False`.
- Флаг не расширяет список поддержанных методов: неизвестный метод по-прежнему падает на шаге 2 с «Unknown quantization method».

## Когда использовать

- Держите в проде чекпоинт, квантованный устаревшим методом, и обновили vLLM: временно вернуть сервис в строй, пока модель не переквантована.
- Воспроизводите старый бенчмарк на конкретной версии весов.
- **Не используйте как постоянную настройку.** Смысл списка в том, что реализация будет удалена; в следующем релизе метод исчезнет из `QUANTIZATION_METHODS`, и флаг перестанет помогать — старт упадёт уже на «Unknown quantization method». Планируйте переквантизацию, а не флаг.

## Влияние на производительность и память

Прямого влияния нет: флаг не меняет ни раскладку весов, ни ядра, ни размер KV-cache. Косвенно — метод квантизации, который он разрешает, определяет объём весов и скорость GEMM, но это свойство метода, а не флага.

## Взаимодействие с другими аргументами

- `--quantization`: основной источник значения. Если он не задан, метод берётся из `config.json` модели, и флаг всё равно может понадобиться.
- `--quantization-config`: пользовательская конфигурация квантизации (пер-слойные спецификации, ignore-паттерны); проверка устаревания идёт по имени метода, а не по этой структуре.
- `--dtype`: при отсутствии квантизации определяет тип весов; при квантизации задаёт тип активаций и вычислений. Флаг устаревания на это не влияет.

## Типовые проблемы и диагностика

- **Симптом:** старт падает сообщением, в котором виден неподставленный `%s`: `ValueError: ('The quantization method %s is deprecated and will be removed in future versions of vLLM. To bypass, set `--allow-deprecated-quantization`.', 'fbgemm_fp8')`. **Причина:** в апстриме `ValueError` вызывается с printf-аргументами, как если бы это был logger; текст и значение приходят двумя элементами кортежа. Это не искажение вашего лога — читайте второй элемент, там имя метода. **Лечение:** либо добавить флаг, либо перейти на актуальный метод.
- **Симптом:** флаг добавлен, сервер стартовал, в логе `WARNING ... The quantization method fbgemm_fp8 is deprecated and will be removed in future versions of vLLM.` **Причина:** штатное поведение включённого флага. **Действие:** зафиксировать задачу на переквантизацию.
- **Симптом:** после обновления vLLM флаг перестал помогать, ошибка сменилась на `Unknown quantization method: fbgemm_fp8. Must be one of [...]`. **Причина:** метод удалён из движка полностью. **Лечение:** переквантовать модель одним из перечисленных в сообщении методов.
- **Проверка на своей сборке:** список поддержанных методов печатается прямо в тексте ошибки «Must be one of [...]»; перечень аргументов — `vllm serve --help`.

## Примеры

```bash
vllm serve /models/legacy-fp8-checkpoint --allow-deprecated-quantization --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/legacy-fp8-checkpoint --quantization fbgemm_fp8 --allow-deprecated-quantization --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/layers/quantization/__init__.py`
- `vllm/vllm/engine/arg_utils.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
