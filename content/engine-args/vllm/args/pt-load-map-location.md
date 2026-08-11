---
schema: 1
engine: vllm
primaryName: "--pt-load-map-location"
title: "--pt-load-map-location"
summary: Значение `map_location` для `torch.load` при чтении чекпоинтов `.bin`/`.pt`. Нужен редким чекпоинтам, которые десериализуются только на конкретном устройстве; на safetensors-модели аргумент не читается вовсе.
group: LoadConfig
related:
  - --load-format
  - --model-loader-extra-config
  - --download-dir
  - --device-ids
  - --tensor-parallel-size
---

# --pt-load-map-location

## Кратко

Формат pytorch bin хранит вместе с тензорами исходное устройство. Обычно это несущественно: vLLM читает чекпоинт на CPU (`map_location="cpu"`) и раскладывает веса по картам сам. Но встречаются чекпоинты, сериализованные так, что `torch.load` на CPU падает; для них `map_location` нужно переопределить.

Аргумент затрагивает только путь `.bin`/`.pt`. Safetensors читается через `safe_open`, и никакого `map_location` там нет.

## Оригинальная справка

```text
The map location for loading pytorch checkpoint, to support loading
checkpoints can only be loaded on certain devices like "cuda", this
is equivalent to `{"": "cuda"}`. Another supported format is mapping
from different devices like from GPU 1 to GPU 0: `{"cuda:1": "cuda:0"}`.
Note that when passed from command line, the strings in dictionary
need to be double quoted for json parsing. For more details, see
the original doc for `map_location` parameter in [`torch.load`][] parameter.
```

## Паспорт аргумента

- Флаги: `--pt-load-map-location`
- Группа argparse: `LoadConfig`
- Тип значения: строка **или** JSON-объект `{"<откуда>": "<куда>"}`; парсер — `union_dict_and_str`
- Допустимые значения: `choices` нет; принимается все, что понимает `map_location` в `torch.load`
- Значение по умолчанию: `"cpu"`
- Эффективное значение: не переопределяется движком
- Где объявлен: `vllm/config/load.py:LoadConfig.pt_load_map_location`
- Этап применения: чтение весов, только для чекпоинтов `.bin`/`.pt`

## Что меняет в движке

Значение доходит до двух итераторов в `vllm/model_executor/model_loader/weight_utils.py`:

```
state = torch.load(bin_file, map_location=pt_load_map_location, weights_only=True)
```

— `pt_weights_iterator` (обычный путь) и `multi_thread_pt_weights_iterator` (при `enable_multithread_load` в `--model-loader-extra-config`). Оба вызываются из `DefaultModelLoader._get_weights_iterator` только в ветке `use_safetensors is False`, то есть когда найденные файлы — `.bin` или `.pt`.

Отсюда практическое следствие: на `--load-format safetensors`, `mistral`, `fastsafetensors`, `instanttensor`, а также на `runai_streamer`, `sharded_state` и `tensorizer` аргумент не читается. На `auto`/`hf` он сработает только если safetensors в репозитории нет и загрузчик откатился к `.bin`.

Заметьте, что `torch.load` вызывается с `weights_only=True` — произвольные объекты pickle не десериализуются.

## Значения и формат

- **Строка**: `cpu`, `cuda`, `cuda:0`. Форма `cuda` эквивалентна словарю `{"": "cuda"}` — читать все тензоры на текущую CUDA-карту.
- **JSON-объект**: перенаправление по устройствам, например `{"cuda:1": "cuda:0"}` — тензоры, сохраненные с первой карты, читать на нулевую. Из командной строки строки внутри JSON обязаны быть в двойных кавычках, а весь объект — экранирован от shell (одинарные кавычки).
- Точечная форма тоже работает: `--pt-load-map-location.cuda:1 cuda:0` собирается парсером в тот же словарь.
- Значение, не похожее на JSON-объект (нет обрамляющих `{}`), сохраняется строкой как есть — это штатное поведение `union_dict_and_str`, а не ошибка.
- Специальных значений (`auto`, `-1`) нет. Пустая строка приведет к `map_location=""`, что `torch.load` не примет.

## Когда использовать

- Чекпоинт `.bin` не читается на CPU: `torch.load` падает при десериализации, либо тензоры оказываются на несуществующем устройстве. Тогда `cuda` — самый прямой обход.
- Чекпоинт сохранен с конкретной карты (`cuda:1`), а на хосте видна только одна: перенаправление `{"cuda:1": "cuda:0"}` спасает.
- Не используйте «для ускорения»: чтение сразу на GPU не ускоряет загрузку — веса все равно перекладываются под нужный шардинг, зато пик VRAM растет.
- Не используйте на safetensors-модели: аргумент проигнорируется, и вы потратите время на ложный след.

## Влияние на производительность и память

- **VRAM.** Значение `cuda` заставляет держать промежуточный state_dict шарда прямо в памяти карты **до** профилирования памяти. На крупном чекпоинте это заметный пик, который не учтен ни в одной оценке; при `--gpu-memory-utilization` близком к 1 это прямой путь к OOM на старте.
- **RAM хоста.** Значение по умолчанию `cpu` дает обратную картину: пик в оперативной памяти на размер одного шарда (или `num_threads` шардов в многопоточном режиме).
- **Время старта.** Практически не меняется.
- **Throughput и latency.** Не влияет: аргумент работает только в фазе загрузки.

## Взаимодействие с другими аргументами

- `--load-format`: определяет, будет ли аргумент вообще прочитан. Безусловно применим только к `pt` и `npcache`; к `auto`/`hf` — лишь при откате на `.bin`.
- `--model-loader-extra-config`: с `enable_multithread_load` то же значение уходит в многопоточный итератор, и пик памяти умножается на число потоков.
- `--device-ids`, `--tensor-parallel-size`: определяют, какие карты видны процессу; перенаправление вида `{"cuda:1": "cuda:0"}` должно согласовываться с этой видимостью.
- `--download-dir`: не связан, но обе проблемы («не тот файл», «не читается файл») проявляются в одной фазе подготовки весов.

## Типовые проблемы и диагностика

- **Симптом:** аргумент задан, ничего не изменилось. **Причина:** модель в формате safetensors. **Проверка:** какие файлы реально нашел загрузчик — отладочная строка `Using model weights format <allow_patterns>`. **Лечение:** аргумент неприменим.
- **Симптом:** ошибка `torch.load` про недоступное устройство (`Attempting to deserialize object on CUDA device N`). **Причина:** чекпоинт сохранен с карты, которой на хосте нет. **Лечение:** перенаправление `{"cuda:N": "cuda:0"}` либо `cpu`.
- **Симптом:** OOM на GPU в фазе `Loading weights`, до профилирования памяти. **Причина:** `map_location` указывает на CUDA. **Лечение:** вернуть `cpu`.
- **Симптом:** ошибка разбора JSON при старте. **Причина:** shell «съел» кавычки. **Лечение:** одинарные кавычки вокруг всего объекта, двойные — внутри; либо точечная форма.
- **Подтверждение принятого значения:** отдельной строки лога нет; наблюдаемое следствие — где возникает пик памяти в фазе загрузки (хост или карта) и строка `Loading pt checkpoint shards` в прогресс-баре.

## Примеры

```bash
vllm serve /models/legacy-bin-model --load-format pt --pt-load-map-location cuda
```

```bash
vllm serve /models/legacy-bin-model --load-format pt --pt-load-map-location '{"cuda:1": "cuda:0"}'
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
