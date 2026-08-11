---
schema: 1
engine: sglang
primaryName: "--mm-attention-backend"
title: "--mm-attention-backend"
summary: Ядро attention внутри визуального/аудио энкодера (ViT), а не в языковой модели. Не задан — выбирается по compute capability; трогают, когда авто-выбор упирается в неподдерживаемое ядро или когда нужно сравнить fa3/fa4/triton на своем железе.
group: mm
related:
  - --attention-backend
  - --enable-multimodal
  - --mm-enable-dp-encoder
  - --device
  - --tp-size
---

# --mm-attention-backend

## Кратко

`--mm-attention-backend` подменяет реализацию attention в модуле `VisionAttention` — то есть внутри энкодера мультимодальной модели. К attention языковой модели он отношения не имеет: там работает `--attention-backend`. Значение имеет наивысший приоритет: оно перебивает и то, что модель передала конструктору, и платформенный дефолт. Ошибка в значении обнаружится не на старте сервера, а при первом построении vision-башни.

## Оригинальная справка

```text
Set multimodal attention backend.
```

## Паспорт аргумента

- Флаги: `--mm-attention-backend`
- Группа: `mm`
- Тип значения: строка
- Допустимые значения: `sdpa`, `fa3`, `fa4`, `triton_attn`, `ascend_attn`, `aiter_attn`, `flashinfer_cudnn`, `amx_attn`, `xpu_attn` — фиксированный список `choices`, совпадающий с ключами таблицы `QKV_BACKEND_IMPL`
- Значение по умолчанию: `null` — «подобрать по платформе»
- Эффективное значение: `VisionAttention._determine_attention_backend` (`sglang/python/sglang/srt/layers/attention/vision.py`) выбирает backend, если аргумент не задан; см. таблицу ниже
- Где объявлен: `ServerArgs.mm_attention_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструирование модели (создание модулей `VisionAttention`), то есть после загрузки конфигурации и до forward

## Что меняет в движке

Каждый `VisionAttention.__init__` вызывает `_determine_attention_backend(passed_backend)` с приоритетом **server args → аргумент конструктора → платформенный дефолт**:

| Платформа | Дефолт |
| --- | --- |
| CUDA, compute capability 9.x (Hopper) | `fa3` |
| CUDA, 10.x кроме 10.3 (Blackwell) | `fa4` |
| CUDA, всё остальное | `triton_attn` |
| Ascend NPU | `ascend_attn` |
| MUSA ≥ 3.1 / MUSA ниже | `fa3` / `triton_attn` |
| ROCm ≥ gfx94 с AITER | `aiter_attn` |
| ROCm, остальное | `triton_attn` |
| CPU с AMX | `amx_attn` |
| XPU | `xpu_attn` при Intel-XPU-бэкенде, иначе `triton_attn` |
| прочее | `sdpa` |

Выбранное имя отображается в класс из `QKV_BACKEND_IMPL`: `VisionTritonAttention`, `VisionSdpaAttention`, `VisionFlash3Attention`, `VisionFlash4Attention`, `VisionFlashInferAttention`, `VisionAscendAttention`, `VisionAiterAttention`, `VisionAMXAttention`, `VisionIntelXPUAttention`.

Отдельные модели читают значение напрямую и меняют поведение сверх выбора ядра:

- `qwen3_vl.py` и `minimax_vl_common.py` при `flashinfer_cudnn` дополнительно выделяют workspace-буфер FlashInfer на текущем устройстве — это отдельный кусок VRAM, которого при других значениях нет;
- `gemma4_vision.py` повторяет ту же логику выбора в собственном `_select_backend`, но на Hopper с поддержкой Blackwell-пути возвращает `triton_attn`;
- `kimi_k3_vl.py` трактует «не задано» как строку `"auto"` и на SM 10.3 выбирает между `fa4` и `sdpa` уже **по размеру батча**: `fa4`, если `max_seqlen` превышает порог или произведение `max_seqlen * total_tokens` достаточно велико и FA4 действительно доступен. Явное значение аргумента отключает эту динамику.

Единственная жесткая проверка внутри `_determine_attention_backend` — `fa3` на Blackwell:

```text
ValueError: The 'fa3' backend is not supported on Blackwell GPUs
```

Все остальные несовместимости (ядро не собрано, нет пакета flashinfer, платформа не та) проявляются как ошибка импорта или ошибка ядра при построении модели.

## Значения и формат

- Одна строка из списка `choices`; argparse отвергает всё остальное с обычным сообщением `invalid choice`.
- Значения `auto` в CLI нет. «Авто» — это отсутствие аргумента; отдельно `kimi_k3_vl` внутри себя обозначает это состояние строкой `"auto"`.
- Пустая строка не эквивалентна «не задано»: она пройдет argparse только если совпадет с choices, то есть не пройдет.
- Значение глобальное: одно ядро на все `VisionAttention` в модели, отдельно для image- и audio-башни задать нельзя.

## Когда использовать

- Авто-выбор упал на старте: `fa3` на Blackwell, `fa4` без собранного ядра, `flashinfer_cudnn` без установленного flashinfer. Тогда безопасный откат — `triton_attn`, а универсальный (медленный, но всегда рабочий) — `sdpa`.
- Нужно снять сравнение: на одной и той же карте `triton_attn` и `fa3`/`fa4` дают заметно разный TTFT на больших изображениях, а на маленьких разница тонет в препроцессинге.
- Модель делает собственный динамический выбор (Kimi K3-VL), и вам нужно детерминированное поведение для замеров — тогда фиксируйте значение явно.
- **Не трогайте**, если тормозит не энкодер: узкое место мультимодального prefill чаще в декодировании и препроцессинге на хосте (`--mm-io-worker-num`, `--mm-processor-worker-num`), а не в attention ViT.
- **Не путайте** с `--attention-backend`: он управляет attention языковой модели и KV-кешем, и подмена одного другим ничего не чинит.

## Влияние на производительность и память

- VRAM: сам выбор ядра почти ничего не стоит, кроме `flashinfer_cudnn` — у Qwen3-VL и MiniMax-VL под него выделяется постоянный workspace-буфер FlashInfer.
- Скорость: влияет только на время прохода ViT, то есть на TTFT мультимодального запроса. На decode-фазу не влияет никак.
- Время старта: ядра `fa3`/`fa4`/`triton_attn` могут потребовать JIT-компиляции при первом прогоне; `sdpa` стартует мгновенно.
- KV-кеш и `--mem-fraction-static` не затрагиваются: у ViT нет KV-кеша.

## Взаимодействие с другими аргументами

- `--attention-backend`: независимый аргумент для языковой модели. Значения из двух списков не взаимозаменяемы.
- `--enable-multimodal`: без построенной vision-башни значение просто не читается.
- `--mm-enable-dp-encoder`: DP-энкодер реплицирует ту же самую `VisionAttention` на все ранги, backend один и тот же на всех.
- `--device`, `--tp-size`: определяют платформу и то, сколько голов приходится на ранг; на выбор дефолта влияет только платформа.

## Типовые проблемы и диагностика

- `ValueError: The 'fa3' backend is not supported on Blackwell GPUs` — либо задан `fa3` явно, либо модель передала его конструктором; на SM100 берите `fa4`, на SM103 — `sdpa`/`triton_attn`.
- `KeyError` по имени backend внутри `QKV_BACKEND_IMPL` означает рассинхрон версии: значение прошло `choices` установленного парсера, но таблица реализаций старше. Сверьте `python -m sglang.launch_server --help` вашей сборки.
- `ImportError`/`ModuleNotFoundError` при построении vision-башни — ядро не установлено; откатитесь на `triton_attn`.
- Подтверждение того, что значение принято, — две строки из `vision.py`, печатаемые один раз: `Multimodal attention backend not set. Use <backend>.` (значит аргумент не задан) и `Using <backend> as multimodal attention backend.`
- Значение аргумента как таковое видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-attention-backend triton_attn
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-attention-backend fa4 --attention-backend flashinfer --tp-size 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/vision.py`
- `sglang/python/sglang/srt/models/qwen3_vl.py`
- `sglang/python/sglang/srt/models/gemma4_vision.py`
- `sglang/python/sglang/srt/models/kimi_k3_vl.py`
- `sglang/python/sglang/srt/models/minimax_vl_common.py`
