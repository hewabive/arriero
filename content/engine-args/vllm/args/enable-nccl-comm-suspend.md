---
schema: 1
engine: vllm
primaryName: "--enable-nccl-comm-suspend"
title: "--enable-nccl-comm-suspend"
summary: Экспериментально освобождает память коммуникаторов NCCL во время sleep mode.
group: ModelConfig
related: []
---

# --enable-nccl-comm-suspend

## Кратко

Экспериментально освобождает память коммуникаторов NCCL во время sleep mode.

## Оригинальная справка

```text
Enable releasing NCCL communicator memory during sleep mode
(``ncclCommSuspend``/``ncclCommResume``). Experimental; when disabled
(the default) sleep still releases weights/KV-cache memory as before.
```

## Паспорт аргумента

- Флаги: `--enable-nccl-comm-suspend`, `--no-enable-nccl-comm-suspend`
- Группа argparse: `ModelConfig`
- Тип значения: `bool`
- Значение по умолчанию в декларации: `False`
- Где объявлен: `vllm/config/model.py:ModelConfig.enable_nccl_comm_suspend`

## Что меняет в движке

В sleep вызываются ncclCommSuspend и ncclCommResume; обычное освобождение весов и KV-cache остаётся и без этого флага.

## Значения и формат

Парная форма `--no-enable-nccl-comm-suspend` выключает значение; отсутствие флага оставляет значение по умолчанию.

## Когда использовать

Используйте только если экономия памяти коммуникаторов нужна при sleep и версия NCCL поддерживает эти вызовы.

## Влияние на производительность и память

Уменьшает занятую GPU-память в sleep; пробуждение может стать медленнее.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

При сбое sleep/wake проверьте сообщения NCCL и повторите без экспериментального флага.

## Примеры

```bash
vllm serve /models/model --enable-nccl-comm-suspend
```

## Источники

- `vllm/vllm/config/model.py`
