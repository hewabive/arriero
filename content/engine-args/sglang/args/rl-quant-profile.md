---
schema: 1
engine: sglang
primaryName: "--rl-quant-profile"
title: "--rl-quant-profile"
summary: Путь к профилю квантизации FlashRL для `--load-format flash_rl`. В checkout'е значение доезжает до `LoadConfig.rl_quant_profile` и не читается ни одним потребителем: загрузчик RL-режима переписан на profile-free FP8.
group: model
related:
  - --load-format
  - --quantization
  - --enable-weights-cpu-backup
---

# --rl-quant-profile

## Кратко

Аргумент относится к узкой интеграции для RL-обучения: формат загрузки `flash_rl` держит веса так, чтобы тренер мог многократно перезаписывать их без перевыделения памяти. Исторически такому режиму нужен был внешний профиль квантизации FlashRL, отсюда и флаг. В коде checkout'а `QuantizedRLModelLoader` описан как «profile-free, native SGLang» и профиль не открывает — значение доходит до `LoadConfig.rl_quant_profile` и там остается неиспользованным. Для инференс-развертывания аргумент не нужен вообще.

## Оригинальная справка

```text
Path to the FlashRL quantization profile. Required when using --load-format flash_rl.
```

## Паспорт аргумента

- Флаги: `--rl-quant-profile`
- Группа: `model`
- Тип значения: путь к файлу профиля (`Optional[str]`)
- Допустимые значения: не ограничены
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется и не читается — в checkout'е поле встречается ровно трижды: объявление в `ServerArgs`, объявление в `LoadConfig` и передача между ними в `build_load_config`
- Где объявлен: `ServerArgs.rl_quant_profile`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме; фактически неподключенный остаток интеграции FlashRL
- Этап применения: формирование `LoadConfig` перед загрузкой весов

## Что меняет в движке

Ничего в текущем коде. `build_load_config` (`sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`) копирует значение в `LoadConfig.rl_quant_profile`; комментарий рядом с объявлением поля в `sglang/python/sglang/srt/configs/load_config.py` описывает его как «Path to rollout quantization profile (e.g. /root/profile.7b.pt)». Ни `QuantizedRLModelLoader`, ни какой-либо другой загрузчик это поле не читает.

Что делает сам режим `--load-format flash_rl`, стоит понимать отдельно от флага. `QuantizedRLModelLoader` (`sglang/python/sglang/srt/model_loader/loader.py`):

- загружает базовую модель в исходной точности обычным `DefaultModelLoader`;
- запоминает для каждого параметра форму, страйд, dtype и размер хранилища, а также атрибуты загрузчика весов (`weight_loader`, `load_qkv_weight` и прочие);
- применяет FP8-квантизацию через `process_weights_after_loading` каждого модуля;
- при последующей перезагрузке весов от тренера квантует их и копирует в **те же** адреса через `torch.as_strided`, чтобы указатели, захваченные CUDA graph, оставались валидными.

Список исключенных из квантизации параметров (`SKIP_QUANTIZATION_PARAMS`: масштабы, bias, `lm_head.weight`, `model.norm.weight`, эмбеддинги, LayerNorm'ы, rotary-буферы) зашит в код и профилем не настраивается.

## Значения и формат

- Строка-путь. Существование файла не проверяется — проверять нечему, поле не читается.
- Пустая строка, несуществующий путь и мусорное значение одинаково безвредны и одинаково бесполезны.
- Специальных значений нет.

## Когда использовать

- В инференс-эксплуатации — не использовать.
- Если вы поднимаете SGLang как rollout-движок для RL и переносите команду из документации FlashRL, флаг можно оставить, но нельзя рассчитывать, что он что-то настраивает: проверьте на своей версии пакета `grep -rn "rl_quant_profile" python/sglang`, и если поле по-прежнему только пробрасывается, рецепт квантизации задается через `--quantization` (в докстринге загрузчика пример: `--quantization fp8 --load-format flash_rl`).
- Не задавайте флаг без `--load-format flash_rl`: даже потенциального смысла у него в этом случае нет.

## Влияние на производительность и память

Сам аргумент влияния не имеет. Влияние есть у режима `--load-format flash_rl`: он держит слепок исходных форм/страйдов всех параметров (небольшой overhead по RAM хоста) и добавляет к первой загрузке проход FP8-квантизации по всем модулям; выигрыш — быстрые повторные загрузки весов без перевыделения GPU-памяти.

## Взаимодействие с другими аргументами

- `--load-format`: единственный флаг, который включает RL-загрузчик (`flash_rl`). Без него аргумент не имеет даже теоретического смысла.
- `--quantization`: в этом режиме именно он задает метод (докстринг загрузчика приводит `--quantization fp8`).
- `--enable-weights-cpu-backup`: смежная механика работы с копиями весов; с RL-перезагрузками сочетается с осторожностью, поскольку обе стороны претендуют на владение буферами параметров.

## Типовые проблемы и диагностика

- «Задал профиль, ничего не изменилось» — ожидаемое поведение checkout'а, а не ошибка конфигурации.
- Строки `[QuantizedRL] Profile-free FP8 quantization enabled`, `[QuantizedRL] Loading from base model: <path>`, `[QuantizedRL] Initial load with FP8 quantization`, `[QuantizedRL] Initial load complete` в логе подтверждают, что включен именно RL-загрузчик — и заодно подтверждают, что он работает без профиля.
- Принятое значение аргумента видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).
- Ошибок, специфичных для этого аргумента, не существует: неверный путь не проверяется.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen2.5-7B --quantization fp8 --load-format flash_rl --rl-quant-profile /root/profile.7b.pt
```

```bash
python -m sglang.launch_server --model-path /models/Qwen2.5-7B --quantization fp8 --load-format flash_rl
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
