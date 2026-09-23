---
schema: 1
engine: vllm
primaryName: "--watermark-config"
title: "--watermark-config"
summary: Передаёт конфигурацию текстового watermarking в движок.
group: VllmConfig
related: []
---

# --watermark-config

## Кратко

Передаёт конфигурацию текстового watermarking в движок.

## Оригинальная справка

```text
Text watermarking configuration.
```

## Паспорт аргумента

- Флаги: `--watermark-config`
- Группа argparse: `VllmConfig`
- Тип значения: `json`
- Значение по умолчанию в декларации: `None`
- Где объявлен: `vllm/config/vllm.py:VllmConfig.watermark_config`

## Что меняет в движке

JSON-объект попадает в VllmConfig.watermark_config; None оставляет watermarking без отдельной настройки.

## Значения и формат

Принимает значение в формате, указанном в `vllm serve --help` установленного окружения; JSON-конфигурацию можно передать строкой или вложенными ключами.

## Когда использовать

Указывайте параметры только для задачи, где нужно маркировать сгенерированный текст. Обязательное поле `key` — секретное целое от 0 до 2⁶⁴−1; храните его вне общедоступных команд и журналов.

## Влияние на производительность и память

Дополнительная обработка токенов может влиять на latency; объём весов и KV-cache сам флаг не меняет.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

При ошибке старта проверьте поля JSON и допустимые значения WatermarkConfig.

## Примеры

```bash
vllm serve /models/model --watermark-config '{"key": 123456789}'
```

## Источники

- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/watermarking.py`
