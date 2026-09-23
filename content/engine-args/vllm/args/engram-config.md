---
schema: 1
engine: vllm
primaryName: "--engram-config"
title: "--engram-config"
summary: Передаёт настройки хранения и шардирования n-gram embeddings.
group: VllmConfig
related: []
---

# --engram-config

## Кратко

Передаёт настройки хранения и шардирования n-gram embeddings.

## Оригинальная справка

```text
N-gram embedding storage and sharding settings.
```

## Паспорт аргумента

- Флаги: `--engram-config`
- Группа argparse: `VllmConfig`
- Тип значения: `json`
- Значение по умолчанию в декларации: `None`
- Где объявлен: `vllm/config/vllm.py:VllmConfig.engram_config`

## Что меняет в движке

JSON-конфигурация попадает в VllmConfig.engram_config и применяется к моделям с Engram.

## Значения и формат

Принимает значение в формате, указанном в `vllm serve --help` установленного окружения; JSON-конфигурацию можно передать строкой или вложенными ключами.

## Когда использовать

Используйте только для модели с Engram. `cpu_offload` держит embedding-веса в закреплённой RAM, `embedding_across_dp` шардирует их между DP-рангами, а `dp_shared_memory` может разделить таблицы между локальными репликами.

## Влияние на производительность и память

Размещение embedding-таблиц влияет на RAM, VRAM и обмены между шардами.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

При отказе загрузки проверьте поля JSON и совместимость конфигурации с моделью.

## Примеры

```bash
vllm serve /models/DeepSeek-V4.1 --engram-config '{"cpu_offload": true}'
```

## Источники

- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/engram.py`
