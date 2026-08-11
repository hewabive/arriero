---
schema: 1
engine: sglang
primaryName: "--disable-flashinfer-autotune"
title: "--disable-flashinfer-autotune"
summary: Отключает прогон автотюнинга ядер FlashInfer при прогреве. Ускоряет старт ценой того, что тюнимые GEMM и MoE-ядра остаются на эвристике FlashInfer — на trtllm-gen fp4 MoE это десятки процентов throughput.
group: exec.kernel
related:
  - --flashinfer-autotune-skip-ops
  - --moe-runner-backend
  - --fp8-gemm-backend
  - --fp4-gemm-backend
  - --quantization
  - --enable-deterministic-inference
  - --max-prefill-tokens
---

# --disable-flashinfer-autotune

## Кратко

При прогреве model runner может один раз прогнать фиктивный forward под контекстом `flashinfer.autotuner.autotune`, чтобы каждое тюнимое ядро FlashInfer выбрало лучшую тактику под текущие формы задач и записало результат в кеш на диске. `--disable-flashinfer-autotune` выключает этот прогон целиком. Автотюнинг и так запускается не всегда — он требует CUDA и попадания в конкретный набор backend'ов и форматов квантизации, — поэтому сначала стоит убедиться, что он у вас вообще происходит.

## Оригинальная справка

```text
Disable FlashInfer autotuning.
```

## Паспорт аргумента

- Флаги: `--disable-flashinfer-autotune`
- Группа: `exec.kernel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false` (автотюнинг разрешен)
- Эффективное значение: не переопределяется. Но результат «автотюнинг не побежит» достигается и другими путями — см. условия ниже
- Где объявлен: `ServerArgs.disable_flashinfer_autotune`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `warmup()` в `BaseRunner` после инициализации модели и до захвата CUDA graph

## Что меняет в движке

Единственный потребитель — `should_run_flashinfer_autotune` (`sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`). Он возвращает `False`, если выполнено хотя бы одно:

- устройство не `cuda`;
- задан `--disable-flashinfer-autotune`;
- задан `--enable-deterministic-inference` (тюненные тактики зависят от формы задачи, а значит от состава батча — это ломает воспроизводимость);
- `--moe-runner-backend flashinfer_cutedsl` вместе с `--moe-a2a-backend deepep` (CuteDSL v1 обходит `MoeRunner`, и фиктивный dispatch может превысить лимит токенов DeepEP low-latency);
- ни один из трех триггеров не сработал: MoE-раннер не из списка `flashinfer_trtllm`, `flashinfer_trtllm_routed`, `flashinfer_mxfp4`, `flashinfer_cutedsl`, `flashinfer_cutlass`; FP4-GEMM-раннер не `flashinfer_cutlass`/`flashinfer_cutedsl` при модели в `modelopt_fp4`/`modelopt_mixed`; FP8-GEMM-раннер не `flashinfer_cutlass` и модель не `modelopt`/`modelopt_fp8`/`modelopt_mixed` на SM100/SM120;
- compute capability меньше 9.0.

Если прогон разрешен, `warmup()` вызывает `_flashinfer_autotune(...)` на decode-образном фиктивном батче, а затем `maybe_flashinfer_autotune_extend(...)` — дополнительный проход на extend-образном батче размера `--max-prefill-tokens` (по умолчанию выключен, включается `SGLANG_FLASHINFER_AUTOTUNE_EXTEND=1`; при нехватке памяти он не падает, а пропускается с записью в лог).

Кеш тактик лежит в `$SGLANG_CACHE_DIR/flashinfer/autotune/<версия flashinfer>/<sm архитектура>/<хеш конфигурации>/rank_tp…json`. В хеш входят путь модели, dtype, `--quantization`, `--moe-runner-backend`, размеры TP/PP/DP/EP, класс HF-конфига и набор пропущенных операций. Переменная `SGLANG_FLASHINFER_AUTOTUNE_CACHE=0` отключает переиспользование кеша и пишет каждый прогон в отдельный файл.

## Значения и формат

- Флаг без аргумента; парной формы нет.
- Задавать его на конфигурации, где автотюнинг и так не запускается (не-FlashInfer раннеры, отсутствие FP4/FP8-modelopt квантизации, SM ниже 9.0), бессмысленно — эффекта не будет.

## Когда использовать

- Когда автотюнинг падает или зависает на вашей связке FlashInfer + GPU и нужно поднять сервер прямо сейчас. Более точечная альтернатива — `--flashinfer-autotune-skip-ops` с именем проблемной операции.
- Когда сервер часто перезапускается на холодном кеше (например, в CI или при частой смене конфигурации): прогон стоит секунды-десятки секунд и дает эффект только на этот запуск, если кеш все равно инвалидируется.
- Не отключайте на продакшн-инстансе, который стартует редко: комментарий в коде фиксирует измеренный порядок величины — trtllm-gen fp4 MoE без тюнинга примерно на 30 % медленнее на батчах ≥ 8k токенов на SM100.

## Влияние на производительность и память

- **Время старта.** Единственный прямой эффект отключения: убирается один-два фиктивных forward под автотюнером плюс запись кеша. При включенном `SGLANG_FLASHINFER_AUTOTUNE_EXTEND` второй проход еще и выделяет буферы под `--max-prefill-tokens` токенов, поэтому отключение снижает пиковую память в момент прогрева.
- **Throughput.** Потери на тюнимых ядрах: FlashInfer выбирает тактику эвристикой, а не измерением.
- **Steady-state VRAM.** Не меняется: буферы прогрева освобождаются до захвата графов.
- **Повторные старты.** С включенным кешем (по умолчанию) второй запуск с той же конфигурацией все равно читает готовые тактики, так что экономия времени от флага почти исчезает.

## Взаимодействие с другими аргументами

- `--flashinfer-autotune-skip-ops`: точечная версия того же — пропустить отдельные операции, а не весь прогон.
- `--moe-runner-backend`, `--fp8-gemm-backend`, `--fp4-gemm-backend`, `--quantization`: определяют, запускается ли автотюнинг вообще.
- `--enable-deterministic-inference`: сам по себе отключает автотюнинг.
- `--max-prefill-tokens`: размер extend-прохода автотюнинга, если он включен переменной окружения.
- `--speculative-algorithm`: при спекуляции тюнятся target и draft по отдельности (`maybe_flashinfer_autotune_speculative_draft`).

## Типовые проблемы и диагностика

- **Симптом:** старт занимает лишние десятки секунд на строке про autotune. **Проверка:** `Running FlashInfer autotune with cache: …` и `FlashInfer autotune completed.` в логе. **Решение:** оставить кеш включенным либо задать этот флаг.
- **Симптом:** падение внутри автотюнинга (в том числе illegal memory access в конкретном ядре). **Решение:** сначала `--flashinfer-autotune-skip-ops <имя>`, и только если это не помогает — полное отключение.
- **Симптом:** флаг задан, а логи автотюнинга и не появлялись раньше. **Причина:** конфигурация не проходит ни один триггер `should_run_flashinfer_autotune`.
- **Симптом:** `FlashInfer extend autotune skipped: not enough free memory …`. **Причина:** extend-проход не поместился; это предупреждение, а не ошибка.
- **Проверка:** дамп `server_args=` при старте показывает флаг; кеш-каталог можно посмотреть глазами по пути из строки лога.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1-FP4 --quantization modelopt_fp4 --moe-runner-backend flashinfer_trtllm --disable-flashinfer-autotune
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1-FP4 --quantization modelopt_fp4 --moe-runner-backend flashinfer_trtllm --flashinfer-autotune-skip-ops mxfp8_gemm
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/python/sglang/srt/environ.py`
