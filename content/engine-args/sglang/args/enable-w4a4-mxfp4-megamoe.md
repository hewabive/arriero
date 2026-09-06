---
schema: 1
engine: sglang
primaryName: "--enable-w4a4-mxfp4-megamoe"
title: "--enable-w4a4-mxfp4-megamoe"
summary: "Переключает MegaMoE на W4A4 MXFP4 с MMA mxf4xmxf4. Применяется только к соответствующему пути DeepGEMM."
group: exec.moe
related:
  - --moe-a2a-backend
  - --moe-runner-backend
  - --quantization
---

# --enable-w4a4-mxfp4-megamoe

## Кратко

Переключает MegaMoE на W4A4 MXFP4 с MMA mxf4xmxf4. Применяется только к соответствующему пути DeepGEMM.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Enable the W4A4 MXFP4 MegaMoE path with DeepGEMM's mxf4xmxf4 MMA type. Use with --moe-a2a-backend megamoe.
```

## Паспорт аргумента

- Флаг: `--enable-w4a4-mxfp4-megamoe`
- Группа: `exec.moe`
- Тип: `bool`
- Декларативный default: `false`
- Объявление: `ServerArgs.enable_w4a4_mxfp4_megamoe` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

В `mega_moe.py` функция `_mega_moe_mma_type` выбирает `mxf4xmxf4` вместо `fp8xfp4`. Тип входит в ключ symmetric buffer и передаётся при построении буферов и вызове MegaMoE. Флаг не конвертирует произвольный checkpoint в MXFP4.

## Значения и формат

Флаг без значения; по умолчанию выключен, используется W4A8-путь `fp8xfp4`.

## Когда использовать

Для совместимой MXFP4-модели и MegaMoE с версией DeepGEMM, реализующей `mxf4xmxf4` (изменение пришло с обновлением sgl-deep-gemm до 0.1.7).

## Влияние на производительность и память

Меняет точность активаций и вычислительный путь MoE, а также связанные рабочие буферы. Проверяйте качество и throughput; KV-cache и формат остальных слоёв не меняются.

## Взаимодействие с другими аргументами

Используйте `--moe-a2a-backend megamoe`. Другие MoE backend не читают этот переключатель.

## Типовые проблемы и диагностика

При ошибке импорта или неподдерживаемого MMA проверьте DeepGEMM и совместимость GPU с выбранным ядром. Принятый флаг в `server_args=` не доказывает, что модель использует MegaMoE.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4-Flash-MXFP4 --tp-size 8 --moe-a2a-backend megamoe --enable-w4a4-mxfp4-megamoe
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/mega_moe.py`
