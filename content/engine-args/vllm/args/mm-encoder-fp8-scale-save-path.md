---
schema: 1
engine: vllm
primaryName: "--mm-encoder-fp8-scale-save-path"
title: "--mm-encoder-fp8-scale-save-path"
summary: Калибровочный флаг: при динамическом FP8-внимании ViT сбрасывает наблюдённые масштабы Q/K/V в JSON — один раз, после того как заполнится 16-элементный буфер amax. Полученный файл потом подаётся как `--mm-encoder-fp8-scale-path`.
group: MultiModalConfig
related:
  - --mm-encoder-attn-dtype
  - --mm-encoder-attn-backend
  - --mm-encoder-fp8-scale-path
  - --mm-encoder-fp8-scale-save-margin
---

# --mm-encoder-fp8-scale-save-path

## Кратко

Это первый шаг апстрим-процесса «откалибровать один раз, использовать всегда»: запуск в динамическом FP8-режиме на репрезентативных данных, автосохранение масштабов, затем эксплуатация с `--mm-encoder-fp8-scale-path` и без динамического оверхеда.

Сохранение одноразовое и происходит само: как только у первого слоя кольцевой буфер amax (16 записей) провернётся целиком, все накопленные масштабы материализуются, умножаются на `--mm-encoder-fp8-scale-save-margin` и пишутся в файл. После этого путь обнуляется в памяти, и повторных записей не будет.

Флаг требует включённого `--mm-encoder-attn-dtype fp8` и взаимоисключён с `--mm-encoder-fp8-scale-path`.

## Оригинальная справка

```text
When set with dynamic FP8 scaling (`mm_encoder_attn_dtype="fp8"`
and no `mm_encoder_fp8_scale_path`), saves the calibrated scales to
this file after the amax history buffer is full. The saved file can
then be used as `mm_encoder_fp8_scale_path` in subsequent runs.
```

## Паспорт аргумента

- Флаги: `--mm-encoder-fp8-scale-save-path`
- Группа argparse: `MultiModalConfig`
- Тип значения: путь к файлу (строка), допустим `None`
- Допустимые значения: путь, **родительский каталог которого существует**; сам файл создаётся
- Значение по умолчанию: `None` — автосохранение выключено
- Эффективное значение: не переопределяется; отсутствующий родительский каталог, отсутствие `fp8` или совместное указание с `--mm-encoder-fp8-scale-path` роняют старт
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_encoder_fp8_scale_save_path`
- Этап применения: валидация конфига → построение слоёв внимания энкодера (захват пути в модульную переменную) → forward'ы ViT (накопление и одноразовая запись)

## Что меняет в движке

**Валидация.** `MultiModalConfig._validate_multimodal_config`:

- без `mm_encoder_attn_dtype == "fp8"` → `'mm_encoder_fp8_scale_path' and 'mm_encoder_fp8_scale_save_path' require 'mm_encoder_attn_dtype' to be 'fp8'.`;
- вместе с `mm_encoder_fp8_scale_path` → `'mm_encoder_fp8_scale_save_path' cannot be used with 'mm_encoder_fp8_scale_path' (saving requires dynamic scaling).`;
- родительский каталог должен существовать: `Path(...).parent.is_dir()`, иначе `FileNotFoundError: Parent directory for FP8 scale save path not found: <dir>`.

**Захват настроек.** `MultiModalEncoderAttention._init_fp8_attn` записывает путь и запас в **модульные** переменные `_fp8_scale_save_path` / `_fp8_scale_save_margin`, потому что контекст `VllmConfig` живёт только на время инициализации модели, а не forward'ов. Захват происходит только при `self._fp8_dynamic_scale`, то есть в динамическом режиме.

**Накопление и запись.** `_maybe_save_fp8_scales(layer_name, q_scale, k_scale, v_scale, buffer_wrapped)` вызывается на каждом forward'е и работает так:

1. если `_fp8_scale_save_path is None` — мгновенный выход (автосохранение выключено или уже произошло);
2. иначе в словарь складываются **ссылки** на тензоры масштабов — без синхронизации GPU→CPU, чтобы не тормозить forward;
3. пока `buffer_wrapped` ложно, на этом всё;
4. при первом же обороте буфера amax значения материализуются через `.item()`, умножаются на запас, путь обнуляется (это и делает запись одноразовой на весь процесс), словарь чистится, JSON пишется с `indent=2`, в лог уходит `Saved FP8 scales (N layers) to <path>`.

Практическое следствие: чтобы файл появился, надо провести через энкодер минимум 16 форвардов — то есть просто поднять сервер недостаточно, нужен трафик.

## Значения и формат

- Не задан (`None`) — автосохранение выключено. Дефолт.
- Путь к файлу; каталог должен существовать заранее, файл будет перезаписан.
- Записывается тот же формат, который читает `--mm-encoder-fp8-scale-path`: `{"<layer_name>": {"q": ..., "k": ..., "v": ...}}`.
- В файл попадают только слои, которые успели поучаствовать в forward'ах до момента срабатывания. Если какая-то ветка энкодера не активировалась (например видео-путь при чисто картиночном калибровочном трафике), её слоёв в файле не будет, и последующий запуск со статикой упадёт на первом же обращении к такому слою.
- Значения уже умножены на запас; повторно применять его не нужно.

## Когда использовать

- Однократная калибровка перед переводом инстанса на статические FP8-масштабы. Апстрим-рецепт использует бенчмарк-утилиту, чтобы прогнать репрезентативный датасет:

```bash
vllm bench mm-processor --model Qwen/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8 --mm-encoder-fp8-scale-save-path /models/scales/qwen3vl-8b-vit.json --dataset-name hf --dataset-path lmarena-ai/VisionArena-Chat --num-prompts 100
```

- Тот же эффект достижим на `vllm serve`, если направить на инстанс достаточно репрезентативного трафика (минимум 16 прогонов энкодера).
- Прокалибруйте заново после смены чекпоинта, разрешения входов или существенного изменения профиля данных.
- Не оставляйте флаг в постоянной конфигурации: он не даёт выигрыша (динамика остаётся включённой), а файл будет перезаписываться при каждом рестарте.
- Не калибруйте на нерепрезентативных данных: масштабы, занижающие реальные активации, дают переполнение FP8-диапазона в проде. Именно от этого и страхует запас.

## Влияние на производительность и память

- **Latency.** Накопление ссылок на тензоры — дешёвое действие без синхронизации; одноразовая материализация со `.item()` даёт единичный стоп конвейера на одном forward'е.
- **Режим работы.** Флаг не выключает динамику: во время калибровочного запуска вы платите пофорвардный оверхед динамического шкалирования. Выигрыш появляется только на следующем запуске со статикой.
- **VRAM.** Не влияет: буферы amax регистрируются самим динамическим режимом, а не этим флагом.
- **Диск.** Файл на несколько килобайт.
- **Время старта.** Не влияет; проверка каталога происходит на этапе валидации конфига.

## Взаимодействие с другими аргументами

- `--mm-encoder-attn-dtype`: обязательное условие (`fp8`).
- `--mm-encoder-attn-backend`: те же требования, что и для FP8 вообще — `FLASHINFER` на CUDA, `ROCM_AITER_FA` на ROCm.
- `--mm-encoder-fp8-scale-path`: взаимоисключающий. Заданный путь чтения выключает динамику, а сохранять статические масштабы нечего.
- `--mm-encoder-fp8-scale-save-margin`: множитель, применяемый именно в момент записи.

## Типовые проблемы и диагностика

- **Симптом:** `FileNotFoundError: Parent directory for FP8 scale save path not found: /models/scales` **Причина:** каталог не создан. **Лечение:** создать заранее — движок создаёт файл, но не дерево каталогов.
- **Симптом:** `'mm_encoder_fp8_scale_save_path' cannot be used with 'mm_encoder_fp8_scale_path' (saving requires dynamic scaling).` **Причина:** заданы оба флага.
- **Симптом:** сервер поднялся, файла нет. **Причина:** не набралось 16 прогонов энкодера, либо трафика не было вовсе. **Лечение:** прогнать калибровочную нагрузку. **Проверка:** ожидаемая строка — `Saved FP8 scales (N layers) to <path>`.
- **Симптом:** последующий запуск со статикой падает на `scales not found for layer '<name>'`. **Причина:** этот слой не активировался во время калибровки. **Лечение:** повторить калибровку на трафике, покрывающем все модальности и ветки энкодера.
- **Симптом:** после перехода на статику появились артефакты на некоторых изображениях. **Причина:** активации вне калибровочного распределения переполняют FP8. **Лечение:** повысить `--mm-encoder-fp8-scale-save-margin` и перекалибровать.
- **Подтверждение принятого значения:** строка `Saved FP8 scales (N layers) to <path>` (info) и появившийся файл.

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8 --mm-encoder-fp8-scale-save-path /models/scales/qwen3vl-8b-vit.json
```

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8 --mm-encoder-fp8-scale-save-path /models/scales/qwen3vl-8b-vit.json --mm-encoder-fp8-scale-save-margin 2.0
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/model_executor/layers/attention/mm_encoder_attention.py`
- `vllm/docs/features/quantization/fp8_vit_attn.md`
