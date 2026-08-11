---
schema: 1
engine: sglang
primaryName: "--pdmux-config-path"
title: "--pdmux-config-path"
summary: Путь к YAML-файлу с делением SM между prefill и decode для PD-Multiplexing. Не задан — берутся встроенные умолчания (8 групп, автоматическое деление SM); задан — файл обязан содержать `sm_group_num` не меньше 3.
group: disagg
related:
  - --enable-pdmux
  - --sm-group-num
  - --cuda-graph-bs
  - --cuda-graph-max-bs
  - --chunked-prefill-size
  - --disable-overlap-schedule
---

# --pdmux-config-path

## Кратко

Аргумент читается ровно один раз — в `Scheduler.init_pdmux`, и только при `--enable-pdmux`. Файл описывает, на сколько групп делить SM карты, какими именно долями и по каким порогам размера decode-батча переключаться между ними. Без файла работают встроенные умолчания, и они разумны: восемь групп с автоматическим делением SM по архитектурным ограничениям green context. Файл нужен, когда автоматическое деление не попадает в профиль вашей нагрузки.

## Оригинальная справка

```text
The path of the PD-Multiplexing config file.
```

## Паспорт аргумента

- Флаги: `--pdmux-config-path`
- Группа: `disagg`
- Тип значения: str (`Optional[str]`), путь к YAML-файлу
- Допустимые значения: `choices` нет; путь должен существовать и быть читаемым в момент инициализации scheduler'а
- Значение по умолчанию: `null` (не задан) — используется `PDMuxConfig()` со встроенными умолчаниями
- Эффективное значение: само поле не переписывается. Обратите внимание, что `sm_group_num` **из файла** и аргумент `--sm-group-num` — разные величины: первый определяет число групп потоков, второй — размер массива decode-backend'ов внимания
- Где объявлен: `ServerArgs.pdmux_config_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; описываемая им подсистема помечена в исходниках как временная реализация
- Этап применения: `Scheduler.init_pdmux` при старте scheduler-процесса → `load_pdmux_config` → `initialize_stream_groups` (создание green-context-потоков) → `adjust_stream_groups` на каждой итерации event loop

## Что меняет в движке

`load_pdmux_config` (`multiplex/pdmux_context.py`) читает YAML через `yaml.safe_load` и заполняет датакласс `PDMuxConfig` четырьмя полями:

| Ключ | Умолчание | Смысл |
| --- | --- | --- |
| `sm_group_num` | `8` | Общее число групп потоков, включая две крайние (весь SM prefill'у и весь SM decode'у). Обязателен в файле, минимум `3` |
| `manual_divisions` | `[]` | Список троек `[prefill_sm, decode_sm, decode_bs_threshold]`. Если задан, длина обязана быть ровно `sm_group_num - 2` |
| `split_forward_token_budget` | `65536` | Бюджет токенов на такт послойного prefill'а: число слоев за такт = `budget // extend_num_tokens`, не меньше 1 |
| `decode_bs_divisor` | `36` | Делитель в автоматическом подборе индекса группы: `stream_idx = clamp(decode_bs * (N-2) // decode_bs_divisor, 1, N-2)` |

Дальше `initialize_stream_groups`:

- при заданных `manual_divisions` берет пары `(prefill_sm, decode_sm)` прямо из файла;
- иначе вызывает `divide_sm(total_sm, compute_capability, sm_group_num - 2)`, который перебирает допустимые деления с учетом архитектурных ограничений green context и выбирает до `sm_group_num - 2` вариантов, начиная с больших долей prefill'у;
- добавляет спереди обычную пару потоков (весь SM prefill'у) и сзади обычную пару (весь SM decode'у).

Фактическое число групп (`real_sm_group_num = len(STREAM_GROUPS)`) может оказаться **меньше** `sm_group_num`, если `divide_sm` не набрал нужного количества допустимых делений. Значение печатается в лог: `PD-Multiplexing enabled with N stream groups, sm_counts (prefill_sm, decode_sm): [...]`.

При заданных `manual_divisions` переключение идет по порогам: берется последняя тройка, чей `decode_bs_threshold` не превышает текущий размер decode-батча.

## Значения и формат

Минимальный файл:

```yaml
sm_group_num: 8
```

Полный файл с ручным делением (для карты со 132 SM, `sm_group_num: 5` ⇒ ровно три тройки):

```yaml
sm_group_num: 5
manual_divisions:
  - [100, 32, 1]
  - [ 68, 64, 16]
  - [ 36, 96, 48]
split_forward_token_budget: 65536
decode_bs_divisor: 36
```

- `sm_group_num` обязателен: его отсутствие — `ValueError: Missing required field: sm_group_num`.
- `sm_group_num < 3` — `ValueError: sm_group_num must be >= 3`. Две группы всегда заняты крайними случаями, поэтому минимум одна реальная green-context-пара требует трех.
- `manual_divisions` либо пуст, либо содержит ровно `sm_group_num - 2` элементов: иначе `ValueError: manual_divisions must have N entries, but got M`.
- Каждая тройка — `[prefill_sm, decode_sm, decode_bs_threshold]`. Суммы SM файл не проверяет: некорректные значения всплывут при создании green context.
- Пустая строка в аргументе (`--pdmux-config-path ""`) равносильна незаданному значению: `load_pdmux_config` возвращает умолчания при ложном пути.
- Несуществующий путь — обычный `FileNotFoundError` при открытии; невалидный YAML — исключение `yaml`.

## Когда использовать

- Автоматическое деление дает слишком мало SM prefill'у на вашей карте, и TTFT просел: задайте `manual_divisions` с явными долями и порогами.
- Нужно сместить точку переключения: `decode_bs_divisor` управляет тем, при каком размере decode-батча забирается больше SM. Меньший делитель — раньше отдается SM decode'у.
- Длинные промпты и заметные паузы decode на такте prefill'а: уменьшайте `split_forward_token_budget`, чтобы prefill считал меньше слоев за такт и чаще уступал.
- Не задавайте файл, пока не измерили профиль: умолчания покрывают типовой случай, а неверные `manual_divisions` легко сделают хуже.
- Не поднимайте `sm_group_num` выше `--sm-group-num`: это прямой путь к `IndexError` при переключении.

## Влияние на производительность и память

- **VRAM.** Через `sm_group_num` — линейно: CUDA-графы захватываются для каждой группы потоков. Восемь групп означают восемь наборов графов.
- **Время старта.** Тем же множителем: захват повторяется для каждой группы.
- **TTFT/ITL.** Основной рычаг настройки: доли SM и пороги переключения определяют, сколько вычислителя достается каждой фазе в каждый момент.
- **Гранулярность.** `split_forward_token_budget` задает, сколько слоев prefill считается за такт: большой бюджет — меньше переключений и меньше накладных расходов, но грубее чередование с decode.
- **RAM хоста.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-pdmux`: без него файл не читается вообще.
- `--sm-group-num`: обязан быть не меньше фактического числа групп потоков, а его лучше держать равным `sm_group_num` из файла.
- `--cuda-graph-bs` / `--cuda-graph-max-bs`: набор захватываемых размеров умножается на число групп.
- `--chunked-prefill-size -1` и `--disable-overlap-schedule`: обязательные спутники pdmux; `split_forward_token_budget` заменяет собой чанкование как механизм дробления prefill'а.

## Типовые проблемы и диагностика

- `ValueError: Missing required field: sm_group_num` — ключ обязателен даже если вы меняете только `decode_bs_divisor`.
- `ValueError: sm_group_num must be >= 3`.
- `ValueError: manual_divisions must have 6 entries, but got 3` — длина списка должна быть ровно `sm_group_num - 2`.
- `ValueError: No valid partitions found for total SMs ... with constraints (min per part: ..., multiple: ...)` — автоматическое деление не нашло вариантов; уменьшите `sm_group_num` или задайте `manual_divisions`.
- `FileNotFoundError` на старте scheduler'а — путь не существует в контексте процесса (проверьте, что путь абсолютный и виден внутри контейнера).
- Фактическое число групп меньше запрошенного — нормальная ситуация при малом числе SM; смотрите строку `PD-Multiplexing enabled with N stream groups, ...` и сверяйте `N` с `--sm-group-num`.
- Принятый путь — в дампе `server_args=` при старте; содержимое файла в лог не попадает, только производный `sm_counts`.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-32B --enable-pdmux --pdmux-config-path /etc/sglang/pdmux.yaml --sm-group-num 8 --chunked-prefill-size -1 --disable-overlap-schedule
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --enable-pdmux --pdmux-config-path /etc/sglang/pdmux-manual.yaml --sm-group-num 5 --chunked-prefill-size -1 --disable-overlap-schedule --cuda-graph-max-bs 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multiplex/pdmux_context.py`
- `sglang/python/sglang/srt/multiplex/multiplexing_mixin.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
