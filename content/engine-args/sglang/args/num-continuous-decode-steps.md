---
schema: 1
engine: sglang
primaryName: "--num-continuous-decode-steps"
title: "--num-continuous-decode-steps"
summary: Исторический аргумент цикла планировщика: в текущем коде значение принимается и сохраняется, но ни одна подсистема его не читает. Менять его бессмысленно, `--scheduler-recv-interval` решает ту же задачу.
group: schedule
related:
  - --scheduler-recv-interval
  - --disable-overlap-schedule
  - --max-running-requests
---

# --num-continuous-decode-steps

## Кратко

Аргумент объявлен, принимается argparse и попадает в `ServerArgs`, но в checkout'е, по которому снят extract, **у него нет ни одного потребителя**: ни планировщик, ни worker'ы, ни model runner к полю `num_continuous_decode_steps` не обращаются. Задание значения не меняет поведение сервера. Задачу «реже опрашивать очередь между decode-шагами» сегодня решает `--scheduler-recv-interval`.

## Оригинальная справка

```text
Run multiple continuous decoding steps to reduce scheduling overhead. This can potentially increase throughput but may also increase time-to-first-token latency. The default value is 1, meaning only run one decoding step at a time.
```

## Паспорт аргумента

- Флаги: `--num-continuous-decode-steps`
- Группа: `schedule`
- Тип значения: целое
- Допустимые значения: не ограничены; проверок при старте нет
- Значение по умолчанию: `1`
- Эффективное значение: значение сохраняется в `ServerArgs` как есть и попадает в дамп `server_args=`, но нигде не читается
- Где объявлен: `ServerArgs.num_continuous_decode_steps`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: формально обычный (не `hidden`, не `Deprecated*Action`), фактически неработающий
- Этап применения: отсутствует

## Что меняет в движке

Ничего. Единственное вхождение имени `num_continuous_decode_steps` в дереве `python/` — само объявление поля в `server_args.py`.

Историческая справка по git-истории checkout'а: аргумент был добавлен коммитом «Simplify the event loop and expose `--num-continuous-decode-steps` as an argument» (#1652) и управлял циклом `for _ in range(self.server_args.num_continuous_decode_steps - 1)` в главном цикле планировщика — сервер выполнял несколько шагов decode подряд, не заходя в опрос очереди. Этот цикл был удален коммитом «Make constrained decoding work for overlap scheduler» (#2095, ноябрь 2024) при переходе на overlap-планировщик; объявление аргумента при этом осталось.

Апстрим-документация про это не знает: `--num-continuous-decode-steps` по-прежнему перечислен в таблице `docs/docs/advanced_features/server_arguments.mdx` и встречается со значением `4` в примерах развертывания DeepSeek-R1 (`docs/src/snippets/autoregressive/deepseek-r1-advanced-deployment.jsx`). Эти примеры не сломаются — значение просто ничего не сделает.

## Значения и формат

- Целое число. Ни валидации, ни особых значений нет: `0` и отрицательные значения примутся так же молча, как и любые другие.
- Значение `1` объявлено как «один шаг decode за раз» и совпадает с фактическим поведением текущего цикла планировщика.

## Когда использовать

- Не использовать. Аргумент не имеет эффекта в этой версии кода.
- Если цель — снизить накладные расходы планировщика на decode, используйте `--scheduler-recv-interval` (пропуск опроса очереди между decode-шагами) и, при необходимости, оставьте включенным overlap-планировщик (не задавайте `--disable-overlap-schedule`).
- Если аргумент достался вам из чужой конфигурации или из апстрим-примера — его можно убрать без изменения поведения.

## Влияние на производительность и память

- Никакого: значение не читается ни одной подсистемой. На VRAM, RAM, время старта, throughput и latency не влияет.

## Взаимодействие с другими аргументами

- `--scheduler-recv-interval`: рабочая замена по смыслу — уменьшает частоту опроса входящих запросов во время серии decode-шагов.
- `--disable-overlap-schedule`: именно переход на overlap-планировщик убрал цикл, которым управлял этот аргумент.
- `--max-running-requests`: реальный размер decode-батча, от которого зависят накладные расходы на шаг.

## Типовые проблемы и диагностика

- Ожидали прироста throughput после `--num-continuous-decode-steps 4` и не получили ничего — это ожидаемо, потребителя у значения нет.
- Предупреждения при старте не будет: аргумент не помечен как deprecated и не проходит через `_handle_deprecated_args`. Единственное подтверждение, что он принят, — поле в дампе `server_args=`.
- Проверить, есть ли аргумент в вашей установленной сборке, можно так: `python -m sglang.launch_server --help | grep num-continuous-decode-steps`. Наличие в `--help` не означает наличие эффекта.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --num-continuous-decode-steps 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --scheduler-recv-interval 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- `sglang/docs/src/snippets/autoregressive/deepseek-r1-advanced-deployment.jsx`
